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

const MODULE_NAME = 'token-stats';
const MAX_RECORDS = 3000;
const GENERATE_URL = '/api/backends/chat-completions/generate';

const defaultSettings = {
    enabled: true,
    records: [],        // { t, model, source, prompt, completion, total, cacheRead, cacheWrite, reasoning, chat }
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
async function captureUsage(response, init) {
    const s = getSettings();
    if (!s.enabled) return;

    const meta = readRequestMeta(init);

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
    if (!usage) return;   // 非补全请求（如状态查询）或上游未给 usage

    const rec = {
        t: Date.now(),
        model: meta.model || '(未知模型)',
        source: meta.source || '(未知渠道)',
        chat: getChatLabel(),
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
        const res = await origFetch(...args);
        if (String(url).includes(GENERATE_URL)) {
            // 必须在 ST 消费 body 之前 clone，否则拿不到流
            void captureUsage(res, args[1]).catch(() => { /* 统计失败绝不影响聊天 */ });
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
    return acc;
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

/** 按天分组（近 N 天，从早到晚） */
function groupByDay(records, days) {
    const buckets = new Map();
    for (const r of records) {
        const d = new Date(r.t);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key).push(r);
    }
    return [...buckets.entries()]
        .map(([day, list]) => ({ day, ...sumRecords(list) }))
        .sort((a, b) => a.day.localeCompare(b.day))
        .slice(-Math.max(days, 1));
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
    }, 400);
}

function statTile(label, value, sub) {
    return `<div class="ts-tile">
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
    const byDay = groupByDay(scoped, 30);
    const maxModel = Math.max(...byModel.map(m => m.total), 1);
    const maxSource = Math.max(...bySource.map(m => m.total), 1);
    const maxDay = Math.max(...byDay.map(d => d.total), 1);

    // 缓存命中率：缓存读 /（缓存读 + 未命中）
    const cacheDenom = sum.cacheRead + scoped.reduce((a, r) => a + num(r.prompt), 0);
    const cacheRate = cacheDenom > 0 ? (sum.cacheRead / cacheDenom * 100).toFixed(1) : '0.0';

    root.innerHTML = `
        <div class="ts-tiles">
            ${statTile('总 tokens', fmt(sum.total), fmtFull(sum.total))}
            ${statTile('输入', fmt(sum.prompt), `${(sum.total ? sum.prompt / sum.total * 100 : 0).toFixed(1)}%`)}
            ${statTile('输出', fmt(sum.completion), `${(sum.total ? sum.completion / sum.total * 100 : 0).toFixed(1)}%`)}
            ${statTile('缓存读', fmt(sum.cacheRead), `命中率 ${cacheRate}%`)}
            ${statTile('思考', fmt(sum.reasoning), sum.reasoning ? '推理 token' : '—')}
            ${statTile('调用次数', fmtFull(sum.calls), '')}
        </div>

        <div class="ts-section">
            <div class="ts-section-title">按模型</div>
            ${byModel.map(m => barRow(m, maxModel,
                `输入 ${fmt(m.prompt)} · 输出 ${fmt(m.completion)} · 缓存读 ${fmt(m.cacheRead)}`)).join('')}
        </div>

        <div class="ts-section">
            <div class="ts-section-title">按渠道</div>
            ${bySource.map(m => barRow(m, maxSource,
                `输入 ${fmt(m.prompt)} · 输出 ${fmt(m.completion)}`)).join('')}
        </div>

        <div class="ts-section">
            <div class="ts-section-title">按天</div>
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
            <div class="ts-section-title">最近调用</div>
            <table class="ts-table">
                <thead><tr><th>时间</th><th>模型</th><th class="ts-num">输入</th><th class="ts-num">输出</th><th class="ts-num">合计</th></tr></thead>
                <tbody>
                ${[...scoped].reverse().slice(0, 25).map(r => {
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
        </div>
    `;
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
        const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'settings');
        const mount = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
        if (!mount) {
            console.warn('[token-stats] 找不到设置容器');
            return;
        }
        mount.insertAdjacentHTML('beforeend', html);

        // 范围切换
        for (const btn of document.querySelectorAll('.ts-range-btn')) {
            btn.addEventListener('click', () => {
                currentRange = btn.dataset.range || 'today';
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

        const clr = document.getElementById('ts-clear');
        if (clr) {
            clr.addEventListener('click', () => {
                if (!confirm('确定清空全部用量记录？此操作不可撤销。')) return;
                getSettings().records = [];
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

function updateStatus() {
    const el = document.getElementById('ts-status');
    if (!el) return;
    const s = getSettings();
    const sum = sumRecords(filterByRange(s.records, 'today'));
    el.textContent = s.enabled
        ? `记录中 · 今日 ${fmt(sum.total)} tokens · ${sum.calls} 次调用 · 累计 ${s.records.length} 条记录`
        : `已暂停 · 累计 ${s.records.length} 条记录（保留中）`;
}

// ─────────────────────────── 入口 ───────────────────────────

getSettings();
installInterceptor();
addExtensionUI().then(() => {
    console.log('[token-stats] Token 用量统计已加载');
});

// 暴露给控制台便于排查
window.tokenStats = {
    settings: () => getSettings(),
    records: () => getSettings().records,
    summary: (range = 'today') => sumRecords(filterByRange(getSettings().records, range)),
    render: () => renderPanel(),
    clear: () => { getSettings().records = []; saveSettingsDebounced(); renderPanel(); },
};
