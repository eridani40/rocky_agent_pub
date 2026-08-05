# v0.0.3 功能详拆（features） — Provider/Model 管理 + Config 三域

> version: 1.2 · 引入版本 v0.0.3 · 最后更新：2026-06-20（v0.0.5 标注）
> 本文是 `03-llm-chat.md` 的 §3 功能需求补充，承载 §3.5–§3.8。主文件 §3.1（chat 流式）/ §3.4（plugin 内核）已在主文件详述，此处不重复。
> **v0.0.4 修订**：§3.5 provider/model UI 入口挪 app 设置页；§3.7 设置 UI 拆分（app 加 providers 区 / 插件页改 ext impls）；新增 §3.8 EP.group 必填 + inventory group-centric。
> **v0.0.5 取代**：§3.7（设置 UI）+ §3.8（EP.group，扩展为 ext type 分化）已被 **`04-config-center-ui.md` §3.9 全面取代**（三栏化 / 两 tab / exclusive-list-ordered / schema 弹层 / plugin 开关独立修 bug）。下文 §3.7 / §3.8 仅作历史快照保留，现行需求以 `04-config-center-ui.md` 为准。

## 目录

| 章节 | 说明 |
|------|------|
| §3.5 Provider / Model 管理 | 添加 provider / 添加 model / chat 选 model（v0.0.4 UI 入口挪 app 设置页） |
| §3.6 Config Service | AppConfig / PluginConfig 落地（DevConfig v0.0.3 落地、v0.0.89 废弃并入 AppConfig） |
| §3.7 设置 UI | app（含 providers 区）/ plugin（纯 ext impls group 分区）/ dev 三个设置页 |
| §3.8 Extension Point.group + Inventory group-centric [v0.0.4] | EP.group 必填；inventory 按 group 聚合 |
| §3.9 LLM 调用错误处理 / 自适应重试 [v0.0.25] | backend-only：LLM 调用层错误归一化 + adaptive retry + provider 降级 + 分阶段超时 + length 处理 |

---

## 3.5 Provider / Model 管理 [v0.0.3] [v0.0.4 modified]

**描述**：用户添加 provider 实例（anthropic_compatible + apiKey/baseURL），在 provider 下添加 model 实例（选 message 协议即 anthropic_messages），chat 界面可选该 model 发对话。
**优先级**：P0
**用户故事**：作为用户，我希望能配置自己的 LLM provider/model，以便 chat 调用我自己的 API key 和模型。

**期望行为**：
- **数据归属**：provider/model 实例数据是 **app_config 数据**（spec config §6 权威）。一条 provider 实例 = app_config `providers` group 一条 record，其 `data` 形如 `{ id, name(ProviderName=anthropic_compatible), baseUrl, credentials: { key }, pluginId, enabled, models[] }`；model 嵌套在 `models[]` 数组里，形如 `{ modelId, protocolId, ... }`。
- **UI 入口 [v0.0.4 modified]**：**app 设置页** providers 区（v0.0.3 在插件设置页，v0.0.4 挪到 app 设置页——数据归属与 UI 归属一致）。展示 provider 列表，每个 provider 可展开看其 model 列表。
  - **[v0.0.7 modified] UI 交互重做**：providers 区从「扁平列表 + 内联展开 model」重做为**三级流**（list → provider 二级页 → model 弹层）+ **唯一保存**（二级页 save-bar）+ 前端 **diff-save**；`ModelInstance` 新增 `label` / `enabled` 字段。功能定义（添加 provider/model、chat 选 model、数据归属）不变，仅交互模型重做。详见 `04-config-center-ui.md` §3.9.7。
