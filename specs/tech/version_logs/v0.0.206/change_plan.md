# v0.0.206 变更计划书 — channel 无状态 impl/config 动态组合 + 接入 scope 激活模型（删 D6）

> **method 级 review 合同**。架构期冻结：coder 按本表实现，code-reviewer 按本表查偏离。事后偏差写进 `change_log.md`。

## 背景与核心决策

**问题**：channel EP（唯一 impl=feishu）绕过 scope 激活模型（`default.yaml` 不配也能用）；且 channel impl 构造焊死 `(instance, manager)`，与 EP 标准 `(implId, cfg)` 投影根本不兼容。

**决策（用户拍板的新模型）**：
- **D1 删 D6**：default scope 无特权，membership 即启用对 default 同效——`default.yaml` 配了才可用，不配 = 关。
- **D2 channel EP 进 default.yaml**：补 channel group/point/feishu impl（保持现状可用；删掉即关）。
- **D3 channel 实现无状态化 + config 纯数据化 + 动态组合（核心重构）**：Channel impl = 无状态协议行为类（构造 `(implId, cfg)` 标准 EP 签名，`getExtensionImpls` 直接供给）；ChannelConfig（原 ChannelInstance 改名）= 纯数据（一份=一个飞书机器人）；二者在 `connect(config, backend)` 时组合，产出 **per-config 连接句柄 ChannelHandle**（会话对象，持 client/dedup/debounce/queue 等连接态）。同一无状态 impl 可并行组合多份 config。**旧 listActiveImplIds 方案作废**（不再需要——getExtensionImpls 构造签名天然兼容）。
- **D4 ChannelManager = 组合器**：`getExtensionImpls(ChannelPoint,'default')` resolve 出 impl map（**scope 门物化点**：feishu 不配 → map 无此项 → 连接/校验失败）；按 channel_config 逐份 `impl.connect(config)` 组合；runtime/binding 挂 configId。
- **D5 改名 instance→config 全链**：domain 类型（ChannelInstance→ChannelConfig、binding.instanceId→configId、manager 方法）+ wire 字段（`sender.channel.instanceId`、`origin.instanceId` → `configId`）。channel_config 落盘字段名全不变（磁盘兼容零迁移）；channel_bindings 落盘字段改名**走 MigrationManager 一次性迁移**（用户裁决「改 + 做迁移」，handler 见模块九）；历史 transcript 的 sender.channel 不迁（append-only 不可变历史，边界与理由见 §影响面评估「迁移边界」）。
- **D6 前端 impl 类型列表后端派生**：新增 `GET /config/channels/impl-types`（scope 激活集合驱动）。
- **D7 `channel_config.enabled` 语义保留**：config 级开关（这份 config 要不要连）⊥ impl 级 scope 门（这个 impl 能不能用）。
- **命名警示**：channel 子系统自有「D6=binding 双向唯一」（§3.4）与本次删除的 plugin scope D6 **无关，严禁误删**。

## 新契约签名（契约核心 — coder 锚点）

```typescript
// app/server/src/channel/types.ts
/** channel 配置（纯数据；原 ChannelInstance 改名）。一个 implId 可有多份 config。落 channel_config 域。 */
export interface ChannelConfig {
  id: string;            // ULID（值域=原 instance id，磁盘文件名不变）
  implId: string; name: string;
  enabled: boolean;      // config 级开关（D7）
  config: Record<string, unknown>;   // 凭证+IM 特定配置（形态= impl manifest configSchema）
  createdAt?: string; updatedAt?: string;
}

/** 无状态 channel impl 契约（协议行为类；不持 config；一个 implId 一份实现实例，由 PluginManager 供给） */
export interface Channel {
  readonly type: string;  // = implId
  /** 按 config 建立连接并返 per-config 连接句柄；失败 throw（凭证缺失/网络） */
  connect(config: ChannelConfig, backend: ChannelManagerBackend): Promise<ChannelHandle>;
}

/** per-config 连接句柄（connect 产出的会话对象；impl 自有实现，持 client/dedup/debounce/queue 等连接态） */
export interface ChannelHandle {
  readonly configId: string;                       // = ChannelConfig.id（manager 索引 + echo self 判定）
  disconnect(): Promise<void>;                     // idempotent
  handleInbound(raw: unknown): Promise<void>;      // IM 事件入站（connect 内接 SDK 回调；UT 可直调）
  sendOutbound(msg: Message): Promise<void>;       // 出站（累积管线产出）
  updateInputState(state: 'typing' | 'idle'): Promise<void>;
}
```

原 5 方法映射：`connect`（升到 impl、带 config 入参）+ `disconnect`/`handleInbound`（原 onInboundMessage）/`sendOutbound`（原 onOutBoundMessage）/`updateInputState`（原 onUpdateInputState）（挂 handle）。**`Channel.instanceId` 删除**——impl 不再绑 config；echo self 判定改 `origin.configId === handle.configId`。

## 列定义（8 列，行 = 一个函数/符号）

模块 / 文件路径 / 函数·符号 / 类型（新增·修改·删除）/ 变更内容 / 约束（MUST·MUST NOT）/ 参考 / 预计影响行。

## 变更清单

