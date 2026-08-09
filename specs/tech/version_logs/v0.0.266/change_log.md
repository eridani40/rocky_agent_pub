# v0.0.266 tech change log — attach 模式生命周期统一 + registry 重构

> 技术驱动需求（无 PRD，用户可感知行为 = attach 生命周期统一）。
> 权威契约：`specs/tech/version_logs/v0.0.266/change_plan.md`（主表 22 行 + Delta 追加 12 行，frozen）。
> 版本上下文：`states/v0.0.266/context.md`；审查报告 ×2：`states/v0.0.266/verify/review/code-review-task1.md` + `code-review-task3.md`。

## 变更摘要

### 需求与动机

v0.0.264 把 headless/managed-profile 纳入 BrowserInstanceManager（launch→操作→close + 前置校验 + 泄漏防护），但 **attach 仍由 ConnectorManager lazy connect 管理**——每次操作隐式连接、无统一生命周期、失活自愈逻辑散在 tool 层。需求：把 attach 也纳入 InstanceManager（launch=connect / close=disconnect / 失活自愈），ConnectorManager 瘦身为「switch 门禁 + UI 状态」，三模式统一生命周期入口。

### 方案（T1 架构期 9 决策 + T3 老板拍板 registry 重构）

**T1（attach 生命周期统一，架构期裁决 ①-⑨）**：
- attach 纳入 BrowserInstanceManager（launch=ChromeMcpDriver.connect 幂等 / 操作经前置校验 / close=disconnect 不杀用户 chrome）；instance 用「可选字段 + mode 判别」扩展（attach 存 BrowserSession + cdpUrl，不走 worker）
- ConnectorManager 瘦身：删 connectForToolRun/getAttachSession/disconnect/getOwner，保留 enable/disable/bootstrap/getState/getAll/isReady（switch 门禁 + UI 状态）；bootstrap 共享 attachDriver 单例 + isAttachEnabled 注入 InstanceManager
- action 枚举去 disconnect 统一 close；异常自愈 = tool.ts 检查 isAttachConnectionLost → handleAttachLost（state=dead + disconnect 清理）→ 下次 no_browser_instance
- 前置校验统一三模式（attach 不再隐式 lazy connect）；attach 不持久化（无 workerPid 锚点）

**T3（老板拍板：ActionExecutor registry 重构，Delta 追加）**：
- 老板审查 T1 实现指出 tool.ts L166 attach 分叉是抽象泄漏——「启动之后，任何 action 不该跟 mode 有关系」
- 抽象 protocol + 两 impl + registry：`mode-impl.ts`（BrowserHandle/ModeImpl/ModeImplEnv/SnapshotSink/InMemoryModeImplRegistry）+ WorkerModeImpl（headless/managed 注册同一实例两键）+ AttachModeImpl（失活自愈下沉 impl）
- **实例对象 = 句柄（handle）**：impl 方法签名 `launch(opts) → handle` / `execute(handle, action, params)` / `close(handle)`；manager 职责收敛为 key 计算 + 存取句柄 + 查 registry 分发 + 状态机，**不读句柄内部字段**
- tool.ts 零 mode 分叉：操作 action 统一走 `im.execute()`；**M1「execute 拒绝 attach」防御分支随之下线——execute 变正确路由**（registry 按 mode 路由 impl）

### T1 — attach 生命周期引擎（commit bf08d15c8 + a284a1c57 M1 fix）

