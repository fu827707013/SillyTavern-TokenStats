/**
 * Token 用量统计 — SillyTavern 扩展
 *
 * 为什么需要这个扩展：
 *   ST 前端在 openai.js:3175 把每个 SSE chunk 都 JSON.parse 了，`parsed.usage`
 *   就在手边，但它从来没有读取过 —— 上游返回的精确用量被直接丢弃。
 *   唯一能做到精确统计的位置就是页面里（能拿到原始响应流）。
 *
 * 数据来源：真实 usage，不是本地估算
 *   实测（2026-10-09）max66 网关即使不带 stream_options.include_usage，
 *   也会在流最后一个 chunk 返回完整 usage：
 *   { prompt_tokens, completion_tokens, total_tokens,
 *     prompt_cache_hit_tokens, prompt_cache_miss_tokens,
 *     cache_read_input_tokens, cache_creation_input_tokens,
 *     completion_thinking_tokens }
 *
 * 拦截点：
 *   openai.js:3149 是聊天补全的唯一出站 fetch（/api/backends/chat-completions/generate），
 *   在此克隆响应流旁路读取，不影响 ST 自身消费。
 */

import { saveSettingsDebounced } from '../../../../script.js';
import { extension_settings, renderExtensionTemplateAsync, getContext } from '../../../extensions.js';
import { POPUP_TYPE, callGenericPopup } from '../../../popup.js';

const MODULE_NAME = 'token-stats';
const MAX_RECORDS = 3000;
const GENERATE_URL = '/api/backends/chat-completions/generate';

const defaultSettings = {
    enabled: true,
    range: 'today',       // 记住上次选的时间范围
    showRecent: false,    // 「最近调用」明细默认折叠，避免把面板拉得很长
    showCharBadge: true,  // 在右侧角色列表给每个角色显示用量徽章
    badgeRange: 'all',    // 角色徽章统计哪个范围
    records: [],          // { t, model, source, prompt, completion, total, cacheRead, cacheWrite, reasoning, chat }
};

function getSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    const s = extension_settings[MODULE_NAME];
    for (const k of Object.keys(defaultSettings)) {
        if (s[k] === undefined) s[k] = structuredClone(defaultSettings[k]);
    }
    if (!Array.isArray(s.records)) s.records = [];
    return s;
}

// ─────────────────────────── 用量捕获 ───────────────────────────

/** 把任意值安全转成有限非负整数 */
function num(v) {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** 上游 usage → 统一结构 */
function normalizeUsage(u) {
    if (!u || typeof u !== 'object') return null;
    const prompt = num(u.prompt_tokens);
    const completion = num(u.completion_tokens);
    if (!prompt && !completion) return null;   // 空 usage（流中间那些 usage:null 已在上游过滤）
    const total = num(u.total_tokens) || (prompt + completion);
    // 缓存读：优先 prompt_cache_hit_tokens（本次实测的字段名），兼容 OpenAI 的 cached_tokens
    const cacheRead = num(u.prompt_cache_hit_tokens)
        || num(u.cache_read_input_tokens)
        || num(u.prompt_tokens_details?.cached_tokens);
    const cacheWrite = num(u.prompt_cache_write_tokens)
        || num(u.cache_creation_input_tokens);
    const reasoning = num(u.completion_thinking_tokens)
        || num(u.completion_tokens_details?.reasoning_tokens);
    return { prompt, completion, total, cacheRead, cacheWrite, reasoning };
}

/**
 * 从响应文本里提取 usage。
 *
 * 注意：不能靠 content-type 判断是不是 SSE —— 实测 max66 网关返回的
 * 流式响应根本没有 content-type 响应头（headers.get 返回 null），
 * 按响应头判断会误走 JSON 分支导致解析失败。改为按内容特征判断。
 */
function extractUsage(text) {
    if (!text) return null;

    // ① 先按 SSE 解析（内容是 "data: {...}" 多行）
    const sse = parseUsageFromSSE(text);
    if (sse) return sse;

    // ② 再按普通 JSON 解析（单次非流式响应）
    return parseUsageFromJson(text);
}

/** 从 SSE 文本里取最后一个非空 usage */
function parseUsageFromSSE(text) {
    let last = null;
    for (const raw of String(text).split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith(':')) continue;   // 跳过 ": ttft-warmup" 之类的注释行
        if (!line.startsWith('data:')) continue;
        const body = line.slice(5).trim();
        if (!body || body === '[DONE]') continue;
        try {
            const j = JSON.parse(body);
            if (j && j.usage) last = j.usage;
        } catch {
            /* 不完整的分片，忽略 */
        }
    }
    return last;
}

