---
type: log
title: Session KB 变更记录
updated: 2026-08-06
---

# Session KB 变更记录（ISO 倒序，最新在前）

## 2026-08-06 · v0.0.271（workspace fs watch 关注集合重构 — watch-set 声明式 + 全量 diff）

- **`[P0]session_workspace_manager.md` 懒监听模型升级**（§1/§3/§5/§6/§9/§10/§11）：关注集合 = 所有打开节点自身 + 各自一级子文件夹（含空文件夹——修 BUG-fs-watch-empty-folder-no-expand：空文件夹从未展开 → 无 watcher → 新增文件无事件）。计算 = 前端 `computeWatchSet` 全量重算 + 每次变化 diff 增删（不在新集合一律 close = 结构性泄漏收敛 R3）；**新增 `applyWatchSet` 接口**（声明式替换该 tab 关注集合：resolve → registry.setTabSet diff → added openIfFirstRef / removed closeIfZeroRef）；幂等语义从「增量非声明式」改「声明式全量 diff」（同集合再调 → diff 全空 → no-op）；4 条回收路径（releaseTab/recycleSession/switchDir/stopAll）在 diff 模型下收敛（都是「清集合 → refcount 归零 → close」，漏增量也被下次 diff 纠正）；watch/unwatch 增量端点保留向后兼容（release-all 仍用），新前端不再调单 path。
- **api `specs/api/overall/04-agent-session.md` v2.7**：§2.6.5 新增 `POST /session/:id/workspace/watch-set`（body `{ clientId, paths: string[] }` 完整集合非增量；paths 逐元素白名单校验，穿越 400 / 不存在静默跳过；缺 clientId 400；realRoot = realpathSync(workspaceDir) 三端点共用 symlink 基准）。
- **前端接线**（`component-workspace-panel.md §4.3`）：展开/收起只改 state（不再触点直接调 watch API 防双发）→ 重算 effect 监听 tree/expanded/childrenCache → `computeWatchSet`（纯函数，`workspace-watch-set.ts`）→ `applyWatchSet`；切目录 `dir-changed` 语义重置（清 expanded，旧相对路径相对新基准无效）；初始 rootTree / childrenCache 时序两次 applyWatchSet 幂等。
- **代码↔spec 核实（doc-modifier 阶段 5）**：① `computeWatchSet` 根 '' 恒含 + 根一级 dir + 打开节点自身 + childrenCache 子一级 dir + 去重排序纯函数 ✅；② useWorkspaceWatch clientId useRef 稳定 + applyWatchSet 完整集合 + cleanup release-all（闭包捕获旧 sessionId）✅；③ handleExpand/handleCollapse 去 watch API + handleSwitchDir dir-changed 清 expanded + 重算 effect 依赖三件套 ✅；④ workspace-api watchWorkspaceSet POST watch-set ✅；⑤ registry.setTabSet 全量 diff + added/removed + 空集清 key + 幂等 + 纯记账 ✅；⑥ manager.applyWatchSet 泄漏收敛（closeIfZeroRef 归零即关）+ 多 tab 合并（refcount>0 不 close）+ 串行化 + 幂等 ✅；⑦ 4 条回收路径（releaseTab/recycleSession/switchDir/stopAll）✅；⑧ watch/unwatch 保留增量幂等 + release-all ✅；⑨ handler watch-set clientId 校验 + paths 数组校验 + 逐 path 白名单 + realRoot symlink 基准 + 不存在静默跳过 + 200 {ok:true} ✅；⑩ 路由落点（session-routes + router-helpers regex 补 watch-set，coder3 偏离 1 必要等价）✅；⑪ dir-watcher depth:0 零改动 + emitter 100ms 契约零改动 ✅；⑫ 前端 watchPath/unwatchPath 零残留 ✅。
- 详情：`specs/tech/version_logs/v0.0.271/change_plan.md` + `change_log.md`；PRD `specs/prd/version_logs/v0.0.271.fs_watch_diff/prd.md`；BUG `states/bugs/BUG-fs-watch-empty-folder-no-expand-[open].md`

## 2026-08-01 · v0.0.235（forked usage 统计链路修复 — RunResult.usage 聚合 + caller 补 notify）