- **`types.ts`**：BrowserInstance mode 扩展 'attach'；worker 字段改可选；新增 session?: BrowserSession + cdpUrl?: string。BrowserLaunchOptions mode 扩展 + cdpUrl?
- **`attach-instance.ts` NEW**：connectAttachSession（driver.connect + DEFAULT_ATTACH_CDP_URL 兜底 + attach_failed 归类）/ disconnectAttachSession（graceful 断开 + 幂等 + 失败 warn 不抛）/ isAttachConnectionLost（isAttachConnectError + transport 级扩展）
- **`instance-manager.ts`**：构造 deps 增 attachDriver? + isAttachEnabled?（fail-closed）；launch attach 分支（key=sessionId:attach 幂等复用 + switch 门禁 + connect + 不持久化）；assertReadyInstance 抽公共（execute 与 getReadyInstance 共用）；getReadyInstance 公开（attach 操作前置校验）；closeInstance attach 分支（disconnect + 删条目，不杀 chrome/不 rmSync/不释放端口/不 unpersist）；handleAttachLost（state=dead + closeInstance 幂等）；close 三模式统一
- **`tool.ts`**：action 枚举去 disconnect；attach 分支重写（launch/close 走 im + getReadyInstance + dispatchAction + 失活自愈 + SSRF 保留）；toLaunchOptions mode 扩展
- **`connector-manager.ts`**：瘦身 280→113（删 attachSession/owner + 4 方法）；`connector/types.ts` 接口同步；NoopConnectorManager 同步
- **`connector-bootstrap.ts`**：返回 { connectorManager, attachDriver }（driver 单例共享）
- **`bootstrap-connectors-phase.ts`**：解构 attachDriver + 注入 InstanceManager（attachDriver + isAttachEnabled 读 switch）
- **`session.ts`**：DELETE 删 connectorManager.disconnect 兜底（releaseSession key 前缀已覆盖）

### T2 — spec 同步（commit c347d7964）

browser_tool.md §4/§4.1/§7 + browser_instance_manager.md §1.1/§2/§3/§4/§5/§8/§10 + connectors.md §2/§3.2/§3.3/§5/§5.1/§6/§8（v1.5）+ tools log.md 条目 + 代码↔spec 一致性验证。

### T3 — registry 重构（commit 6206af430）

- **`mode-impl.ts` NEW（111 行）**：BrowserHandle（key/mode/state/createdAt/lastUsedAt，manager 只读公共字段）/ ModeImpl（launch(key,opts,env) / execute(handle,action,params,ctx) / close(handle,env) / cleanupOrphan?(rec,env)）/ ModeImplEnv（dataDir/now/allocatePort/releasePort/attachDriver/isAttachEnabled）/ ExecuteCtx（signal/snapshot）/ SnapshotSink / LaunchResult / InMemoryModeImplRegistry
- **`worker-mode-impl.ts` NEW（212 行）**：headless/managed 共用（注册两键）；launch（mode 分支内部化 + allocatePort + spawn + confirm + persist）/ execute（worker 协议 + cdp_timeout/崩溃/abort 置 dead + screenshot 落盘下沉）/ close（三要素清理幂等）/ cleanupOrphan
- **`attach-mode-impl.ts` NEW（78 行）**：launch（门禁 + 驱动缺省 fail-closed + connect）/ execute（dispatchAction + 失活自愈 attach_lost + 非失活透传 + screenshot）/ close（disconnect 幂等不杀 chrome）
- **`instance-manager.ts`（300 → 197 行）**：句柄表 + registry.get(mode) 分发 + 状态机门禁；零 `mode ===` 路由（仅 key 构造）；不读 handle 私有字段；execute 签名加 ctx；**删 M1「execute 拒绝 attach」防御分支**——execute 变正确路由
- **`tool.ts`（238 → 199 行）**：删 attach 分支（getReadyInstance + dispatchAction + isAttachConnectionLost + handleAttachLost）+ 删 headless screenshot 拦截；统一 im.execute + SnapshotSink ctx 构造；零 mode 分叉
- **`attach-instance.ts`（182 → 78 行）**：保留纯 helper（connect/disconnect/isAttachConnectionLost），删 launchAttach/handleAttachLost/AttachManagerHooks/buildAttachInstance/AttachLaunchGate/launchAttachInstance
- **`types.ts`**：删 BrowserInstance（BrowserHandle 迁 mode-impl.ts）；PersistedInstanceRecord 保留（孤儿清理锚点，mode 限 headless/managed-profile）
- **`bootstrap-connectors-phase.ts`**：装配 InMemoryModeImplRegistry（worker 两键 + attach 键）→ BrowserInstanceManager({ dataDir, registry, attachDriver, isAttachEnabled })
- **测试**：worker-mode-impl.test.ts（13 用例）+ attach-mode-impl.test.ts（14 用例）+ instance-manager.test.ts M1 改造（execute attach 拒绝 → 正确路由）+ browser-tool.test.ts 统一 execute 断言