- **添加 provider**：用户填 `baseUrl`（默认 `https://api.anthropic.com`）+ `apiKey` → 创建一条 app_config provider record。
- **添加 model**：在 provider 下填 `modelId`（如 `claude-sonnet-4-6`）+ 选 `protocolId`（下拉，来自 active `llm_protocol` ext impl，v0.0.3 仅 `anthropic_messages`）+ 可选 `maxOutputTokens` 等 → push 到该 provider record 的 `models[]`。
- **chat 选 model**：chat 输入框左下「选 model」按钮，弹出选择器列出所有 active provider 下的所有 model（`providerId/modelId` 展示），选中后 chat 使用该 model。
- **overlay 聚合**（不变）：LlmClient 组装时 `resolveProviderConfig = deepMerge(代码默认, app_config providerConfig)`，app 覆盖。代码默认来自 provider ExtImpl configSchema。
- **backend handlers/数据结构 [v0.0.4] 不变**：仅前端 UI 入口从插件设置页迁移到 app 设置页。

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3.5.1 [v0.0.4] | app 设置页 providers 区 → 添加 provider(填 baseUrl + apiKey) | provider 列表新增一条，app_config `providers` group 多一条 record |
| UC-3.5.2 [v0.0.4] | 在该 provider 下 → 添加 model(填 modelId + 选 anthropic_messages 协议) | provider 展开 model 列表新增一条 |
| UC-3.5.3 | 切到 chat → 点「选 model」→ 看到刚加的 `providerId/modelId` → 选中 → 发 query | chat 使用该 model 调通（见 UC-3.1.1） |
| UC-3.5.4 | 删除一个 model → chat 选 model 下拉中该 model 消失 | 删除生效，UI 与 app_config 同步 |
| UC-3.5.5 [v0.0.4] | 未配任何 provider/model → 打开 chat 选 model | 选择器空态（提示去 app 设置页配置） |

---

## 3.6 Config Service [v0.0.3]

**描述**：落地 config 模块 service（AppConfigService / PluginConfigService），底经 v0.0.2 CrudStore（engine: file），遵循 overlay 增量模型。（v0.0.3 曾落地 DevConfigService 作第三域，**v0.0.89 废弃**——技术调参组全迁 AppConfig，走 `/config/app`。）
**优先级**：P0
**用户故事**：作为框架，我希望有一个统一的 config 读写层，让 app/plugin/dev 三类配置各自隔离、按 group 分片、稀疏 delta 存储。

**期望行为**：
- **AppConfigService**（通用 KV）：`(group, key) → data` 的 get/set，entity `app_config`，落盘 `~/.rocky_agent_{env}/app_config/{group}/<id>.json`。（v0.0.89 起原 `DevConfigService`/`dev_config` 废弃，技术调参组全迁 app_config。）
  - app：记录缺失即未配置（值是用户权威）。
  - dev：「缺省→代码默认」由消费方 `?? CODE_DEFAULT` 处理，service 只做裸 KV 读。
- **PluginConfigService**（管理面）：`setEnabled` / `setImplEnabled` / `setConfig` / `setImplConfig` / `inventory`（全量树 JOIN 数据）/ `persist()`。详见 spec `config/[P0]plugin_config_service.md`。
- **overlay 模型**（spec §6 核心）：树枝（有哪些 plugin/ext impl）100% 来自 registry 代码；叶子（enabled/config 值）是稀疏 delta，未配置走代码默认。
  - P0 plugin/ext impl enabled 默认全开（native 受信）。
  - config 值默认来自各级 `configSchema.default`。
- **HTTP facade**（归 specs/api，此处只约定产品面）：`GET/SET /config/app`、`/config/dev`、`/config/plugin` 暴露三域读写。

**v0.0.3 具体 group/key**：