### 模块一：plugin_system — 删 D6（已评估 16 EP 零回归）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| plugin_system | app/server/src/plugin/scope-config-provider.ts | LoadedScopeConfigProvider.isPointActivated() | 修改 | 删 :118 `if default return true`；default 同路径 `cfg ? cfg.activatedPoints.includes(pointId) : false` | MUST NOT 留 default 特判 | specs/tech/config/[P0]ext_impl_scope.md §4.2 | +1/-2 |
| plugin_system | app/server/src/plugin/scope-config-provider.ts | LoadedScopeConfigProvider.listActivatedPoints() | 修改 | 删 :125 短路；签名删死参数 `allPointIds`；返 `cfg?.activatedPoints.slice() ?? []` | MUST 同步 interface + 唯一生产调用方 plugin-config-service | CLAUDE.md 不留死代码 | +1/-3 |
| plugin_system | app/server/src/plugin/scope-config-provider.ts | ScopeConfigProvider.listActivatedPoints（interface） | 修改 | 签名改 `(scopeId: string): string[]`；jsdoc 改「返该 scope yaml 声明集」 | MUST typecheck 找出全部实现/调用方（含 UT mock） | plugin_system/[P1]scopes_config_decl.md §3.3 | +2/-3 |
| plugin_system | app/server/src/plugin/scope-config-provider.ts | LoadedScopeConfigProvider.resolveSourceScope() | 修改 | 删 :131 default 短路（冗余：loop guard 对 'default' 自然落 return 'default'，行为不变）；保留 unregistered throw + extends 链 | MUST NOT 动 :137 throw 与 :146-153 链逻辑；保留 DEFAULT_SCOPE_ID 常量（链终点） | v0.0.204 change_log | +0/-2 |
| plugin_system | app/server/src/plugin/scope-config-provider.ts | 文件头 + 三方法 jsdoc | 修改 | 去 D6 表述，写新语义「default 无特权，激活=point 节点存在，membership=impls key」；引用处写「plugin scope D6（v0.0.206 已删）」消歧 | MUST 与 channel D6（binding 双向唯一）消歧 | 本文件 §背景 | +8/-8 |
| plugin_system | app/server/src/plugin/plugin-config-service.ts | PluginConfigService.listActivatedPoints() | 修改 | 删 `this.registry.listPoints()` 第二参；jsdoc 改「default 返 default.yaml 声明集」 | 非 default 行为不变 | ext_impl_scope.md §6 | +2/-2 |
| plugin_system | app/server/src/handlers/plugin-scope-handlers.ts | handleScopeActivation() 注释 | 修改 | :47-48/:60 去「D6 短路」表述；运行逻辑与 404 不变 | MUST NOT 改运行逻辑 | specs/api/overall/03-config-center.md | +2/-2 |
| plugin_system | app/server/src/plugin/scope-activation-store.ts | 文件头 D6 注释（:12-13） | 修改 | 改述「v0.0.206 起 default 激活态同由 default.yaml 声明」；store 为 deprecated 读路径保留件 | 纯注释 | ext_impl_scope.md §3 | +2/-2 |
| plugin_system | app/server/src/plugin/inventory-builder.ts | isPointActivated() jsdoc（:123） | 修改 | 删「含 D6 default 短路」括注 | 纯注释 | — | +1/-1 |
| plugin_system | app/server/src/plugin/plugin-manager.ts | 文件头 + getExtensionImpls jsdoc（:16,:75） | 修改 | 去 D6 表述；补「channel 等 EP 经本方法直供无状态 impl（v0.0.206）」 | 实现零改动（本版不动 getExtensionImpls 内部逻辑） | plugin_manager_interface.md §3.6 | +3/-3 |

### 模块二：scopes 声明 — channel EP 进 default.yaml

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| plugin_system | app/plugins/scopes/default.yaml | groups[] 新增 channel 节点 | 修改 | 文件尾加 `- id: channel` + `points: [{pointId: channel, impls: [feishu]}]`；description「全 16 EP」改「全 17 EP」 | MUST 与 groups.json channel group 一致（validateGroups 双向一致）；channel=list 不触发 exclusive 恰好 1 | groups.json:40-43；scopes_config_decl §4 | +6/-1 |

