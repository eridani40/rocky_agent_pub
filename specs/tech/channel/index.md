---
type: index
title: Channel 子系统总起（IM 渠道接入层）
priority: P0
updated: 2026-07-26
since: v0.0.103
related:
  - "[[P0]channel_extension_point.md]"
  - "[[P0]channel_impl_interface.md]"
  - "[[P0]channel_manager.md]"
  - "../plugin_system/[P0]extension_point_interface.md"
  - "../config/[P1]connectors.md"
  - "../agent/index.md"
---

# Channel 子系统总起（IM 渠道接入层）

## ① 是什么

**channel = Extension Point**（与 `llm_provider` / `web_search_provider` 同构可扩展）；**飞书 = channel EP 的一个 ExtImpl**。channel 把外部 IM（飞书/未来微信/钉钉）接入 agent：IM 用户消息经 channel 进 agent loop（与 web client 对等），agent 产出经 channel 回 IM。

| 核心概念 | 一句话 |
|---|---|
| **channel EP** | id='channel' / cardinality='list'（多 IM 平台并存），契约 = `Channel` interface（`[P0]channel_impl_interface.md`） |
| **Channel impl** | 无状态协议行为类：`readonly type` + `connect(config, backend) → ChannelHandle`（每个 IM 平台一个 impl；不持 config，同一 impl 可并行组合多份 config） |
| **ChannelHandle** | per-config 连接句柄（connect 产出的会话对象）：`configId` + `disconnect`/`handleInbound`/`sendOutbound`/`updateInputState`；连接态（client/dedup/debounce/queue）挂这里 |
| **ChannelHandleBase** | ChannelHandle 契约的 abstract base —— 给句柄提供通用方法（`deliverTo`/`bind`/`unbind`/`listPlaygroundSessions`/`listStudioLeaders`/`getBindedSession`/`findConversationBySession`） |
| **FeishuChannel** | 本期唯一 impl（ExtImpl，`app/plugins/builtins/feishu/`）；`connect` 产 `FeishuConnection`（WSClient + 斜杠指令） |
| **ChannelConfig** | 一份 channel 配置（纯数据，含凭证；原 ChannelInstance 改名，落盘字段不变）；一个 impl 可有多份 config（多 token），落 `channel_config` 域 |
| **ChannelBinding** | (configId, conversationId) ↔ sessionId 双向唯一映射，落 `channel_bindings` 域 |
| **ChannelManager** | channel EP 的消费方 + **组合器**（getExtensionImpls resolve impl map → 按 config 逐份 connect）+ config/binding/连接管家 + outbound 累积管线 |
| **双状态机** | `switch`(on/off 持久化) + `connection`(disconnected/connecting/connected/error 运行时派生)，**channel switch=on 立即 connect**（与 connector lazy 不同） |
| **outbound 累积** | ChannelManager subscribe agent_loop → 消费 loop 分发 block → per-session SendQueue 串行发送 → handle.sendOutbound（block 级，channel 不感知累积） |
| **SendQueue** | per-session 有序发送队列（`channel-send-queue.ts`）：消费与发送解耦，保序 + 有界 100 + 重试 3 次 + abort 感知 |

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| channel EP 定义 + 契约（Channel interface） + groups.json 登记约定 | EP 框架本身（cardinality 三态/registry/inventory → `../plugin_system/`） |
| ChannelHandleBase abstract 通用方法 + FeishuChannel impl / FeishuConnection 句柄 | 各 IM 平台 SDK 内部细节（事件字段/发送 API → impl 内部，编码期对照官方文档） |
| ChannelManager：bootstrap/config/binding/outbound 累积/状态推前端 | agent 执行运行时（deliverTo/agent_loop → `../agent/`） |
| ChannelConfigService（`channel_config` 域） + ChannelBindingStore（`channel_bindings` 域） | CrudStore FS engine / sharding（→ `../persistence/`） |
| 双状态机（switch+connection） + 启动恢复 + 重连 3 次/5s | connector 双状态机（→ `../config/[P1]connectors.md`，channel 复用同构模式） |
| channel 配置页 UI 契约（testid/状态字段/凭证表单） | 通用 UI 框架（nav-rail/view-store/app-shell → `../../../specs/ui/`） |
| HTTP facade（`/config/channels` GET/POST/PUT/DELETE） | HTTP 路由机制（→ `specs/api/`） |

## ③ 与系统的关系