| 域 | group | key | data 形状 | 默认 |
|----|-------|-----|----------|------|
| app | appearance | theme | `"dark"` / `"light"` | 代码默认（如 `"light"`） |
| app | providers | {providerInstanceId} | provider+models[] json | 无 record = 空 |
| dev | llm request | stall timeout | number (s) | 代码默认 |
| dev | llm request | max retry times | number | 代码默认 |
| plugin | (pluginId) | enabled/configValues | 见 spec | P0 默认全开 |

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3.6.1 | `SET /config/app` appearance.theme=dark → `GET /config/app` appearance.theme | 返回 `"dark"`，落盘 app_config/appearance/ |
| UC-3.6.2 | `SET /config/dev` llm.stallTimeout=30 → 重启应用 → `GET` | 值持久化（30），重启后仍读到 |
| UC-3.6.3 | 删掉一条 dev record → `GET` 该 key | service 返回空（消费方走 `?? CODE_DEFAULT`） |
| UC-3.6.4 | `GET /config/plugin` inventory | 返回全量树（含 anthropic_compatible / anthropic_messages，均默认 enabled） |
| UC-3.6.5 | 新增一个代码内置 ext impl（不需写任何 config record）→ inventory | 自动出现在树里、带代码默认 enabled（树枝来自 registry） |

---

## 3.7 设置 UI [v0.0.3] [v0.0.4 modified]

**描述**：三个设置页（app / plugin / dev），从 sidebar 图标栏进入（v0.0.4：图标栏替代文字按钮），各自承载对应 config 域的读写界面。
**优先级**：P0
**用户故事**：作为用户，我希望有清晰的设置入口，分别管理我的偏好+provider/model（app）、插件行为主体（plugin）、技术调参（dev）。

**期望行为**：
- **入口 [v0.0.4 modified]**：sidebar 图标栏 4 图标（会话/app/插件/dev），点击切换右栏主区到对应页。当前激活的图标有视觉强调（terracotta 边 / sage 圆点 / 背景色块）。hover 出 tooltip 文字。
- **app 设置页 [v0.0.4 modified]**：
  - `appearance` group：`theme` 选项框（dark / light），切换立即生效（CSS 变量集切换），持久化到 app_config。
  - **`providers` 区 [v0.0.4 新增]**：provider 列表（每条展示 name + baseUrl），支持添加/删除；provider 可展开看 model 列表，支持添加/删除 model（选 protocolId 下拉）。详见 §3.5。（v0.0.3 此功能在插件设置页，v0.0.4 挪到 app 设置页）
- **插件设置页 [v0.0.4 modified]**（**纯 plugins + ext impls，移除 provider/model 实例 CRUD**）：
  - 按 **ExtensionPoint.group 分区**渲染（详见 §3.8）。
  - **provider 区**（group='provider'）：展示该 group 下所有 ext impl（跨 plugin/跨 point 聚合）——`anthropic_compatible`（point=llm_provider）+ `anthropic_messages`（point=llm_protocol）。
  - 每个插件项展示 plugin 信息（label + enabled）；每个 ext impl 展示 pointId + implId + enabled（P0 全开可切 setEnabled/setImplEnabled）。
  - inventory 数据来自 PluginConfigService.inventory（group-centric，见 §3.8）。
- **dev 设置页**：
  - `llm request` group：`stall timeout (s)` 数字输入 + `max retry times` 数字输入，保存即持久化（v0.0.3 chat 不消费，仅验证存取）。
- **布局稳定性**：所有表单字段固定占位，按钮 hover 出现/激活态切换/sidebar tooltip 出现 不导致相邻位移（沿用 §2.3）。

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3.7.1 [v0.0.4] | 点 sidebar「app 设置」图标 → 右栏切到 app 设置页 → 看到 theme 选项框 + providers 区 | 当前 theme 选中态正确；providers 区展示已配 provider 列表（空态或已有） |
| UC-3.7.2 | theme 选项框切到 dark → 整个应用视觉切深色 → 刷新仍为 dark | theme 切换全局生效 + 持久化 |
| UC-3.7.3 [v0.0.4] | app 设置页 providers 区 → 添加 provider 流程见 UC-3.5.1 | providers 区正确渲染 + provider/model CRUD 生效 |
| UC-3.7.4 [v0.0.4] | 点 sidebar「插件」图标 → 插件设置页 → 看到 plugins + ext impls 按 group='provider' 分区（anthropic_compatible + anthropic_messages） | 插件页按 group 分区渲染；enabled 展示正确（P0 全开） |
| UC-3.7.5 [v0.0.4] | 点 sidebar「dev」图标 → 看到 llm request 两 key 输入框 → 填值保存 → 重启仍读到 | dev 设置存取链路通 |
| UC-3.7.6 [v0.0.4] | sidebar 4 图标当前激活态有视觉强调；hover 出 tooltip；切换不抖动 | 布局稳定，无元素位移 |

