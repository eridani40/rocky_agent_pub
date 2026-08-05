---
type: reference
title: 模块依赖关系（deps.md）
priority: P1
updated: 2026-06-30
---

# 模块依赖关系（deps.md）

> 基于 `specs/tech/` 下全部规范文档的实际内容梳理（非臆测）。文档未明确说明的依赖标注「未明确」。
> 「大板块」= 最多 2 级，agent 下钻一级。共 12 个板块（v0.0.10 新增 #12 observability）。
>
> **[v0.0.10 变更]**：#12 observability 已落地（LangfuseAdapter + loop 埋点 + env var convention + flush 生命周期），新增依赖边 1 loop → 12 observability（SessionConfig.observability 注入）+ 12 → 2 message（类型引用填全量字段）+ 12 → 10 config（凭证来源）。详见 `specs/tech/version_logs/v0.0.10/change_log.md §7/§8`。

## 板块清单

| # | 板块 | 职责（一句话） |
|---|------|----------------|
| 1 | `agent/agent_interface_and_loop` | AgentManager/AgentLoop/AgentEvent —— 顶层执行引擎，跑 ReAct 循环 |
| 2 | `agent/message`、`agent/event` | Message/ContentBlock/Usage（message）+ EventBus/EventHub/event_convention（event）—— 消息类型与事件底座（hub 全局单例、bus per-topic） |
| 3 | `agent/context` | ContextEngine —— ingest/snapshot/compact/usage 上下文生命周期 |
| 4 | `agent/session` | SessionStore（统一存储：Session/Run + raw/transcript/tool_result/summary + 大内容 saveContent/getContent） |
| 5 | `agent/providers_and_models` | provider/protocol/model/client —— LLM 接入组合层 |
| 6 | `app/envs` | test/dev/prod 三环境语义 + 三份 `.env` + `scripts/` 脚本契约 |
| 7 | `app/package` | 物理布局/workspace 包边界 + electron-builder 打包 + dev/test 工具链 |
| 8 | `plugin_system` | Extension Point + cardinality + ext impl + 发现/激活 + 威胁模型（**配置管理面已并入 config 模块为 PluginConfigService**） |
| 9 | `persistence` | SchemaDef + CrudStore + fs/sqlite engine + search(P1) —— 数据落地基座 |
| 10 | `config` | AppConfig/PluginConfig —— 仅逻辑 schema，不含 CRUD（DevConfig v0.0.89 废弃，技术调参迁 AppConfig） |
| 11 | `agent/tools` | tool_execution_engine + 工具类（file_op/bash/web/task/agent）+ Toolkit 聚合 —— 工具执行（占位） |
| 12 | `agent/observability` | ObservabilityAdapter（Trace/Generation/Span 生命周期）+ loop 边界埋点契约 + 全量字段定义；LangfuseAdapter 首实现 —— 可观测性（横切，被 loop 调）。**[v0.0.10 已落地]** |

---

## 方法学提醒（务必先读）

**spec 不对称是本系统最大的依赖陷阱**。`persistence/[P0]overview.md §7` 单方面声明了多个入向依赖（"X 消费 CrudStore"），但被声明的一方（`agent/session`、`agent/message`、`plugin_system`→现 config/`PluginConfigService`）在自己的 spec 里**完全没有出现** `CrudStore / persistence` 字样——它们只定义抽象的 `SessionStore` 接口，或写"持久化到 `plugins.policy.json` 文件"。

因此 9 声称的「2/4/8 依赖我」全部是 **persistence 单方声明 / spec 层未对齐**，标注为 **implied（persistence 侧声明）**。见文末「待对齐项」。

---

## A → B 依赖汇总表