### 模块三：channel 契约重构 — 无状态 impl + ChannelHandle + ChannelConfig

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| channel | app/server/src/channel/types.ts | ChannelConfig（原 ChannelInstance） | 修改 | 类型改名 + 注释改「纯数据配置」；字段全不变（id/implId/name/enabled/config/createdAt/updatedAt）→ 磁盘 channel_config 记录全兼容 | MUST 字段名零变化（值域/文件名兼容） | channel_manager.md §3.7 | +4/-3 |
| channel | app/server/src/channel/types.ts | Channel interface | 修改 | 删旧 5 方法 + `instanceId` getter；新契约 = `readonly type` + `connect(config, backend): Promise<ChannelHandle>`（签名见 §新契约） | MUST 不持 config（无状态）；impl 构造签名约定 `(implId, cfg)`（PluginManager.instantiate 标准） | channel_impl_interface.md §2（重写） | +8/-16 |
| channel | app/server/src/channel/types.ts | ChannelHandle interface | 新增 | `configId` + `disconnect` + `handleInbound` + `sendOutbound` + `updateInputState`（签名见 §新契约） | MUST 为 per-config 会话对象（连接态挂这里，不挂 impl） | 本文件 §新契约 | +14 |
| channel | app/server/src/channel/types.ts | ChannelBinding.instanceId → configId | 修改 | 字段改名（落盘 channel_bindings 记录内字段；文件名模式 `<configId>__<conversationId>` 值不变） | MUST 配 MigrationManager 一次性迁移 handler（模块九——用户裁决「改+做迁移」）；MUST NOT 在 store 读路径加旧字段兼容/防御分支 | specs/tech/migration/[P0]migration_manager.md §3.1 | +3/-3 |
| channel | app/server/src/channel/types.ts | ChannelState 等注释 | 修改 | 「实例」改「配置（config）」；字段与取值不变（API 契约不动） | MUST NOT 改字段名（17-channel.md §2 契约不动） | specs/api/overall/17-channel.md | +3/-3 |
| channel | app/server/src/channel/channel-base.ts | ChannelBase → ChannelHandleBase 整文件重写 | 修改 | 构造 `(config: ChannelConfig, backend: ChannelManagerBackend)`；`get configId() { return this.config.id }`；abstract 4 方法；concrete helper（getBindedSession/bind/unbind/findConversationBySession/deliverTo/listPlaygroundSessions/listStudioLeaders）`this.instance.id`→`this.config.id`、`this.manager`→`this.backend` | handle 持 config **引用**（PUT mutate 同一对象→运行中 handle 见新值，保 §3.10 语义）；MUST NOT 在 base 持连接态（client 归 impl 子类） | channel_manager.md §3.10 | +10/-12 |
| channel | app/server/src/channel/channel-base.ts | ChannelManagerBackend interface | 修改 | 5 方法首参 `instanceId` 改名 `configId`（语义/值域不变） | 实现方 ChannelManagerImpl 同步 | — | +6/-6 |
| channel | app/plugins/builtins/feishu/feishu-channel.ts | FeishuChannel 重写为无状态 impl | 修改 | 删 `extends ChannelBase` + 旧构造 `(instance, manager)` + 全部 per-config 状态与方法（迁出）；新：`class FeishuChannel implements Channel`，构造 `(implId?: string, _cfg?: unknown, genMessageId?: MessageIdGenerator)`；`connect(config, backend)` → `new FeishuConnection(config, backend, this.genMessageId)` + `await conn.open()` + 返 conn | MUST 前两参兼容 `(implId, cfg)`（getExtensionImpls 直供；UT 走 3 参注入 id 生成器）；cfg 忽略（configSchema 是 channel_config 校验 schema 非 impl cfg）；MUST NOT 持 client/config | channel_impl_interface.md §4（重写） | +18/-60 |
| channel | app/plugins/builtins/feishu/feishu-connection.ts | FeishuConnection class | 新增 | `extends ChannelHandleBase`：持 `client: FeishuClient\|null` + processed/processedOrder + debouncers/debouncedText + queueLocks + genMessageId；`open()`（readCredentials(config)→new FeishuClient→onMessage 接 `this.handleInbound`→client.connect()）；实现 disconnect（清 timer+断 client）/handleInbound（原 onInboundMessage 整体搬迁）/sendOutbound（原 onOutBoundMessage）/updateInputState（no-op）；私有 helper 原样搬迁（tryBeginProcessing/scheduleDebounce/enqueueSequential/handleSlash/deliverUserMessage/sendUnboundHint/resolveChatType），`this.instance`→`this.config`、`this.manager`→`this.backend`、sender.channel 填 `configId: this.config.id` | MUST 与原 FeishuChannel 行为逐行等价（纯搬迁+改名，零逻辑改）；sender.channel.type=`this.config.implId` | 原 feishu-channel.ts :43-313 | +290 |

