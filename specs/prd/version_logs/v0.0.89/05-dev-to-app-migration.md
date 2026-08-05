---
version: v0.0.89
work_block: ⑤
title: dev→app 迁移 + 废弃 dev_config
status: working
updated: 2026-07-07
---

# 工作块 ⑤ — dev→app 迁移 + 废弃 dev_config

> 把 dev_config 全部活跃数据一次性迁入 app_config，迁移完删 dev_config entity / service / 路由 / 落盘目录；用户手动执行删除脚本（merge 后）。
> 决策来源：req §「所有配置融入 app config表，废弃dev config」+ design-brief §4 + §6.7。

## 1. 现状（来自 spec）

- **dev_config 活跃 group**（前端 `DEV_GROUPS` + schema 保留）：
  - `llm_request`（前端 dev group，schema 实际属 app_config — 见 `[P0]dev_config.md §3.6.1`，**已部分迁移**）
  - `runtime/observability`（list-of-objects，`spec §3.9.8`）
  - `logs`（4 boolean）
  - `agent`（schema 保留，前端未暴露，落盘空但代码读 `agent.maxIterations`）
  - `context`（schema 保留，前端未暴露，代码读 `context.maxOutputTokens`）
  - `web`（jina 三 key）
  - `sub_agent_templates`（explorer builtin + 用户模板，**专属 handler** `dev-config-template-handlers.ts` + builtin 保护逻辑）
- **死数据**：`dev_config/llm_request/{stall_timeout_s,max_retry_times}`（v0.0.25 前遗留，代码零引用 — 真配置在 `app_config/llm_request/default`）
- **service**：`DevConfigService`（`app/server/src/config/dev-config-service.ts`）+ 共享基类 `kv-config-service.ts`（与 AppConfigService 共用）
- **handler**：`handlers/kv-config-handlers.ts`（dev 路由）+ `handlers/dev-config-template-handlers.ts`（sub_agent_templates 专属）
- **schema**：`schema_defs/dev_config/`
- **落盘目录**：`dev_config/{group}/<id>.json`

## 2. 迁移映射（命名零冲突直迁）

| dev_config group/key | → app_config | 备注 |
|---|---|---|
| `logs`（4 bool） | `logs`（同 group 同 key） | 直迁；UI 走「可观测性 tab → 日志 group」 |
| `runtime/observability` | `runtime/observability`（同 group 同 key） | secret 保护（secretKey redact 出参 + 占位 merge 入参，与现有 dev_config 同套路） |
| `sub_agent_templates`（explorer + 用户模板） | `sub_agent_templates`（同 group 同 key） | **保留专属 handler 逻辑**：builtin 保护 + 仅它允许 DELETE；handler 改读 app_config |
| `web`（jina 三 key） | `web`（同 group 同 key） | 直迁；jinaApiKey secret 处理同 observability |
| `context`（落盘空，代码读） | `context`（同 group 同 key） | 落盘仍空；代码读路径改 `appConfigService.get("context", ...)` |
| `agent`（落盘空，代码读） | `agent`（同 group 同 key） | 同上 |
| `llm_request`（dev_config/llm_request/{stall_timeout_s,max_retry_times}） | **丢弃** | v0.0.25 前死数据，代码零引用；真配置在 `app_config/llm_request/default` |

> **外观合并**（`locale` group → `appearance` group）属工作块 ① §4，不在此处（locale 本就在 app_config，只是 group 名变更）。

## 3. 迁移流程

### 3.1 代码侧改造（本版本承担）

> 由 arch 在 change_plan 列 method 级改动；本 PRD 仅列 PRD 视角的契约面。

#### A. schema 迁移
- 删 `schema_defs/dev_config/`
- 把 dev_config 的 6 个 group（logs/runtime/sub_agent_templates/web/context/agent）的 schema 形态（data shape）补到 `schema_defs/app_config/`（如已有则保持；如无新增文件）

#### B. service 迁移
- 删 `DevConfigService`（`dev-config-service.ts`）
- 共享基类 `kv-config-service.ts` 不动（AppConfigService 继承）
- 删 `services/dev/`（如有独立 service）

#### C. handler 迁移
- 删 `handlers/kv-config-handlers.ts` 中 dev 相关路由（`/config/dev` GET/PUT）
- `dev-config-template-handlers.ts` 改名 `app-config-template-handlers.ts`，路由从 `/config/dev/sub_agent_templates` 改 `/config/app/sub_agent_templates`；逻辑不变（builtin 保护 + 仅它允许 DELETE）
- 删 `services/dev-config-observability-service.ts`（如存在独立 observability service）— observability 数据读路径改 `appConfigService.get("runtime", "observability")`

