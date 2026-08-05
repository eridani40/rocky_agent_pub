---
version: v0.0.89
work_block: ③
title: model resolve 抽象 + summaryModelDefault + 保留字 default
status: working
updated: 2026-07-07
---

# 工作块 ③ — model resolve 抽象 + summaryModelDefault + 保留字 default

> 统一 model resolve 链：按 `session × task 类型` 决定 modelId。引入保留字 `default`（=未手动选/跟随默认）；squad 加 `summaryModelDefault`；resolve 不到直接报错。
> 决策来源：req §「关于默认会话模型 & 默认压缩模型」+ design-brief §3 + §6.2。

## 1. 现状（来自 spec）

- **session**：`providerId?` + `modelId?`（均 string? optional）；新建 session 不写两字段 → `undefined`
- **squad**：`modelDefault: string`（必填，per-squad；建队时填）；**无 summaryModelDefault**
- **member.model**：空串 ""=inherit squad.modelDefault；具体 modelId 覆盖
- **resolveProviderModel**（`session-provider-utils.ts:54`）：当前链 = `bodyOverride.modelId ?? member.model ?? squad.modelDefault ?? (兜底取 enabled provider)`
- **compact 路径**（`session-compact.ts:104`）：取 chat 同 model（不区分 summary）
- **validateModelId**（`services/model-validation.ts`）：校验 modelId 是某 enabled provider 的 enabled model

## 2. 目标 — 统一 resolve 链（**N6**）

按 `session 类型 (playground / studio) × task 类型 (chat / summary)` 决定 modelId，统一一张表：

### 2.1 resolve 表

| session 类型 | task | resolve fallback 链（自顶向下，首个命中即用） | 末位兜底 |
|---|---|---|---|
| **playground** | **chat**（普通会话） | `session.modelId`（具体 modelId，非 `default`）→ `app_config.default_models.chat`（**N1**） | resolve 不到 → **报错**（不静默兜底） |
| **playground** | **summary**（compact / forked / skill 整理 / memory 整理） | `app_config.default_models.summary`（**N1**）→ `session.modelId`（具体）→ `app_config.default_models.chat` | 同上 |
| **studio squad chat** | chat | `session.modelId`（具体）→ `squad.modelDefault` | 同上 |
| **studio squad chat** | summary | `squad.summaryModelDefault`（**N4**，新增；空=回退）→ `squad.modelDefault` | 同上 |
| **studio leader/mate session** | chat | `session.modelId`（具体）→ `member.model`（具体或空）→ `squad.modelDefault` | 同上 |
| **studio leader/mate session** | summary | `squad.summaryModelDefault`（空=回退）→ `member.model` → `squad.modelDefault` | 同上 |

> studio session 与 playground session **完全隔离**：studio **绝不**读 `app_config.default_models`，仅读 squad 配置（req：「studio 完全不受 app config 的 playground 默认模型影响」）。

### 2.2 保留字 `default`（**N5**）

- **保留字**：`Session.modelId = "default"` = 「未手动选」
- **行为**：
  - resolve 链遇到 `"default"` → 视为 `undefined`，继续往下一步 fallback
  - 不引入 `none`（与 `default` 同义，代码统一用 `default`）
  - 不引入「显式无模型抛错」语义（之前讨论的 `none` 抛错方案废弃）
- **新建 session 默认值**：`modelId = "default"`（替代当前 `undefined`）
- **resolve 不到的报错**：fallback 链跑完仍无具体 modelId → 抛 `ModelNotConfiguredError`（HTTP 400 给客户端，UI 显「请配置模型后再发起会话」）

### 2.3 不变的兜底逻辑

- `validateModelId`：保持「校验 modelId 是某 enabled provider 的 enabled model」语义
- 对 `"default"` 跳过校验（保留字）
- 具体 modelId 不存在 / disabled → resolve 时按 resolve 链继续（视为无效）

## 3. data model 变更

### 3.1 session（**N5**）

- 字段：`modelId: string \| undefined`（schema 不变）
- 默认值：新建 session 写 `modelId = "default"`（替代当前不写）
- 兼容性：旧 session `modelId = undefined` 视为 `"default"`（resolve 链统一处理 `undefined ?? "default"`，无 schema migration）

### 3.2 squad（**N4**）

