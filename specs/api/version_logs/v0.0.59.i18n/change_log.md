# v0.0.59.i18n API 变更说明（displayReason 契约澄清）

> version: 1.0 · 2026-07-04
> 一句话：i18n 基础设施首版（前端启用 react-i18next），**HTTP 端点形状零变更**；displayReason 契约「字段不变、前端侧改用 errorCategory 查 locale 表」向后兼容；附带修正两处历史 spec 偏差（currentRun.error 出现条件 + LlmErrorCategory 实测 18 值）。
> 概念权威源：`specs/tech/i18n/[P0]i18n_overview.md §8`。
> PRD：`specs/prd/version_logs/v0.0.59.i18n.md`。

## 1. HTTP 端点形状变更

**无**。本版本不改任何 HTTP 端点路径 / 方法 / 请求体 / 响应体 schema。

## 2. displayReason 契约澄清（零 breakage）

### 2.1 契约不变（v0.0.25 rev2 锁定）

```typescript
RunErrorInfo = {
  errorCategory: LlmErrorCategory;   // 枚举值 code（如 'AUTH_INVALID'），不变
  displayReason: string;              // zh-CN 兜底文案，不变（deriveDisplayReason() 函数不动）
  errorDetail?: string;               // raw provider message，不变
}
```

### 2.2 前端行为变更（透明于后端 / AT）

| 字段 | 后端行为（v0.0.59 不变） | 前端行为（v0.0.59 启用 i18n 后） |
|---|---|---|
| `errorCategory` | 后端发枚举值 code | **优先** `localizedDisplayReason()` → `t('error.llm.' + camelCase(errorCategory))` 查 locale 表（`app/web/src/i18n/locales/<lng>/error.json`，**18 个** leaf） |
| `displayReason` | 后端继续发 zh-CN 兜底文案（`deriveDisplayReason()` 不动） | locale 表查到 → 用本地化文案；查不到 → **回退**用此字段值（zh-CN 兜底，与 locale 表 zh-CN 文案一致，无视觉差异） |
| `errorDetail` | 后端发 raw provider message（debug tooltip 用） | 原样直展（不 i18n，属自由文本） |

### 2.3 AT 影响

- **API 层断言不变**：仍可断言 `errorCategory` code / `displayReason` 字段存在（契约未变）。
- **前端 DOM 文案断言（E2E）**：按当前 locale 期望对应文案（PRD §4 路径 P4）。

## 3. 历史偏差修正（原则 12/13：代码静默偏离 spec 最危险）

实施过程 AT designer 实测发现两处历史 spec 偏差，全部回填：

### 3.1 GET /session/:id currentRun.error 出现条件（关键修正）

**原 spec 表述**（v0.0.25 rev2，多处）：
> `GET /session/:id` 响应 `currentRun.error` / 历史 run error 携带 `RunErrorInfo`（eager-drain 落 RunRecord；forked 旁路不落 RunRecord）

**实测**：state=error + eager-drain（currentRunId=null）时响应**无 currentRun/error 字段**。

**修正后表述**：
> `GET /session/:id` 响应 `currentRun.error` **仅在 `state=running` 且 `currentRunId≠null` 时存在**——`state=error` + eager-drain（currentRunId=null）时响应**无 currentRun/error 字段**；error 信息读：
> - **流中实时**：SSE error 事件（`/sse` channel，topic=`agent_loop`）
> - **落库历史**：history run 的 `RunRecord.error`（经 `GET /session/:id/messages` 间接消费）
> - forked 旁路（compact 等）不落 RunRecord，error 仅在 SSE/log

**涉及修正文件**：
- `specs/api/overall/02-llm-chat.md §1 [v0.0.25 rev2 modified]` 第 3 条
- `specs/api/overall/04-agent-session.md §10 路径 C`（AT 实际依据文件，更关键）

**AT case 影响**：原 AT case 若断言「`GET /session/:id` state=error 时响应含 currentRun.error」会 fail——应改读 SSE error 事件或 RunRecord。

### 3.2 LlmErrorCategory 实测 18 值（不是 19）

**原 spec 表述**（v0.0.25 rev2，多处）：
> `LlmErrorCategory` 从 17 → **19 值**（新增 `MAX_TOKENS_TOO_HIGH` / `EMPTY_RESPONSE`）。

**实测**：后端 `app/server/src/llm/caller/display_reason.ts` 的 `DISPLAY_REASON_TABLE` **当前 18 行**（`MAX_TOKENS_TOO_HIGH` 在表中只出现一次，历史 spec 误记为「17 + 2 = 19」）。前端 `error.json` zh-CN/en 各 18 leaf 一一对应。

**修正后表述**：
> LlmErrorCategory 实测 **18 值**。历史 spec 误记为 19（基于「17 行 + rev2 新增 2 个」推算，但 `MAX_TOKENS_TOO_HIGH` 在表中只出现一次，总数为 18）。

**涉及修正文件**：
- `specs/api/overall/02-llm-chat.md §1 [v0.0.25 rev2 modified]` header + `[v0.0.59 modified]` 第 2 条
- `specs/api/overall/04-agent-session.md §10 路径 C`

**AT case 影响**：无（AT 不断言「枚举总数」，只断言具体 category code 存在）。

## 4. 不涉及

- `/chat` / `/provider` / `/provider/:id/model` / `/config/*` 端点：本版本**完全不变**。
- SSE wire event 形状：本版本**完全不变**（前端启用 i18n 是纯前端行为）。
- 后端 locale 链路：本版本**不实现**（displayReason 范式 = 后端发 code、前端查表，后端透明）。
