---
version: v0.0.89
slug: ui_opt
title: 配置优化 — squad summaryModelDefault + session 保留字 default + dev_config 废弃
status: working
updated: 2026-07-07
---

# v0.0.89 API 增量记录

> 本版本 API 契约变更（黑盒断言依据）。`specs/api/overall/` 同步由 doc-modifier 阶段 5 处理；本文为版本增量（design intent frozen at architecture）。
> 引用：PRD `specs/prd/version_logs/v0.0.89/03-model-resolver.md` + `04-model-picker-migration.md` + `05-dev-to-app-migration.md`。
> Method 级改动合同见 `specs/tech/version_logs/v0.0.89/change_plan.md`（C/D/E/M 段）。

## 1. 新增端点

### 1.1 `PUT /config/app/sub_agent_templates`（迁自 `/config/dev`）

- **方法**：PUT
- **路径**：`/config/app/sub_agent_templates`（精确匹配，在 `/config/app` 通用 KV 之前注册）
- **请求体**：同既有 `/config/dev` PUT 形态（`{group:"sub_agent_templates", items:[{key,data},...]}` 或 `{group, key, data}`）
- **响应**：`200 { ok: true }` 或 `403 { error: "builtin_readonly" }`（builtin explorer 模板保护）或 `400`
- **行为**：builtin 保护逻辑保留（新建禁止 builtin:true、改 builtin 模板拒 403）；secret redact 路径不变
- **约束**：MUST 与 `/config/app` 通用 KV 路径协调（sub_agent_templates 优先匹配）；MUST builtin 保护原子（任一 item 命中即整体拒）
- **参考**：specs/api/overall/10-multi-agent.md §5.2；PRD 05 §3.1.C

### 1.2 `DELETE /config/app/sub_agent_templates`

- **方法**：DELETE
- **路径**：`/config/app/sub_agent_templates`
- **请求体**：`{group:"sub_agent_templates", key:<templateName>}`
- **响应**：`200 { ok: true }` / `403 { error: "builtin_readonly" }` / `403 { error: "group_not_deletable" }`（非 sub_agent_templates group 拒）/ `404`
- **行为**：仅 sub_agent_templates group 允许 DELETE（其它 group 拒 group_not_deletable）；builtin:true 拒
- **参考**：specs/api/overall/10-multi-agent.md §5.3；PRD 05 §3.1.C

## 2. 变更端点

### 2.1 `POST /squad` / `PATCH /squad/:id` — 加 summaryModelDefault

- **body**（POST + PATCH）：增 `summaryModelDefault?: string`
  - 字符串值 = 具体 ModelRef（如 `"<providerId>:<modelId>"` 或仅 modelId，与 modelDefault 同形态）
  - `undefined` / 缺省 = 未配（PATCH 不传该字段 = 不修改）
  - 空串 `""` = 显式清空（写 undefined）
  - 保留字 `"default"` = 放行（与 session.modelId 保留字语义一致，但 squad 层无「跟随」概念，等同 undefined）
- **响应**（SquadDetail）：必含 `summaryModelDefault: string | undefined`（即便未配也回显 undefined，不省字段）
- **校验**：具体 modelId 走 validateModelId（保留字 default 放行）
- **约束**：MUST PATCH 可单独清 summaryModelDefault（不影响 modelDefault）；MUST NOT 默认值兜底
- **参考**：specs/api/overall/11a-squad-endpoints.md §1.1/§1.4；PRD 03 §3.2

### 2.2 `GET /squad/:id` — SquadDetail 含 summaryModelDefault

- **响应**：增 `summaryModelDefault: string | undefined`
- **参考**：specs/api/overall/11a-squad-endpoints.md §1.3

### 2.3 `POST /session/:id/chat` / `POST /session/:id/messages` / `POST /session/:id/run` — 错误体加 MODEL_NOT_CONFIGURED

- **错误响应**（HTTP 400）：
  ```json
  {
    "code": "MODEL_NOT_CONFIGURED",
    "message": "请配置模型后再发起会话",
    "detail": { "sessionType": "playground" | "studio", "task": "chat" | "summary" }
  }
  ```
- **触发条件**：resolveModel fallback 链跑完仍无具体 modelId（playground: default_models.chat 未配 + session.modelId=default；studio: squad.modelDefault 空 + member.model 空）
- **约束**：MUST 不静默 fallback 到首个 enabled provider；MUST 错误体含 code/message/detail 三字段
- **参考**：specs/api/overall/02-llm-chat.md §5；PRD 03 §5.1

### 2.4 `POST /session` / `PUT /session/:id` — modelId 接受保留字 `"default"`