- **`[P0]session_usage.md §6.1` 旁路 run notify 口径修正**：caller `accumulateUsage` 拿到 sid 链后对链上每个 sid 调 `notifyUsageChanged`（让 forked 分区增量即时可见，不依赖下一轮 main assemble）；同一 sid 多次 write 时 notify 一次即可（读 write 完成后最终 view）。**保留** v0.0.204 核心口径——caller 按 run 结束总量一次性累计 + `RunLifecyclePort.onUsage` 对 forked early return 防「逐调用 + 总量」双计。
- **`[P0]session_usage.md §10 补注**：`RunResult.usage`（`runReActLoop` 返回值，内存对象）已聚合每轮 callLLM usage（修复 v0.0.40 T6a 起回归——三条 return 曾硬编码 `{} as never`，导致 forked caller 拿到空 usage、forked 分区归 0、前端「整理」行隐藏）；**Run record 持久化 schema 仍不含累计 usage 字段**（future），崩溃恢复仍靠 SessionUsageMeta 持久化。
- **实现落点**：`session-usage-helper.sumUsage`（Σ NUMERIC_KEYS 纯函数）+ `run-react-loop.runReActLoop` 局部 `accumulatedUsage` 每轮 `sumUsage` 累加、三条 return 填值（L85/L279/L297）+ `context-compact-runner.runCompact`（L164-165）/ `post-compact-consolidation.startConsolidation`（L128-129）两 caller 在 `accumulateUsage` 后对 sid 链各调一次 `notifyUsageChanged`。
- **AT 验证**：`compact_model_directive` forked input_total_tokens=16085 / output=799 真实聚合（修复前 forked 分区归 0 → 「整理」行隐藏；修复后「整理」行显示）。
- **code↔spec 偏离核实（doc-modifier 阶段 5）**：`run-lifecycle-port.ts` L71 forked early return 保留（§6.1 防双计）；main loop 经 `attachRunPromise` 硬编码忽略 RunResult.usage（零双计）；`sumUsage` 复用 NUMERIC_KEYS（§2 字段集合）；三处代码 inline 注释已由 coder 同步更新为「caller 补 notify」表述。零静默偏离。
- 详情：`specs/tech/version_logs/v0.0.235/change_plan.md`

## 2026-08-01 · v0.0.231（Session 加 pinned 字段 — playground 会话置顶）

- **`[P0]session_store.md §2`**：Session interface 加 `pinned?: boolean`（lazy 默认 false，toSession `=== true` 规范化，无 migration；对齐 unread/titled 先例）。写路径唯一 = PUT /session/:id body.pinned（部分更新透传 + 非 boolean 400 + 写后 metaBroadcaster.broadcast）；**pinned-only 更新不刷 updatedAt**（置顶是纯标记——用户裁决 2026-08-01；经 `PutOptions.preserveUpdatedAt` + `computeEnvelope`，version 仍 +1），取消置顶按原对话时间在非置顶组归位。分组/排序纯前端展示层（store 统一比较器：先 pinned 降序、同组内 updatedAt desc），GET /session 顺序契约不变。
- 详情：`specs/tech/version_logs/v0.0.231/change_plan.md` + `specs/api/version_logs/v0.0.231/change_log.md`

## 2026-07-31 · v0.0.228（session_todo_changed 事件 — todo SSE 实时化）

- **`[P0]session_event.md §2`**：`SessionEventType` 联合 + `SessionEvent` 联合加 `session_todo_changed` / `SessionTodoChangedEvent`（data=空对象轻量信号，消费方收后重拉 GET 全量）。
- **`[P0]session_event.md §3` 触发表 + 三不 emit 原则**：`TodoStore.upsertItem` 写成功 / `removeItem` 真删 / `cleanupFinished` 真清（removed>0）触发；`removeAll`（session 销毁）不 emit。
- **`[P0]session_event.md §3a.4`**：session_todo_changed 经 **raw statusBus**（TodoStore 注入 wrap 前 bus）且不触发 session_meta broadcast（todo 不在 SessionMetaView；双保险=不进 META_TRIGGERING_TYPES）。
- **代码↔spec 偏离核实（doc-modifier 阶段 5）**：`session-event-types.ts`（类型/联合/注释）+ `todo-store.ts emitChanged`（ulid 幂等 id、try/catch 吞错）+ `bootstrap.ts:354`（注入 raw sessionStatusBus，时序先于 store-phase wrap）+ `session-meta-broadcaster.ts META_TRIGGERING_TYPES`（不含 todo 事件）与 spec 一致；无静默偏离。
- 详情：`specs/tech/version_logs/v0.0.228/change_plan.md` + `change_log.md`

## 2026-07-28 · v0.0.208 academy 板块整体删除（影响：SessionKind/SessionContext/SessionTypeProfile/SessionStore 全面收窄）

- **`[P0]session_kind.md §1-§5`** + **`[P0]session_store.md schema`** + **`index.md` 概念表** + **`[P0]session_type_profile.md`**：`BizType` 收窄为 `playground | studio`（去 academy）；`Role` 收窄为 `rocky | leader | mate | squad`（去 coach/student/trainer）；`SessionContext` 去 classroomId/coachId/studentId 三字段；K1-K5/C1-C3 校验规则去 academy/trainer 相关行；session_type_profile 的 academy-coach/academy-trainer profile 与 scope yaml 示例全部删除；canonicalId 示例改用 playground/studio 组合。

> 本目录级变更日志（位置轴）。跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 一行一 feature；版本块尾指向该版本 change_log 详情。

## 2026-07-26 · v0.0.205.t2_cons（AppTaskLock 1h 超时接管 + status 端点加 status/startedAt）

- **`[P0]app_task_lock.md §3.1`**：`acquire` CAS 前加超时接管——`state==='running' && startedAt 距今 > STALE_RUNNING_MS(1h)` → 视为可获取（覆盖写新 running + emit，等价 release+re-acquire 原子一步）；startedAt 缺失/NaN 保守不接管；仍内存 only 不落盘。解同进程 hang 永久卡死（重启天然释放已由 §3.2 满足）。
- **`GET /consolidation/status`** 响应加 `status: 'running'|'idle'|'failed'` + `startedAt: string|null`（透传 lock state，done 归 idle）；前端整理 tab onInit 据此初始化 isRunning（修切走切回按钮可点 UX bug）。契约 `specs/api/overall/03-config-center.md §2.7`。

详情：`specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md`（模块 B1）

## 2026-07-25 · v0.0.204 收尾（旁路 usage caller 总量口径 + profile 矩阵校验 + consolidate 交集 invariant）

- **`[P0]session_usage.md §6.1`**：旁路 run（summary/consolidate）usage 口径改述——**caller 按 run 结束总量一次性累计** `accumulateUsage(sid,'forked',总usage)`（fork-1 runCompact / fork-2 startConsolidation），`RunLifecyclePort.onUsage` 对 forked 桶 early return（不逐调用累计、不 notify，防双计）；推送由下一轮 main assemble 的 notifyUsageChanged 携带；**tier2 三 run 零累计**（公共全局整理不摊 session usage，用户裁决）。
- **`[P0]session_type_profile.md §4/§6`**：§4 加 invariant——main toolBound ∩ consolidate 基座 toolBound（[skill_manage,memory_manage]）必须非空（consolidate 旁路复用 main snapshot.tools，交集空则 fork-2 空跑）；trainer.main=18 / squad.main=3 各补两工具。§6 validator 校验项补矩阵完整性（validateMainMatrix：enabled `<prefix>:main` 必须有 `:summary`+`:consolidate` profile）+ 禁跨 biz extends（四基座豁免）。

## 2026-07-24 · v0.0.204（agent session type 行为契约统一 — forked 退役 + runKind 扁平 + SessionContext + profile 配置层）

- **`[P0]session_kind.md`（重写）**：SessionKind 瘦身——只留 biz/role/derivation（落盘）+ runKind（run 级不落盘，由 run 装配入口赋予）；实例 ID（squadId/memberId/parentSessionId/classroomId/coachId/studentId）拆为 `SessionContext` 结伴传递；canonicalId() 4 段纯拼接（同时即 scopeId）；trainer 升格独立 parent Role（K4 trainer⇒parent）；Derivation `main`→`parent` 改名；RunKind 扁平闭合枚举 3 值（main/summary/consolidate）替代原 modeKey 字段；ToolPolicyRole getter 删除（职责归 SessionTypePolicy）；校验拆两层（K1-K5 形状 + C1-C7 上下文存在性）。
- **`[P0]session_type_profile.md`（新建）**：SessionType Profile 配置层（每 SessionKind 组合一份 yaml + extends 继承 + 启动 validator + enabled 门）+ SessionTypePolicy 收缩 interface（profile + resolveToolSet）；21 策略点 → 机制映射；扩展新类型 step-by-step；打包护栏（build-plugins copyResources 须覆盖 session-types/）。
- **`[P0]session_store.md`**：SessionStore 加 `getSessionContext(sid)` 投影方法（与 getSessionKind 同一构造点产出 `{kind, context}`，runKind 不在此赋值）；createSession 加 enabled 门（profile 文件存在且 enabled!==false）；SessionConfig.scope 死字段删除描述（消费已不存在）。
- **`index.md`**：核心概念表加 SessionContext/SessionTypeProfile/RunKind/trainer；原则 8 改写（SessionKind 瘦身 + 实例 ID 拆分 + v0.0.204 终版概念）；导航加 session_type_profile 行。
- **forked 命名体系退役**：forked/isForked/forkedRun/buildForkedDeps/ForkedContextPort/ForkedLifecyclePort/MUTED_BUS 在本 KB 当前后续描述中不再出现（spec 当前置概念改述为「runKind=summary/consolidate（同 session 的旁路 run，snapshot 可选输入）」）；modeKey 字段并入 runKind 退役。
- **dev1 v0.0.203 merge 后 trainer 升格对齐**：academy-trainer 在 v0.0.203 是「subagent template 表达 + 独立 ToolPolicyRole」（ad-hoc 方案），v0.0.204 升格为独立 parent:main agent（profile.userReachable:false + ephemeral:true 承载「不可触达/临时/回收」语义，不进身份维度）；academy-student 未启用（enabled 语义）。
- 详情：`specs/tech/version_logs/v0.0.204/change_plan.md`

## 2026-07-21 · v0.0.186.summary_bake（summary 记录加 block 字段 — compact 烘焙文本持久化）

- **SummarySchema 新增 `block` 字段**（string，optional）：compact 时 `bakeSummaryBlock` 一次构建的完整 summary block 文本（preamble+head+tail），组装期 base_builder 直接用作 messages[0]（零计算，prompt 缓存前缀逐字节稳定；详见 context KB log 同日条目）。
- `SummaryInfo.block: string | null`（`toSummary` 归一：旧记录无字段 → null → 组装走即时构建 fallback，下次 compact 自动升级，不做启动迁移）；`setSummary` 入参加可选 `block`（传入才落字段，未传 → 旧记录形态不变）。
- 实现：`agent/schema_defs/summary.ts` + `session-store-types.ts` + `session-store-converters.toSummary` + `session-store-usage-impl.sessionStoreSetSummary`。

## 2026-07-21 · v0.0.185.cache（MessageRange 加 takeFromStart — head 候选锚定会话真第一条）

- `[P0]session_store.md`：`MessageRange` 新增可选 `takeFromStart?: boolean`（取范围头部 limit 条；缺省 false=取尾部；仅无 beforeId 时生效）。内部 store 接口扩展，HTTP/SSE 契约不动（handler 只显式取 limit/beforeId）。用途：rocky_context assemble 的 head 候选锚定会话真第一条（prompt 缓存前缀稳定，详见 context KB log 同日条目）。
- 实现：`session-store-messages-impl.sessionStoreGetMessages` + 插件 `in_memory_session_store.getMessages` 同步支持（`slice(0, limit)` vs `slice(-limit)`）。

## 2026-07-19 · v0.0.177.image_copy（workspace 端点组加 save-image leaf）

- **新增生产端点 `POST /session/:id/workspace/save-image`**（`handlers/session-workspace-save-image.ts`，约 148 行）：粘贴剪切板图片 base64 落盘 `<workspaceDir>/images/image-<ulid>.<ext>` → 返相对 workspaceDir 的 POSIX 路径，前端据此插 `@file` pill。
- **路由 leaf 追加**：`matchSessionPath` workspace 子段正则末尾追加 `|save-image`（sub=`workspace_save-image`），dispatch 加分支调 `handleWorkspaceSaveImage`。既有 5 个 leaf（tree/open/pick-directory/watch/unwatch）匹配顺序不动（INV-R-1）。
- **复用既有安全范式**：`json()` helper via import；filename server 单一权威（`ulid()` + 闭合 ext），`mediaTypeToImageExt` 闭合 5 值（png/jpg/gif/webp，jpeg/jpg 都 → .jpg）；`realpathSync(workspaceDir)` + `absPath.startsWith(realRoot + sep)` 白名单二次守卫；error message 不回显 base64/abspath。
- **无 spec↔code 偏离**：api §2.6.6 + ui `chat-composer.md §粘贴图片` 已 doc-modifier 阶段补齐。

详情：`specs/tech/version_logs/v0.0.177/change_plan.md`（§新端点 API 契约 + §变更清单）

## 2026-07-17 · v0.0.164.memory_opt（新增 AppTaskLock — app 级 × per-task 内存锁）

- **`[P0]app_task_lock.md`（新建 KB 文件）**：`AppTaskLock` class（形态**照抄** SessionTaskLock 扩到 app 级，去 sessionId 维度）——同 API（`acquire/markDone/markFailed/release/getState/reconcileOnStartup` + `setAppTaskBus`）、同 CAS 语义、同「不落盘」决策、同「三不原则」emit 语义。本版本唯一新概念，用于防「手动 POST /consolidation/run + cron 到点」跨触发源撞车（engine 的 per-job inFlight Set 只防同 Promise 重入，不防跨 caller 撞车）。
- **决策**：`AppTaskLock` **独立 class**（不复用 SessionTaskLock 扩 sid='__app__'），三大理由——(1) API 类型层强制（不需 sessionId 入参哨兵字符串）；(2) emit 目标不同（`app_task` topic 广播 group `_all` vs `session_panel` per-sid）；(3) bootstrap 独立单例装配。见 `../../version_logs/v0.0.164.memory_opt/change_log.md §2 决策表`。
- **新增 SSE topic `app_task`**（广播 group `_all`，non-replayable——app 级状态刷新走 HTTP `GET /consolidation/status` 拉初始态，SSE 只作实时刷新）；事件类型 `consolidation_task_update`，data=AppTaskState 全量。
- **`[P0]session_event.md §3b`（新增）**：app_task topic 契约（topic 属性表 + `ConsolidationTaskUpdateEvent` 类型 + 触发时机 + 与 session_panel/session_meta 的边界）。
- **`index.md ④`** 加原则 11：app 级后台任务互斥用 AppTaskLock（形态对齐 SessionTaskLock），本版本 taskType='tier2_consolidation'；未来其他 app 级任务（backup/cleanup 等）复用同一 lock。
- **`index.md ⑤`** 导航加 `app_task_lock.md` 行。
- **bootstrap 装配序（cross-phase）**：`bus-phase.registerTopic(APP_TASK_TOPIC, replayable:false)` → `store-phase.new AppTaskLock + reconcileOnStartup(no-op)` → `agent-phase.setAppTaskBus(appTaskBus)`（bus 就绪保证）→ `scheduler-phase 透传 appTaskLock 到 registerConsolidationJob`。缺一即崩（bus 未注入 emit no-op；appTaskLock 未透传 cron gate2 缺失）。
- **debt 备忘**：本 KB 涉及 `bootstrap-agent-phase.ts` 332/`bootstrap.ts` 423 dev1 基线已 >300 行；T4 追加 7/11 行 wiring 均最小可行必要，非本版本引入。建议后续版本拆分（如按 `PhaseDeps` 分片）。

详情：`specs/tech/version_logs/v0.0.164.memory_opt/change_log.md` + `change_plan.md`

## 2026-07-17 · v0.0.163.studio_unread_race（unread CAS 落盘时序不变量）

- **[P0]session_state.md §4.4 timing 表**：调用方栏细化到 `markUnreadTrue` / `markReadAndEmit`；新增「落盘时序不变量」段——broadcaster 同步重读 crud，触发方必须 await put 落盘后再 broadcast/emit，否则广播旧值 → 前端红点被清后又被旧值重置回来的 race（用户 Studio 观察）。
- **[P0]session_state.md §6.3 不变量 7 新增**：unread CAS 落盘时序约束仅落在 `markUnreadTrue` / `markReadAndEmit` 两个入口；状态机五态 CAS（markRunning/markIdle/...）不受约束（无同步重读 crud 的 broadcaster 挂后）。
- **对齐 code**：`app/server/src/agent/session-unread-ops.ts` 两处 `void putAsync` → `await putAsync`；spec 同步。
- 详情：`specs/tech/version_logs/v0.0.163/change_log.md`

## 2026-07-16 · v0.0.158.compact_model_resolve（session-messages / session-compact / bootstrap 收敛到唯一入口）

- **session_config `buildSessionConfigFromDeps` 签名瘦身**：删 `bodyOverride: ProviderModelOverride | undefined` 位置参 + 末位 `task: 'chat' | 'summary' = 'chat'` 参数（三处 caller session-messages / session-compact / bootstrap 同步去参）。`ProviderModelOverride` interface 整删（grep 0 引用）。技术权威 `../providers_and_models/[P0]model_resolve.md §5.1`。
- **session-messages `handleMessagesPost`**：删 body override 解析（body.providerId 校验分支 + body.modelId 校验 + 落盘分支 `validateModelId → normalizeReservedModelId → updateSession({modelId})` 整块）；`PostMessageBody` interface 删 `providerId?` / `modelId?` 两字段；旧 client 传字段**运行时静默忽略**（不解析、不校验、不 400、不落 session）。合规实现见 `../../../api/overall/04-agent-session.md §3.2`。
- **session-compact `handleSessionCompact`**：删 `buildSessionConfigFromDeps(...)` 90 行组装块；改为 `config = await deps.agentManager.resolveConfigBySid(id)` 唯一入口（chat/compact 同链）。handler 从 ~90 行瘦到 ~30 行。技术权威 `../context/[P0]context_compact_detail.md §2b`。
- **bootstrap 三处闭包**（v0.0.156 拆分后位于 `bootstrap-agent-phase.ts`）：
  - `setResolveConfig` 闭包：调 `buildSessionConfigFromDeps` 位置参对齐新签名（删 bodyOverride 位置参 + 末位 task）。
  - `setForkedRunner` 闭包：**首行** `const config = await agentManager.resolveConfigBySid(input.sessionId)`（自动 compact 走**唯一入口**，不消费 caller 传入的 config）；下方 `agentManager.forkedRun` 用本地 `config`。
  - `setConsolidationRunner` 闭包：同 setForkedRunner，T1 记忆整理也走**唯一入口**。
- **`compact-types` / `context-compact-runner` / `post-compact-consolidation` runner input shape 收敛**：`CompactForkedRunner` + `ConsolidationRunner` 的 input 删 `config: SessionConfig` 字段；`runCompact` 形参 config 保留（内部只用 `config.sessionId`）；`CompactCtx.config` 保留（consolidation handler 从 `ctx.config.sessionId` 派生 sid）。详见 `../context/[P0]context_compact_detail.md §6.4` v0.0.158 行。
- **不动 spec**：session state 六态机 / SessionStore API / SSE 事件模型 / squad session 派生规则（本版本改的是「chat 发消息 body / compact runner 入口」的模型 resolve 收敛，session 数据模型 + 状态机 + 事件流全无变化）。
- 详情：`specs/tech/version_logs/v0.0.158.compact_model_resolve/change_plan.md`（§B session-config + §C session-compact + §D session-messages + §E bootstrap + §F compact runner/types）

## 2026-07-16 · v0.0.156（SessionStore facade 化，方法体拆 4 impl 文件）

- **`session-store.ts` 822 → 313 行 facade**：constructor + 字段声明（`readonly crud/statusBus/childrenIndex` 等，见下「偏离」）+ 21 method 签名 + 方法体单行委托（`return sessionStoreXxx(this, ...)`）。所有公开方法（含 core createSession/getSession/getSessionKind/updateSession/listSessions/deleteSession 等）**统一委托模式**——`session-store-core-impl.ts` 承接 core 8 方法。
- **4 impl 文件**：
  - `session-store-core-impl.ts`（295 行，8 函数）：createSession / getSession / getSessionKind / updateSession / listSessions / deleteSession / fallbackCascadeDelete / stripEnvelope
  - `session-store-messages-impl.ts`(177 行，7 函数)：createRun / getRun / updateRun / getRuns / appendMessages / getMessages / getMessagesByRun
  - `session-store-usage-impl.ts`（202 行，8 函数）：getSummary / setSummary / accumulateUsage / updateContextWindowUsage / notifyUsageChanged / getRatio / getUsageView / persistUsage
  - `session-store-children-impl.ts`（94 行，1 函数）：listChildren
- **偏离（INV-S-3 字段可见性 doc-modifier 已回填）**：change_plan §4.5 约束「crud/statusBus/childrenIndex 保留 `private`/`readonly`」，实际拆分需 impl 函数访问 `store.crud/statusBus/childrenIndex`，故改为 `readonly crud/statusBus/childrenIndex`（public readonly，与已有 `readonly stateMachine` 字段同款）。readonly 保留防止运行时改写；不影响外部 encapsulation（外部消费方仍走 method surface，未新增字段读依赖）。
- **INV-S-1/2/4 语义等价**：appendMessages / getMessages / getMessagesByRun 分页语义（ULID 字典序 = 时间序）+ listChildren 分组语义（running / terminated 按 updatedAt desc + childrenIndex 增量维护 O(children)）+ usage 三分区累加 + ratio 滑动 3 中位数 + `statusBus.emit(session_usage_update)` 全部等价。
- **INV-S-3 公开 API 100% 等价**：grep 验证 bootstrap / handlers / services 零改（`store.appendMessages/getMessages/accumulateUsage/notifyUsageChanged/getRatio` 等所有调用点未动）。
- **`[P0]session_store.md` §4 补 facade 注（现状描述）**：SessionStore class = facade，方法体走 `session-store-{core,messages,usage,children}-impl.ts` 单行委托；接口契约不变。
- 详情：`specs/tech/version_logs/v0.0.156/change_log.md` + `change_plan.md`（段 C-2 + INV-S-1~4）。

## 2026-07-14 · v0.0.139（workspace watcher 懒监听重构：展开才监听 + tab 显式控制）

- **`[P0]session_workspace_manager.md` 全文重写**：监听模型从「每前台 session 一个**递归** watcher」→「**懒监听**：workspace 根一层 + 展开目录各一层（chokidar `depth:0` 非递归）+ tab 监听列表（`clientId`）+ 目录引用计数」。接口 `startWatch/stopWatch/switchDir` → `watch/unwatch/releaseTab/recycleSession/switchDir`；两层回收（前端显式 releaseTab + `session_panel` 1→0 兜底 recycleSession）；关闭串行化防重入（Bun FSEvents 段错误面）；移除 addDir→`watcher.add` 自动递归；GET tree 绝不隐式 watch。文件拆分（manager/registry/dir-watcher/change-emitter）。
- **`[P0]session_workspace_manager.md §3/§12`（doc-modifier 订正对齐代码）**：`watch/unwatch` 接口签名 3 参 → **4 参**（加 `workspaceDir`——manager 不持 SessionStore，需 caller 传根做 resolve + emitter relPath 基准，合理偏离已裁决）；§12 补 watch/unwatch handler 物理落点 = `handlers/session-workspace-watch.ts`（从 session-workspace.ts 拆出防超 300 行，契约/符号名不变）。
- **`index.md ④#10 + ⑤`**：核心设计原则 #10 从「await ready + addDir 显式 add（递归模型）」改写为懒监听模型；导航描述同步。
- **`[P0]session_workspace.md §1/§3/§4` + `[P0]session_store.md §4`**：§1/§3 fs watch 监听根从 `startWatch(sid,dir)` → 前端显式 `POST watch{clientId,path:''}`；§4 切目录副作用 stop→set→start → recycleSession→setDir（不重启，前端重新 watch 新根）；session_store.md `setWorkspaceDir` 注释 stop→set→start → recycle→set。
- 详见 `specs/tech/version_logs/v0.0.139/change_plan.md` + `reqs/[working] v0.0.139.lazy-workspace-watch/req.md`（用户六裁决红线）。

