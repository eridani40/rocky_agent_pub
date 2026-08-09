---
type: spec
title: Connectors（连接器）
priority: P1
status: active
updated: 2026-08-06
since: v0.0.23
---

# Connectors（连接器）— 概念 + 状态机 + 持久化

> 管什么：连接器概念（`browser`）+ **双状态机**（switch 开关态 + connection 连接态）+ 持久化（switch intent）+ 重启自动重连 + ConnectorManager（运行时维护）+ attach 可用性门禁。
> 不管什么：chrome 发现/CDP/MCP attach 细节（→ `specs/tech/agent/tools/[P1]browser_tool.md`）；HTTP facade（→ specs/api）。
> 需求来源：`reqs/v0.0.23/reqs.md`「配置功能·连接器」。

> **[v0.0.105] computer 不是连接器（pivot 结论）**：v0.0.105 曾设计 computer 作第 2 连接器（toggle + owner 锁 + lazy connect + spawn Swift helper），真机 dogfood 发现裸 spawn 子进程拿不到 macOS TCC 权限，**架构 pivot 到「Rocky Electron 主进程注入 `ComputerNativePort`」**——computer **去连接器语义**（无 toggle / owner 锁 / connect-disconnect），是本机主进程常驻能力。原「computer 连接器」章节全部作废（本文回退 browser-only）。computer 现状 → `specs/tech/agent/platform/[P1]computer_native_capability.md` + `specs/tech/agent/tools/[P1]computer_use_tool.md`；UI 权限引导卡片 → `specs/ui/overall/05-connectors.md §3.2`。

## 1. 概念

**连接器（Connector）**= 一个「需要用户主动连接、连接态运行时维护」的外部附件槽。

| connector id | 引入版本 | 控制 | 驱动 | 多一层权限态 |
|---|---|---|---|---|
| `browser` | v0.0.23 | chrome 进程内（一个浏览器 tab） | a11y tree + element ref（CDP/MCP） | ❌ |

`browser` 连接器是 `browser` 工具 attach 模式（mode③）的**前置门禁**。

> 与 `browser` 工具 mode①②（headless/managed-profile，agent 自启 chrome，无需用户连接）正交——那两模式不依赖连接器。

## 2. 双状态（核心）

连接器**不是一个 bool**，而是两个独立状态（需求明确：「这里不可以是一个 true、false 状态」）：

| 状态 | 取值 | 含义 | 持久化 |
|---|---|---|---|
| **switch（开关态）** | `on` / `off` | 用户「是否启用此功能」的意图（feature flag） | **是**（intent） |
| **connection（连接态）** | `disconnected` / `connecting` / `connected` / `error` | 运行时连接实况 | **否**（运行时派生/维护） |

**关键语义（`[v0.0.46]` 修正 + `[v0.0.266]` 连接态瘦身）**：switch 与 connection **完全解耦**——`switch=on` **仅表示「用户已启用此功能」**（不再实时反映是否连上）：
- 用户 toggle on → 立即 `switch=on`（持久化 intent）+ `connection=disconnected`（尚未 connect）。
- **`[v0.0.266]` 连接态不再由 ConnectorManager 维护**：attach 连接/断开/失活全部归 InstanceManager（launch=connect / close=disconnect / 失活自愈下沉 AttachModeImpl），`connection` 恒 `disconnected`（仅 UI 展示用）。LLM 调 `browser({mode:'attach', action:'launch'})` → AttachModeImpl.launch → attachDriver.connect（见 §6），`switch` 保持 `on` 全程不变。
- 重启 `intent=on` → `switch=on`（UI 显启用）+ `connection=disconnected`（不 auto connect），LLM 用 attach launch 时才连。

## 3. 状态机

### 3.1 字段

```typescript
interface ConnectorState {
  id: 'browser';                  // v0.0.23 browser（v0.0.105 曾扩 computer，pivot 后回退）
  switch: 'on' | 'off';           // 用户已启用此功能（feature flag）；与 connection 解耦
  connection: 'disconnected' | 'connecting' | 'connected' | 'error';
  errorDetail?: string;           // connection=error 时的原因（chrome 未开 / IPC 超时）
  lastConnectedAt?: number;       // 上次 connected 时间（可观测/UI 展示）
}
```

### 3.2 迁移规则（browser，`[v0.0.46]` 时机重构 + `[v0.0.266]` 瘦身为 switch 门禁）