- **body.modelId**：接受
  - 具体 modelId（如 `"gpt-4o"`）— 走既有校验
  - `"default"` — 保留字放行（不查 provider 命中），落盘 `"default"`
  - `"none"` — 等价 `"default"`（落盘 `"default"`）
  - `undefined`（仅 PUT）— 不修改
- **POST 默认值**：body.modelId 缺省 → 落 `"default"`（替代当前不写）
- **约束**：MUST validateModelId 短路保留字；MUST NOT 校验保留字时查 provider
- **参考**：specs/api/overall/02-llm-chat.md；PRD 03 §2.2 + §3.1 + §4

### 2.5 `GET/PUT /config/app?group=appearance` — appearance group 含 language

- **GET 响应 items[]**：原 `[{key:"theme", data:"dark"}, {key:"density", ...}]` 增 `[{key:"language", data:"zh-CN"}]`（迁自 locale group）
- **PUT items[]**：客户端须 read-modify-write（GET → 改 language 或 theme → PUT 整组），避免覆盖
- **约束**：MUST language 切即生效语义保持（前端 changeLanguage 调 PUT 后不等页面 dirty 流）
- **参考**：PRD 01 §4；specs/tech/i18n/[P0]i18n_overview.md §5.4

### 2.6 `GET /config/app?group=<迁来的 dev group>` — 数据源切换

- **影响 group**：`logs` / `runtime`（含 observability）/ `web` / `sub_agent_templates` / `agent` / `context`
- **路径**：从 `/config/dev?group=X` → `/config/app?group=X`（group/key 名零变更）
- **secret redact**：observability.secretKey / web.jinaApiKey 仍 redact 出参 `"***"` + 占位 merge 入参
- **约束**：MUST 旧 `/config/dev` 路由全删（返 404）；MUST secret 字段处理不变
- **参考**：PRD 05 §2 表 + §3.1.E

## 3. 废弃端点

### 3.1 `/config/dev` 全部方法

- `GET /config/dev?group=...` → 废弃（404）
- `PUT /config/dev` → 废弃
- `DELETE /config/dev` → 废弃（迁移到 `/config/app/sub_agent_templates`）
- **替代**：所有 group 改走 `/config/app?group=...`；sub_agent_templates DELETE 改 `/config/app/sub_agent_templates`
- **参考**：PRD 05 §3.1.C/E

## 4. 数据契约断言要点（API test designer 用）

- `POST /squad` 不传 `summaryModelDefault` → 响应 `summaryModelDefault === undefined`
- `PATCH /squad/:id` body `{summaryModelDefault: "providerA:gpt-4o"}` → 响应 `summaryModelDefault === "providerA:gpt-4o"`，且 `modelDefault` 不变
- `PATCH /squad/:id` body `{summaryModelDefault: ""}` → 响应 `summaryModelDefault === undefined`（清空）
- `POST /session` body 不含 `modelId` → GET 响应 `modelId === "default"`
- `POST /session/:id/chat`（session.modelId=default + 无 default_models.chat + 无 enabled provider 默认匹配）→ 400 `{code:"MODEL_NOT_CONFIGURED"}`
- `GET /config/app?group=appearance` → items 含 theme + language 两 key
- `PUT /config/app?group=appearance` body 仅含 theme（漏 language）→ 应不覆盖 language（read-modify-write 契约由前端保证，后端 setGroup 整组覆盖；AT 验证前端实现正确性）
- `DELETE /config/app/sub_agent_templates` body `{group:"sub_agent_templates", key:"explorer"}` → 403 `{error:"builtin_readonly"}`
- `DELETE /config/app/sub_agent_templates` body `{group:"logs", key:"enableLlmRequestLog"}` → 403 `{error:"group_not_deletable"}`
- `GET /config/dev?group=logs` → 404

## 5. 与 change_plan.md 的对应

| API 变更 | change_plan 段 | 实现文件 |
|---|---|---|
| `/config/app/sub_agent_templates` PUT/DELETE | E 段 | router.ts + app-config-template-handlers.ts |
| squad summaryModelDefault | C/D 段 | handlers/squad.ts + services/squad-service.ts |
| MODEL_NOT_CONFIGURED | B/C 段 | services/model-resolver.ts + handlers/session-{messages,run,compact}.ts |
| session.modelId 保留字 | C 段 | handlers/session.ts + services/model-validation.ts |
| appearance group 含 language | G 段 | app/web/src/i18n/change-language.ts + locale-init.ts |
| `/config/dev` 废弃 | E 段 | router.ts |
