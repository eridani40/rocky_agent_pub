---
type: interface
title: Channel Impl Interface (Channel + ChannelHandle + ChannelHandleBase + FeishuChannel)
priority: P0
status: active
updated: 2026-07-26
since: v0.0.103
related:
  - "[[P0]channel_extension_point.md]"
  - "[[P0]channel_manager.md]"
  - "../plugin_system/[P0]ext_impl_and_manifest_interface.md"
  - "../agent/message/[P0]agent_message_interface.md"
---

# Channel Impl Interface

## 1. 概述

channel EP 的契约 = **`Channel` interface（无状态协议行为类）**：`readonly type` + `connect(config, backend) → ChannelHandle`，由每个 IM 平台 impl 实现。impl **不持 config**（标准 EP 构造签名 `(implId, cfg)`，`PluginManager.getExtensionImpls` 直供）；**config 是纯数据**（`ChannelConfig`，一份 = 一个 IM 机器人），二者在 `connect(config, backend)` 时**动态组合**产出 **per-config 连接句柄 `ChannelHandle`**（会话对象，持 client/dedup/debounce/queue 等连接态）。同一无状态 impl 可并行组合多份 config。`ChannelHandleBase` abstract 提供**通用方法**（句柄调用的 helper，如 deliverTo/bind/listSessions），让 impl 只关注 IM 协议本身。本期唯一 impl = `FeishuChannel`（ExtImpl，manifest 落 `app/plugins/builtins/feishu/plugin.json`；`connect` 产 `FeishuConnection`）。

**不管**：EP 定义（→ `[P0]channel_extension_point.md`）、ChannelManager 组合与消费方式（→ `[P0]channel_manager.md`）、飞书 SDK 内部字段（编码期对照官方文档）。

## 2. 契约定义（TContract）

```typescript
// app/server/src/channel/types.ts

/** channel 配置（纯数据；原 ChannelInstance 改名，字段全不变 → 磁盘 channel_config 记录全兼容）。
 *  一个 implId 可有多份 config（每份独立凭证/连接/binding）。 */
export interface ChannelConfig {
  id: string;            // ULID（值域 = 原 instance id，磁盘文件名不变）
  implId: string; name: string;
  enabled: boolean;      // config 级开关（这份 config 要不要连）⊥ impl 级 scope 门
  config: Record<string, unknown>;   // 凭证 + IM 特定配置（形态 = impl manifest configSchema）
  createdAt?: string; updatedAt?: string;
}

/** 无状态 channel impl 契约（= channel EP 的 TContract）。
 *  不持 config；一个 implId 一份实现实例，由 PluginManager.getExtensionImpls 供给。 */
export interface Channel {
  /** impl 类型标识（= implId，如 'feishu'） */
  readonly type: string;
  /** 按 config 建立连接并返 per-config 连接句柄；失败 throw（凭证缺失/网络）由 Manager 转 connection='error' */
  connect(config: ChannelConfig, backend: ChannelManagerBackend): Promise<ChannelHandle>;
}

/** per-config 连接句柄（connect 产出的会话对象；impl 自有实现，持 client/dedup/debounce/queue 等连接态） */
export interface ChannelHandle {
  /** = ChannelConfig.id（manager 索引 + accumulator echo self 判定用：
   *  origin.configId === handle.configId → DROP。self 判定按 configId 非 type
   *  （type=implId 不唯一，同一 implId 可有多份 config） */
  readonly configId: string;
  /** 主动断开（handler 注销 + socket close）；idempotent */
  disconnect(): Promise<void>;
  /** IM 事件入站（connect 内接 SDK 回调；UT 可直调）：解析 + 去重/去抖/顺序 + 路由（斜杠/deliverTo） */
  handleInbound(raw: unknown): Promise<void>;
  /** 出站：收到一条 assistant text Message（累积管线产出，block 级），格式化发 IM；不感知累积 */
  sendOutbound(msg: Message): Promise<void>;
  /** agent 输入状态联动（run_start→'typing' / run_end→'idle'）；无原生 API 时可 no-op */
  updateInputState(state: 'typing' | 'idle'): Promise<void>;
}
```