## 设计决策（T1 架构期 9 决策 + T3 老板 3 条拍板 + delta 5 决策）

### T1 架构期决策（change_plan 决策 ①-⑨）

1. **attach 纳入 BrowserInstanceManager**：launch → 操作 → close 三模式统一；instance 用「可选字段 + mode 判别」扩展，attach 存 BrowserSession + cdpUrl，不走 worker。
2. **attach launch = ChromeMcpDriver.connect**：经 InstanceManager 注入 attachDriver，key=sessionId:attach 幂等复用。
3. **attach 操作类 action 经 getReadyInstance 前置校验后主进程 dispatchAction**：attach 的 screenshot 落盘需 ToolCtx，execute 保持 worker 语义不混入（T1 态；T3 后被 registry 重构覆盖）。
4. **异常自愈 = tool.ts 检查 dispatchAction 返回文本匹配 isAttachConnectionLost** → im.handleAttachLost（state=dead + disconnect 清理）→ 下次 no_browser_instance（T1 态；T3 失活自愈下沉 AttachModeImpl）。
5. **attach close = attachDriver.disconnect**：不杀 chrome / 不删目录 / 不释放端口 / 不持久化。
6. **action 枚举去 disconnect 统一 close**。
7. **ConnectorManager 瘦身为「switch 门禁 + UI 状态」**：删 connectForToolRun/getAttachSession/disconnect/getOwner。
8. **bootstrap 共享 attachDriver 单例 + isAttachEnabled（读 switch）注入 InstanceManager**。
9. **前置校验统一三模式**：attach 不再隐式 lazy connect。

### T3 老板 3 条拍板

1. **protocol + 两 impl + registry**：每个 mode 注册自己的 impl（headless/managed-profile 注册同一个 worker impl，attach 注册 attach impl）；tool.ts 操作 action 统一走 `im.execute()`（零 mode 分叉）。
2. **实例对象 = 句柄（handle）**：impl 方法签名 `launch(opts) → handle` / `execute(handle, action, params)` / `close(handle)`；manager 职责收敛为 key 计算 + 存取句柄 + 查 registry 分发 + 状态机，**不读句柄内部字段**（worker/session/userDataDir 直读全收敛进 impl）；impl = 无状态策略集。
3. **M1「execute 拒绝 attach」防御分支下线**——execute 变正确路由而非拒绝。

### Delta 5 决策（change_plan Delta 附带）

1. **execute 签名加 ctx：`execute(sessionId, opts, action, params, ctx: { signal?, snapshot? })`**——manager 不 import ToolCtx（轻量 ExecuteCtx 接口透传 impl，避免 tool 层循环依赖）。
2. **失活自愈下沉 impl**：attach impl execute 内检测 isAttachConnectionLost → 置 handle.state='dead' + 返回 attach_lost 引导文案 → manager execute 见 dead → closeInstance（disconnect + 删表）——tool.ts 不再检查。
3. **screenshot 落盘下沉 impl**：worker（r.text JSON parse → decode base64 → ctx.snapshot.save）+ attach（session.screenshot() Buffer 直交）→ 路径文本；tool.ts 构造 SnapshotSink 闭包绑定 workdir/toolCallId（INV-157 单一出口保留）。
4. **usedPorts 归属 manager**：从 manager 私有 Set 迁 env.allocatePort/releasePort（launch 分配、close/失败释放、abort 兜底时序不变）。
5. **registry 代替一切 mode switch**：instance-manager 零 `mode ===` 判断（grep 验证仅 key 构造 2 处注释/构造）；bootstrap 注册 headless/managed 同一 WorkerModeImpl 两键 + attach 键。

## 代码↔spec 核实（doc-modifier 阶段 5 — 逐项比对 change_plan + 代码）