| A | → | B | 强弱 | 依赖内容 |
|---|---|----|------|----------|
| 1 loop | → | 2 message/event | 强 | ContentBlock/Usage 类型（message）+ EventBus 注入（event） |
| 1 loop | → | 3 context | 强 | 实例化 ContextEngine 并每轮调用 |
| 1 loop | → | 4 session | 强 | SessionConfig / SessionStore / persistUsage |
| 1 loop | → | 5 providers | 强 | 调 LLM，agent 持 LlmClient（门面封装 4 件套：providerConfig 数据 + provider 代码 + protocol 代码 + modelConfig 数据） |
| 1 loop | → | 12 observability | 强 | 经 SessionConfig.observability 注入 adapter，run/LLM/tool 边界埋点（默认 NoopAdapter） |
| 1 loop | → | 9 persistence | 未明确 | store engine 未点名 |
| 1 loop | → | 10 config | 未明确 | SessionConfig 来源未说明 |
| 12 observability | → | 2 message | 强 | 引用 Message/Usage/ToolDefinition/ToolResultBlock 类型填全量字段（GenInput/ToolSpanInput） |
| 12 observability | → | 10 config | 弱 | LangfuseAdapter 凭证（publicKey/secretKey/baseUrl）来源 **app_config observability 列表（runtime 组，v0.0.89 迁自废弃 dev_config；每 enabled item 一独立 adapter）**；**ENV 兜底（`LANGFUSE_*`）已于 v0.0.11 移除** |
| 2 event | → | 1 loop | 弱 | EventBus/EventHub 以 AgentManager 为范例（仅文档） |
| 2 message | → | 4 session | 强 | Message 内嵌 rawRef/toolResultRef + snip 字段（类型耦合） |
| 2 message | → | 9 persistence | 强 | Message 经 CrudStore 落盘（transcript entity，engine/分片归 session schema） |
| 3 context | → | 1 loop | 强 | 复用 SessionConfig 作为 session context |
| 3 context | → | 2 message | 强 | Message[] / UsageBlock / system: Message |
| 3 context | → | 4 session | 强 | SessionStore 注入（写 transcript / saveContent offload raw/tool_result / 读 summary）；调 session usage 更新接口（assemble→updateContextWindowUsage、LLM 返回→accumulateUsage(type)）；usage view/通知归 session（session_usage） |
| 3 context | → | 5 providers | 强 | config.client 提供 contextWindow（tokenLimit）+ compact 调 client；token 估算用 char×ratio（context 自持 session ratio，不经 client，见 context_usage_detail §4） |
| 3 context | → | 9 persistence | 未明确 | store 是抽象 SessionStore |
| 3 context | → | 8 plugin | 强（实例级） | 消费 plugin 扩展点框架：ingest/assemble/system_prompt 的 handler/mapper/reducer 均为 ordered ext impl（5 个扩展点见 8→3 行） |
| 3 context | → | 10 config | 未明确 | SessionConfig 来源未说明 |
| 4 session | → | 1 loop | 强 | Run ↔ AgentLoop.start、StopReason 共享 |
| 4 session | → | 2 message | 强 | SessionStore.appendMessages/getMessages: Message[] |
| 4 session | → | 3 context | 弱 | 概念映射；offload 是 ContextEngine 决策、存储归 SessionStore（非反向） |
| 4 session | → | 9 persistence | 强 | transcript/summary/usage/raw/tool_result 经 CrudStore（engine per-schema 待定）；raw/tool_result 为普通 CrudStore 实体、无独立 off-store |
| 5 providers | → | 2 message | 强 | CanonicalRequest/Response 内嵌 Message/Usage |
| 5 providers | → | 3 context | 弱反向 | model 喂 context 预算（方向是 context→providers） |
| 5 providers | → | 9 persistence | 未明确 | ULID id 暗示持久化但未点名 |
| 5 providers | → | 8 plugin | 强（实例级） | provider 与 protocol 都是 list 扩展点的 ext impl（`llm_provider` / `llm_protocol`）；providerConfig/modelConfig 是 app_config 数据（非 ext impl） |
| 6 envs | → | 7 package | 弱/边界互引 | scripts 调 tool_chain / packaging |
| 7 package | → | 6 envs | 弱/边界互引 | 边界表反向指向 envs |
| 7 package | → | 1-5 agent | implied | server 装载 agent（运行时装配，spec 未显式点名） |
| 8 plugin | → | 3 context | 强（实例级） | context 声明 5 个 ordered 扩展点（context_ingest_handler / system_prompt_mapper / system_prompt_reducer / context_assemble_mapper / context_assemble_reducer，均 group=context）；旧 ContextEnginePoint=exclusive 已废弃（ContextEngine 不再整体可替换，内部改 ordered handler/mapper/reducer） |
| 8 plugin | → | 5 providers | 强（实例级） | LlmProviderPoint = list 扩展点 |
| 8 plugin | → | 9 persistence | 强 | policy 的 SchemaDef 声明 engine:'file'（schema 驱动路由） |
| 10 config | → | 9 persistence | 强 | 读写/校验/乐观锁全归 CrudStore + SchemaDef |
| 10 config | → | 8 plugin | 弱（数据契约） | inventory 读 plugin registry **声明数据**（manifest/EP/ExtImpl），非代码模块依赖；二者代码层不互相依赖、各自依赖 persistence |
| 10 config | → | 5 providers | 弱 | AppConfig.providers 引用 provider 插件（providers.models[] 每条 = 完整 modelConfig，含 contextWindow/pricing 等；providerConfig = providers 组一条实例，**`[v0.0.53]` 顶层含 protocolId**，1 provider : 1 protocol 锁定；model 不再持 protocolId） |
| 10 config | → | 4 session | 弱 | app_config `agent.maxIterations` 默认值（v0.0.89 迁自 DevConfig） |
| 10 config | → | 3 context | 弱 | app_config `context.autoCompactThreshold`（v0.0.89 迁自 DevConfig） |