| 触发 | switch | connection | 动作 |
|---|---|---|---|
| 初始（首次，无持久化） | off | disconnected | — |
| 用户点 toggle on（intent=on）`[v0.0.46]` | **on** | disconnected | 仅持久化 intent + UI switch=on；**不进 connecting、不调 driver.connect**（对比 v0.0.34：立即 connecting） |
| **LLM 调 `browser({mode:'attach', action:'launch'})` 且 switch=on**`[v0.0.266]` | on | disconnected（ConnectorManager 不再维护连接态） | AttachModeImpl.launch：isAttachEnabled（读 switch）通过 → attachDriver.connect（见 `browser_tool.md` §4.1）；失败 → `attach_failed`（同 §3.3 失败即停） |
| 同 session 后续 attach 操作（launch 已建）`[v0.0.266]` | on | — | InstanceManager key=`sessionId:attach` 幂等复用，不重复 connect |
| **LLM 调 attach 但 switch=off**`[v0.0.46]` | off | disconnected | AttachModeImpl.launch 门禁 isAttachEnabled=false → `{kind:'not_enabled'}`；tool 引导用户去连接器页开启开关；**不连接** |
| attach 连接失败（`[v0.0.34]` 判据真实化 list_pages round-trip 失败） | on（保持）`[v0.0.46]` | — | InstanceManager `connectAttachSession` 失败 → `{kind:'attach_failed'}`；**不自动重连**（沿用 §3.3）；用户再让 agent launch 触发重试 |
| 用户点 toggle off（intent=off） | off | disconnected | 仅持久化 intent + UI switch=off；**不断已连接的 attach**（attach 连接归 InstanceManager，由 close/releaseSession 释放）`[v0.0.266]` |
| 运行中 chrome 关闭/连接断（switch=on）`[v0.0.266]` | on（保持） | — | attach 操作时 CDP 失活 → AttachModeImpl.execute 内检测 `isAttachConnectionLost` → 置 handle.state='dead' + 返回 attach_lost → manager 收尾 closeInstance（disconnect + 删条目）→ 下次 `no_browser_instance` 引导重新 launch |
| **session 结束（agent DELETE / idle）**`[v0.0.46]` | on（保持） | — | InstanceManager `releaseSession(sid)` 兜底：key 前缀 `sessionId:` 匹配（含 attach）→ attach 走 disconnectAttachSession（不杀用户 Chrome）`[v0.0.266]` |
| **app 重启（持久化 intent=on）**`[v0.0.46]` | **on** | disconnected | ConnectorManager `bootstrap()` 只读 intent 恢复 UI 态；**不 connect、不 spawn chrome-devtools-mcp、不弹「有应用要调试」prompt**（对比 v0.0.34：立即 connecting）；attach 连接由用户下次 launch 建立 `[v0.0.266]` |

> **`[v0.0.46]` 核心差异**：v0.0.34 把 switch=on 当作「立即 connect 意图」；v0.0.46 后 switch 退化为**纯功能开关**——connect 时机由 tool.run 首次调 attach 触发。**`[v0.0.266]` 进一步**：connect/disconnect/owner 职责整体迁 InstanceManager（launch=connect / close=disconnect / 失活自愈），ConnectorManager 只做 switch 门禁 + UI 状态（enable/disable/bootstrap/getState/getAll/isReady）——**connection 状态不再由 ConnectorManager 维护**（恒 disconnected，仅 UI 展示用）。

### 3.3 重连策略（`[v0.0.46]` bootstrap 只读 intent + `[v0.0.34]` 失败即停）