### 模块四：ChannelManager 组合器 + 管线适配

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| channel | app/server/src/channel/channel-manager.ts | ChannelManager interface | 修改 | 改名：`registerInstance→registerConfig(config): Promise<void>`（原返 Channel 无消费方）、`unregisterInstance→unregisterConfig`、`updateInstance→updateConfig`；`subscribeOutbound/unsubscribeOutbound(sessionId, handle: ChannelHandle)`；新增 `listActiveImpls(): Channel[]`；binding 系首参改名 configId | MUST 无 instanceId 残留；`deleteBindingsBySession/ByInstance` 保留（改名后签名） | channel_manager.md §2（重写） | +16/-14 |
| channel | app/server/src/channel/channel-manager.ts | RuntimeState | 修改 | `channel: Channel` → `handle?: ChannelHandle`（connect 成功前 undefined） | — | — | +2/-2 |
| channel | app/server/src/channel/channel-manager.ts | ChannelManagerOptions | 修改 | 新增 `pluginManager: PluginManager`（getExtensionImpls 供无状态 impl）；`registry` 保留（管理面：configSchema 校验 + label 反查） | MUST type-only import PluginManager | channel_manager.md §4（T4 修订） | +4/-1 |
| channel | app/server/src/channel/channel-manager.ts | ChannelManagerImpl.ensureImpls()（private） | 新增 | lazy：`this.impls ??= new Map(pluginManager.getExtensionImpls<Channel>(ChannelPoint as ExtensionPoint<Channel>, 'default').map(c => [c.type, c]))`（yaml 静态，缓存安全） | MUST 只调 getExtensionImpls（scope 解析单源）；MUST NOT 裸查 registry 取实现 | ext_impl_scope.md §5.2（例外删除） | +6 |
| channel | app/server/src/channel/channel-manager.ts | ChannelManagerImpl.resolveImpl()（private） | 新增 | `ensureImpls().get(implId) ?? throw Error('ChannelManager: implId "x" 未在 scope \'default\' 激活（default.yaml 未配置 channel impl）')` | 此 throw = scope 门物化；文案含「未激活」便于排障 | req 验收状态 | +4 |
| channel | app/server/src/channel/channel-manager.ts | ChannelManagerImpl.listActiveImpls() | 新增 | `return [...this.ensureImpls().values()]` | handler impl-types 端点 + POST 激活校验消费 | — | +3 |
| channel | app/server/src/channel/channel-manager.ts | ChannelManagerImpl.bootstrap() | 修改 | rebuildReverseIndex → `ensureImpls()` → 扫 channel_config：configs.set + runtime.set + enabled→`void this.spawnConnect(cfg).catch(()=>{})` | MUST NOT 阻塞 server.listen | channel_manager.md §3.1 | +4/-4 |
| channel | app/server/src/channel/channel-manager.ts | ChannelManagerImpl.spawnConnect()（private，原 spawnChannelAndConnect） | 修改 | `const impl = this.resolveImpl(cfg.implId)`（**gate 失败→error 态立即返回，不进 retry**——确定性失败重试无意义）→ `await this.connectWithRetry(cfg.id, () => impl.connect(cfg, this))`；catch→rt error 态 | MUST gate 在 retry 外；fire-and-forget 由调用方 void | channel_manager.md §3.3 | +12/-10 |
| channel | app/server/src/channel/channel-manager.ts | ChannelManagerImpl.connectWithRetry()（private） | 修改 | 签名加 `connectFn: () => Promise<ChannelHandle>` 委托 retry；成功后重建 binding 的 subscribeChannel（不变） | — | channel-retry.ts | +3/-3 |
| channel | app/server/src/channel/channel-manager.ts | registerConfig/unregisterConfig/setEnabled/updateConfig | 修改 | 改名+适配：registerConfig 落 configs/runtime + enabled→spawnConnect（返 void）；unregisterConfig `rt.handle?.disconnect()`；setEnabled on→spawnConnect（fresh handle，gate 重过）/off→abort retry+`rt.handle?.disconnect()`+unsubscribe；updateConfig mutate 同一 config 引用 | MUST off 路径对 handle undefined 安全（gate 失败的 config toggle off 不崩） | channel_manager.md §3.3/§3.10 | +10/-10 |
| channel | app/server/src/channel/channel-manager.ts | getState/getAllStates/binding 系/subscribe 系 | 修改 | configs Map 源 + handle 参数 + configId 改名；accumulator 自愈查找 `r.handle === handle` | binding 双向唯一（channel D6）逻辑零变化 | channel_manager.md §3.4 | +12/-12 |
| channel | app/server/src/channel/channel-retry.ts | connectChannelWithRetry() | 修改 | 签名改 `(rt, controller, connectFn: () => Promise<ChannelHandle>)`；每 attempt `rt.handle = await connectFn()`（fresh handle）；删 `!channel` 守卫（connectFn throw 即 errorDetail 来源，含 gate 文案） | MUST 保留 3 次×5s + aborted 语义 + connect 成功后被 off 的 disconnect 补偿（对新 handle 调） | channel_manager.md §3.3 | +8/-6 |
| channel | app/server/src/channel/channel-accumulator.ts | runChannelAccumulator() | 修改 | 签名 `channel: Channel`→`handle: ChannelHandle`；`onOutBoundMessage→sendOutbound`、`onUpdateInputState→updateInputState`、日志/echo `channel.instanceId`→`handle.configId`（:46,84,88,124,156,158） | echo self 判定语义不变（同 config 的 user 消息 DROP） | channel_manager.md §3.5.1 | +8/-8 |
| channel | app/server/src/channel/channel-send-queue.ts | SendQueue | 修改 | 构造参数与字段 `channel: Channel`→`handle: ChannelHandle`；`channel.onOutBoundMessage`→`handle.sendOutbound`（:101） | 保序/有界/重试逻辑零变化 | channel_manager.md §3.5.0 | +5/-5 |
| channel | app/server/src/channel/channel-binding-store.ts | 全方法 + 字段 + SchemaDef | 修改 | `instanceId`→`configId` 全链（get/upsert/delete/deleteBySession/deleteByInstance/findBySession/rebuildReverseIndex/listByInstance/countByInstance）；**`ChannelBindingSchema.fields.instanceId` → `configId`（required，落盘 schema 同步改名）**；`bindingId()` 参数改名 | 双向唯一语义零变化；schema 改名后旧记录须经模块九迁移才可读（MigrationManager 先于 Phase 10 store 使用，时序保证） | types.ts ChannelBinding 行；session-derivation-main-to-parent 先例 | +20/-20 |
| channel | app/server/src/channel/channel-config-service.ts | 类型引用 + 注释 | 修改 | `ChannelInstance`→`ChannelConfig`；注释「多 instance」→「多 config」；SchemaDef 字段零变化 | MUST NOT 改 ChannelConfigSchema 字段（磁盘兼容） | — | +8/-8 |

### 模块五：handler + impl-types 端点 + 装配

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| channel | app/server/src/handlers/channel.ts | lookupChannelImpl() | 修改 | 双段校验，签名 `(deps, implId)` 返 `{ ok:true; reg } \| { ok:false; error }`：①注册 `registry.getByPoint('channel')`（管理面/校验保留）→ 未注册 `"implId 'x' not registered as channel EP"`；②激活 `deps.channelManager.listActiveImpls().some(c => c.type === implId)` → 未激活 `"implId 'x' is registered but not activated in scope 'default'（default.yaml 未配置 channel impl）"` | MUST 两种 400 文案区分；MUST NOT 用 registry 判激活（scope 解析单源=PluginManager，经 manager 物化） | req 决策 | +12/-4 |
| channel | app/server/src/handlers/channel.ts | handleChannelCreate() | 修改 | 适配 lookupChannelImpl 新返回（`!res.ok → 400`）；`registerInstance`→`registerConfig`；文件头约束注释同步 | MUST 保持校验顺序：格式→name→注册+激活→configSchema→enabled | 17-channel.md §3 | +5/-4 |
| channel | app/server/src/handlers/channel.ts | handleChannelUpdate/Delete/List | 修改 | `updateInstance→updateConfig`、`unregisterInstance→unregisterConfig` 适配；逻辑零变化 | — | — | +4/-4 |
| channel | app/server/src/handlers/channel.ts | handleChannelImplTypes() | 新增 | GET /config/channels/impl-types：`channelManager.listActiveImpls()` → 每项 `{ implId: c.type, label: registry.getPluginManifest(registry.getImplById(c.type)!.pluginId)?.label ?? c.type }`；返 `json(200,{items})` | label 透传原始 `__MSG_` 占位符（前端 resolveI18nField）；getImplById 此处为管理面反查 pluginId | 17-channel.md（新增端点，doc-modifier 补） | +14 |
| channel | app/server/src/handlers/channel.ts | handleChannelRoute() | 修改 | 新增字面分支 `path === '/config/channels/impl-types'`（GET→handler，其他 method→405），**位于 `/config/channels/:id` 正则之前** | MUST 分支顺序钉死，否则 'impl-types' 被 :id 吞 | channel.ts :260-297 | +6 |
| channel | app/server/src/channel/channel-bootstrap.ts | 文件头注释 | 修改 | 补「ChannelManagerImpl 经 pluginManager.getExtensionImpls 供无状态 impl（v0.0.206）」 | 纯注释（opts 类型自动带新字段） | — | +1 |
| channel | app/server/src/bootstrap-connectors-phase.ts | deps + 调用点 + shutdown hook | 修改 | deps 接口加 `pluginManager: PluginManager`（type import）；`createAndBootstrapChannelManager({...})` 加 `pluginManager`；shutdown hook `unregisterInstance→unregisterConfig` | MUST type-only import | bootstrap-connectors-phase.ts :47-93 | +5/-2 |
| channel | app/server/src/bootstrap.ts | Phase 10 调用点（:384 区间） | 修改 | `bootstrapConnectorsPhase({...})` deps 加 `pluginManager`（:275 已解构） | 单行传递 | bootstrap.ts :275,:384 | +1 |