---

## 依赖层级（自底向上）

```
最外层装配：   6 envs  ←→  7 package           （独立于业务核心，弱互引）

顶层编排：                          1 agent_loop   ← 顶（几乎无人依赖）
                                  ↗
中间偏顶：        3 context ──→ 1        4 session ──→ 1
                    │                       │
中间层：      2 message          5 providers ──── （被 3 依赖）
              8 plugin_system ──→ {3, 5}（扩展点实例）
              10 config ──→ {8, 9}（强）+ {3,4,5}（弱）
                          │
底层基础设施：            └──→ 9 persistence（纯叶子，无出向依赖）
```

- **底层（无/弱出向）**：`9 persistence`（纯叶子，所有人依赖它）、`6 app/envs`（外层叶子）
- **中间层**：`10 config`（配置视图层）、`8 plugin_system`（可扩展性基座）、`2 message`（类型底座）、`5 providers`（LLM 接入层）
- **顶层编排**：`1 agent_loop`（执行引擎）、`3 context`（协作者）、`4 session`（存储接口定义方）
- **最外层装配**：`7 app/package`（装配壳）

**一句话拓扑**：
`9 persistence（底） ← {10 config, 8 plugin, 2 message, 5 providers} ← {3 context, 4 session} ← 1 agent_loop（顶）`，外圈 `6 envs ↔ 7 package` 独立。

---

## 双向依赖 / 循环风险

| 边 | 方向 | 强弱 | 风险 |
|----|------|------|------|
| ~~10 config ↔ 8 plugin~~ | — | **非双向（已订正 2026-06-20）** | config 与 plugin_system 代码模块层**不互相依赖**，各自依赖 persistence；config 仅读 plugin registry 声明数据（inventory 取树，数据契约，非模块依赖）。原「双向边」描述废弃。 |
| **6 envs ↔ 7 package** | 弱 ↔ 弱 | 双向 | **无**。仅边界归属互引，无运行时代码依赖。 |
| **1 ↔ 2、1 ↔ 3、1 ↔ 4、2 ↔ 4、3 ↔ 4** | 强/弱混合 | 双向 | **非代码循环**。全部是「接口契约 vs 调用方/消费方」的合法分层耦合。其中 1↔3、1↔4、2↔4 为强↔强，构成紧耦合核心团。 |
| **9 ← 8 ← {3,5} ← {1,4} ← 9** | 多跳 implied | 间接环 | **非直接循环**。spec 不对称使其难验证，建议对齐措辞。 |