/** 从普通 JSON 响应里取 usage */
function parseUsageFromJson(text) {
    try {
        const j = JSON.parse(text);
        return j?.usage ?? null;
    } catch {
        return null;
    }
}

/** 读请求体，拿到模型名与渠道 */
function readRequestMeta(init) {
    try {
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null;
        if (!body) return {};
        return {
            model: String(body.model || ''),
            source: String(body.chat_completion_source || ''),
        };
    } catch {
        return {};
    }
}

/** 后台旁路读取响应，提取 usage 并入库。不阻塞、不影响 ST */
async function captureUsage(response, init, chatLabelAtStart) {
    const s = getSettings();
    if (!s.enabled) return;

    const meta = readRequestMeta(init);

    // 出错的响应不统计（否则会把错误信息当成"没有 usage"计入未命中）
    if (!response.ok) return;

    let text = '';
    try {
        const clone = response.clone();
        const reader = clone.body.getReader();
        const dec = new TextDecoder();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            text += dec.decode(value, { stream: true });
        }
    } catch (err) {
        console.warn('[token-stats] 读取响应流失败', err);
        return;
    }

    const raw = extractUsage(text);
    const usage = normalizeUsage(raw);

    if (!usage) {
        // 上游没给 usage —— 记一笔，让用户知道"统计不到"而不是"没在工作"
        s.missedCalls = num(s.missedCalls) + 1;
        saveSettingsDebounced();
        updateStatus();
        return;
    }

    const rec = {
        t: Date.now(),
        model: meta.model || '(未知模型)',
        source: meta.source || '(未知渠道)',
        // 用请求发出时抓到的角色名，不能用读完流之后的 ——
        // 读流是异步的，群聊里这一刻可能已经轮到下一个角色说话了
        chat: chatLabelAtStart || getChatLabel(),
        ...usage,
    };
    pushRecord(rec);
}

/** 当前会话标签，便于按角色/会话区分 */
function getChatLabel() {
    try {
        const ctx = getContext();
        return ctx?.name2 || '未知角色';
    } catch {
        return '未知角色';
    }
}

function pushRecord(rec) {
    const s = getSettings();
    s.records.push(rec);
    if (s.records.length > MAX_RECORDS) {
        s.records.splice(0, s.records.length - MAX_RECORDS);
    }
    saveSettingsDebounced();
    scheduleRender();
}

/** 装上拦截器。只做一次字符串判断，开销可忽略 */
function installInterceptor() {
    if (window.__tokenStatsPatched) return;
    window.__tokenStatsPatched = true;

    const origFetch = window.fetch.bind(window);
    window.fetch = async function (...args) {
        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url ?? '');
        // 必须在发请求前抓角色名 —— 这是同步的，拿到的一定是"谁在说话"
        const labelAtStart = String(url).includes(GENERATE_URL) ? getChatLabel() : null;
        const res = await origFetch(...args);
        if (String(url).includes(GENERATE_URL)) {
            // 必须在 ST 消费 body 之前 clone，否则拿不到流
            void captureUsage(res, args[1], labelAtStart).catch(() => { /* 统计失败绝不影响聊天 */ });
        }
        return res;
    };
    console.log('[token-stats] 已挂载用量拦截器');
}

// ─────────────────────────── 聚合 ───────────────────────────

const RANGES = {
    today: { label: '今日', days: 0 },
    d7: { label: '近 7 天', days: 7 },
    d30: { label: '近 30 天', days: 30 },
    all: { label: '全部', days: -1 },
};

function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
}

function filterByRange(records, range) {
    if (range === 'all') return records;
    if (range === 'today') return records.filter(r => r.t >= startOfToday());
    const days = RANGES[range]?.days ?? 0;
    const from = startOfToday() - (days - 1) * 86400000;
    return records.filter(r => r.t >= from);
}