### 模块六：wire 字段改名（sender.channel.instanceId / origin.instanceId → configId）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| message | app/server/src/message/types.ts | MessageSenderChannel.instanceId → configId | 修改 | :338 字段改名 + 注释（`= ChannelConfig.id`）；判别联合其余字段不动 | MUST grep 全量引用一并改（rename-refs-batch-sed-verify）；改完 grep `instanceId` 残留归零（channel 域外历史注释除外） | agent_message_interface.md §5 | +3/-3 |
| agent | app/server/src/agent/agent-event-types.ts | origin.instanceId → configId | 修改 | :146,:151 字段改名 + 注释（client 缺省 `{type:'client', configId:'0'}`） | wire 形状变更，前端 reducer 同步（本模块下行） | agent_event.md §4.2 | +3/-3 |
| agent | app/server/src/agent/agent-loop-emitters.ts | deriveOrigin() + 调用点 | 修改 | :116,:133-144 `instanceId`→`configId`（含 `sender.channel.configId` 读取 + client 缺省 `'0'`） | 行为零变化（纯改名） | — | +5/-5 |
| agent | app/server/src/agent/__tests__/emit-user-message-origin.test.ts | origin 断言 | 修改 | 断言字段 `instanceId`→`configId` | — | — | +4/-4 |
| ui-chat | app/web/src/store/reducer/agent-event-types.ts + app/web/src/store/reducer/apply-agent-event.ts + app/web/src/components/chat-page/types/message.ts | origin/sender.channel 字段 | 修改 | 前端 wire 镜像类型 + 读取处 `instanceId`→`configId` 同步改名 | MUST 与 server wire 形状一致（SSE 契约同源） | agent_event.md §4.2 | +8/-8 |
| ui-chat | app/web/src/store/__tests__/chat-slice-reducer.test.ts + chat-slice-reducer-a2a-sender.test.ts + app/web/src/components/chat-page/__tests__/message-flatten.test.ts | 测试 fixture/断言 | 修改 | `instanceId`→`configId` 适配 | — | — | +8/-8 |

### 模块七：前端 — 类型改名 + impl 类型列表派生 + 空态

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-channel | app/web/src/lib/channel-api.ts | ChannelInstance → ChannelConfig | 修改 | 接口改名 + 注释（字段不动，API 契约不变）；下游 import 同步（page/section/__tests__） | MUST NOT 改字段名（17-channel.md 不动） | — | +6/-6 |
| ui-channel | app/web/src/lib/channel-api.ts | ChannelImplTypeInfo + listChannelImplTypes() | 新增 | `{ implId: string; label: string }`；GET /config/channels/impl-types → `r.items ?? []` | label 为原始 `__MSG_` 占位符，MUST NOT 在 lib 层解析 i18n | 17-channel.md（新端点） | +10 |
| ui-channel | app/web/src/components/channel-page/page-channel.tsx | CHANNEL_IMPL_TYPES 常量（:31-39） | 删除 | 删硬编码 `[{implId:'feishu',label:'飞书'}]` 及 TODO 注释块 | 全删不 deprecated | memory delete-old-code-fully | -9 |
| ui-channel | app/web/src/components/channel-page/page-channel.tsx | implTypes state + mount fetch | 新增 | `useState<ChannelImplTypeInfo[]>([])`；useEffect mount 一次性 `listChannelImplTypes()`（AbortController，失败 catch 置 []）；渲染期 map `{implId, label: resolveI18nField(raw.label, tPc)}` 传 SectionChannelForm；新增 `tPc = useTranslation('plugin-config').t` | MUST 不进 5s useLifecycle poll（静态代码声明）；MUST 用 plugin-config ns 的 t 解析 label | component_architecture.md §3.10；下方拆解表 | +22 |
| ui-channel | app/web/src/components/channel-page/section-channel-form.tsx | options useMemo（:57）+ implId 初值（:47） | 修改 | 删 types 空时 feishu 兜底→空数组；初值 `?? 'feishu'` 改 `?? ''`；`ChannelInstance`→`ChannelConfig` 类型适配 | MUST NOT 留 feishu 硬编码兜底 | req 验收状态 | +3/-4 |
| ui-channel | app/web/src/components/channel-page/section-channel-form.tsx | types 空态渲染 | 新增 | types.length===0：select disabled + `{t('form.noImplTypes')}` 提示 + 提交 disabled | 空态不阻断既有 config 列表/编辑 | section-channel-form.md（coder 前置） | +8 |
| ui-channel | app/web/src/components/channel-page/section-channel-list.tsx | 类型适配 | 修改 | `ChannelInstance`→`ChannelConfig`（import + props 类型） | 纯改名 | — | +4/-4 |
| ui-channel | app/web/src/i18n/locales/zh-CN/channel.json + en/channel.json | form.noImplTypes | 新增 | zh「无可用渠道类型（channel impl 未在 default.yaml 激活）」/ en "No channel type available (channel impl not activated in default.yaml)" | MUST 两语言都加 + t() 渲染 | memory i18n-key-add-checklist | +2 |
| ui-channel | app/web/src/components/channel-page/__tests__/channel-page.test.tsx | 类型 + mock 适配 | 修改 | `ChannelInstance`→`ChannelConfig`；mock `listChannelImplTypes`（vi.mock channel-api 新增函数） | — | — | +8/-6 |
| ui-channel | specs/ui/components/channel-page/page-channel.md + section-channel-form.md | 组件 spec | 修改 | coder **编码前置**更新：impl-types 数据源拆解 + types 空态契约 + 删「硬编码 feishu」描述 + instance→config 术语 | MUST 先 spec 后实现 | _conventions.md | ~24 |