#### D. 消费方改读（关键）
- 所有 `devConfigService.get(...)` 改 `appConfigService.get(...)`（arch grep 全部点，PRD 不穷举）
- 重点消费方（来自 `[P0]dev_config.md §5`）：
  - `agent.maxIterations` / `agent.doomLoopThreshold`：消费方 `?? CODE_DEFAULT`
  - `context.autoCompactThreshold` / `context.maxOutputTokens`：消费方 `?? CODE_DEFAULT`
  - `runtime.observability`：bootstrap 构造 `ObservabilityManager`
  - `web.jinaApiKey` / `web.jinaEnabled` / `web.jinaTimeoutMs`：web_fetch 工具
  - `logs.enableLlmRequestLog` 等 4 个：LogWriter 模块
- secret 字段处理不变（落盘原值、API 出参 redact、PUT 占位 merge）

#### E. 前端改读
- 删 `page-dev-config.tsx`（整个 dev 配置页废弃）
- `DEV_GROUPS` 常量删除（已无 dev 页面）
- 应用设置合并页 sidebar 删 dev config 区域（仅留「可观测性 + 插件」两 tab，其中可观测性 group 数据源改 app_config）
- 删 dev 路由相关 view id（如 `'settings-dev'` — v0.0.47 已合并到 `'settings-app'`，但代码可能有残留）

### 3.2 数据迁移脚本（merge 后用户执行）

> PRD 只描述脚本行为契约；具体脚本由 coder 在 dev_config 删除前提供（放 `scripts/` 目录，文件名建议 `migrate-dev-to-app.v0.0.89.sh`）。

#### 输入
- `<DATA_DIR>`（默认 `<cwd>/data/`）
- 自动找 `dev_config/{group}/*.json` 全部文件

#### 行为
1. 遍历 `dev_config/{group}/*.json`，对每条 record：
   - 跳过 `llm_request` group 的两条死数据（`stall_timeout_s` / `max_retry_times`）— log warn 后丢弃
   - 其他 record：复制到 `app_config/{group}/`，**保持 id 和 key 不变**（直接拷文件，因 ULID 全局唯一 + group 名零冲突）
2. 验证：每条迁移后 record 在 app_config 下存在；dev 下原文件保留（脚本不删 dev，由用户验证后手动删）
3. 输出 summary：`migrated: N records, skipped: 2 dead records, failed: 0`

#### 用户执行步骤（merge 后）
```bash
# 1. 启动应用一次，触发 bootstrap 校验（确认无错误）
# 2. 运行迁移脚本
bash scripts/migrate-dev-to-app.v0.0.89.sh [DATA_DIR]
# 3. 验证应用设置页能正确显示迁过来的配置（observability / logs / web / sub_agent_templates）
# 4. 验证通过后手动删除 dev_config 目录
rm -rf <DATA_DIR>/dev_config
```

#### 失败处理
- 任何一条迁移失败 → 脚本 rollback 已迁移的 app_config 文件（按 copy log 反向删）+ exit 1
- 跑前自动 backup dev_config 到 `dev_config.backup-<timestamp>/`

## 4. 关键用户路径（MANDATORY — 测试最低覆盖）

### P10：dev→app 迁移后消费方读 app_config 正确
- 链路：
  1. 升级前：dev_config 有 `runtime/observability` (langfuse 配置) + `logs/enableLlmRequestLog=true` + `web/jinaApiKey=xxx` + `sub_agent_templates/explorer`
  2. 升级（合并分支）→ 应用启动（旧 dev_config 落盘仍在）
  3. 跑迁移脚本 → 看 `app_config/runtime/observability/...json` 等 4 类文件出现
  4. 应用设置页 → 可观测性 tab → 看到 langfuse 配置（数据未丢）；日志 group → enableLlmRequestLog 开关 on
  5. 触发 LLM 调用 → langfuse trace 出现（manager 读 app_config.runtime.observability 正确）
  6. 触发 web_fetch → 用 jinaApiKey=xxx（web_fetch 读 app_config.web 正确）
  7. studio 派生 subagent → explorer 模板可用（sub_agent_templates 读 app_config 正确）
- 关键断言：
  - 4 类 record 迁移后 id 不变（直接拷文件）
  - 消费方读 app_config 正常工作（无 `?? CODE_DEFAULT` 兜底命中 — 因 record 已存在）
  - observability secret 字段 redact 不破（迁后 GET 仍 `"***"`）
  - sub_agent_templates builtin 保护逻辑仍生效（DELETE explorer 返 403）

### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-5.1 | 升级前 dev_config 有 `runtime/observability` (2 项 langfuse) → 升级 → 跑迁移 → 应用设置 → 可观测性 tab | 2 项 langfuse 配置显示在「可观测性 tab → langfuse group」列表；secretKey redact 仍 `"***"` |
| UC-5.2 | 升级前 dev_config 有 `logs/enableToolResultLog=true` → 跑迁移 → 应用设置 → 日志 group | 4 个 toggle 显示，enableToolResultLog=on；其他 3 个=off（默认） |
| UC-5.3 | 升级前 dev_config 有 `web/jinaApiKey=xxx` → 跑迁移 → 触发 web_fetch → 看 jina 调用 header | Authorization Bearer xxx（jinaApiKey 读 app_config.web 正确） |
| UC-5.4 | 升级前 dev_config 有 `sub_agent_templates/explorer` (builtin) + 用户模板 → 跑迁移 → DELETE 用户模板 → DELETE explorer | 用户模板可删；explorer DELETE 返 403（builtin 保护生效） |
| UC-5.5 | 升级前 dev_config 有 `llm_request/stall_timeout_s` 死数据 → 跑迁移 → 看 log | log warn「skipped dead record: dev_config/llm_request/stall_timeout_s」；该 record 不进 app_config |
| UC-5.6 | 升级前 dev_config 有 `agent/maxIterations=30` → 跑迁移 → 应用启动 → 看 session maxIterations | session 用 maxIterations=30（读 app_config.agent 正确，不回退 CODE_DEFAULT=25） |
| UC-5.7 | 迁移脚本跑完 → 用户手动 `rm -rf dev_config` → 重启应用 | 应用启动无错（无 dev_config 找不到的报错）；所有配置仍可用（已迁 app_config） |
| UC-5.8 | 跑迁移脚本前 backup → 跑失败（如某 record 已存在 app_config）→ rollback | app_config 内已迁移文件被清；dev_config 保留；脚本 exit 1 + 输出失败 record |

## 5. 对齐 ui/tech spec（MANDATORY）

### 5.1 直接复用
- AppConfigService 通用 KV（`[P0]app_config.md §5`）
- setGroup 原子提交
- secret 字段 redact 出参 + 占位 merge 入参（observability secretKey / web jinaApiKey，已有 dev_config 套路）
- sub_agent_templates builtin 保护（`dev-config-template-handlers.ts` 既有逻辑）

### 5.2 需 arch 补/改 ui/tech spec
- **N2**（迁组集合）：
  - tech `specs/tech/config/[P0]app_config.md` §3 加新 group shape：
    - `logs`（4 boolean，迁自 dev_config）
    - `runtime/observability`（list-of-objects，迁自 dev_config；schema 与 `[P0]dev_config.md §3.4.1` 一致）
    - `web`（jina 三 key，迁自 dev_config；schema 与 `[P0]dev_config.md §3.5` 一致）
    - `sub_agent_templates`（explorer + 用户模板）
    - `agent` / `context`（落盘空，消费方读路径改 app_config）
  - tech `specs/tech/config/[P0]app_config.md §3.4` 末尾「group 集合」改为：`{ appearance, providers, locale(deprecated), llm_request, user_memory, web_search, default_models(new), logs, runtime, web, sub_agent_templates, agent, context }`
  - tech `specs/tech/config/[P0]dev_config.md` 整体标 deprecated 后删（或保留作历史 spec，正文加 ⚠️ DEPRECATED）
  - tech `specs/tech/config/index.md` 更新（删 DevConfig 行 / 加 AppConfig 新 group 导航）
- **handler 改名**：
  - api `specs/api/overall/` 中 dev 相关路由（`/config/dev/*`）全部废弃；`sub_agent_templates` 路由改 `/config/app/sub_agent_templates/*`；secret 处理套路不变
  - ui `specs/ui/components/app-dev-config-page/page-dev-config.md` 标 deprecated 后删
- **消费方契约**：
  - 各消费 spec（observability_manager / web_fetch_tool / dev-logs / context_engine / agent_loop / sub_agent_templates）中 `devConfigService.get(...)` 改 `appConfigService.get(...)`（doc-modifier 阶段 5 统一改）

## 6. 不在本工作块

- 迁移脚本具体实现（coder 阶段产出，PRD 仅定行为契约）
- 数据备份策略细节（脚本自带 backup，用户操作步骤已含）
- 旧 dev_config 目录删除的自动时机（req：「删除动作你只需准备好脚本，merge后我会让你执行的」— 用户手动）

## 7. 风险

| 风险 | 缓解 |
|---|---|
| 消费方漏改读路径（仍读 devConfigService） → 数据迁了但代码看不到 → 回退默认 | arch change_plan 用 grep 全列消费点；coder 逐个改 + UT；AT 用真实落盘 dev_config 数据跑迁移后验证消费方读 app_config |
| sub_agent_templates handler 改名时 builtin 保护逻辑漏改 → 模板可被删 | AT 覆盖 DELETE builtin explorer 返 403（UC-5.4） |
| observability manager 重启时机：迁移完不重启 → manager 仍持旧 client | UI 提示「重启生效」（沿用 `[P0]dev_config.md §3.4.1` 既有「配置不热更新」契约）；用户重启后 manager 重读 app_config |
| secret 字段在迁移中泄露到 log | 脚本迁移时 log 仅 record id，不 log data；secret 落盘仍原值（与 dev_config 同等级别） |
| dev_config/llm_request 死数据误迁移 → 覆盖 app_config/llm_request/default | 脚本显式 skip 该 group + log warn（UC-5.5） |