```
   app/plugins/builtins/feishu/plugin.json  (manifest 声明 feishu impl → channel EP)
        │  BuiltinLoader 扫描
        ▼
   Registry  ─────────────────────────────────┐
        │                                     │
        ▼ getExtensionImpls(ChannelPoint,'default')   │ inventory JOIN
   PluginManager（scope 解析单源）              ▼
        │  impl map（scope 门物化）       PluginConfigService（→ ../config/）
        ▼
   ChannelManager（组合器 + channel EP 消费方）
        │  bootstrap → 按 channel_config 逐份 ──→ impl.connect(config, backend) → ChannelHandle
        │  inbound ← handle.handleInbound → base.deliverTo → agentManager.deliverTo
        │  outbound subscribe → 累积 → handle.sendOutbound
        │
        ▼
   agentManager (现有, 零改)
     - deliverTo(sid, Message) ◀── inbound 入口（与 client 对等）
     - subscribe(sid,'current') ◀── ChannelManager outbound 订阅
     - agent_loop replayable pub-sub bus（web SseChannel + ChannelManager 都订阅 = 联动天然成立）
```

**对外协作点**：
- channel EP 注册：`app/server/src/plugin/extension-point.ts` `BUILTIN_EXTENSION_POINTS` 加 `ChannelPoint`。
- groups.json 登记：`app/plugins/groups.json` 加 group「渠道」（UI 入口 = 技能↔连接器之间）。
- 框架代码：`app/server/src/channel/`（channel-base / channel-manager / channel-accumulator / channel-send-queue / channel-config-service / channel-binding-store / channel-retry / types）。
- 飞书 impl：`app/plugins/builtins/feishu/`（feishu-channel / feishu-client / feishu-protocol / feishu-slash）。
- 数据落 `channel_config` + `channel_bindings` 两独立域。
- bootstrap 注入：`bootstrap.ts` 经 `bootstrapConnectorsPhase` 调 `createAndBootstrapChannelManager({dataDir, agentManager, sessionStore, registry, pluginManager})`（agent_loop bus 就绪后；pluginManager 供 getExtensionImpls 无状态 impl）。

## ④ 核心设计原则（跨文件不变量）