| # | change_plan 契约 | 代码实现 | 一致 |
|---|---|---|---|
| 1 | BrowserHandle（key/mode/state/createdAt/lastUsedAt，manager 只读公共字段） | `mode-impl.ts` BrowserHandle 五字段齐全 | ✅ |
| 2 | ModeImpl（launch/execute/close/cleanupOrphan?）+ ModeImplEnv（dataDir/now/allocatePort/releasePort/attachDriver/isAttachEnabled）+ SnapshotSink + InMemoryModeImplRegistry | `mode-impl.ts`（111 行）全实现；InMemoryModeImplRegistry 两键/一键注册 | ✅ |
| 3 | WorkerModeImpl（headless/managed 共用注册两键；launch/execute/close/cleanupOrphan） | `worker-mode-impl.ts`（212 行）注册两键；worker 协议语义不变 | ✅ |
| 4 | AttachModeImpl（launch 门禁+connect / execute dispatch+失活自愈 / close disconnect 幂等） | `attach-mode-impl.ts`（78 行）三方法全对齐；失活自愈下沉 impl | ✅ |
| 5 | manager 收敛：句柄表 + registry 分发 + 状态机（<200 行）；零 mode===；不读句柄私有字段 | `instance-manager.ts`（197 行）<200 ✓；grep 零 mode===（仅 key 构造 2 处）✓；不读私有字段（WorkerHandle/AttachHandle 全在 impl）✓ | ✅ |
| 6 | execute 签名加 ctx；**删 M1「execute 拒绝 attach」防御分支——变正确路由** | `instance-manager.ts:119-135` 签名带 ctx；无 attach 拒绝分支；registry.get(opts.mode).execute 统一路由 | ✅ |
| 7 | tool.ts 零分叉：删 attach 分支 + 统一 im.execute + SnapshotSink ctx 构造 | `tool.ts:147-174` launch/close 走 im + 操作统一 execute + snapshot save 闭包 | ✅ |
| 8 | attach-instance 保留纯 helper（connect/disconnect/isAttachConnectionLost），删 hooks | `attach-instance.ts`（78 行）三 helper 保留；无 launchAttach/handleAttachLost/AttachManagerHooks（grep 无残留） | ✅ |
| 9 | types.ts 删 BrowserInstance（BrowserHandle 迁 mode-impl）；PersistedInstanceRecord 保留 | types.ts 无 BrowserInstance（grep 无残留）；PersistedInstanceRecord 保留（worker 用） | ✅ |
| 10 | bootstrap 装配 registry（worker 两键 + attach 键）→ manager | `bootstrap-connectors-phase.ts:121-141` 与 spec 逐字一致（attachDriver/isAttachEnabled 经 env） | ✅ |
| 11 | attach launch：门禁 isAttachEnabled + attachDriver 缺省 fail-closed + connect 幂等 | `attach-mode-impl.ts:28-50` 门禁① → not_enabled；驱动缺省 → attach_failed；connect 复用 | ✅ |
| 12 | attach execute：dispatch + 失活置 dead + 非失活透传 + screenshot 落盘 | `attach-mode-impl.ts:52-71` dispatchAction + isAttachConnectionLost → dead + attach_lost；非失活原样透传 | ✅ |
| 13 | attach close：disconnect 幂等不杀 chrome | `attach-mode-impl.ts:73-77` disconnectAttachSession + state=dead | ✅ |
| 14 | 前置校验 assertReadyInstance（instance 存在 + ready + idle lazy check） | `instance-manager.ts:171-183` 三条件 + idle_timeout 分类 | ✅ |
| 15 | ConnectorManager 瘦身（删 4 方法 + 3 类型）；NoopConnectorManager 同步 | connector/types.ts + connector-manager.ts（113 行）+ connector-types.ts 对齐；grep 无消费方 | ✅ |
| 16 | execute 返回后 state==='dead' → closeInstance（impl.close 幂等兜底 + 删表） | `instance-manager.ts:131-133` dead → closeInstance | ✅ |
| 17 | launch/close 保留 mode 语义（impl 内部行为非 manager switch） | `instance-manager.ts:103-144` launch/close 全经 registry.get(mode) | ✅ |

**偏离记录（全部等价合理，非静默）**：