function sumRecords(records) {
    const acc = { prompt: 0, completion: 0, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: records.length };
    for (const r of records) {
        acc.prompt += num(r.prompt);
        acc.completion += num(r.completion);
        acc.total += num(r.total);
        acc.cacheRead += num(r.cacheRead);
        acc.cacheWrite += num(r.cacheWrite);
        acc.reasoning += num(r.reasoning);
    }
    // 未命中的输入 = 输入总量 - 缓存命中量（下限 0，防上游字段异常时出负数）
    acc.cacheMiss = Math.max(0, acc.prompt - acc.cacheRead);
    return acc;
}

/**
 * 缓存命中率。
 *
 * ⚠️ 关键：上游的 prompt_tokens **已经包含**缓存命中的部分，三者关系是
 *     prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens
 * （2026-10-09 用同一段长前缀连续请求实测确认：两次 prompt_tokens 均为 1287，
 *   第一次 hit=0/miss=1287，第二次 hit=1152/miss=135）
 *
 * 所以分母就是 prompt_tokens，不能再加一次 cacheRead ——
 * 否则 1152/1287 = 89.5% 会被算成 1152/(1152+1287) = 47.2%，凭空少一半。
 */
function cacheHitRate(sum) {
    if (!sum.prompt) return null;
    return sum.cacheRead / sum.prompt * 100;
}

function groupBy(records, key) {
    const map = new Map();
    for (const r of records) {
        const k = r[key] || '(未知)';
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(r);
    }
    return [...map.entries()]
        .map(([name, list]) => ({ name, ...sumRecords(list) }))
        .sort((a, b) => b.total - a.total);
}

/**
 * 按天分组。
 * days 传 0 表示不限制（"全部"范围用），否则只保留最近 N 天。
 */
function groupByDay(records, days) {
    const buckets = new Map();
    for (const r of records) {
        const d = new Date(r.t);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(r);
    }
    const all = [...buckets.entries()]
        .map(([day, list]) => ({ day, ...sumRecords(list) }))
        .sort((a, b) => a.day.localeCompare(b.day));
    return days > 0 ? all.slice(-days) : all;
}

// ─────────────────────────── 渲染 ───────────────────────────

/** 紧凑数字，与 DSH 用量面板风格一致：1.58k / 10.2M / 11.6B */
function fmt(n) {
    const v = num(n);
    if (v < 1000) return String(v);
    if (v < 1e6) return (v / 1e3).toFixed(v < 1e4 ? 2 : 1) + 'k';
    if (v < 1e9) return (v / 1e6).toFixed(v < 1e7 ? 2 : 1) + 'M';
    return (v / 1e9).toFixed(2) + 'B';
}

function fmtFull(n) {
    return num(n).toLocaleString('zh-CN');
}

/** 命中率格式化：null（无输入数据）显示 —，否则保留 1 位小数 */
function fmtRate(rate) {
    return rate === null ? '—' : `${rate.toFixed(1)}%`;
}

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let currentRange = 'today';
let renderTimer = null;

function scheduleRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
        renderTimer = null;
        renderPanel();
        updateStatus();
        refreshCharBadges();
    }, 400);
}

// ─────────────────── 角色列表用量徽章 ───────────────────
//
// 在右侧角色列表的每个角色名旁边显示一个紧凑的用量徽章。
//
// 实现要点：
//   · 不改酒馆源码，用 MutationObserver 监听列表重绘（翻页/搜索/换页大小都会重建 DOM）
//   · 徽章按「角色名」匹配记录里的 chat 字段
//   · 名字区宽度很紧（366px 里名字占 339px），所以徽章做得极小并允许被挤压隐藏

const CHAR_LIST_SEL = '#rm_print_characters_block';
const BADGE_CLS = 'ts-char-badge';

/** 按角色名汇总用量 */
function usageByCharacter(range) {
    const map = new Map();
    for (const r of filterByRange(getSettings().records, range)) {
        const name = r.chat;
        if (!name || name === '未知角色') continue;
        if (!map.has(name)) map.set(name, { total: 0, calls: 0 });
        const e = map.get(name);
        e.total += num(r.total);
        e.calls += 1;
    }
    return map;
}

/** 数字压缩：12345 → 12.3k */
function shortNum(n) {
    const v = num(n);
    if (v < 1000) return String(v);
    if (v < 1000000) return (v / 1000).toFixed(v < 10000 ? 1 : 0) + 'k';
    return (v / 1000000).toFixed(1) + 'M';
}