## 2026-07-09 · v0.0.101（suspended 第六态 + pendingToolCalls 落盘 + reconcile 保留）

- **`[P0]session_state.md §1/§2/§3/§5`**：五态 → 六态（加 `suspended`）；`running===state∈{running,interrupting}` 排除 suspended（INV-2，列表亮「?」非 spinner）；`markSuspended` 新 CAS（生产者=onRunEnd stopReason=tool_pending）；`markRunning` WHERE 加 suspended（suspended→running 是回填激活，O6）；`reconcileOnStartup` 保留 suspended + 校验 pendingToolCalls（不清 idle，INV-3）。
- **`[P0]session_store.md §2/§4`**：Session 加 `pendingToolCalls: PendingToolCall[]`（落盘）；SessionStore API 扩展 markSuspended/peekPendingToolCall/setPendingToolCalls/resolvePendingToolCall。
- 详见 `specs/tech/version_logs/v0.0.101/change_log.md` + `change_plan.md`（模块 D）。

## 2026-07-08 · v0.0.89（session.modelId 保留字 `default` = 未手动选/跟随默认）

- **`[P0]session_store.md §2 Session interface`**：`modelId?: string` 字段（已存在）注释更新——保留字 `"default"` = 未手动选/跟随默认。POST /session body.modelId 缺省 → 落 `"default"`（替代旧 undefined）；PUT /session/:id body.modelId 接受 `"default"`/`"none"`（规范化为 default 落盘）/具体 ModelRef；resolveModel 在 `providers_and_models/[P0]model_resolve.md §3.1` 视 `default`/`none`/`""`/`undefined` 为「继续 fallback」（不短路，不抛错）。
- **`session.providerId` 字段降级注释**：v0.0.9 历史持久化字段（多数未填），不代表主动选择；resolver 不读 providerId，仅 cross-provider 反查 modelId 定位 provider（v0.0.33.2 BUG-3 修后稳定路径）。schema 类型不变（仍 optional string）。
- **schema 类型不变**：仍是 `string?` optional——保留字通过单点 helper `isReservedModelId` / `normalizeReservedModelId`（落 `services/model-validation.ts`）处理，不引入新 flag 字段（v0.0.89 决策「session.modelId 不加 flag 字段，用 string 保留字」）。
- **代码落点（T2 已 verified）**：`handlers/session.ts:handleSessionCollection` POST 缺省 → `effectiveModelId = body.modelId ?? 'default'`；`handleSessionItem` PUT 接受 `default`/`none`/具体 + `none` 规范化为 `default` 落盘；`handlers/session-messages.ts` + `session-run.ts` bodyOverride.modelId 优先 + 保留字视为未覆盖继续走 fallback；`member.ts` validateModelId 注释更新（保留字 default=inherit）。