### 模块八：UT 重写/修复/新增

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| channel | app/plugins/builtins/feishu/__tests__/feishu-channel.test.ts | 全文件重写适配 | 修改 | 构造模式改：`const impl = new FeishuChannel('feishu', {}, mockGen)` + `const h = await impl.connect(makeConfig(), makeManager())` + `h.handleInbound(raw)` / `h.disconnect()`；断言语义逐用例保留（去重/去抖/斜杠/未绑定提示/deliverTo） | MUST 与原用例语义一一对应（纯构造适配，不删覆盖） | 模块三 FeishuConnection 行 | +40/-40 |
| channel | app/plugins/builtins/feishu/__tests__/feishu-channel-outbound-warn.test.ts | 构造适配 | 修改 | 同上模式：impl.connect→handle.sendOutbound；空 payload warn 断言保留 | — | — | +10/-10 |
| channel | app/server/src/channel/__tests__/channel-binding-and-redact.test.ts | makeCm + FakeChannel | 修改 | opts 加 `pluginManager` mock（`getExtensionImpls` 返 `[fakeImpl]`）；FakeChannel 拆 FakeImpl（connect→FakeHandle）+ FakeHandle（configId/disconnect/handleInbound/sendOutbound/updateInputState）；binding/redact 断言语义保留 | — | 模块四 | +30/-20 |
| channel | app/server/src/channel/__tests__/channel-accumulator-lifecycle.test.ts | mock 适配 | 修改 | mock channel→handle（sendOutbound/updateInputState/configId）；生命周期/自愈断言保留 | — | — | +16/-16 |
| channel | app/server/src/channel/__tests__/channel-retry.test.ts | connectFn 签名适配 | 修改 | 传 `() => Promise<handle>`；3 次×5s/abort/补偿断言语义保留 | — | — | +12/-12 |
| channel | app/server/src/channel/__tests__/channel-config-service.test.ts + channel-binding-store.test.ts | 类型/字段改名适配 | 修改 | `ChannelInstance`→`ChannelConfig`、`instanceId`→`configId`（import/fixture/断言） | 纯改名，断言语义不变 | — | +14/-14 |
| channel | app/server/src/channel/__tests__/channel-scope-gate.test.ts | 新文件 | 新增 | 4 用例：①resolveImpl impl 未激活（getExtensionImpls 返 []）→ spawnConnect → connection='error' + errorDetail 含「未在 scope 'default' 激活」且不 retry（connectFn 0 次）；②激活 → connect 成功 connected；③listActiveImpls 返 impl 列表；④**multi-config 并行**：同一 fakeImpl 两份 config 各 spawnConnect → 两个独立 handle（connect 调用各收对应 config，互不影响） | MUST 仿 binding-and-redact mock 结构；④=动态组合核心卖点护栏 | req 新模型 | +70 |
| channel | app/server/src/handlers/__tests__/channel.test.ts | makeMockChannelManager + 新用例 | 修改 | mock 加 `listActiveImpls: () => [{ type: 'feishu' }]` + 改名方法适配；新增 2 用例：①POST registered 未激活（listActiveImpls 返 []）→ 400 未激活文案；②GET impl-types → 200 items 含 feishu+label | MUST 复用 makeRealRegistry | 17-channel.md | +32/-6 |
| plugin_system | app/server/src/plugin/__tests__/inventory-builder.test.ts | :136 activated 用例 fixture | 修改 | default `activatedPoints` 补断言涉及 EP（对齐真实 default.yaml）；断言语义不变 | MUST 只动 fixture | 影响面评估 | +3/-1 |
| plugin_system | app/server/src/plugin/__tests__/inventory-builder-d7-flagged.test.ts | :156 用例 fixture | 修改 | default `activatedPoints` 补 `'llm_provider'`（及用例涉及 EP） | 同上 | — | +2/-1 |
| plugin_system | app/server/src/plugin/__tests__/inventory-builder-bug-a.test.ts | fixture 复核 | 修改 | 无显式 activated 断言，预期仅注释对齐；全量跑有 fail 按同修模式补 | MUST 全量 `bun run test` 复核 | memory selfcheck-fulltest | +2 |
| plugin_system | app/server/src/handlers/__tests__/plugin-scope-handlers.test.ts | fixture + :145 标题 | 修改 | `activatedPoints: ['tc_test_ep']`；标题改「default 返 yaml 声明的激活 EP（D6 已删）」 | 断言不变 | — | +2/-2 |
| plugin_system | app/server/src/plugin/__tests__/plugin-manager-scope.test.ts | D6 标题/注释 + 新语义用例 | 修改 | describe/it 去 D6 表述；新增 2 断言：`isPointActivated('default', 未声明EP)===false` + `listActivatedPoints('default')` 只返 yaml 声明（直测 LoadedScopeConfigProvider） | 既用例全绿（resolveSourceScope 对 default 行为不变） | ext_impl_scope.md §4.2 新语义 | +14/-4 |
| plugin_system | app/server/src/plugin/__tests__/migration-equivalence.test.ts | 真实配置护栏 | 新增 | 1 用例：真实 default.yaml+BuiltinLoader → `mgr.getExtensionImpls(ChannelPoint as ExtensionPoint<Channel>, 'default')` 返 1 项且 `.type==='feishu'`（防 channel 误删出 default.yaml + 验无状态构造 (implId,cfg) 可实例化） | MUST 走 makeRealManager | scopes_config_decl §4 | +10 |