/** 给角色列表里的每个角色打上用量徽章 */
function refreshCharBadges() {
    const s = getSettings();
    const list = document.querySelector(CHAR_LIST_SEL);
    if (!list) return;

    if (!s.showCharBadge) {
        for (const b of list.querySelectorAll(`.${BADGE_CLS}`)) b.remove();
        return;
    }

    const usage = usageByCharacter(s.badgeRange || 'all');

    for (const item of list.querySelectorAll('.character_select')) {
        const nameEl = item.querySelector('.ch_name');
        if (!nameEl) continue;
        const name = nameEl.textContent.trim();
        const stat = usage.get(name);
        const block = nameEl.closest('.character_name_block') || nameEl.parentElement;

        let badge = block.querySelector(`.${BADGE_CLS}`);
        if (!stat) {
            badge?.remove();      // 该角色没有记录，不留空徽章
            continue;
        }
        if (!badge) {
            badge = document.createElement('small');
            badge.className = BADGE_CLS;
            // 插在角色名后面（版本号之前），视觉上更贴近名字
            nameEl.insertAdjacentElement('afterend', badge);
        }
        const label = `${shortNum(stat.total)} · ${stat.calls} 次`;
        if (badge.textContent !== label) badge.textContent = label;
        badge.title = `${name}\n累计 ${fmtFull(stat.total)} tokens · ${stat.calls} 次调用\n范围：${RANGES[s.badgeRange]?.label ?? '全部'}（可在扩展设置里改）`;
    }
}

let charObserver = null;
let charObserverRetry = null;

/** 监听角色列表 DOM 变化，列表重绘后自动补徽章 */
function installCharBadgeObserver() {
    if (charObserver) return;
    const list = document.querySelector(CHAR_LIST_SEL);
    if (!list) {
        // 扩展加载时角色列表可能还没渲染出来，稍后重试（最多约 30 秒）
        if ((charObserverRetry = (charObserverRetry || 0) + 1) <= 30) {
            setTimeout(installCharBadgeObserver, 1000);
        }
        return;
    }

    let t = null;
    charObserver = new MutationObserver(() => {
        if (t) return;
        t = setTimeout(() => {
            t = null;
            refreshCharBadges();
        }, 250);   // 防抖：翻页时会连续触发
    });
    charObserver.observe(list, { childList: true, subtree: true });
    refreshCharBadges();
}

function statTile(label, value, sub, extraClass = '') {
    return `<div class="ts-tile${extraClass ? ' ' + extraClass : ''}">
        <div class="ts-tile-value">${esc(value)}</div>
        <div class="ts-tile-label">${esc(label)}</div>
        ${sub ? `<div class="ts-tile-sub">${esc(sub)}</div>` : ''}
    </div>`;
}

function barRow(item, maxTotal, sub) {
    const pct = maxTotal > 0 ? Math.max(2, Math.round(item.total / maxTotal * 100)) : 2;
    return `<div class="ts-bar-row">
        <div class="ts-bar-head">
            <span class="ts-bar-name" title="${esc(item.name)}">${esc(item.name)}</span>
            <span class="ts-bar-val">${fmt(item.total)}<span class="ts-bar-calls"> · ${item.calls} 次</span></span>
        </div>
        <div class="ts-bar-track"><div class="ts-bar-fill" style="width:${pct}%"></div></div>
        ${sub ? `<div class="ts-bar-sub">${sub}</div>` : ''}
    </div>`;
}