详情：`specs/tech/version_logs/v0.0.89/change_log.md`

## 2026-07-07 · v0.0.85.ui_opt（SessionWorkspaceManager chokidar ready + addDir）

- **`[P0]session_workspace_manager.md §3/§4` 补「await ready + addDir」**（F2，对齐 squad_filewatch BUG-005/006 模式）：
  - `startWatch` 内部加 `await waitForChokidarReady(watcher, 5000)`（5s 超时兜底防 hang，超时仍 resolve 不抛）——保证 caller 拿到的 watcher 已就绪，文件事件不落在初始扫描窗口被 ignoreInitial 吞。
  - `startWatch` 注册 `watcher.on('addDir', abs => watcher.add(abs))`——macOS FSEvents 后端对运行时新建子目录递归监听不可靠，强制 add（chokidar4 `add()` 同步非 Promise，禁 `.catch()`）。
  - 仍保留 `ignoreInitial:true`（初始树走 GET tree API）+ 100ms debounce + lazy lifecycle 不动。
- **`bootstrap.ts setSubscribeHooks` 改 async+await**（F2 D4 修复）：onSubscribe/onUnsubscribe 内 `await workspaceManager.startWatch(...)` / `await workspaceManager.stopWatch(...)`，消除 `void startWatch/stopWatch` fire-and-forget 竞争（快速切 tab 时序残留/漏启）。
- **`sse_channel.md §5` setSubscribeHooks 接口**：`SubscribeHooks.onSubscribe/onUnsubscribe` 返回类型 `void → void | Promise<void>`（保留 sync 兼容）；`SseChannel.subscribe/unsubscribe` 内 `await hooks.onSubscribe?.(...)` / `await hooks.onUnsubscribe?.(...)`（hook 异常 try/catch 不影响订阅本身）。
- F2 前端：squad 群聊（section-squad-chat.tsx）补独立 session_panel 订阅（独立 SseClient 实例 + handler 仅处理 workspace event → setLastWorkspaceEvent）；member-chat 补一行 onWorkspaceEvent 接 store.setLastWorkspaceEvent（修当前漏接）。