---

## 3.8 Extension Point.group + Inventory group-centric [v0.0.4]

**描述**：v0.0.4 引入两条设计约束——ExtensionPoint.group 必填（EP 固有属性）；PluginConfigService.inventory 改按 EP.group 聚合返回（UI 按 group 分区渲染）。
**优先级**：P0
**用户故事**：作为框架，我希望 ext point 自带 group 分类，让插件页 UI 能天然按 group 分区展示行为主体，无需中间映射表。

**期望行为**：
- **EP.group 必填**：每个 ExtensionPoint 声明时直接定义 `group: string`（必填，非可选）。v0.0.4 现有 2 个 ext point 均归 group='provider'：`llm_provider`、`llm_protocol`。group 是 EP 固有属性（声明期确定）。
- **inventory 返回结构（group-centric）**：`PluginConfigService.inventory()` 返回 `{ [group: string]: Array<{ pluginId, pointId, implId, enabled }> }`——按 EP.group 聚合，每个 ext impl 携带其 EP 的 group。
- **UI 渲染**：插件设置页按 group 分区（每个 group 一个区），区内列出该 group 所有 ext impl（跨 plugin/跨 point 聚合）。如 provider 区同时含 `anthropic_compatible`（来自 llm_anthropic plugin / llm_provider point）+ `anthropic_messages`（来自 llm_anthropic plugin / llm_protocol point）。
- **enabled 门不变（正交）**：plugin.enabled ∧ impl.enabled 两级决定运行时是否生效。group 仅决定 UI 展示分区，与 enabled 行为门正交。
- **group 一致性**：config 实体 group 字段（`app_config` schema 的 `group: string required` 分片键）是 config 数据分片键 + UI 分区维度，无中间映射表。

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3.8.1 | `GET /config/plugin` inventory | 返回结构按 group 聚合：`{ provider: [{ pluginId: "llm_anthropic", pointId: "llm_provider", implId: "anthropic_compatible", enabled: true }, { pluginId: "llm_anthropic", pointId: "llm_protocol", implId: "anthropic_messages", enabled: true }] }` |
| UC-3.8.2 | 插件设置页 → 看 group 分区 | provider 区可见 anthropic_compatible + anthropic_messages 两项，均 enabled |
| UC-3.8.3 | 切某个 impl 的 enabled（setImplEnabled）→ inventory 反映 | enabled 状态变更持久化，inventory 返回结构同步 |
| UC-3.8.4 | 声明一个新 ext point 带 group='provider' → inventory 自动归入 provider 区 | 树枝来自 registry 代码（声明期），无需写 config record |

---

## 3.9 LLM 调用错误处理 / 自适应重试 / provider 降级 [v0.0.25]

**描述**：为 LLM 调用层补齐错误处理。让 LLM 调用遇到 429/overload/auth/超时/length 等错误时**自适应地重试、换 key/provider、改参数**，而非直接塌缩成 `LOOP_ERROR`。整链全 dead 才真失败，否则用户对 overload / 429 / 超时**无感**仍能拿到完整回复。**纯后端**（无 UI、无设计稿、无终端用户感知），通过「系统行为路径」表述可观测行为。
**优先级**：P0
**用户故事**：作为系统，我希望 LLM 调用能从瞬时错误自适应恢复（重试 / 换 key / 换 provider / 改参数），并在不可恢复错误（auth/content_filter/model_not_found）时立即明确上抛带原因的错误，而非笼统 LOOP_ERROR 或卡死。