**v0.0.206 契约重构**：旧「impl 持 instance 的 5 方法契约」（`connect/disconnect/onInboundMessage/onOutBoundMessage/onUpdateInputState` 挂 impl + `Channel.instanceId` getter + 构造 `(instance, manager)` 焊死）已废——impl 与 config 解耦后才能接入 scope 激活模型（getExtensionImpls 标准 `(implId, cfg)` 投影）。旧 5 方法映射：`connect` 升到 impl（带 config 入参），其余 4 方法挂 handle（`onInboundMessage→handleInbound`、`onOutBoundMessage→sendOutbound`、`onUpdateInputState→updateInputState`）。

## 3. ChannelHandleBase（abstract，通用 helper）

```typescript
// app/server/src/channel/channel-base.ts

/**
 * ChannelHandle 契约的 abstract base —— 给连接句柄提供通用方法。
 * 句柄 extends 本类 + 实现 ChannelHandle 的 4 方法，不重复写通用逻辑。
 * （原 ChannelBase 焊死 (instance, manager) 构造，v0.0.206 整文件重写为本类。）
 */
export abstract class ChannelHandleBase implements ChannelHandle {
  protected config: ChannelConfig;           // 本句柄组合的那份配置（持引用：PUT mutate 同一对象 → 运行中句柄见新值）
  protected backend: ChannelManagerBackend;  // 反向引用（getBinding/bind/unbind/findConversationBySession/deliverTo/listSessions）

  constructor(config: ChannelConfig, backend: ChannelManagerBackend) { ... }
  get configId(): string { return this.config.id; }

  // ===== impl 必须实现的 4 方法（abstract） =====
  abstract disconnect(): Promise<void>;
  abstract handleInbound(raw: unknown): Promise<void>;
  abstract sendOutbound(msg: Message): Promise<void>;
  abstract updateInputState(state: 'typing' | 'idle'): Promise<void>;

  // ===== base 提供给句柄调用的通用方法（concrete，透传 backend，首参 configId = this.config.id） =====
  // getBindedSession(conversationId) → backend.getBinding（未绑返 null，UC-G3 提示）
  // deliverTo(sessionId, message) → backend.deliverTo（= agentManager.deliverTo，与 web client 对等入口）
  // bind(conversationId, sessionId, by) → backend.bind（双向唯一检查 + 持久化 + 建 outbound 累积管线）
  // unbind(conversationId) → backend.unbind（删 binding + 取消 outbound 订阅防泄漏）
  // findConversationBySession(sessionId) → backend.findConversationBySession(configId, sessionId)
  //   （sendOutbound 反查 conversation 用；manager 限定本 config 查询防互窜，无返 null）
  // listPlaygroundSessions() / listStudioLeaders() → backend.listSessions({biz:'playground'} / {biz:'studio', role:'leader'})
}
```

`ChannelManagerBackend` = manager 暴露给句柄的后门接口（`getBinding/bind/unbind/findConversationBySession/deliverTo/listSessions`，binding 系首参 `configId`）；实现方 = `ChannelManagerImpl`。

## 4. FeishuChannel（ExtImpl，本期唯一）

### 4.1 manifest（`app/plugins/builtins/feishu/plugin.json`）

```json
{
  "id": "feishu",
  "label": "__MSG_plugin.builtin.feishu.label__",
  "description": "__MSG_plugin.builtin.feishu.description__",
  "extImpls": [
    {
      "implId": "feishu",
      "point": "channel",
      "impl": "./feishu-channel.ts",
      "description": "__MSG_plugin.builtin.feishu.impl.feishu.description__",
      "configSchema": {
        "type": "object",
        "additionalProperties": false,
        "properties": {
          "appId": { "type": "string", "minLength": 1, "description": "__MSG_plugin.builtin.feishu.impl.feishu.config.appId.description__" },
          "appSecret": { "type": "string", "minLength": 1, "format": "secret", "description": "__MSG_plugin.builtin.feishu.impl.feishu.config.appSecret.description__" }
        },
        "required": ["appId", "appSecret"]
      }
    }
  ]
}
```

- **impl 路径**：`./feishu-channel.ts`（相对 plugin 目录，BuiltinLoader 解析）。
- **configSchema**（不变量 8 单一源）：`{appId, appSecret}` 两字段（D4 仅两字段，去 webhook 的 encryptKey/verificationToken）。**它是 channel_config 的校验 schema，不是 impl 构造 cfg**——impl 构造第二参 `cfg` 被忽略（feishu 凭证在 `connect(config, ...)` 时从 `config.config` 读）。
- **`format: "secret"`**：appSecret 字段标记为 secret，配置页用 `primitive-secret-input`（mask 展示：前≤4 + 中 `*` + 末≤4），GET 接口 redact 为占位 `'***'`。
- **default-export 类**：`feishu-channel.ts` 默认导出 `FeishuChannel implements Channel`（无状态）。

