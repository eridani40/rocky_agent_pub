# v0.0.30 技术架构变更日志 — dev config 日志开关（4 开关 × 4 日志文件）

> 范围：概念先行 spec（不写业务代码）。来源 `states/v0.0.30/design.md`（已确认设计）。
> 用户豁免 api/e2e 测试，本版仅 UT。

## 1. 变更概览

dev config 新增 `logs` group（4 个 boolean 开关，默认 false），各自独立控制对应调试流量追加写入 `<DATA_DIR>/logs/<type>.log`（JSONL）。新增 LogWriter 模块 + 4 个 hook 点。

## 2. spec 文件变更

### 2.1 修改：`specs/tech/config/[P0]dev_config.md`（2.4 → 2.5）

- **§1 修正 group 集合现状**：澄清「后端 service 无 group 白名单（通用 KV 任意读写），group 的『已知集合』在前端 `DEV_GROUPS` 常量声明」；列当前前端可见 group：`llm_request` + `observability` + `logs`（v0.0.30）。注明早期 spec 列举的 agent/llm/context/runtime/web 在当前前端未实际暴露。
- **§3.6 新增 logs group**：4 boolean key（`enableLlmRequestLog`/`enableToolResultLog`/`enableAppApiLog`/`enableEventLog`，默认 false，可选覆盖语义 `?? false`，非 secret，普通 KV group 非 observability 特殊路由）。UI 走 section-config-layout + key-card（已支持 boolean）。
- **§3.6.1 标注 llm_request 归属**：前端 dev 页的 `llm_request` group 实际是 app_config group（schema 在 app_config §3.4，service `LlmRequestConfigService` 底经 appConfig，路由 `/config/app/llm_request`），前端为 UI 分组放在 dev 页，数据归属 app_config。本版不动归属。
- **§5 消费链补 logs.\*** + 现状说明（agent/llm/context/runtime 消费链在当前前端未暴露，schema 定义保留）。
- **§7 DevConfigService 接口补 `listGroup` / `delete`**（kv-config-handlers 已用、design.md hook 点依赖，原 spec 漏列）。

### 2.2 新增：`specs/tech/dev-logs/[P0]overall.md`（version 1.0）

新模块 spec，覆盖：
- **LogWriter**（`app/server/src/dev-logs/log-writer.ts`）：JSONL 追加 `<DATA_DIR>/logs/{llm,tool,api,event}.log`；启动 ensure 目录；异步不阻塞、失败静默；**零成本门禁在 write 内部**（`devConfig.get('logs', key) ?? false` 早 return，调用方无需判断开关，开关读取保证 UI 改后下次 write 即生效）。
- **4 hook 点契约**：
  - **llm**（→ `logs/llm.log`）：注入 `llm_caller.invoke`，捕获 provider/model/request(messages+params)/response(message+usage 或 error)，**invoke 级一条**（非 attempt 级，避免重试噪音），经 `InvokeContext.logWriter` 透传。
  - **tool**（→ `logs/tool.log`）：注入 `ToolExecutionEngine.executeOne`，捕获 tool(name)/input(arguments)/output(content)+isError，每次工具调用一条，经 `ToolSessionConfigLike.logWriter` 透传。not-allowed 门控分支不写（非真执行）。
  - **api**（→ `logs/api.log`）：注入 `router.handleRequest`，捕获 method/path/status/requestBody/responseBody，每次入站请求一条，从 `BootstrapResult.logWriter` 取。**排除** /sse、/sse/\*、/health（避免噪音/死循环/流式不兼容）。**零开销**：开关 false 时不读 req body（避免 clone 成本）。
  - **event**（→ `logs/event.log`）：emit 是直接 `bus.emit`（不经 hub，散落多处），方案是在 **bootstrap 创建 bus 后、registerTopic 前包一层 wrapBusWithLog proxy**（拦截 emit 写日志 + 委托 inner.emit），覆盖全部 topic 的 bus（agent_loop + session_panel）保证不漏。
