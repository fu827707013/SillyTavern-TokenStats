# Token 用量统计（SillyTavern 扩展）

在酒馆里实时统计 token 用量 —— **数据来自上游返回的真实 `usage`，不是本地字符估算**。

![统计面板](https://img.shields.io/badge/SillyTavern-1.19.0-blue)

## 它解决什么问题

酒馆前端其实**拿到了**每次请求的真实 token 用量，但从不使用：

- `public/scripts/openai.js:3175` 把每个 SSE chunk 都 `JSON.parse` 了，`parsed.usage` 就在手边
- 但整个前端**没有任何一处读取它** —— 数据到手就被丢弃

结果是：你在别的客户端（如 DSH）能看到精确用量，在酒馆里却看不到。

本扩展在请求响应流上旁路读取，把这份被丢掉的数据记录下来并可视化。

## 功能

- **精确统计**：输入 / 输出 / 合计 / 缓存读 / 缓存写 / 思考 token
- **多维度分组**：按模型、按渠道、按天
- **明细表**：最近 25 次调用逐条可查
- **时间范围**：今日 / 近 7 天 / 近 30 天 / 全部
- **自动持久化**：记录存在酒馆设置里，刷新页面不丢
- **不干扰原功能**：旁路克隆响应流，不影响酒馆自身消费

## 兼容性

实测上游返回的 usage 字段（以 DeepSeek 系模型为例）：

```json
{
  "prompt_tokens": 15,
  "completion_tokens": 1,
  "total_tokens": 16,
  "prompt_cache_hit_tokens": 0,
  "prompt_cache_miss_tokens": 15,
  "cache_read_input_tokens": 0,
  "cache_creation_input_tokens": 0,
  "completion_thinking_tokens": 0
}
```

同时兼容 OpenAI 格式的 `cached_tokens` / `reasoning_tokens` 字段名。

> **注意**：上游必须返回 `usage` 才有数据。部分第三方网关会省略该字段 —— 这种情况下面板会一直是 0。

## 安装

### 方式一：酒馆内一键安装（推荐）

1. 打开酒馆 → 顶部**积木图标（扩展程序）**
2. 在「Install extension」输入框粘贴本仓库地址：
   ```
   https://github.com/<你的用户名>/SillyTavern-TokenStats
   ```
3. 点 **Install**，确认第三方扩展警告
4. 刷新页面（F5）

### 方式二：手动复制

把本仓库所有文件放进：

```
SillyTavern/public/scripts/extensions/third-party/token-stats/
```

**关键**：`index.js` 必须和 `manifest.json` **在同一层**。多套一层同名文件夹会导致酒馆静默不加载。

## 使用

安装后刷新页面，点顶部**积木图标** → 找到「Token 用量统计」面板。

- 正常聊天，用量自动记录
- 点「今日 / 近 7 天 / 近 30 天 / 全部」切换统计范围
- 关掉「启用统计」会停止记录新调用，**历史数据保留**
- 「清空」按钮删除全部历史记录

### 控制台自查

```js
window.tokenStats.summary('today')
// → { prompt: 0, completion: 0, total: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0 }

window.tokenStats.records()      // 全部原始记录
window.tokenStats.clear()        // 清空（同面板按钮）
```

## 它怎么工作的

1. 包装 `window.fetch`，只拦截 `/api/backends/chat-completions/generate`（酒馆聊天补全的唯一出站请求）
2. 克隆响应流**旁路**读取 —— 酒馆自己仍消费原始流，互不影响
3. 逐行解析 SSE（`data: {...}`），取最后一个非空 `usage`
4. 归一化字段后写入 `extension_settings['token-stats'].records`

**不依赖 `content-type` 判断**：实测部分网关的流式响应不带该响应头，按响应头判断会解析失败。

## 已知限制

- 只统计聊天补全，不含图片生成等其他请求
- 记录上限 3000 条（超出后丢弃最早的）
- 不计算费用金额 —— 各家计价规则不同，强行换算会误导

## 许可

MIT

## 版本

1.0.0 — 基于 SillyTavern 1.19.0 实测开发