- **`[v0.0.46]` bootstrap 不再 connect**：app 启动时 ConnectorManager `bootstrap()` 只读持久化 intent 恢复 UI 态（intent=on → `switch=on, connection=disconnected`；intent=off → `switch=off, connection=disconnected`）——**不调 driver.connect、不 spawn chrome-devtools-mcp**。这根治了 v0.0.34「app 启动弹『有应用要调试』系统 prompt」的 chrome-devtools-mcp `--autoConnect` 副作用。
- **`[v0.0.46]` connect 时机 = tool.run → `[v0.0.266]` = AttachModeImpl.launch（经 execute 统一路由）**：lazy connect 由 AttachModeImpl.launch（attach-instance.ts 纯 helper）在 LLM 调 `browser({mode:'attach', action:'launch'})` 时触发（switch 门禁 + attachDriver.connect）。
- **失败即停（`[v0.0.34]` BUG-009，仍生效）**：attach connect 失败（含判据真实化的 list_pages round-trip 探测失败，见 `browser_tool.md` §4.1）→ `attach_failed`、`switch` 保持 `on`（v0.0.46 起 switch 与 connection 解耦）、持久化 `intent` 仍 `on`——**不进重试循环、不再 spawn chrome-devtools-mcp**。用户下次让 agent launch attach，或用户在 UI 主动重试，才重新触发。
- **断线（运行中 chrome 关闭）`[v0.0.266]`**：attach 操作时 CDP 失活 → AttachModeImpl.execute 内检测 `isAttachConnectionLost` → 置 handle.state='dead' + 返回 attach_lost → manager 收尾 closeInstance（disconnect + 删条目）→ 下次 `no_browser_instance` 引导重新 launch；周期探测/自动退避重连仍列为后续 enhancement。

## 4. 持久化（switch intent）

```typescript
// connector_config entity（独立 config 域，KV by connector id）
const ConnectorConfigSchema = {
  entity: "connector_config",
  engine: "file",
  fs: { sharding: { shardKeyField: "id" }, format: "json" },
  fields: {
    id:      { type: "string", required: true },   // connector id（"browser"）
    enabled: { type: "boolean", required: true },  // 持久化的 switch INTENT（非实时态）
  },
};
```

- **只持久化 `enabled`（intent）**，不持久化 connection 实时态（运行时重派生）。
- record 不存在 / `enabled=false` → 启动态 switch=off / disconnected。
- `enabled=true` → 启动 reconnect（§3.3）。

> 为何独立 config 域（非 app_config）：连接器是**用户面向**的运行时状态附件（有 nav 页 + toggle），既非技术调参也非 app 必填权威值；其「intent 持久化 + 运行时态机」自成一域（类比 observability manager，但用户面向）。

## 5. ConnectorManager（运行时服务，`[v0.0.46]` 时机重构 + `[v0.0.266]` 瘦身为 switch 门禁 + UI 状态）

> **共享类型抽取（v0.0.105，browser-only）**：v0.0.105 曾计划 computer 作第 2 连接器 + 泛型 `ConnectorManager<SessionT>` 抽象，故把连接器共享概念类型（`ConnectorState` / `OwnerRef` / `ConnectForToolRunResult` kind 枚举）从 `tools/browser/connector-types.ts` 提取到 `app/server/src/connector/types.ts`。**computer pivot 后**该文件回退 **browser-only**（`ConnectorId='browser'`，无 `permission_missing` kind、无 `permissions` 字段）。**`[v0.0.266]` 瘦身**：删 `OwnerRef` / `ConnectForToolRunResult` / `ConnectForToolRunErrorKind` 类型 + `connectForToolRun` / `getAttachSession` / `disconnect` / `getOwner` 方法（attach 连接职责整体迁 InstanceManager，见 `browser_instance_manager.md` §3.3/§4）。

```typescript
// app/server/src/connector/types.ts（browser-only；v0.0.266 瘦身后）
type ConnectorId = 'browser';

interface ConnectorState {
  id: ConnectorId;
  switch: 'on' | 'off';
  connection: 'disconnected' | 'connecting' | 'connected' | 'error';  // UI 展示用；v0.0.266 起 ConnectorManager 不再维护实时连接态（恒 disconnected）
}

/** 共享接口（switch 门禁 + UI 状态；attach 连接归 InstanceManager） */
interface ConnectorManager {
  getState?(id: ConnectorId): ConnectorState;
  isReady(id: ConnectorId): boolean;                    // v0.0.266 语义 = switch==='on'（feature flag 门禁）
  getAll(): ConnectorState[];
  enable?(id: ConnectorId): Promise<void>;
  disable?(id: ConnectorId): Promise<void>;
  bootstrap?(): Promise<void>;
}
```

> HTTP facade（`handlers/connector.ts`）：`VALID_CONNECTOR_IDS = Set(['browser'])`；`GET /config/connectors` 返 browser 一条；`PUT /config/connectors/:id` 仅接 `'browser'`。

### 5.1 BrowserConnectorManager（`[v0.0.266]` 瘦身：switch 门禁 + UI 状态）