1. **channel = EP（和 provider 同构可扩展）**——channel 不是硬编码 if/else 分支，而是 `ExtensionPoint<Channel>`（id='channel', cardinality='list'）；新 IM 平台 = 加 impl，不动核心。→ `[P0]channel_extension_point.md §3.1`
2. **复用 plugin_system 全套**——EP/ExtImpl/Registry/PluginManager/groups.json/configSchema 单一源/两级 enabled 全复用，**不重新发明**。channel EP 登记 groups.json 启动校验（registry ↔ groups.json 双向一致）。→ `../plugin_system/` + `[P0]channel_extension_point.md §3.2`
3. **channel = client 对等（不发明第三种东西）**——channel 不创建专属 session；IM 用户消息 sender=`{source:'user', channel:{...}}`（**不扩 source 枚举**），与 web 用户消息走同一 deliverTo → agent loop → agent_loop bus。web 和 channel 是同一 bus 的两个订阅者 → 联动天然成立。→ `[P0]channel_impl_interface.md §3.2`
4. **agent loop 本体零改**——channel 只是又一条 inbound 路径（deliverTo）+ 又一个 outbound 订阅者（subscribe）。agent loop 不感知 channel 存在。→ `[P0]channel_manager.md §3.2`
5. **outbound 累积在 ChannelManager（channel 不感知累积，block 级发送）**——channel.onOutBoundMessage 收**单 block 的一条文本 Message**（每 block 一条飞书消息，实时），不收事件流；tool 过程以**概括文本**发（`🔧 调用工具：X` / `📋 工具回复：成功/失败`）。Manager 端 subscribe → 消费 loop 分发 block → per-session SendQueue 串行发送。channel impl 只收拼好的文本 Message。→ `[P0]channel_manager.md §3.5`
6. **binding 双向唯一**——一个 (config, conversation) 绑一个 session（一对一覆盖），**且一个 session 只被一个 (config, conversation) 绑**（违反报错）。简化 outbound（无 fan-out）。→ `[P0]channel_manager.md §3.4`
7. **switch=on 立即 connect（与 connector lazy 不同）**——channel switch=on 持久化 intent + **立即** connect（IM 必须常连才能收消息）；不像 connector lazy（attach 首次调用才 connect）。重连 3 次 × 5s，仍失败转 error 等用户 off→on 重置。→ `[P0]channel_manager.md §3.3`
8. **configSchema 单一源（appId 普通 + appSecret secret）**——feishu impl 的 `configSchema` 是唯一 schema 源（驱配置页表单 + 校验 + default），appSecret 用 `primitive-secret-input`（mask 展示）。**与 plugin_system 不变量 8 对齐**。→ `[P0]channel_impl_interface.md §3.4`
9. **[v0.0.107] user 消息 outbound 按 origin 分流（echo 屏蔽）**——agent loop 对 user 消息也 emit `text_block_*`（供 client 渲染），outbound accumulator 必须按 `message_start.origin` 分流：`origin.configId === handle.configId`（本渠道自发）→ **DROP**（echo 屏蔽）/ 跨渠道 → 前缀 `User (from ${type})` / 非 user → 原 answer。**self 判定按 configId 非 type**（同 implId 多 config）；**origin 是事件层信封元数据，绝不进 LLM content**。→ `[P0]channel_manager.md §3.5.1` + `../agent/agent_interface_and_loop/[P0]agent_event.md §4.2`
10. **[v0.0.106] 内存态是 GET 的权威源，写盘必须同步内存**——`GET /config/channels` 的 name/switch 取自 ChannelManager 内存 configs Map（`getState()`），非落盘直读；任何更新落盘的写路径（PUT）须调 `updateConfig` 同步内存，否则 GET 返 stale（重启才刷新）。这是 v0.0.106 「编辑 channel 后不刷新」的修复原则。→ `[P0]channel_manager.md §3.10`
11. **[v0.0.118] outbound 管线三层健壮性——任何 IO 不允许无超时挂死整条管线**：①**发送有超时**——`FeishuClient.sendMessage` 30s（`withTimeout`）包住 HTTP（Lark SDK axios 默认无超时是停发根因）；②**消费与发送解耦**——消费 loop 只 enqueue 不 await，per-session SendQueue 保序串行发送 + 重试/有界/abort 感知，一次挂死不冻结消费；③**loop 死亡可见且自愈**——异常必打日志（非静默 `.catch`）+ 死亡 controller 从 Map 摘除（修幂等误判）+ 非 abort 退出条件重建（5s，binding 存在 + connected）。消费 loop 每事件 try/catch 防连累，block 缓冲槽 5min stale 回收防泄漏。→ `[P0]channel_manager.md §3.5/§3.5.2` + `[P0]channel_impl_interface.md §5.7`
12. **[v0.0.206] impl 无状态 + config 纯数据 + 动态组合；scope membership 即启用**——Channel impl = 无状态协议行为类（标准 EP 构造 `(implId, cfg)`，由 `getExtensionImpls(ChannelPoint,'default')` 直供，**删 plugin scope D6 后 default.yaml 不配 = 关**）；ChannelConfig = 纯数据（一份 = 一个 IM 机器人）；二者在 `connect(config, backend)` 时组合产 per-config 句柄 ChannelHandle，同一 impl 并行组合多份 config。**scope 门物化点** = `ChannelManager.resolveImpl`：impl 未激活 → map miss → config 转 error 态（不 retry、不崩 server）。两级开关正交：impl 级 = scope membership，config 级 = `config.enabled`。→ `[P0]channel_impl_interface.md §2` + `[P0]channel_manager.md §3.1/§3.11`

## ⑤ 本目录导航

| 文档 | 管什么（一句话） | 优先级 | 链接 |
|---|---|---|---|
| `extension_point_interface.md` | channel EP 定义（id/cardinality/契约）+ groups.json 登记约定 | P0 | [link]([P0]channel_extension_point.md) |
| `channel_impl_interface.md` | Channel 契约（无状态 type+connect→ChannelHandle）+ ChannelHandleBase abstract + FeishuChannel/FeishuConnection + configSchema | P0 | [link]([P0]channel_impl_interface.md) |
| `channel_manager.md` | ChannelManager（组合器：ensureImpls/resolveImpl scope 门 + bootstrap/config/binding/outbound 累积/状态推前端）+ ChannelConfigService + ChannelBindingStore + 双状态机 + 启动恢复 | P0 | [link]([P0]channel_manager.md) |

> 配置管理面（启用/选择）由 `../config/` KB 的 plugin_config_service 提供；UI 组件契约见 `../../../specs/ui/components/channel-page/`；HTTP facade 见 `../../../specs/api/overall/17-channel.md`。
> 变更历史见 `log.md`；跨版本发布说明见 `../version_logs/v0.0.103/change_log.md`。