function renderPanel() {
    const root = document.getElementById('token-stats-body');
    if (!root) return;

    const s = getSettings();
    const scoped = filterByRange(s.records, currentRange);
    const sum = sumRecords(scoped);

    if (!scoped.length) {
        root.innerHTML = `<div class="ts-empty">
            ${s.records.length
                ? '该时间段内没有记录，换个范围看看。'
                : '还没有数据。发一条消息后即可看到真实用量。'}
        </div>`;
        return;
    }

    const byModel = groupBy(scoped, 'model');
    const bySource = groupBy(scoped, 'source');
    const byChat = groupBy(scoped, 'chat').filter(c => c.name && c.name !== '未知角色');
    // 「全部」范围不限制天数，其他范围最多看 30 天
    const byDay = groupByDay(scoped, currentRange === 'all' ? 0 : 30);
    const maxModel = Math.max(...byModel.map(m => m.total), 1);
    const maxSource = Math.max(...bySource.map(m => m.total), 1);
    const maxDay = Math.max(...byDay.map(d => d.total), 1);

    const rate = cacheHitRate(sum);
    const rateSub = rate === null ? '无输入数据' : '命中 / 输入';
    const pct = (part) => (sum.total ? (part / sum.total * 100).toFixed(1) : '0.0');
    const showRecent = !!s.showRecent;
    const recentRows = [...scoped].reverse().slice(0, 25);

    root.innerHTML = `
        <div class="ts-tiles">
            ${statTile('总 tokens', fmt(sum.total), fmtFull(sum.total))}
            ${statTile('输入', fmt(sum.prompt), `${pct(sum.prompt)}%`)}
            ${statTile('输出', fmt(sum.completion), `${pct(sum.completion)}%`)}
            ${statTile('缓存命中率', fmtRate(rate), rateSub, 'ts-tile-accent')}
            ${statTile('缓存读', fmt(sum.cacheRead), sum.prompt ? `未命中 ${fmt(sum.cacheMiss)}` : '—')}
            ${statTile('缓存写', fmt(sum.cacheWrite), sum.cacheWrite ? '写入缓存' : '—')}
            ${statTile('思考', fmt(sum.reasoning), sum.reasoning ? `${pct(sum.reasoning)}%` : '—')}
            ${statTile('调用次数', fmtFull(sum.calls), `平均 ${fmt(sum.calls ? Math.round(sum.total / sum.calls) : 0)}/次`)}
        </div>

        <div class="ts-section">
            <div class="ts-section-title">按模型</div>
            ${byModel.map(m => barRow(m, maxModel,
                `输入 ${fmt(m.prompt)} · 输出 ${fmt(m.completion)}${m.cacheRead ? ` · 缓存读 ${fmt(m.cacheRead)}` : ''}`)).join('')}
        </div>

        <div class="ts-section">
            <div class="ts-section-title">按渠道</div>
            ${bySource.map(m => barRow(m, maxSource,
                `输入 ${fmt(m.prompt)} · 输出 ${fmt(m.completion)}`)).join('')}
        </div>

        ${byChat.length ? `
        <div class="ts-section">
            <div class="ts-section-title">按角色</div>
            ${byChat.map(m => barRow(m, Math.max(...byChat.map(c => c.total), 1),
                `${m.calls} 次调用`)).join('')}
        </div>` : ''}

        <div class="ts-section">
            <div class="ts-section-title">按天${currentRange === 'all' && byDay.length > 30 ? `（共 ${byDay.length} 天）` : ''}</div>
            ${byDay.map(d => `
                <div class="ts-bar-row">
                    <div class="ts-bar-head">
                        <span class="ts-bar-name">${esc(d.day)}</span>
                        <span class="ts-bar-val">${fmt(d.total)}<span class="ts-bar-calls"> · ${d.calls} 次</span></span>
                    </div>
                    <div class="ts-bar-track"><div class="ts-bar-fill" style="width:${Math.max(2, Math.round(d.total / maxDay * 100))}%"></div></div>
                </div>`).join('')}
        </div>

        <div class="ts-section">
            <div class="ts-section-title ts-toggle-head" id="ts-recent-toggle" role="button" tabindex="0"
                 title="${showRecent ? '点击收起' : '点击展开'}">
                <span>最近调用</span>
                <span class="ts-toggle-meta">${recentRows.length} 条</span>
                <i class="fa-solid fa-chevron-${showRecent ? 'up' : 'down'} ts-toggle-icon"></i>
            </div>
            ${showRecent ? `
            <div class="ts-table-wrap">
            <table class="ts-table">
                <thead><tr><th>时间</th><th>模型</th><th class="ts-num">输入</th><th class="ts-num">输出</th><th class="ts-num">合计</th></tr></thead>
                <tbody>
                ${recentRows.map(r => {
                    const d = new Date(r.t);
                    const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
                    const date = `${d.getMonth() + 1}/${d.getDate()}`;
                    return `<tr>
                        <td class="ts-dim">${date} ${hh}</td>
                        <td title="${esc(r.model)}">${esc(r.model)}</td>
                        <td class="ts-num">${fmtFull(r.prompt)}</td>
                        <td class="ts-num">${fmtFull(r.completion)}</td>
                        <td class="ts-num ts-strong">${fmtFull(r.total)}</td>
                    </tr>`;
                }).join('')}
                </tbody>
            </table>
            </div>` : ''}
        </div>
    `;

    // 折叠开关
    const toggleHead = document.getElementById('ts-recent-toggle');
    if (toggleHead) {
        const flip = () => {
            const st = getSettings();
            st.showRecent = !st.showRecent;
            saveSettingsDebounced();
            renderPanel();
        };
        toggleHead.addEventListener('click', flip);
        toggleHead.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); }
        });
    }
}