- **状态**：仅 `switch`（intent 持久化恢复）+ `connection`（恒 disconnected，UI 展示用）；**不再持有 attachSession / owner**。
- **enable(id)**：写 intent（持久化 enabled=true）+ `switch=on` + `connection=disconnected`（**不 connect**——attach 连接由 InstanceManager launch 建立）。
- **disable(id)**：写 intent（enabled=false）+ `switch=off` + `connection=disconnected`（**不断已连接的 attach**——attach 连接归 InstanceManager，由 close/releaseSession 释放）。
- **bootstrap()**：只读 intent 恢复 UI 态（intent=on → switch=on；off → off），不 connect、不 spawn chrome-devtools-mcp。
- **isReady(id)**：`switch === 'on'`（feature flag 门禁，与 bootstrap 注入 InstanceManager 的 `isAttachEnabled` 语义一致）。

## 6. attach 可用性门禁（browser tool，`[v0.0.46]` 门禁分层 + lazy connect → `[v0.0.266]` switch 门禁 + InstanceManager 连接）

`browser` 工具 mode③（attach）调用时，连接建立/释放/失活清理全部由 BrowserInstanceManager 处理（见 `browser_instance_manager.md` §3.3/§4）：

```typescript
// bootstrap-connectors-phase.ts（v0.0.266 装配；T3 registry 重构）
const { connectorManager, attachDriver } = createAndBootstrapConnectorManager(dataDir);
const im = new BrowserInstanceManager({
  dataDir,
  attachDriver,                                        // 共享 ChromeMcpDriver 单例（经 ModeImplEnv 透传 AttachModeImpl）
  isAttachEnabled: () => connectorManager.getState?.('browser')?.switch === 'on',  // switch 门禁
});

// browser_tool run 内（mode==='attach'，[v0.0.266 T3] 零 mode 分叉——操作类 action 统一走 execute）
// launch → im.launch(sessionId, {mode:'attach', cdpUrl?})
//   ├─ isAttachEnabled() false → {kind:'not_enabled'}（引导用户去连接器页开启开关）
//   └─ AttachModeImpl.launch → attachDriver.connect → BrowserSession（key=sessionId:attach 幂等复用）
// 操作类 action → im.execute(sessionId, {mode:'attach'}, action, params, ctx)
//   ├─ 前置校验 assertReadyInstance（无 instance → no_browser_instance 引导先 launch）
//   └─ registry.get('attach') = AttachModeImpl.execute → dispatchAction(session, ...)
//        └─ 失活（CDP 断/chrome 关）→ isAttachConnectionLost(文本) → 置 handle.state='dead' + attach_lost
//           → manager 收尾 closeInstance（disconnect + 删条目）→ 下次 no_browser_instance 引导重新 launch
// close → im.close(sessionId, {mode:'attach'}) = AttachModeImpl.close → attachDriver.disconnect（不杀用户 Chrome）
```

- **switch 门禁在 AttachModeImpl.launch 内**（isAttachEnabled 读 connectorManager switch）；失败 §3.3 失败即停不重试。
- **幂等复用**：同 session 后续 attach 操作（launch 已建）复用 key=`sessionId:attach` 实例，不重复 connect。
- **不通过 UI 通知冲突**：未启用/失活错误全部通过 tool result 传达给 LLM，UI 无 toast/modal（PRD §7 用户决策）。
- mode①②（headless/managed-profile）**不查连接器**——它们自启 chrome，与连接器无关。

## 7. 边界

| 零件 | 归属 |
|---|---|
| 连接器概念（browser）+ 双状态机 + 持久化 intent + 重启重连 + ConnectorManager + attach 门禁 | 本文 ✅ |
| chrome 发现 / ChromeMcpDriver attach（默认 `--autoConnect` `[v0.0.34.1]`）/ connect 判据真实化 细节 | `browser_tool.md` §3/§4/§4.1 |
| 连接器页 UI（nav/tab/toggle/connection status/guidance） | `specs/ui/overall/05-connectors.md` + `connector-page/` |
| HTTP facade（GET/PUT connector state、enable/disable） | specs/api（v0.0.23 补） |
| connector_config 持久化机制 | `persistence/` |
| **computer 原生能力**（非连接器，主进程注入 ComputerNativePort）| `specs/tech/agent/platform/[P1]computer_native_capability.md` + `tools/[P1]computer_use_tool.md`（UI 权限卡片 `05-connectors.md §3.2`）|

## 8. 版本