- 字段：`summaryModelDefault: string \| undefined`（**新增**，optional）
- 默认值：undefined（=回退 modelDefault）
- API：`POST /squad` / `PUT /squad/:id` 接受 `summaryModelDefault?: string`；UI 在 squad 编辑页加 model picker（可空 + x 清除）
- schema 改：`schema_defs/squad/squad.ts` 加字段（optional）

### 3.3 member（不动）

- `member.model` 沿用现有语义：空串 "" = inherit squad.modelDefault；具体 modelId 覆盖
- resolve 链不动 member.model 三态

## 4. 实现影响（提示 arch / coder）

> 仅列 PRD 视角的实现要点，具体 change_plan 由 arch 产出。

- **新 resolve 函数**（建议 `services/model-resolver.ts` 或扩展 `session-provider-utils.ts`）：
  - 入参：`{ session, squad?, member?, appConfigService, task: 'chat' \| 'summary' }`
  - 出参：`{ providerId, modelId }` 或 throw `ModelNotConfiguredError`
  - 内部按 §2.1 表走 fallback 链
- **调用点改造**：
  - `handlers/session-config.ts:147-160`（buildSessionConfigFromDeps）— task=chat 走新链
  - `session-compact.ts:104`（compact 入口）— task=summary 走新链
  - 任何 forked / skill / memory 整理入口 — task=summary 走新链（由 arch grep 全部入口，PRD 不穷举）
- **validateModelId 改造**：白名单加 `"default"`（不报「invalid modelId」）；具体 modelId 校验保持
- **createSession 改造**：默认 `modelId = "default"`（替代当前不写）

## 5. 错误处理

### 5.1 resolve 不到

- HTTP：`POST /session/:id/chat` / `POST /messages` 收到 `ModelNotConfiguredError` → 400 + 错误体 `{code: "MODEL_NOT_CONFIGURED", message: "请配置模型后再发起会话", detail: {sessionType, task}}`
- UI：chat-input-bar send → 收到 400 → toast「请配置模型后再发起会话」+ 链接到「应用设置 → 模型 → playground 默认模型」（playground）/ 「squad 编辑页」（studio）
- 不静默 fallback 到「首个 enabled provider」（这是当前行为，导致用户不知道模型配错了）

### 5.2 ModelRef 解析失败（具体 modelId 不存在 / disabled）

- 视为 resolve 链该步未命中，继续下一步
- 全部 fallback 跑完仍无 → §5.1 报错

## 6. 关键用户路径（MANDATORY — 测试最低覆盖）

### P7：新建 session `modelId=default` + resolve fallback
- 链路：
  1. 新建 playground session → 看 session record `modelId="default"`
  2. `app_config.default_models.chat` 已配 modelA → 发消息 → LLM 调用用 modelA
  3. 承上 → 清 default_models.chat（写 undefined）→ 新建 session → 发消息 → 报错「请配置模型」
- 关键断言：
  - 新建 session `modelId="default"`（不是 undefined）
  - resolve `"default"` → fallback 到 default_models.chat
  - 全空 → 报错（不静默兜底）
- UC：UC-3.1 + UC-3.2 + UC-3.3

### P8：playground compact 走默认整理模型 fallback 链
- 链路：
  1. `default_models.summary=modelB` → 触发 compact → LLM 调用用 modelB
  2. 清 `default_models.summary` + session.modelId=modelA（用户切过）→ compact → 用 modelA（fallback 第 2 步）
  3. 清 `default_models.summary` + session.modelId="default" + `default_models.chat=modelC` → compact → 用 modelC（fallback 第 3 步）
  4. 全空 → compact → 报错
- 关键断言：
  - summary fallback 链顺序：`default_models.summary → session.modelId(具体) → default_models.chat`
  - "default" 不进 summary fallback 第 2 步（视为 undefined）
- UC：UC-3.4 + UC-3.5 + UC-3.6

### P9：studio squad 配默认整理模型 + 不受 app_config 影响
- 链路：
  1. squad A：`modelDefault=modelX` + `summaryModelDefault=modelY` → studio leader session（member.model=""）→ chat 用 modelX；compact 用 modelY
  2. squad A：清 `summaryModelDefault` → compact → fallback 到 `modelDefault=modelX`
  3. 改 `app_config.default_models.chat=modelZ` → squad A 的 session 行为不变（studio 不读 app_config）