// ─────────────────────────── UI ───────────────────────────

/**
 * 动态推导本扩展在酒馆里的扩展名。
 *
 * 为什么不能写死：从 GitHub 安装时，酒馆用【仓库名】当文件夹名
 * （src/endpoints/extensions.js:122），所以本地文件夹可能是
 * SillyTavern-TokenStats，而不是手工复制时的 token-stats。
 * 写死会导致 renderExtensionTemplateAsync 找不到 settings.html，
 * 面板静默不显示 —— 插件看着"加载了"却没有界面。
 *
 * 做法：从本模块的 URL 反推，兼容任意文件夹名。
 *   /scripts/extensions/third-party/<文件夹>/index.js
 *   → third-party/<文件夹>
 */
function resolveExtensionName() {
    try {
        const url = new URL(import.meta.url);
        const m = url.pathname.match(/\/scripts\/extensions\/(.+?)\/[^/]+\.js$/);
        if (m && m[1]) return m[1];
    } catch {
        /* 忽略，走兜底 */
    }
    return 'third-party/token-stats';   // 兜底：手工复制时的默认名
}

const EXTENSION_NAME = resolveExtensionName();

async function addExtensionUI() {
    try {
        // 防重复注入：热重载或异常路径可能让本函数跑第二次
        if (document.querySelector('.token-stats-settings')) {
            console.warn('[token-stats] 面板已存在，跳过重复注入');
            return;
        }

        const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'settings');
        const mount = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        if (!mount) {
            console.warn('[token-stats] 找不到设置容器');
            return;
        }
        mount.insertAdjacentHTML('beforeend', html);

        // 恢复上次选择的时间范围
        currentRange = getSettings().range || 'today';
        for (const b of document.querySelectorAll('.ts-range-btn')) {
            b.classList.toggle('ts-active', b.dataset.range === currentRange);
        }

        // 范围切换
        for (const btn of document.querySelectorAll('.ts-range-btn')) {
            btn.addEventListener('click', () => {
                currentRange = btn.dataset.range || 'today';
                getSettings().range = currentRange;
                saveSettingsDebounced();
                for (const b of document.querySelectorAll('.ts-range-btn')) {
                    b.classList.toggle('ts-active', b === btn);
                }
                renderPanel();
            });
        }

        const en = document.getElementById('ts-enabled');
        if (en) {
            en.checked = getSettings().enabled;
            en.addEventListener('change', () => {
                getSettings().enabled = en.checked;
                saveSettingsDebounced();
                updateStatus();
                toastr.info(en.checked ? '已开始记录 token 用量' : '已暂停记录（历史数据保留）', 'Token 用量统计');
            });
        }

        // 导出 CSV
        const exp = document.getElementById('ts-export');
        if (exp) {
            exp.addEventListener('click', exportCsv);
        }

        // 角色列表徽章开关
        const badgeToggle = document.getElementById('ts-char-badge');
        if (badgeToggle) {
            badgeToggle.checked = getSettings().showCharBadge !== false;
            badgeToggle.addEventListener('change', () => {
                getSettings().showCharBadge = badgeToggle.checked;
                saveSettingsDebounced();
                refreshCharBadges();
            });
        }

        // 徽章统计范围
        const badgeRange = document.getElementById('ts-badge-range');
        if (badgeRange) {
            badgeRange.value = getSettings().badgeRange || 'all';
            badgeRange.addEventListener('change', () => {
                getSettings().badgeRange = badgeRange.value;
                saveSettingsDebounced();
                refreshCharBadges();
            });
        }

        const clr = document.getElementById('ts-clear');
        if (clr) {
            clr.addEventListener('click', async () => {
                const s = getSettings();
                if (!s.records.length) {
                    toastr.info('没有可清空的记录', 'Token 用量统计');
                    return;
                }
                // 用酒馆原生弹窗，风格与 ST 一致（confirm() 在部分环境会被拦截）
                const ok = await callGenericPopup(
                    `确定清空全部 <b>${s.records.length}</b> 条用量记录？<br>此操作不可撤销。`,
                    POPUP_TYPE.CONFIRM,
                    '',
                    { okButton: '清空', cancelButton: '取消' },
                );
                if (!ok) return;
                s.records = [];
                s.missedCalls = 0;
                saveSettingsDebounced();
                renderPanel();
                updateStatus();
                toastr.success('用量记录已清空', 'Token 用量统计');
            });
        }

        updateStatus();
        renderPanel();
    } catch (err) {
        console.error('[token-stats] 注入设置面板失败', err);
    }
}