### 模块九：一次性迁移（MigrationManager handler，用户裁决「改+做迁移」）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| migration | app/server/src/migration/handlers/channel-binding-config-id.ts | channelBindingConfigIdMigration | 新增 | 扫 `{dataDir}/channel_bindings/*.json`：逐文件读 JSON（fs-store 扁平信封形状 = record 字段 + createdAt/updatedAt/version 顶层平铺）→ 顶层有 `instanceId` 字段才迁：`configId = instanceId` 原值承接 + 删 `instanceId` + `atomicWriteSync` 写回（信封 createdAt/updatedAt/version 不动）；已迁（有 configId 无 instanceId）跳过。改前整目录一次性备份到 `{dataDir}/channel_bindings.pre-configid.bak/`（已存在则不覆盖） | MUST 幂等（字段级 marker=`instanceId` 存在性，安全重跑 no-op）；MUST 仅迁 active dataDir（ctx.dataDir，不扫多环境）；MUST NOT handler 内 catch（throw 由 MigrationManager 统一记 ledger error）；MUST 备份不覆盖既有备份（memory-intro 先例）；MUST NOT 迁 transcript/SSE（边界见 §影响面评估「迁移边界」） | migration_manager.md §2.3 handler 契约；memory-intro.ts 先例（备份+幂等） | +70 |
| migration | app/server/src/migration/handlers/handlers.yaml | channel-binding-config-id entry | 修改 | 注册表加一条：`id: channel-binding-config-id, versionRange: '<0.0.207', module: './handlers/channel-binding-config-id'`（含注释：range 上界取 '<0.0.207' = 在 0.0.206 release 上跑，对齐 v0.0.203/v0.0.204/v0.0.205 off-by-one 先例） | MUST range 取 '<0.0.207'——取 '<0.0.206' 会在 0.0.206 release 判 na 永不执行（load-bearing，session-derivation 同类教训） | handlers.yaml 既有注释先例 | +4 |
| migration | app/server/src/migration/handlers/index.ts | handlerRegistry 注册 | 修改 | import `channelBindingConfigIdMigration` + 加入 handlerRegistry map（键 `'channel-binding-config-id'`） | MUST 静态 import（packaged asar 安全，migration_manager §3.2） | migration_manager.md §3.2 | +2 |
| migration | app/server/src/migration/handlers/__tests__/channel-binding-config-id.test.ts | 迁移 UT | 新增 | 4 用例：①旧形状记录（含 instanceId）→ 迁后 configId 承接原值 + instanceId 删除 + 信封字段不动；②已迁记录（仅 configId）→ no-op（mtime/内容不变，幂等）；③重跑二次 → 仍 no-op（幂等防重跑，配 ledger done 主防线语义）；④备份目录生成且不覆盖既有备份；⑤（并入①）空目录/目录不存在 → 正常 no-op 不 throw | MUST 用临时 dataDir（mkdtemp）；MUST 断 full-record 形状非只断字段存在 | migration_manager.md §3.1 applied 主防线 | +80 |

**迁移边界（哪些迁 / 哪些不迁，理由）**：

| 数据 | 迁? | 理由 |
|---|---|---|
| `channel_bindings/*.json` 记录 `instanceId`→`configId` | **迁**（本模块） | 活跃运行时状态：bootstrap rebuildReverseIndex 从此建反向索引，不迁则 configId=undefined → binding 查找/echo 屏蔽/解绑全断。域小（个位数 KV 文件），迁移成本极低 |
| `sessions/{sid}/transcript/*.jsonl` 历史 message `sender.channel.instanceId` | **不迁** | (a) **append-only 不可变历史**（INV-S-1）：transcript 是「当时事实」记录，重写历史帧违反不可变语义，且全量重写所有 session 段文件风险/成本远超收益；(b) **运行时消费零影响**：origin 由 agent-loop-emitters 对**新入站消息**实时派生（新消息走新字段 configId），历史消息从不重新 emit；echo 屏蔽判定的是运行时新事件 origin，不读历史；(c) 影响仅前端历史消息的来源标签降级（老飞书消息不再标渠道来源），纯展示层可接受；(d) 数据量级不对称（transcript 百万行 vs bindings 个位数） |
| SSE `origin.instanceId` | **无数据可迁**（wire 改名即完成） | origin 是运行时派生字段（deriveOrigin 从 message.sender.channel 现算随 message_start 发出），不落盘；改名后新事件即新形状 |

## 组件-数据源拆解表（前端数据生命周期变更硬门禁）