**T1 偏离 6 项（code-reviewer 13:55 裁决）**：
- **偏离 1：hooks 模式抽取（AttachManagerHooks）**——等价合理：防 manager 反向依赖 attach-instance（纯 hooks 访问私有状态）；instance-manager 压至 300；公开 API 不变。
- **偏离 2：tool.ts 连带重写**（原属 T2 covers）——等价合理：base tool.ts L164 直接调 connectForToolRun，T1 删接口后编译必破；tool.ts 完整走新范式且行为符合行 14-16 契约。
- **偏离 3：isReady 语义**（switch+connection → 仅 switch）——等价合理：生产无消费方；语义 = feature flag 门禁；/config/connectors UI 契约不变。
- **偏离 4：tool-error-format.ts 删除**——等价合理：无消费方（grep 0）；符合「删后无死代码」。
- **偏离 5：toRecord non-null 断言**（mode/userDataDir/cdpPort/workerPid）——等价合理：attach 恒不持久化；toRecord 只在 worker-based 路径调用。
- **偏离 6：08-web-tools.md 提前同步**——等价合理：change_plan 行 14 MUST「枚举收缩后 schema/文档同步」在 T1 tool.ts 行触发；版本 1.4 同步完整。

**T3 偏离 4 项（code-reviewer 14:30 裁决）**：
- **偏离 1：dispatchAction 返回 ToolRunResult → BrowserExecuteResult + DispatchCtx{snapshot?}**——等价合理：AttachModeImpl.execute 必须返回 BrowserExecuteResult（manager.execute 协议）；tool-dispatch 的 dispatchAction 被 attach impl 复用 → 返回类型必须对齐；DispatchCtx{snapshot?} 是 ExecuteCtx 的轻量子集——架构必要对齐。
- **偏离 2：lastUsedAt 刷新归 manager**——等价合理：impl 不调 Date.now()（保 idle 测试注入时钟）；manager.execute 返回后刷新（成功/失败都刷，对齐原语义）。
- **偏离 3：WorkerModeImpl.launch 3 参（key 由 manager 传入）**——等价合理：impl 无状态不自己算 key（instanceKey 保留在 manager）；与 LaunchResult 接口一致。
- **偏离 4：LaunchResult.error.kind 改可选**——等价合理：spawn/launchConfirm 失败可能无 kind（对齐 BrowserExecuteResult 的 error.kind?）；formatExecuteError 已处理可选 kind。

## 行为等价专项确认

- **worker 协议**：spawnPersistentWorker + requestId 路由 + pending Map + worker.send 语义不变（worker-mode-impl.execute 逐行等价原 instance-manager execute worker 段）。
- **screenshot 落盘**：worker（r.text JSON parse → decode base64 → ctx.snapshot.save）+ attach（session.screenshot() Buffer 直交 snapshot.save）→ 路径文本；tool.ts 构造 SnapshotSink 闭包绑定 workdir/toolCallId（INV-157 单一出口保留）。
- **失活自愈**：下沉 AttachModeImpl.execute（isAttachConnectionLost → handle.state='dead' + attach_lost 文案）→ manager execute 见 dead → closeInstance（disconnect + 删表）→ 下次 no_browser_instance。
- **端口分配时序**：allocatePort 归 env（manager usedPorts），launch 分配、close/失败释放、abort 兜底——时序不变。

## 文档同步（doc-modifier 阶段 5）

- `specs/tech/version_logs/v0.0.266/change_log.md`（本文件，新建）。
- `specs/tech/agent/tools/log.md`：v0.0.266 条目追加 T3 registry 段（T2 已写 T1 语义，T3 追加最终态）。
- `specs/tech/agent/tools/index.md`：browser_tool.md / browser_instance_manager.md 概念行补 v0.0.266 T3。
- **spec 终检（T3 后一致性）**：
  - `[P1]connectors.md`：§6 代码示例（getReadyInstance + dispatchAction + handleAttachLost）→ 更新为 execute 统一路由 + AttachModeImpl 失活自愈；§8 version 1.5 描述同步；§2/§3.2/§3.3/§5/§6 launchAttach/handleAttachLost/tool 层失活检测残留全部更新（7 处）。
  - `[P1]browser_instance_manager.md` / `[P1]browser_tool.md`：T2 已写 T3 语义（§1.1/§2/§3.3/§4.2/§5.2/§7/§8/§10），终检确认无「execute 拒绝 attach」残留（getReadyInstance 仅「已删/不再」语境）。
- 约束遵守：不碰产品代码（文档改动仅 specs/）；行数合规（index.md 102 ≤120；单文件 ≤500）。