/** 导出为 CSV，方便自己用 Excel 对账 */
function exportCsv() {
    const s = getSettings();
    const rows = filterByRange(s.records, currentRange);
    if (!rows.length) {
        toastr.info('当前范围没有可导出的记录', 'Token 用量统计');
        return;
    }
    const head = ['时间', '模型', '渠道', '角色', '输入', '输出', '合计', '缓存读', '缓存写', '思考'];
    const esc2 = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [head.join(',')];
    for (const r of rows) {
        const d = new Date(r.t);
        const ts = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
        lines.push([ts, r.model, r.source, r.chat, num(r.prompt), num(r.completion), num(r.total), num(r.cacheRead), num(r.cacheWrite), num(r.reasoning)].map(esc2).join(','));
    }
    // 加 BOM，Excel 打开中文不乱码
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `token-usage-${currentRange}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toastr.success(`已导出 ${rows.length} 条记录`, 'Token 用量统计');
}

function updateStatus() {
    const el = document.getElementById('ts-status');
    if (!el) return;
    const s = getSettings();
    const sum = sumRecords(filterByRange(s.records, 'today'));

    if (!s.enabled) {
        el.textContent = `已暂停 · 累计 ${s.records.length} 条记录（历史数据保留）`;
        return;
    }

    let text = `记录中 · 今日 ${fmt(sum.total)} tokens · ${sum.calls} 次调用 · 累计 ${s.records.length} 条`;

    // 上游没返回 usage 时提示，避免用户误以为插件坏了
    const missed = num(s.missedCalls);
    if (missed > 0) {
        text += ` · ⚠ ${missed} 次未返回用量`;
        el.title = '部分调用上游没有返回 usage 字段，这类调用无法统计（通常是网关不支持）。可在控制台跑 window.tokenStats.diagnose() 看详情。';
    } else {
        el.title = '';
    }
    el.textContent = text;
}

// ─────────────────────────── 入口 ───────────────────────────

getSettings();
installInterceptor();
installCharBadgeObserver();
addExtensionUI().then(() => {
    console.log('[token-stats] Token 用量统计已加载');
});

// 暴露给控制台便于排查
window.tokenStats = {
    settings: () => getSettings(),
    records: () => getSettings().records,
    summary: (range = 'today') => sumRecords(filterByRange(getSettings().records, range)),
    render: () => renderPanel(),
    refreshBadges: () => refreshCharBadges(),
    clear: () => { getSettings().records = []; saveSettingsDebounced(); renderPanel(); updateStatus(); refreshCharBadges(); },
    export: () => exportCsv(),

    /** 自检：确认拦截器、面板、数据链路是否都正常 */
    diagnose() {
        const s = getSettings();
        const sum = sumRecords(s.records);
        const rate = cacheHitRate(sum);
        return {
            扩展名: EXTENSION_NAME,
            拦截器已挂载: !!window.__tokenStatsPatched,
            设置面板数量: document.querySelectorAll('.token-stats-settings').length,
            启用统计: s.enabled,
            记录总数: s.records.length,
            未返回用量的调用: num(s.missedCalls),
            全部合计: { 输入: sum.prompt, 输出: sum.completion, 合计: sum.total, 缓存读: sum.cacheRead },
            缓存命中率: rate === null ? '无输入数据' : `${rate.toFixed(1)}%`,
            记录上限: MAX_RECORDS,
            提示: s.records.length === 0 ? '还没有数据，发一条消息试试' : '一切正常',
        };
    },

    /** 清掉"未返回用量"计数（排查完想归零时用） */
    resetMissed() {
        getSettings().missedCalls = 0;
        saveSettingsDebounced();
        updateStatus();
    },
};