- **group 注册**：明确「后端无 group 枚举注册点」，`logs` 注册 = 前端 `DEV_GROUPS` 加一条（后端零改动，kv-config-handlers 通用路径已支持任意 group）。
- **明确不做**：轮转/大小上限/truncate/控制台/查看面板/body 截断（dev feature scope 外，follow-up）。
- **UT 范围**：LogWriter（写正确文件+JSONL+false 不写+append+静默）、零开销门禁、config（默认 false/override/group 出现）、4 hook（on 产正确记录/off no-op）、event bus proxy（拦截+不破坏 sub/replay）。

### 2.3 修改：`specs/ui/components/app-dev-config-page/page-dev-config.md`

- 补 logs group 说明：普通 KV group 路径（非 observability 特化路由），`DEV_GROUPS` 声明 logs + 4 boolean key，挂载/保存同 llm_request 套路，右侧渲染 4 张 key-card（已支持 boolean toggle）。

### 2.4 key-card boolean 现状（无需改）

`component-key-card.md` + `.tsx` **已支持 boolean**（`KeyInfo.type` 枚举含 `'boolean'`，tsx 按类型路由到 `key-boolean` 按钮，aria-pressed + 开/关 文案 + onClick 翻转）。**无需补 boolean 渲染**，logs group 4 个 boolean key 直接复用现有 key-card。

## 3. 关键设计决策（Why）

1. **零成本门禁在 LogWriter.write 内部，不在调用方**：调用方（4 hook）直接 `logWriter.write(...)` 无需判断开关，hook 代码干净；门禁集中在 write 一处（`?? false` 早 return），开关读取是本地 KV O(1)，每请求一次可接受；保证 UI 改开关后下次 write 即生效（无需重启、无需热更新订阅）。
2. **event hook 用 bus proxy 而非改 emit 调用点**：emit 直接调 `bus.emit` 散落在 agent-manager/agent-loop-stage-llm/abort-finalize/session-clear-op 多处，逐一改易漏。bus 实例创建集中在 bootstrap，包一层 wrapBusWithLog proxy 一次覆盖全部 topic 的 bus，且不破坏 sub/replay/cancel 语义（仅拦截 emit 委托 inner）。
3. **llm hook 在 invoke 级而非 attempt 级**：attempt 重试是 LLM 调用内部细节（最多 N 次），dev 日志关心一次逻辑 LLM 调用的最终结果，invoke 级一条更清晰（attempt 级 observability 已由 langfuse 覆盖）。
4. **api hook 排除 /sse 与 /health**：SSE 是长连接流（不适用 req/resp JSON 模型，且每帧一条会爆量）；health 是高频探活无业务含义。
5. **group 注册在前端 DEV_GROUPS**：澄清 design.md 的「group 枚举代码需注册」——后端无注册点（service 通用 KV），注册就是前端常量加一条，后端零改动。

## 4. 与 design.md 一致性

- 4 个开关 + 4 个文件名 + 字段：✅ 对齐（design.md §2 表）。
- LogWriter 位置 `app/server/src/dev-logs/` + JSONL + append + 静默 + 零开销门禁：✅ 对齐（design.md §3）。
- 4 hook 位置：✅ 对齐（design.md §4），并细化到具体函数（invoke / executeOne / handleRequest / bus proxy）。
- UI 复用 section-config-layout + key-card：✅ 对齐（design.md §5），且确认 key-card 已支持 boolean 无需补。

## 5. 需 orchestrator/coder 注意

- **dev_config.md §1/§5 现状修正**是 architect 主动发现的 spec 过时（早期列举的 agent/llm/context/runtime/web group 在当前前端未暴露），已修正对齐代码现状。coder 实现 logs group 时以「前端 DEV_GROUPS 加 logs 条 + 后端零改动」为准，不要被旧 spec 的 group 集合列举误导。
- **body 截断本版不做**：design.md 未提截断，spec §6 明确不做。若 LLM messages / tool output 过大导致日志文件膨胀，用户自行关开关 + 删文件（dev feature 接受此权衡）。
- **event bus proxy 注入需改 bootstrap**：coder 需在 bootstrap 创建 bus 处加 wrapBusWithLog（影响 agent_loop + session_panel 两个 bus），注意 proxy 不破坏现有 sub/replay/cancel 行为（UT 必须覆盖）。