version: 1.5 `[v0.0.266 modified]`（1.4 → 1.5：**ConnectorManager 瘦身为 switch 门禁 + UI 状态**——attach 连接职责整体迁 BrowserInstanceManager（launch=connect / 操作经 execute 统一路由（T3 registry 重构，AttachModeImpl 内 dispatch + 失活自愈 attach_lost）/ close=disconnect 不杀 chrome）。§3.2 状态机删 lazy connect/owner/disconnect/占用冲突行，改 InstanceManager launch 语义；§3.3 重连策略更新（connect 时机 = InstanceManager.launch、断线失活自愈下沉 AttachModeImpl）；§5 ConnectorManager 接口删 connectForToolRun/getAttachSession/disconnect/getOwner + OwnerRef/ConnectForToolRunResult/ConnectForToolRunErrorKind 类型；§5.1 BrowserConnectorManager 瘦身（不再持有 attachSession/owner，isReady = switch 门禁）；§6 attach 门禁改 isAttachEnabled（读 switch）注入 InstanceManager。HTTP facade（GET/PUT /config/connectors）契约零变化——UI 读 switch/connection 字段不受影响。详 `specs/tech/version_logs/v0.0.266/change_plan.md`）。
version: 1.4 `[v0.0.105 modified]`（1.3 → 1.4：**computer 连接器回退（pivot）**——v0.0.105 曾扩 computer 作第 2 连接器，真机 dogfood 发现裸 spawn Swift helper 拿不到 macOS TCC 权限，架构 pivot 到「主进程注入 `ComputerNativePort`」，computer **去连接器语义**。本文回退 browser-only：删 §1 computer 行、§3.1 `id` 类型回 `'browser'` + 删 `permissions` 字段、删 §3.2.2 computer 迁移规则、删 §5.2 ComputerConnectorManager、§5 shared type `ConnectorId` 回 `'browser'` + 删 `permission_missing` kind（共享抽取 `connector/types.ts` 保留但 browser-only）。computer 现状 → `specs/tech/agent/platform/[P1]computer_native_capability.md`。详 `specs/tech/version_logs/v0.0.105/change_log.md`）。
> 注：1.3 `[v0.0.105]`（computer 作第 2 连接器）为已回退的中间设计，不再有效——完整来龙去脉见 `version_logs/v0.0.105/change_log.md`。
version: 1.2 `[v0.0.46 modified]`（1.1 → 1.2：**connect 时机重构**——把 attach connect 从 `bootstrap()`/`enable()` 立即触发改为 tool.run 首次调 attach 时 lazy 触发，根治 v0.0.34 「app 启动弹『有应用要调试』系统 prompt」。§2 switch 语义：从「实时反映连上」改为「用户已启用（feature flag）」，与 connection 完全解耦。§3.2 迁移表：toggle on 只翻 UI 不 connect；新增 LLM 首次 attach lazy connect 行、LLM disconnect action 行、占用冲突行、switch=off 拒绝行、session DELETE 兜底行；app 重启 intent=on → `switch=on/connection=disconnected` 不 connect。§3.3：bootstrap 只读 intent 不 connect；`[v0.0.34]` 失败即停仍生效但 switch 保持 on。§5 ConnectorManager 接口：新增 `connectForToolRun(sessionId)`（含门禁分层 + owner sessionId 粒度）与 `disconnect(sessionId?)`（idempotent）；`enable`/`bootstrap` 均不再 connect。§6 attach 门禁：分层三态（not_enabled / in_use_by_other / connect_failed）由 tool result 传达 LLM，不通过 UI 通知；attach 资源全局单例（owner）。详见 `states/v0.0.46.connector_opt/design.md` + PRD `specs/prd/version_logs/v0.0.46.connector_opt/change_log.md`）。1.1 `[v0.0.34 modified]`（1.0 → 1.1：**失败即停语义文档化 + 判据真实化对齐**（BUG-009）。§3.3 重连策略改写：connect 失败（含 list_pages round-trip 探测失败）→ `error`、`switch=off`、`intent` 保持 `on` 但**不自动重连**——根治「失败却反复 spawn chrome-devtools-mcp 孤儿」，配合 `browser_tool.md` §4.1 治理2 判据真实化）。1.0 `[v0.0.23]`（新增：连接器概念（仅 browser）+ switch/connection 双状态机 + 持久化 intent + 重启自动重连 + ConnectorManager + browser attach 门禁）。