**期望行为（系统级）**：
- **错误归一化**：所有 LLM 错误（HTTP status + `error.type` + 流内 error + 消息文本）归一化为统一 `LlmErrorCategory`（17 值，按恢复语义分组：可重试-瞬时 / 超时 / 凭证 / 请求 / 用户中断）。不再塌缩 `LOOP_ERROR`。
- **Adaptive retry**：同 provider 瞬时错误 → 指数退避 + jitter 重试；连续 N 次 → 升级（overload→换 provider、连续 AUTH→key dead）。
- **Provider 降级**：429/overload 是 `(provider,key)` 的属性，冷却窗口**进程级全局共享**（多 session 并发：session A 触发冷却，session B 立即跳过）。fallback chain 遍历跳过 cooled_down/dead 取首个 healthy；整链全 dead 才明确错误上抛（带真实 category + 原因）。
- **分阶段超时**：TTFB 45s + chunk 间阶段 stall（answer 30s / think 30s / tool 120s）+ wall-clock 600s 兜底。**abort 区分**：用户 abort 保留 partial 不重试；看门狗超时 abort 丢 partial 重试。
- **Length 处理**：`CONTEXT_LENGTH_EXCEEDED`（输入超）→ 压缩/截断 + 粘性预压缩；`MAX_TOKENS_EXCEEDED`（输出触顶）→ 决策树（prefill 续写 / max_tokens bump / 上抛）；区分 `STREAM_INCOMPLETE`（无 stop_reason + tool args 未完成，不 bump）vs `MAX_TOKENS_EXCEEDED`（有 length stop_reason，bump）。
- **错误状态在 loop RunState**（非 LlmCaller 局部、非仅 session）：每个 iteration 调 LLM 时 `buildRequest` 能跨 retry/iteration 修改实参（attempt1 max_tokens=20000 → 命中 MAX_TOKENS → attempt2 改 30000；下一 iteration 继承 overlay）。
- **不可恢复错误**：`CONTENT_FILTERED` / `AUTH_INVALID` / `MODEL_NOT_FOUND` → 不盲重试，直接上抛用户（带原因）。
- **物理层 wire body 记录**（BUG-001）：langfuse generation metadata 记 encode 后 fetch 前的最终 wire body（含 tool_result 原文），做逻辑 input vs 物理 body diff 对账。
- **anthropic role=tool 协议修复**（BUG-002）：canonical `role:"tool"` message → encode 层转 `role:"user"` + `tool_result` block + 合并连续同 role → 端点接受（不再 422）。
- **`llm_request` config 组**：`timeout` / `retry` / `degradation` / `length` / `fallback_chain`（不配=默认，配了=按配置走 app_config）。

**概念先行 / spec 对齐**：本节是行为描述层；类内部设计、接口签名、schema 在 `specs/tech/agent/llm_caller/`（6 spec：overview / error_normalization / provider_health_registry / retry_and_timeout / length_handling / llm_request_config）+ providers_and_models 4 件套修订。详见 `specs/prd/version_logs/v0.0.25/change_log.md`（10 系统行为路径 + §8 spec 对齐核查）。

**E2E/AT Use Cases（系统行为路径，详见 PRD version_log §2）**