详情：`specs/tech/version_logs/v0.0.85.ui_opt/change_plan.md`

## 2026-07-06 · v0.0.80.t1（tier1_consolidation 锁实接）

- **`[P0]session_task_lock.md §6` 实现落点表**：`post-compact-consolidation.ts` 行从「修改（如 tier1 接入）」改为「**已接入**（v0.0.80.t1）」——`MemorySkillConsolidationHandler.handle` 内部 acquire `'tier1_consolidation'`：锁失败静默 return（fire-and-forget）；fork-2 完成 `markDone` / 异常 `markFailed`（与 `compact` 锁对称）；emit 由 SessionTaskLock 内部 emitTaskUpdate 自动承担（v0.0.78.bug 已实装）。
- **§7 不变量 #4 补例**：「同 session 同 taskType 同时只 1 个 active」补例：`compact + tier1_consolidation` 同 session 可并行（不同 taskType，互不阻塞）——v0.0.80.t1 sibling 双发后这是常态（fork-1 acquire `compact` + fork-2 acquire `tier1_consolidation` 同时跑，写入域正交：summary 写 setSummary，consolidation 写 skill/memory 独立 store）。
- **`index.md` ④ 第 4 条补 v0.0.80.t1 注记**：tier1_consolidation 锁实接（MemorySkillConsolidationHandler.handle 内部 acquire/markDone/markFailed + compact + tier1 同 session 可并行）。

