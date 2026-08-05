# v0.0.62.i18n_migration API 变更说明

> version: 1.0 · 2026-07-04
> 一句话：i18n 迁移 Batch 2 的 API 层影响——契约**全部不变**（端点形状 / 字段类型 / 错误码全不改），仅补充两个「行为不变但语义需文档化」的点：BUG-001 POST titled 副作用 + manifest description 占位符协议。
> 概念权威源：`specs/tech/i18n/` KB（`[P1]manifest_i18n.md` + `[P0]i18n_overview.md §8`）。
> PRD：`specs/prd/version_logs/v0.0.62.i18n_migration.md`。

## 1. API 契约不变（零 breakage 全清单）

| 域 | 端点 / 字段 | v0.0.62 状态 | 备注 |
|---|---|---|---|
| chat SSE | `Run.stopReason`（7 enum）/ `RunErrorInfo.errorCategory`（18 enum） | 字面量 + code 集合**全不变** | 前端查 locale 表是纯前端行为（透明于后端/AT） |
| session HTTP | `POST /session` / `POST /session/:id/messages` / `PUT /session/:id` / `GET /session/:id` | 形状全不变 | 仅 POST body.title 时 `titled` 字段值从 lazy `false` 变实际 `true`（bool 仍 bool，零 breakage） |
| session schema | `Session.title: string` / `Session.titled: boolean` | 类型全不变 | titled 是 lazy 默认 false（v0.0.47），POST 路径补置 true 后响应 body 该字段从 false 变 true |
| plugin inventory | `GET /config/plugin` 三级 description（plugin/point/impl）+ schemaConfig description + 顶层 plugins[].label/desc | 字段名 + 类型（string）**全不变** | 值从字面文案 → `__MSG_<key>__` 占位符；旧 caller 直接读仍工作（看到 `__MSG_...__` 字面） |
| HTTP 错误体 | 4xx/5xx `{ error: msg }` | 不变（归硬边界原样直展） | 实测无机器可读 `code` 字段；本地化需新引入 code 字段（不在本版本） |

## 2. 变更点 1：POST /session body.title → titled=true（BUG-001 修复）

**端点**：`POST /session`（`specs/api/overall/04-agent-session.md §2.1`）

**问题**：v0.0.47 引入 `titled` 字段时，PUT /session/:id body.title 路径同步置 titled=true（防 AI 名覆盖），但 POST /session body.title 路径漏写。结果：用户创建 session 时带 title 字段（即「用户主动命名」），titled 仍是 lazy 默认 false，AI 后续 auto-naming 会 CAS 误判「未命名」覆盖用户字面。

**修复**：`app/server/src/handlers/session.ts:139-150` POST handler 在 `createSession` 之后（紧跟）调 `updateSession(id, { titled: true })`，对齐同文件 PUT:185-193 行为。

```typescript
// session.ts POST handler（v0.0.62 修复后）
const created = await deps.store.createSession({ id, title: body.title ?? '新会话', /* ... */ });
// [v0.0.62 i18n BUG-001] body.title 时同步置 titled=true（对齐 PUT:185-193）
if (body.title !== undefined) {
  await deps.store.updateSession(id, { titled: true });
  const updated = await deps.store.getSession(id);
  return json(201, updated ?? created);
}
return json(201, created);
```

**契约影响**：
- 端点形状不变（仍 201 + Session）
- 字段类型不变（titled 仍 boolean）
- 仅响应 body 的 `titled` 字段值：用户传 body.title 时从 lazy false 变 true（实际值）
- 旧 caller（不读 titled）零影响；新 caller（前端 i18n 用 titled===false 渲染 default title）行为正确化

**AT 覆盖**：`tests/api/i18n/session_titled_signal_tc1`（PASS）—— POST /session with title → 201 响应 titled===true；POST /session 无 title → 201 响应 titled===false。

## 3. 变更点 2：plugin inventory description 字段值（占位符协议）

**端点**：`GET /config/plugin`（`specs/api/overall/03-config-center.md §3.1`）

**变更**：3 路描述字段（plugin `label/description` / `pointDescription` / `description` impl 级）+ `schemaConfig.<key>.description` + 顶层 `plugins[].label/description`——builtin 部分的值从字面中文改为 `__MSG_<dotted.key>__` 占位符。

**契约影响**：
- 字段名 + 类型（string）全不变
- 后端 inventory-builder.ts 透传 string 不解占位符（符合 `[P0]i18n_overview.md §6` 后端不 locale 决策）
- 前端组件经 `resolveI18nField(value, t)` helper 翻译（识别 `__MSG_` → `t()` 查 plugin-config ns locale 表、否则直展原文）
- 旧 caller（不调 resolveI18nField）直接读字面值会看到 `__MSG_...__` 字面而非本地化文案（但 string 仍是合法 string，无 schema 违规）；builtin plugin 调用方都已接入 helper
- 第三方/老 plugin 字面值由 helper 直展兼容（fallback 路径）

**实测覆盖范围**：
- 3 builtin plugin（llm_anthropic / zhipu_web_search / rocky_context）的 manifest.json：label/description/extImpls[].description 共 67 占位符
- 12 内置 EP description（extension-point.ts）：`__MSG_extpoint.<id>.description__`
- ~14 schemaConfig description 占位符
- 前端 `plugin-config.json` zh-CN+en 各 106 leaf 覆盖全部

**AT 覆盖**：`tests/api/i18n/plugin_inventory_placeholder_tc1`（PASS，含 BUG-002 修复后）—— GET /config/plugin 响应三级 description 断言含 `__MSG_` 占位符。

## 4. AT case 套件（6/6 PASS = 100%）

| case_id | 域 | 验证 | 结果 |
|---|---|---|---|
| `i18n/plugin_inventory_placeholder_tc1` | plugin inventory | GET /config/plugin 三级 description + schemaConfig 占位符化 | PASS（BUG-002 修复后） |
| `i18n/session_titled_signal_tc1` | session | POST /session with title → titled=true；无 title → titled=false | PASS（BUG-001 修复后） |
| `i18n/type_code_enum_stable_tc1` | SSE chat | Run.stopReason / errorCategory enum 集合稳定 | PASS |
| `i18n/description_three_level_tc1` | plugin inventory | 三级 description 透传字段稳定 | PASS（适配占位符化后） |
| `i18n/display_reason_tc1` | SSE chat | errorCategory code + displayReason 兜底契约 | PASS（回归 v0.0.59） |
| `i18n/locale_config_tc1` | config | app_config.locale.language GET/PUT | PASS（回归 v0.0.59） |

## 5. 跨 KB 协同

- `specs/tech/i18n/[P0]i18n_overview.md §8`（displayReason 范式样板，零 API breakage）
- `specs/tech/i18n/[P1]manifest_i18n.md`（manifest 占位符协议 + resolveI18nField helper 契约）
- `specs/tech/i18n/index.md §⑥`（type code 跨版本累积映射表）
- `specs/tech/agent/auto_naming/[P0]auto_naming_service.md §6`（POST/PUT title 路径协作）
- `specs/prd/version_logs/v0.0.62.i18n_migration.md`（PRD M3+M5 范围）