| ID | 路径 | 预期结果 |
|----|------|---------|
| UC-3.9.1（P1） | provider overloaded/rate_limit → adaptive retry → 恢复 | 用户无感拿到回复；langfuse 记 retry 链 |
| UC-3.9.2（P2） | provider 连续 overloaded → 全局健康表升级 → fallback chain 切下一个 healthy | 请求完成；整链全 dead → 明确错误上抛（带真实 category） |
| UC-3.9.3（P3） | CONTEXT_LENGTH_EXCEEDED → 自动压缩/截断输入 → 重试成功；粘性：下 iteration 主动预压缩 | 二次成功；跨 iteration 粘性状态生效 |
| UC-3.9.4（P4） | MAX_TOKENS_EXCEEDED + partial 可 salvage + supportsPrefill → prefill 续写拼接完整回复 | 完整回复（非截断） |
| UC-3.9.5（P5） | TTFB > 45s / chunk stall / wall 600s → 看门狗 abort | abort + retry（丢 partial） |
| UC-3.9.6（P6） | 用户 abort vs 看门狗 abort | 用户 abort 保留 partial 不重试；看门狗 abort 丢 partial 重试 |
| UC-3.9.7（P7） | tool 调用后下一 iteration LLM 看到真实 tool result（非 `...`） | langfuse wire body 含 tool_result 原文 |
| UC-3.9.8（P8） | anthropic 多 tool result + tool 紧跟 user 请求 | wire 无 role=tool；端点返 200（非 422） |
| UC-3.9.9（P9） | 跨 iteration 错误状态继承 | bump max_tokens 后下一 iteration LLM 请求 max_tokens=30000（继承 overlay） |
| UC-3.9.10（P10） | CONTENT_FILTERED / AUTH_INVALID / MODEL_NOT_FOUND | 不重试直接上抛（NO_RETRY） |

**known-issue**：BUG-005 — `client.validate()` 裸 Error → NETWORK（misconfig 时白重试 3 次，Low-Med，open，不阻断合并；详见 `specs/tech/agent/llm_caller/[P0]llm_caller_overview.md §7`）。

**期望行为（rev2 改版，v0.0.25 后期澄清的 4 块架构变化）**：

> rev1 上方「期望行为（系统级）」是基线；rev2 在此基础上调整 4 处（用户在 v0.0.25 中期澄清），全部已编码 + 回归 AT 4/4 PASS + spec 落 `specs/tech/agent/llm_caller/`（rev2 段）。权威附录 `specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md`。

- **连续错误驱动的自适应 maxTokens**：错误状态改为 `LlmErrorState.recentErrors`（**连续错误历史数组**，而非 rev1 的 maxTokensOverlay 单值）；**成功一次即 clearRecentErrors 清空整个数组**。maxTokens **派生**（非存储）：`buildRequest` 时按 recentErrors 中 `MAX_TOKENS_TOO_HIGH` 出现次数计算 `base × 0.7^count`——请求参数越界被 provider 拒时自动降到合法区，避免白重试；连续错误清零后恢复 base。
- **per-session × per-model 降级**：`ProviderHealthRegistry` 的健康 key 从 rev1 的 `(provider, key)` 升级为四元组 `(sessionId, providerId, keyRef, modelId)`——同一 provider/key 在不同 session / 不同 model 下的健康态互不污染（session A 触发某 model 冷却不影响 session B 同 provider 另一 model 的调用）。`resolveTarget` 改**两遍扫描**：第 1 遍只取 healthy 项（isPreferred）；第 1 遍无果则第 2 遍兜底取 healthy 或 degraded 项（isAvailable），cooled_down（未到期）两遍都跳、dead 排除。整链全 dead/全 cooled_down 才上抛（带真实 lastError category）。
- **错误外显（finish_reason + SSE）**：run 失败时 `RunRecord.error` 落 `RunErrorInfo = { errorCategory, displayReason, errorDetail? }`（agent loop catch ClassifiedLlmError 后填），`GET /session/:id` 可读 currentRun.error / 历史 run error。新增 `llm_attempt` SSE event（per-attempt 实时外显 retry / fallback 进度，payload 含 attempt/providerId/keyRef/modelId/action/category）。SSE `error` 事件去硬编 `LOOP_ERROR`，按真实 category 上抛（向后兼容：旧 caller 仍读 `message`，新增 `errorCategory`/`displayReason`/`errorDetail` 可选字段）。17 行 `errorCategory → displayReason` 映射（AUTH_INVALID→「认证失败…」/ RATE_LIMITED→「模型限流…」/ PROVIDER_OVERLOADED→「服务商过载…」等，权威表见 rev2 附录 §1）。
- **空响应重试**：新增 category `EMPTY_RESPONSE`（流 finish 但 content 为空）——纯重试（无 overlay、不降级），区别于 length 触顶。
- **length 一步到位**：`MAX_TOKENS_EXCEEDED`（有 stop_reason=length，输出触顶）决策树简化为 **one-shot ceiling bump**（一步升到 `model.maxOutputTokens`，不再分步试探）；prefill 续写**defer**（spec 留目标，v0.0.25 不实现）。
- **validate 收口（BUG-005）**：`client.validate()` 抛的裸 Error 在 rev1 被误归 NETWORK（misconfig 白重试）；rev2 收口为 `MAX_TOKENS_TOO_HIGH`（maxTokens 越界）/ `BAD_REQUEST_OTHER`（temp/topP 等其他参数错误），不再白重试。