详情：`specs/tech/version_logs/v0.0.80.t1/change_log.md`

## 2026-07-06 · v0.0.78.bug（SessionTaskLock bus 注入 + summary_task_update SSE 恢复）

- **`[P0]session_task_lock.md` SessionTaskLock 加 bus 注入**：私有字段 `sessionPanelBus?: ReplayableEventBus` + 后置 setter `setSessionPanelBus(bus)`（与 ContextEngine.setTaskLock 同模式，避免构造函数耦合；bootstrap 在 registerTopic(SESSION_PANEL_TOPIC) 后调）。
- **CAS 成功后 emit `summary_task_update`**：`acquire/markDone/markFailed/release` 各自在 CAS 成功（state 真正变更）后调私有 `emitTaskUpdate(sid, next)`；emit 异常吞掉不影响 CAS 返回值（observability 链路自治，不污染调用方）；bus 未注入时 no-op（UT 兼容）。**emit 失败 / CAS 失败 / 非 running 调用** 三种 no-op 情形明确。
- **`[P0]session_event.md` 同步**：§2 `SummaryTaskUpdateEvent.data` 类型改为 `SessionTaskState`（从 session_task_lock.md 引用，不再本地重定义 `SummaryTaskStatus`）；§3 触发表加 v0.0.78 emit 源迁移说明（markSummary* → SessionTaskLock.acquire/markDone/markFailed/release）；§3a.3 `SessionMetaView.summaryTask` 改 optional（方案 A：broadcaster 不填，前端从单独 SSE 事件取——前端 CompactBtn 订阅代码已就绪，不读 meta_view）。
- **`session-event-types.ts` + `session-meta-broadcaster.ts`**：恢复 `SummaryTaskUpdateEvent` interface（v0.0.55 误删）+ `_META_TRIGGERING_TYPES` 加回 'summary_task_update'。事件名复用「summary_task_update」（不改 compact_task_update）——决策见 change_log：前端契约零改动 + SessionTaskLock 已开放集合（'compact' | 'tier1_consolidation' | string）。

详情：`specs/tech/version_logs/v0.0.78.bug/change_log.md §T2`

## 2026-07-04 · v0.0.66（session_store EP 化 — persistent/in_memory 双 impl）

- **`[P0]session_store.md` §4 顶部加 session_store EP 注**：SessionStore 接口额外做成 `SessionStorePoint` exclusive 扩展点（group='context'），`ContextEngine.ingest/assemble` 经 `resolveStore(scopeId)` 选 impl。两个 impl：
  - `persistent_session_store`（default scope 选中）：包装真实持久 SessionStore 实例（delegate holder，plugin → server import，全方法子集）
  - `in_memory_session_store`（forked scope 选中）：per-session `Map<sessionId, Message[]>`；只实现 appendMessages + getMessages + getSummary（恒 null）+ getRatio（恒 1.0）+ updateContextWindowUsage（no-op）+ releaseSlot
- **`releaseSlot` 命名分离**（v0.0.66）：`SessionStoreContract.releaseSlot` 仅清 forked 内存槽（forked run 结束 caller 调）；与 `SessionStore.clearSession`（删整 session 返 Session）命名分离，避免误删真实 session。`session_store.md §4` clearSession 方法加注。
- 实现层（task）：`app/plugins/builtins/rocky_context/store/persistent_session_store.ts` + `in_memory_session_store.ts` + `app/server/src/agent/session-store-ep-delegate.ts`（delegate holder）+ `app/server/src/agent/context-engine-store-resolver.ts`（resolveStore + clearScopeSession）。
- 关联：`../context/[P0]context_engine.md §3.6`（ContextEngine 主干零 isForked）+ `../context/[P0]extension point and implementations.md §3.9`（session_store EP 索引）。

详情：`specs/tech/version_logs/v0.0.66/change_log.md`

## 2026-07-04 · v0.0.57（删 SessionKind.parentToolPolicyRole getter）

- **`[P0]session_kind.md §2.2/§3.2/§4.2/§7.5/§9`**：删除 `parentToolPolicyRole` getter——它是 capByParent 的唯一消费者，capByParent 删除后变死代码。subagent 不再从自身 biz+role 派生 parent ToolPolicyRole，parent 信息无需在 kind 层暴露。§4.2 改为「v0.0.57 已删」历史说明。
- **代码同步**：`app/shared/src/types/session-kind.ts` 删 getter + 头部注释；UT 删 `SessionKind.parentToolPolicyRole` describe 块。
- **关联**：`tools/[P0]tool_policy.md` 同步删 capByParent 字段 + resolveTools subagent 分支的 ∩ parent.bound。

## 2026-07-03 · v0.0.56（SessionKind 统一 session 身份维度）