### 紧耦合核心团 {1, 2, 3, 4}

`agent_loop / message / context / session` 四者强↔强交织，实际构成一个不可再分的边界。**task 拆分时作为一个整体，不宜跨团分到不同 task/版本**。

### bootstrap 循环已根除（schema 驱动路由）

架构决策（2026-06-19）：**persistence 为静态基座（非 plugin），engine 是 SchemaDef 字段，路由纯 schema 驱动**——CompositeStore（= EngineManager）按 `schema.engine` 泛型路由，persistence 不认识任何业务实体（含 config），代码模块层零依赖。file 与 sqlite 均为内置、bootstrap 安全（config 用 sqlite 也不循环）；config 的 SchemaDef 选 `file` 纯属操作性偏好（人可读 policy 文件），不是架构硬约束。engine 启动参数（路径/db）来自 ENV（app/envs），不来自 config——这是真正的"底"。上文「9 ← 8 ← {3,5} ← {1,4} ← 9」的 implied 间接环**不存在**，未来加 engine（甚至第三方）也不引入循环，因为 config 的 engine 归属永远由其 schema 声明、且只用内置 engine。

---

## 待对齐项（建议 doc-modifier 处理）

1. ~~spec 不对称（config→persistence）~~ ✅ 已解决（2026-06-19）：config 硬编码 FsCrudStore，三处口径统一。
2. ~~术语 gap（ChatModelBase vs LlmModel）~~ ✅ 已解决（2026-06-19）：删除 ChatModelBase，LlmClient 作唯一门面封装 **4 件套**（providerConfig 数据 + provider 代码 + protocol 代码 + modelConfig 数据；path/contentType 自承载在 protocol impl，无 protocolConfig）；数据描述符 LlmModel→LlmModelConfig；agent/context 只持 LlmClient，tokenizer 收进 client.countTokens()（**2026-06-20 订正**：tokenizer 与 client.countTokens 均废弃——token 真实值由 LLM 返回（UsageBlock），context window 估算改 char×ratio per-session 归 ContextEngine；真实基准 = LLM token + snapshot char；见 context_usage_detail §4）。2026-06-19 再订：protocol 标准值归代码、providerConfig/modelConfig 归 app_config 数据、provider/protocol 是 `llm_provider`/`llm_protocol` 两个 list 扩展点的 ext impl。
3. ~~**config ↔ plugin_system 双向边**~~ ✅ 已解决（2026-06-20）：config 与 plugin_system 代码模块层**不互相依赖**，二者各自依赖 persistence；config 仅读 plugin registry 声明数据（inventory 取树，数据契约，非模块依赖）。原「双向边」描述废弃，见 A→B 表 + `progress.md` 关键依赖结论。
4. ~~message / session 的 engine 归属~~ ✅ 依赖已确认（2026-06-19）：message/session 持久化依赖 persistence CrudStore（非 spec 不对称）。仅 engine 具体选 file/sqlite 由各 SchemaDef 声明，**per-schema 待定、非阻塞**。raw/tool_result（offload 大内容）为普通 CrudStore 实体、无独立 off-store（off-loader 已废弃）。

---

## 关键证据文件

- `persistence/[P0]overview.md §7` —— 入向依赖声明（spec 不对称源头）
- `config/[P0]plugin_config_service.md §4.4` —— PluginConfigService persist 经 CrudStore 落盘 plugins.policy.json（吸收自原 plugin_system config_backend_interface，已迁移；两级 config 表 + string key API，P0 默认全开）
- `config/[P0]overview.md §1/§3` —— config→persistence/plugin 强依赖
- `agent/agent_interface_and_loop/[P0]agent_loop_eager_drain.md §2/§4/§6` —— AgentLoop 装配与调用
- `agent/context/[P0]context_engine.md §2/§3` —— ContextEngine 出向依赖集中点