**rev2 AT/ET Use Cases**（在 rev1 P1-P10 基础上，以下路径由 UT + spec 覆盖，真服务难构造特定 provider 状态故未全跑 AT；rev1 P1-P10 真服务回归 4/4 PASS）：

| ID | 路径 | 预期结果 |
|----|------|---------|
| UC-3.9.11（rev2） | 请求 maxTokens 越界被 provider 拒 → recentErrors append MAX_TOKENS_TOO_HIGH → buildRequest 派生 maxTokens=base×0.7 | 重试用降后的 maxTokens 成功；langfuse 记 retry 链 + category |
| UC-3.9.12（rev2） | session A 某 model 触发 429 冷却 → session B 同 provider 另一 model 调用不受影响 | session B 仍走该 provider（四元组 key 隔离） |
| UC-3.9.13（rev2） | 整链 healthy 项全冷却 → resolveTarget 第 2 遍兜底取 degraded | 兜底可用（degraded 仍能调用）；全 dead 才上抛带 category |
| UC-3.9.14（rev2） | run 失败 → `GET /session/:id` 读 currentRun.error | 返回 RunErrorInfo（errorCategory + displayReason + errorDetail） |
| UC-3.9.15（rev2） | LLM 流 finish 但 content 空 → EMPTY_RESPONSE → 纯重试 | 重试成功拿到非空响应 |

---

## 版本

version: 1.4（v0.0.25 rev2 改版补 §3.9 rev2 段：连续错误驱动的自适应 maxTokens（recentErrors 成功清空 + base×0.7^TOO_HIGH 派生）/ per-session×per-model 降级（四元组 key + 两遍扫描）/ 错误外显（RunErrorInfo 落 RunRecord + llm_attempt SSE + ErrorEvent errorCategory 去 LOOP_ERROR + 17 行映射）/ 空响应重试（EMPTY_RESPONSE）/ length one-shot ceiling bump + prefill defer / validate 收口 BUG-005；+ UC-3.9.11~15 五路径（UT+spec 覆盖）；权威附录 `specs/tech/version_logs/v0.0.25/llm_caller_rev2_changes.md`）。1.3（v0.0.25 新增 §3.9 LLM 调用错误处理 / 自适应重试 / provider 降级（backend-only：LlmErrorCategory 17 值归一化 + adaptive retry + 进程级 ProviderHealthRegistry + fallback_chain + 分阶段超时 + length 处理 prefill/bump + llm_request config 组；10 系统行为路径 P1-P10 + known-issue BUG-005）；概念先行对齐 `specs/tech/agent/llm_caller/`）。1.2（v0.0.5 标注）。1.1（v0.0.4 修订：§3.5 UI 入口挪 app 设置页 / §3.7 设置 UI 拆分 / 新增 §3.8 EP.group + inventory group-centric）