### 4.2 类骨架（无状态 impl + per-config 连接句柄）

```typescript
// app/plugins/builtins/feishu/feishu-channel.ts
/** 无状态 impl：不持 client/config；构造兼容标准 EP 签名 (implId, cfg)（getExtensionImpls 直供）。
 *  第三参 genMessageId 专为 UT 注入（生产 undefined → 内部默认 ulid 生成器）。 */
export default class FeishuChannel implements Channel {
  readonly type = 'feishu';
  constructor(implId?: string, _cfg?: unknown, genMessageId?: MessageIdGenerator) { ... }

  async connect(config: ChannelConfig, backend: ChannelManagerBackend): Promise<ChannelHandle> {
    const conn = new FeishuConnection(config, backend, this.genMessageId);
    await conn.open();   // readCredentials(config) → new FeishuClient → onMessage 接 handleInbound → client.connect()
    return conn;
  }
}

// app/plugins/builtins/feishu/feishu-connection.ts
/** per-config 连接句柄（extends ChannelHandleBase）：持全部连接态。
 *  逻辑 = 原 FeishuChannel per-instance 部分逐行等价搬迁（instance→config / manager→backend 改名，零逻辑改）。 */
export class FeishuConnection extends ChannelHandleBase {
  private client: FeishuClient | null;      // WSClient 封装（feishu-client.ts）
  private processed / processedOrder;        // message_id 去重（UC-G1）
  private debouncers / debouncedText;        // per conversationId 去抖
  private queueLocks;                        // per conversationId 顺序队列

  async open() { /* 建 WSClient + 注册 im.message.receive_v1 → this.handleInbound */ }
  async disconnect() { /* 清 timer + 断 client；idempotent */ }
  async handleInbound(raw) {
    // 1) parse event (message_id/chat_id/open_id/chat_type/content/mentions)
    // 2) 去重 tryBeginProcessing(message_id)
    // 3) 剥离 @bot mention（保留 / 前缀）
    // 4) 若 startsWith('/') → 派发斜杠（不进去抖，立即执行）
    // 5) 否则去抖 + 顺序队列 → parseFeishuMessage → base.deliverTo
  }
  async sendOutbound(msg) { /* content blocks → 飞书文本/图片（im.message.create）；超长分块 */ }
  async updateInputState(state) { /* no-op（飞书无原生 typing） */ }
}
```

### 4.3 辅助文件（feishu impl 内部）

- `feishu-connection.ts`：per-config 连接句柄（见 §4.2，连接态全部挂这里）。
- `feishu-client.ts`：WSClient 封装（连接 + 事件分发 + 发送 API），凭证从 `config.config` 读（`readCredentials`）。
- `feishu-protocol.ts`：事件解析（chatId/openId/content/mentions）+ 消息格式化（blocks→飞书 text/image）。
- `feishu-slash.ts`：斜杠指令识别（`/listp`/`/bindp`/`/lists`/`/binds`/`/unbind`/`/status`）+ 派发到 base helper。

## 5. 设计决策

### 5.1 channel = client 对等（不扩 source 枚举，D5）

**结论**：IM 用户消息 sender = `{ source: 'user', channel: { type, configId, conversationId, imUserId, imUserName } }`。**不新建 source 类型**（不加 `'channel'` source），只是 user 变体加可选 `channel` 标记。
**理由**：channel 与 client 对等（都把消息送给同一个 agent loop），不应让下游消费方（chat 渲染/搜索）需要分叉处理 user vs channel-user；channel 字段是「来源标记」，UI 展示「飞书用户 X 说了 Y」即可。
**实现**：`MessageSender` user 变体改为 `{ source: 'user'; channel?: { type, configId, conversationId, imUserId, imUserName } }`（仅加可选字段，向后兼容）。
**[v0.0.107] channel 加 `type` 字段**（implId，如 `'feishu'`）：其余字段只标识「哪份配置/会话/IM 用户」，**不标识「哪种 IM」**。加 `type` 后，下游（accumulator self 判定、client 来源徽标、跨渠道「User (from X)」渲染）才能按 IM 种类分流。
- `type` 值 = `ChannelConfig.implId`（feishu 入站 `feishu-connection.ts` 填 `type: this.config.implId`、`configId: this.config.id`）。
- client（web）发的 user 消息无 channel → message_start 事件层 origin 缺省 `{type:'client', configId:'0'}`（不构造 channel 子结构，只在事件 origin 上表达）。
- **[v0.0.206] `instanceId` → `configId`**（ChannelInstance 改名 ChannelConfig 全链联动）：wire 字段 `sender.channel.configId` / `origin.configId`；**历史 transcript 的 sender.channel 不迁**（append-only 不可变历史，origin 只对新消息实时派生，运行时消费零影响）；**channel_bindings 落盘字段走 MigrationManager 一次性迁移**（handler `channel-binding-config-id`，见 `../migration/log.md`）。