- 新建 `[P0]session_kind.md`：SessionKind 类型（接口 + Role/Derivation/BizType 枚举）+ `getSessionKind(sid)` 构造入口（SessionStore 方法）+ 派生 getter（isStudio/isSubagent/toolPolicyRole/allowedTools）+ 6 条校验规则（写入时 validate）+ ToolPolicyRole 类型移入 shared 层。
- `index.md`：⑤ 导航加 `session_kind.md` 行；④ 加第 9 条核心原则（SessionKind 统一对象）。
- `[P0]session_store.md §2`：删 `type` / `scope` / `subAgentConfig.parentRole` 字段；加 `role: Role` / `derivation: Derivation` / `biz: BizType`（必填字段；旧 optional 字段删除）。
- `[P0]session_biztype.md §4`：bizType↔type 关系表升级为 biz↔role 校验规则（写入时 validate，字段仍独立存）。
- 关联：`[P0]tool_policy.md §2.3`（resolveRole → kind.toolPolicyRole）；`[P1]subagent_derivation.md §2`（type/scope 字段语义 → role/derivation）；`[P1]a2a_protocol.md §2`（AgentRef.type `'session'`→`'rocky'`）；squad/*（三角色 session 字段）。

详情：`specs/tech/version_logs/v0.0.56-session_type/change_log.md`

## 2026-07-03 · v0.0.56 hotfix（SessionKind 彻底迁移——删死代码 + capByParent 从 kind 纯派生）

- **`[P0]session_kind.md`**：§2.2 SessionKind interface→**class**（构造函数 + readonly 字段）；**删** `allowedTools(parentKind?)` 方法 + `ResolveToolsFn` 类型（死代码）；**加** `parentToolPolicyRole` getter（derivation='subagent'→`${biz}-${role}`，否则 undefined）。§3.2 构造算法简化为 `new SessionKind({...})`。§4.2 重写（旧 allowedTools 算法 → parentToolPolicyRole 派生）。§7.5 删依赖注入描述。§2.3 加 `SessionKindInput` interface。
- **`[P0]session_biztype.md §2`**：bizType?:（optional 空=playground）→ biz:（必填，无 lazy 默认）；概念类型名 `BizType` 不变。
- **关键**：capByParent 从 kind 纯派生——不读 parent session、不需 parentRole 字段持久化、不需 parentKind 入参。

详情：`specs/tech/version_logs/v0.0.56-session_type/change_log.md`（hotfix 节）

## 2026-07-03 · v0.0.55（统一 SessionTaskLock + subsumes summaryTask）

- 新建 `[P0]session_task_lock.md`：per-session × per-task 内存锁（CAS 语义，不落盘）；接口 acquire/markDone/markFailed/release/getState/reconcileOnStartup；subsumes v0.0.13 summaryTask 旁路 CAS。
- `index.md`：① 加 SessionTaskLock 概念 + summaryTask 标废弃；④ 第 4 条改写（统一锁 subsumes summaryTask + 不落盘理由）；⑤ 导航加 session_task_lock 行 + session_state 行加废弃标注。
- `[P0]session_state.md §3a`：summaryTask 旁路 CAS 段标记废弃（迁移到 session_task_lock.md）；调用方 markSummary* 改 SessionTaskLock.acquire/markDone/markFailed。
- `Session.summaryTask` 字段 + markSummary* 方法从 SessionStore/session-state-machine 删除（实现层 task）。

详情：`specs/tech/version_logs/v0.0.55.memory_ui_session_lock/change_log.md`

## 2026-07-02 · v0.0.47 doc-modifier 同步（drift 订正）

- `[P0]session_store.md §2` titled 字段：补「**createSession 强制写 false**」一句（对齐代码 session-store.ts:107-111 显式写 false 防御 caller 透传 CreateSessionInput.titled）；引用行号从 `session.ts:165-191` 校正为 `session.ts:184-195` + `session-update.ts:37-44`（applyTitleUpdate helper 抽出后 PUT title 走 helper，line 号变化）。
- `[P0]session_event.md` + `index.md` + 本 `log.md` frontmatter `updated` 2026-06-30 / 07-01 → 2026-07-02（v0.0.47 doc-modifier 阶段同步）。
- 验证：`[P0]session_event.md §3a.4` 触发时机表 v0.0.47 两行（PUT title / AI 起名 CAS broadcaster 直调）与代码一致；`SessionMetaView.titled` 字段（§3a.3）对齐 session-meta-broadcaster.ts sessionToMetaView 实现。

## 2026-07-01 · v0.0.47（titled 字段 + PUT title 广播补强）

- `index.md` ④ 加第 8 条核心原则：**titled 字段 lazy 默认 false**（lazy 默认 + 不跑 migration；首 query 触发条件天然保护现存 session）；⑤ 加关联 KB 引用（auto_naming）。
- `[P0]session_store.md §2`：Session interface 加 `titled?: boolean`（optional，lazy 默认 false；AI 起名应用 / 用户改名均置 true）。**lazy 默认 false 无 migration**：AI 起名首 query 触发条件（transcript 无 prior role=user，详见 `../auto_naming/[P0]auto_naming_service.md §2.2`）天然保护现存 session 不被误触发，无需扫描存量置 true。
- `[P0]session_event.md §3a`：`SessionMetaView` 加 `titled: boolean` 字段（对齐 GET /session 返回 shape）；§3a.4 触发时机表加「PUT /session/:id body.title 更新」一行（v0.0.47 补强：title 更新路径写完调 `metaBroadcaster.broadcast(sid)`）。
- AI 起名 service（消费 titled + 触发 broadcast）独立 KB：`../auto_naming/`。
- PUT title 广播补强（`session-update.ts:76-80` + `session.ts:165-191`）：title 写完后调 `metaBroadcaster.broadcast(sid)`，让前端列表经 `session_meta_update` 实时刷新。

## 2026-07-01 · v0.0.44（session_usage write/notify 分离）

- `[P0]session_usage.md` §3/§5/§6/§9/§10：`accumulateUsage` / `updateContextWindowUsage` 变纯 write（不 emit）；新增 `notifyUsageChanged(sid)`：读 `getUsageView(sid)` 全量 view → emit `session_usage_update`。`accumulateUsage` 返回 sid 链（自身 + 递归 parent）供调用方 batch notify。
- 修正 v0.0.40 T6a（`e394bae`）暴露的 UI 归 0 bug：根因是 write 与 notify 耦合 + emit payload 缺字段（accumulate emit 不带 cw），非 loop 顺序问题。参考 v0.0.27 `SessionMetaBroadcaster` 单点捕获先例。

## 2026-06-30 · v0.0.35

- OKF KB 化：建 `index.md`（5 章总起）+ 本 `log.md`（session 无 overview.md，9 文件本就平铺）。
- 全部 9 文件加 YAML frontmatter（`type`/`title`/`priority`/`status`/`updated`/`since`）。
- 正文清理版本噪声：顶部 `> version: X.Y` blockquote + 尾部 `## N. 版本` 段移除（迁移到本 log）；inline `[vX.Y]` 字段级「新增」标签下沉到 frontmatter `since` 或保留为 drift 订正标记。

## 2026-06-29 · v0.0.33.1（squad 增量字段 + bizType）

- `session_store.md` v2.8：Session 加 `bizType?:'playground'|'studio'` / `squadId?` / `memberId?` 三 optional 字段；`type` enum 的 `'member'` 改 `'mate'`（B 方案，避免与 member entity 名撞）；`parentSessionId` 注释补「leader/mate/squad session = null，仅 subagent 有 parent」。
- 新增 `session_biztype.md` v1.0：bizType 二分 + 隔离规则（GET /session 缺省 playground 过滤 / subagent 跟 parent / 现存 lazy 默认）+ 传递规则。

## 2026-06-27 · v0.0.30（subagent 列表索引）

- `session_store.md` v2.6：`SessionStore` 接口加 `listChildren(parentSid, filter)` + 内存正向索引 `Map<parentSid, Set<childSid>>`（`session-children-index.ts` `ChildrenIndex`，lazy 建 + create/delete 增量维护，O(children) 替代全量 scan O(N)）。

## 2026-06-27 · v0.0.28（multi_agent 派生字段）

- `session_store.md` v2.7：Session interface 补 multi_agent 字段（`type?`/`parentSessionId?` 顶层/`scope?`/`subAgentTemplateType?`/`origin?`/`subAgentConfig?`），每字段指向 `specs/tech/multi_agent/[P1]subagent_derivation.md §2`；SessionUsageMeta.parentSessionId 注释校准为「两处保持之一」。

## 2026-06-27 · v0.0.27（未读 + session_meta 广播）

- 未读模型从 watermark（`lastReadAt`/`lastFinishedAt` 派生）改为 **explicit-bool**（`unread: boolean` 存储值）：决策见 `specs/tech/version_logs/v0.0.27/unread-model-decision.md`。
- `session_state.md` v1.5：产生未读归属层从 agent-loop 改为 **session 层自治**（`SessionUnreadOps` runtime 监听状态机 completion 信号 → 查 isSessionActive 非前台 → CAS unread=true）；崩溃恢复不产生未读。
- `session_event.md` v1.7：新增 `session_meta` 广播 topic（共享 `_all` group / non-replayable）+ `SessionMetaUpdateEvent` + `SessionMetaView` + 触发时机全集；`SessionMetaBroadcaster` 订阅 statusBus 单点捕获。

## 2026-06-23 · v0.0.17（workspace）

- 新增 `session_workspace.md` v1.1：Session 加 `workspaceDir: string` 持久化字段；初始目录策略 `<DATA_DIR>/workspaces/<sid>` 自动建（BUG-001 修复：caller 提供 workspaceDir 时校验 abs+exists+isDir 后用该值）；切换流程 stop→set→start；历史兼容 lazy 修复。
- 新增 `session_workspace_manager.md` v1.1：SessionWorkspaceManager（chokidar v4 选型 + watcher **lazy** 启停 + 切目录换 watch + 100ms debounce + 跨平台注意 + 前端先 GET tree 再 subscribe 协调）。
- `session_event.md` v1.4：SessionEventType 加 `session_workspace_file_changed` + `session_workspace_dir_changed`（snake_case 校正）。
- `system_reminder`（context KB）workspace provider 接线：`workdir = session.workspaceDir`。

## 2026-06-23 · v0.0.16（clear + cacheRate + system 注入路径）

- 新增 `session_clear.md` v1.1：clearSession 接口（单事务清空 transcript/summary/runs/usage/summaryTask/state，tokenLimit 保留）+ clear vs delete 边界 + 并发处理（abort current run + markSummaryFailed）+ store 内 emit 三事件（spec drift 订正：原写 caller emit，代码 store 内 emit，spec 对齐代码）。
- `session_usage.md` v4.1/4.2：SessionUsageView 加 4 个 cacheRate 派生字段 + 键名对齐代码（简写 current/sub/forked/total + Record 化）。

## 2026-06-22 · v0.0.14（accumulateUsage 激活）

- `session_usage.md` v4.0：`accumulateUsage` 从 no-op 激活（三分区真累加 + 递归 sub + ratio 学习 3 轮收敛 + session_usage_update 真发 + getUsageView 真聚合）。

## 2026-06-21 · v0.0.13（summaryTask + usage view）

- `session_store.md` v2.1：Session 加 `summaryTask: SummaryTask` 单值字段（D2.3，旁路 CAS）。
- `session_event.md` v1.3：SessionEventType 加 `summary_task_update`（D2.6）+ 触发时机扩展 4 个 summaryTask CAS API。

## 2026-06-20 · v0.0.12（五态机）

- `session_state.md` v1.0：Session 运行态五态枚举（idle/running/interrupting/interrupted/error）+ 冗余 `running` bool + `currentRunId` + 全 CAS API + reconcileOnStartup 崩溃恢复。设计源 `states/v0.0.12/design.md` 板块 4/5/7/11。
- `session_store.md` v2.0：Session interface 加运行态字段。
- `session_event.md` v1.2：SessionEventType 加 `session_status_update` + 触发时机扩展 6 个状态机 CAS API。

## 2026-06-20 · v0.0.10（Usage 类型落地）

- `session_usage.md`：Usage 类型（9 token 字段 + char + cost）在 `app/server/src/message/types.ts` 全字段落地；`CanonicalResponse.usage` 从 `Record<string,number>` 改完整 `Usage`。

## 2026-06-19 · v0.0.7/0.0.8（ foundational）

- `session_concepts.md`：内容概念（raw/transcript/tool_result/summary）+ truncate vs snip + snip 状态。
- `session_store.md` v1.x：SessionStore 统一存储 + Session/Run interface + pk 检查 + 持久化后端（取代旧 session_interface/session_off_loader）。
- `session_event.md` v1.0/1.1：SessionEvent 体系（topic `session`→`session_panel`；`usage-changed`→`session_usage_update`；union key `subtype`→`type`）。
- `session_usage.md` v1.x/2.x/3.x：Usage 类型 + main→current 重命名 + ratio 归 session + char 入 usage。

## 2026-07-15 · v0.0.148（Session 加 effort / approvalMode / alwaysApprovedKeys 三字段）

- `session_store.md` §2 Session interface 加 3 持久化字段（optional + lazy 默认，兼容历史 session）：
  - `effort: 'default'|'low'|'high'|'max'`（缺省 default）— 推理强度档位，canonical 语义值（default=不传 wire）。
  - `approvalMode: 'normal'|'greenlight'`（缺省 normal）— 审批模式总开关（绿灯短路策略 ask）。
  - `alwaysApprovedKeys: string[]`（缺省 []）— 本会话「永远同意」集合（per-session 持久化，纠正 v0.0.122 D2 内存不落盘）。
- SessionSchema 加对应 3 字段（effort/approvalMode 用 enum 闭合；alwaysApprovedKeys 用 json 透传，同 pendingToolCalls 风格）。
- updateSession patch Pick 扩 3 字段；alwaysApprovedKeys 走 read-modify-write 去重 add（ApprovalManager.addAlwaysApprovedKey 路径）。
- PUT /session/:id UpdateSessionBody 扩 effort/approvalMode（alwaysApprovedKeys 不进 body，无用户直填语义，仅 ApprovalManager 内部写）。
- 前端 chat-api.ts updateSession body 同步扩 effort/approvalMode。

详情：`specs/tech/version_logs/v0.0.148/change_plan.md`（链路 B）+ `specs/api/version_logs/v0.0.148/change_log.md`