- 关键断言：
  - studio session resolve 仅读 squad 配置 + member.model
  - `summaryModelDefault` 空 → fallback `modelDefault`
  - app_config.default_models 对 studio 完全无效
- UC：UC-3.7 + UC-3.8 + UC-3.9

### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3.1 | 新建 playground session（不发消息）→ GET /session/:id | `session.modelId === "default"` |
| UC-3.2 | 配 `default_models.chat=modelA` → 新建 session → 发消息 → 看 langfuse trace | LLM 调用用 modelA；trace.model = modelA |
| UC-3.3 | 清 `default_models.chat` + 新建 session + session.modelId="default" → 发消息 | HTTP 400 `MODEL_NOT_CONFIGURED`；UI toast「请配置模型后再发起会话」 |
| UC-3.4 | 配 `default_models.summary=modelB` → 触发 session compact → 看 langfuse trace | compact 调用用 modelB |
| UC-3.5 | 清 summary + session.modelId=modelA（切过）→ compact | compact 用 modelA（fallback 第 2 步） |
| UC-3.6 | 清 summary + session.modelId="default" + chat=modelC → compact | compact 用 modelC（fallback 第 3 步） |
| UC-3.7 | 建 squad A：modelDefault=modelX + summaryModelDefault=modelY → leader session chat + compact | chat 用 modelX；compact 用 modelY |
| UC-3.8 | PUT squad A 清 summaryModelDefault → leader session compact | compact 用 modelX（fallback modelDefault） |
| UC-3.9 | 改 `app_config.default_models.chat=modelZ` → squad A leader session 仍 chat 用 modelX | app_config 对 studio 无影响 |
| UC-3.10 | session.modelId="某个 disabled 的 modelId" → 发消息 | resolve 视为无效继续 fallback；fallback 跑完仍无 → 报错（不静默用 disabled） |

## 7. 对齐 ui/tech spec（MANDATORY）

### 7.1 直接复用
- `Member.model` 三态（空=inherit / 具体=覆盖）— `[P1]data_model.md §1.2`
- `squad.modelDefault` 必填 + 建队时填 — `[P1]data_model.md §1.1`
- `validateModelId` 校验 enabled — `services/model-validation.ts`
- `DEFAULT_LLM_REQUEST_CONFIG` 默认回退 — `[P0]app_config.md §3.4`

### 7.2 需 arch 补/改 ui/tech spec
- **N4**（squad += summaryModelDefault）：
  - tech `specs/tech/squad/[P1]data_model.md §1.1` 加字段（optional，空=回退）
  - tech `schema_defs/squad/squad.ts` 加字段
  - api `specs/api/overall/` squad 端点的 body/response 加字段
  - ui `specs/ui/components/studio-page/` squad 编辑页加 model picker（summaryModelDefault）
- **N5**（session += 保留字 default）：
  - tech `specs/tech/agent/session/[P0]session_store.md §2` 末尾加注：`modelId="default"` = 未手动选；新建默认 `"default"`；resolve 时视为 `undefined`
  - tech `services/model-validation.ts`（不在 specs/，由 arch 在 change_plan 列出）白名单加 `"default"`
- **N6**（model resolve 抽象）：
  - tech **新增** `specs/tech/agent/providers_and_models/[P0]model_resolve.md` 或 `specs/tech/agent/session/[P0]model_resolve.md`：定义 resolve 函数签名 + fallback 表 + ModelNotConfiguredError
  - tech `session-config.ts` / `session-compact.ts` 改读新 resolve（arch change_plan 列 grep 点）
- **API 契约**：
  - `POST /squad` / `PUT /squad/:id` body += `summaryModelDefault?: string`
  - `POST /session/:id/chat` 错误体 += `code: "MODEL_NOT_CONFIGURED"`（400）

## 8. 不在本工作块

- UI 模型选择器（chat-input-bar）具体交互 — 工作块 ④
- studio squad 编辑页的 summaryModelDefault picker 视觉 — 由 ui spec 阶段补（不在 PRD 范围）
- forked / skill / memory 各整理入口的逐个改读新 resolve — 由 arch change_plan 列出，本 PRD 仅定义 resolve 函数契约