### 5.2 abstract base + interface（不全塞 impl）

**结论**：通用方法（deliverTo/bind/listSessions/getBindedSession/unbind/findConversationBySession）放 ChannelHandleBase abstract，句柄只实现 4 个 IM-specific 方法。base 提供 `protected` helper 让句柄调用。
**理由**：避免每个 IM impl 重复写 deliverTo/bind（DRY）；通用方法走 ChannelManager 集中（便于审计/单测）。
**反例**：若全塞 impl，加微信时复制粘贴一遍 deliverTo/bind。

### 5.3 sendOutbound 反查 conversation：findConversationBySession

**结论**：`ChannelHandle.sendOutbound(msg)` 契约只收 `Message`（不携带 conversationId），句柄必须自己反查「该 sessionId 对应哪个 conversation」才能发飞书。base 提供 `findConversationBySession(sessionId)` 透传 `backend.findConversationBySession(configId, sessionId)`；ChannelManager 内部限定本 config 查询（防 config 间互窜），即 `findBySession(sessionId).configId === this.config.id` 才返回 conversationId。
**理由**：sendOutbound 签名保持简洁（只收 msg，不额外塞 conversationId 字段污染 Message 类型）；反查逻辑走 manager 集中（便于审计 + 单测 + 双向唯一索引复用）。
**反例**：若把 conversationId 塞进 Message 透传，破坏 Message 类型纯净 + outbound 累积器（ChannelManager）要感知 channel-specific 字段，违反「channel 不感知累积」的反向（channel 不应让 manager 感知 channel-specific 字段）。

### 5.4 实例化：getExtensionImpls 直供 + connect 动态组合（v0.0.206 重写）

**结论**：impl 类由 manifest 声明，经 PluginManager `getExtensionImpls(ChannelPoint, 'default')` 按**标准 EP 签名 `(implId, cfg)` 实例化**（feishu 构造前两参兼容即可，cfg 忽略——configSchema 是 channel_config 校验 schema 非 impl cfg）；ChannelManager 拿 impl map 后按每份 channel_config 调 `impl.connect(config, backend)` **动态组合**出 per-config 句柄。
**与旧模型的差异**：v0.0.206 前 channel 不走 getExtensionImpls（旧构造 `(instance, manager)` 焊死与 EP 标准投影不兼容），由 ChannelManager 直接持 Registry `getImplById` 反射 `new`——那让 channel EP 绕过 scope 激活模型（default.yaml 不配也能用）。现 impl 无状态化后构造签名天然兼容 EP 投影，**scope 门物化点** = `ChannelManager.resolveImpl`（feishu 未在 default.yaml 激活 → impl map 无此项 → throw「未在 scope 'default' 激活」→ config 转 error 态，不重试不崩 server）。
**约束**：impl 类构造签名必须兼容 `(implId?: string, cfg?: unknown)`（manifest 约定，getExtensionImpls 只传 2 参；feishu 第三参 genMessageId 专为 UT 注入）。

### 5.5 configSchema 单一源（appId 普通 + appSecret secret）

**结论**（对齐 plugin_system 不变量 8）：feishu 的 `{appId, appSecret}` 落 `ExtImpl.configSchema`（JSON Schema），驱配置页表单 + 校验 + default 底座。appSecret 标 `format: "secret"` 走 `primitive-secret-input`（v0.0.90.ui 已有，复用 observability/providers/web-search 同款）。
**GET redact 约定**：`GET /config/channels` 返回的 instance.config.appSecret 一律 redact 为占位 `'***'`（仿 web-config-redact 套路），避免日志/响应泄漏；PUT 时 `'***'` 表示「未改」由后端 merge 原值。