| 组件 | 数据 | 数据形 | topic | 读 API | 触发 | 契约草案 |
|---|---|---|---|---|---|---|
| page-channel | configs（原 instances，改名） | Snapshot<ChannelConfig[]> | 无 SSE | GET /config/channels | onInit + startTimer(5s) onTick | 不变（仅类型改名） |
| page-channel | implTypes（**本版新增**） | 一次性 Snapshot（非 poll 非 SSE，组件本地 useState） | 无 | GET /config/channels/impl-types → `{items:[{implId,label}]}` | mount 一次性（useEffect+AbortController） | label=原始 __MSG_ 占位符，渲染期 resolveI18nField(label, tPc) |

依据：`specs/tech/app/frontend/[P0]component_data_map.md` 结构；静态代码声明配置不进 useLifecycle poll 链。

## 影响面评估

**跨模块链路**：plugin_system（D6）→ scopes yaml → channel 契约（types/base/feishu）→ ChannelManager 组合器 → handler/装配 → wire 字段（message/agent/web）→ migration handler（bindings 字段迁移，启动期先于 Phase 10 store 使用）→ 前端 channel 页。依赖顺序：模块一/二（plugin）与模块三/四（channel 重构）可并行；模块五依赖三/四；模块六依赖三（handle.configId）；模块九依赖三（ChannelBinding schema 改名）；模块七前端依赖五（端点契约，本表已冻结）。

**破坏性变更**：
1. `ScopeConfigProvider.listActivatedPoints` 删第二参（内部 interface；typecheck 兜底）。
2. **Channel 契约重写**：旧 5 方法 + `(instance, manager)` 构造全废——唯一 impl（feishu）+ ChannelManager + 管线（accumulator/send-queue/retry）+ 全部 channel UT 同步重写，本表已全量列出。
3. **wire 字段改名**：`sender.channel.configId` / `origin.configId`——SSE 事件 + 落盘 Message.sender 形状变化。迁移边界（用户裁决「改+做迁移」）：**channel_bindings 走模块九一次性迁移**（活跃运行时状态，不迁就断链）；**历史 transcript sender.channel 不迁**（append-only 不可变历史，运行时消费零影响——origin 只对**新**消息实时派生，echo 屏蔽不读历史；影响仅前端历史消息来源标签降级）；**SSE origin 无数据可迁**（运行时派生不落盘）。AT 排查：`tests/api` 无 instanceId 断言（grep 零命中），ET 无 channel case → 无 fixture 漂移。
4. 行为变化（test env 限定）：fixture EP 在 default 视图 activated true→false + activations 端点变化——无生产消费方、无 AT/ET 覆盖，仅 UT fixture 对齐（同前版评估）。
5. 行为变化（prod 新增）：default.yaml 补 channel 后 plugin-config 页 channel group 的 feishu enabled=false→true（D6 曾掩盖的本真状态）。

**16 EP 回归结论（逐项核对，同前版）**：全在 default.yaml 声明 → 删 D6 后 default 行为逐点一致；`resolveSourceScope('default',*)` loop guard 自然返 'default'；inventory default 视图不变。**零行为变化**，回归基线 = migration-equivalence + plugin-manager-scope-config + builtin-llm-anthropic 全绿。

**验收状态可达性（用户目标）**：default.yaml 删 channel point（或 impls 移 feishu）→ ①`getExtensionImpls(ChannelPoint,'default')` 不含 feishu → impl-types items=[] → 前端类型列表空+空态提示；②POST 400「registered but not activated」；③既有 channel_config bootstrap 时 resolveImpl throw → spawnConnect 直接 error 态（不 retry 不崩 server）；toggle off/on 安全（off 对 undefined handle 不崩，on 重过 gate 仍 error）。

**风险点**：(a) FeishuConnection 搬迁必须逐行等价（入站三件套：dedup/debounce/顺序队列——约束列已钉零逻辑改）；(b) `handleChannelRoute` 分支顺序；(c) wire 改名必须 grep 残留归零（rename-refs-batch-sed-verify）；(d) UT 重写面大（feishu 382 行 + channel 4 文件），coder 必须全量 `bun run test` 复核非只跑新文件；(e) 迁移 handler 的 versionRange off-by-one（'<0.0.207' 才在 0.0.206 release 执行，yaml 注释先例已钉）+ 幂等（ledger done 主防线 + 字段级 marker）；(f) spec 同步面广（见下），doc-modifier 遗漏会留「instance/D6」死概念。

**doc-modifier 同步清单（阶段 5）**：`specs/tech/channel/[P0]channel_impl_interface.md`（契约重写：无状态 impl+ChannelHandle+动态组合+sender.channel.configId）；`specs/tech/channel/[P0]channel_manager.md`（组合器模型重写 §1/§2/§3.1/§3.3/§4 T4 修订；§3.4 binding configId；§3.7 config 纯数据）；`specs/tech/channel/[P0]channel_extension_point.md`（纳入 scope 模型注记）；`specs/tech/config/[P0]ext_impl_scope.md`（D6 改写 + §5.2 例外删 + §9 边界行改）；`specs/tech/plugin_system/[P0]plugin_manager_interface.md`（§3.6 D6 + :38 注释）；`specs/tech/plugin_system/[P1]scopes_config_decl.md`（:152-153 + §4 强约定补「对 default 同效」）；`specs/tech/agent/message/[P0]agent_message_interface.md` §5（sender.channel.configId + 历史 transcript 不迁边界注记）；`specs/tech/agent/agent_interface_and_loop/[P0]agent_event.md` §4.2（origin.configId）；`specs/tech/migration/log.md`（channel-binding-config-id handler 收编记录）；`specs/api/overall/17-channel.md`（impl-types 端点 + POST 新 400 + 术语 config）；`specs/ui/overall/06-channel.md` + `specs/ui/components/channel-page/*`（术语 + 派生 + 空态）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