### 5.6 Bun+飞书 SDK 兼容风险（编码期冒烟门禁，MANDATORY）

**结论**：`@larksuiteoapi/node-sdk` 在 Bun 下可能 hang（类 `bun-playwright connectOverCDP` 已知 bug #9357）。**编码期必须冒烟验证**：能 import + 能 new WSClient + 能连上飞书 + 能收事件 + 不 hang。
**兜底方案**：若中招，feishu-client.ts 走 **node 子进程**（spawn `node` 跑独立 SDK 进程，IPC 传事件/消息），主进程不直接 import SDK。
**门禁位置**：编码期冒烟脚本（`feishu.env` 真凭证手动跑），失败 → 升级 architect 评估 node 子进程方案 + 用户裁决。

### 5.7 [v0.0.118] 出站发送超时 + 全链路日志（发送鲁棒性）

**结论**：`FeishuClient.sendMessage`（`feishu-client.ts`）用 `withTimeout(promise, 30000, label)` 包住 `httpClient.im.message.create(...)`，30s 未返回即抛错（`SEND_TIMEOUT_MS = 30000`）。

**根因（本版本修复的停发 bug）**：Lark SDK 的 `defaultHttpInstance = axios.create()`（无参）→ axios 默认 `timeout=0`（**永不超时**）。一次 HTTP 挂死（休眠 half-open TCP / 切网 / 代理静默丢包）→ 上层 `await` 永不返回。在 v0.0.118 发送解耦前，这会冻结整条消费 loop（→ 停发）；解耦后（§`[P0]channel_manager.md §3.5`）仅卡住 SendQueue 一格，但超时仍是必需——否则 SendQueue 的重试/放行永不触发。

**全链路日志契约**（`[feishu][outbound]` 前缀，每次发送必留痕，排查停发/挂死/空丢弃的可见性）：
- **开始**：`sendMessage 开始 receiveId=X msg_type=Y content(N 字符)=preview`（内容截断 50 字符，不打全文）。
- **成功**：`sendMessage 成功 receiveId=X 耗时=Nms [message_id=...]`。
- **超时/网络失败**：`sendMessage 失败 receiveId=X 耗时=Nms 错误: <e>`（超时错误 message 含 label `feishu sendMessage receiveId=X`，可定位来源）。
- **API 错误**（`resp.code !== 0`）：`sendMessage API 错误 receiveId=X 耗时=Nms` + 抛错（含 code/msg）。

**`withTimeout` label 参数**（`feishu-helpers.ts`）：`withTimeout<T>(promise, timeoutMs, label?)` 加可选 `label`——超时 Error message = `${label} timeout after ${timeoutMs}ms`（不传则 `sequential task timeout after ${timeoutMs}ms`），让超时可定位来源（区分 sendMessage 超时 vs inbound 顺序队列超时）。

**空 payload warn**（`sendOutbound`，`feishu-connection.ts`）：`formatFeishuOutbound(msg, chatType)` 返回空数组（content blocks 有内容但格式化后为空）时，从原「静默 return」改为 `console.warn('[feishu][outbound] 空 payload 丢弃 sessionId=X blockTypes=[...]')` 再 return——空 payload 是排查盲点（发出去了没 / 内容为空），须可见。

## 6. 边界

| 零件 | 归属 |
|---|---|
| Channel 契约（无状态 type+connect）+ ChannelHandle 4 方法 + ChannelConfig + ChannelHandleBase abstract 通用方法 | 本文件 ✅ |
| FeishuClient.sendMessage 30s 超时 + 发送日志契约 + withTimeout label + 空 payload warn | 本文件 §5.7 ✅ |
| channel EP 定义 + groups.json 登记 | `[P0]channel_extension_point.md` |
| ChannelManager 组合与消费 EP（ensureImpls/resolveImpl scope 门 + per-config connect + outbound subscribe） | `[P0]channel_manager.md` |
| 飞书 SDK 内部字段（事件 JSON / 发送 API / @bot 剥离） | `design-feishu.md §9`（编码期对照官方文档） |
| MessageSender user 变体扩 channel? 字段 | `../agent/message/[P0]agent_message_interface.md §5` |
| secret-input primitive | `../../../specs/ui/components/framework/primitive-secret-input.md` |
