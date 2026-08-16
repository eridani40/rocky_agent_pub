# v0.0.348 变更计划书 — 队员面板状态不实时修复（studio session meta hydration）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 背景

- BUG 报告：`states/bugs/BUG-member-panel-state-stale-[open].md`（主仓，worktree 已同步）
- 根因一句话：`useStudioUnreadMeta` 的三张 map（unread/running/state）唯一写入源是 SSE 增量帧；`sessionMetaBus` 非 replayable（订阅前帧永久丢）+ onInit 仅 subscribe 无 GET 基线（hydration 随 v0.0.165 删除）+ 无 onResumed 兜底 → 冷启动/断连窗口丢帧后状态永久错误。
- 老板拍板契约（不可违背）——**视图级数据生命周期模型**：外层 squad list 三重保障（GET+SSE+onResumed）不动；内层 member panel 进入即 GET 基线 + SSE follow；切走即停、无陈旧态、无残留；SSE 重连 → GET 校正；视图自声明订阅范围，数据不常驻。

## 架构决策

| # | 决策 | 理由 |
|---|------|------|
| ① | **方案 A 采纳**：onInit 同步建订阅 + 发起 `GET /session?biz=studio` 全量 hydrate 三张 map；onResumed → 重新 GET 校正（照 use-squad-meta 十行模式） | 对照组已验证：use-squad-meta 同模式（GET+SSE+onResumed 三重保障）无此 bug；改动面 = 单 hook + lib 小函数 + UT |
| ② | **方案 B 明确拒绝**（GET /squad/:id/members 附 session state） | 侵入 API 契约（Member 结构加字段）+ detail/SSE 双源合并复杂度；A 的全量 GET 开销在 studio 会话量级（同 squad 数百级）完全可接受，B 无收益 |
| ③ | **共享订阅保留 + 全量 hydration 实现「点击有基线」**：订阅仍是 SSE 单例 `session_meta _all`（共享、轻）；studio 页 mount 时一次拉齐全部 studio 会话 → 点击任意 squad 时 ctx 已含其 sessionId 基线。严格 per-squad 生命周期不可行：无 per-squad GET 端点 + stateMap 按 sessionId 跨 squad 有效，per-squad 重建徒增复杂度。老板模型不可违背点全部满足：无陈旧态（hydration+onResumed）、不常驻（hook 随 StudioPage 卸载即清）、切走无残留（onDestroy 回收句柄） | 语义遵从优于形式复刻；文档化取舍 |
| ④ | **竞态仲裁：ctx 增第四张内部 map `metaMap: sid→updatedAt`**。帧写入与 GET 合并都写 metaMap；GET 合并用**重建语义**：以响应为基线重建三 map，ctx 中 updatedAt 比响应条目新的 sid 保留（帧先到场景，防 GET 后到覆盖新帧）；响应中缺失的 sid 若 ctx 有更新帧也保留（新建会话帧先到），陈旧幽灵由下次 GET 清理 | 唯一危险序 = GET 在途新帧先到、GET 响应后到；updatedAt 为 ISO string 字典序比较安全（types/session.ts:140 必填） |
| ⑤ | **`listSessionsByBiz(biz, base?)` 新增**（session-api.ts），不改 listSessions 签名 | 后端 GET /session 已支持 `?biz=studio`（handlers/session.ts:78-83，缺省 playground）——纯前端 lib 小改，非 API 契约变更；改 listSessions 签名会波及 3 个现有调用方 |
| ⑥ | **三 map 连带一并修**（unread 红点/running spinner/state 分组同源同缺陷）；running 统一由 `isRunningState(state)` 派生，不直读 Session.running 字段 | 单次 GET 同时 hydrate 三张；帧路径现状即派生，保持两路径同源 |
| ⑦ | **useLifecycle 时序**：onInit 同步声明 subscribe + 返空 ctx（订阅尽早建立，零滞后窗口），GET 为 fire-and-forget promise，resolve 后经 `mutateCtx(merge)` 合并——**禁止** onInit 内 await GET（会推迟 establishSubscriptions 扩大丢帧窗口，use-lifecycle.ts 订阅在 onInit resolve 后才建） | use-lifecycle.ts 契约 §onInit/establishSubscriptions 时序 |
| ⑧ | **onResumed 句柄回收严于 use-squad-meta 先例**：注册返回的 unsubscribe 句柄存 hook 级 ref，onDestroy 调用回收（先例 use-squad-meta 未存句柄 → 页面卸载后回调残留 singleton，属遗留缺陷，本次不重蹈） | 老板模型「切走即停、无残留」 |
| ⑨ | markReadAndClear 语义不变（mutate 乐观清 + SSE 兜底）；外层 squad list 链路 / API 契约 / 后端零改动 | 派单边界 |

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| web/lib-api | app/web/src/lib/chat-api/session-api.ts | listSessionsByBiz(biz, base?) | 新增 | `GET /session?biz=${biz}`，复用现有 request/parse 模式返回 Session[]；与后端 ?biz 查询串一一对应 | MUST NOT 改 listSessions 签名（use-page-chat-mount/use-chat-actions 3 调用方零改动）；MUST biz 值白名单校验可选（直传亦可，后端已容错） | app/server/src/handlers/session.ts:78-83；specs/api/overall/04-agent-session.md | +16 |
| web/lib-api | app/web/src/lib/chat-api/index.ts | barrel export | 修改 | 追加导出 listSessionsByBiz | MUST 保持既有导出不动 | 同上 | +1 |
| studio-meta | app/web/src/components/studio-page/use-studio-unread-meta.ts | StudioMetaCtx.metaMap | 修改 | 类型加第四张 `metaMap: KeyedMap<string,string>`（sid→updatedAt，竞态仲裁内部用，不进返回 API） | MUST NOT 外露到 StudioUnreadMeta 返回值 | 本表决策④ | +5 |
| studio-meta | 同上 | mergeFromSessions(ctx, sessions) | 新增 | 纯函数：以 sessions 为基线重建三 map+metaMap（unread 直读 / running=isRunningState 派生 / state 直读），ctx 中 updatedAt 更新的 sid 条目原样保留 | MUST 幂等纯函数（禁副作用）；MUST NOT 盲覆盖（④仲裁） | 决策④⑥；types/session.ts:26 | +28 |
| studio-meta | 同上 | useStudioUnreadMeta.onInit | 修改 | 保持同步 subscribe+返空 ctx；追加：发起 hydrate()（fire-and-forget，不 await）+ `onResumed(()=>void hydrateRef.current())` 注册、退订句柄存模块 ref | MUST 订阅声明先于 GET resolve（⑦时序）；MUST 句柄可回收 | 决策⑦⑧；use-squad-meta.ts:50-56 对照 | +20 |
| studio-meta | 同上 | hydrate()（闭包/helper） | 新增 | `listSessionsByBiz('studio')` → `mutateCtx(ctx=>mergeFromSessions(ctx,list))`；失败 console.warn 静默（SSE 仍活，下次 onResumed 重试） | MUST 经 mutateCtx 写回（ref-latest 单路径）；MUST NOT 抛出到渲染层 | 决策①⑦ | +14 |
| studio-meta | 同上 | onEvent | 修改 | 帧写入三 map 同时写 `metaMap[sid]=data.updatedAt`（biz 守卫等既有逻辑不动） | MUST data.updatedAt 缺失时跳过 metaMap 写（防御）不跳过三 map | 决策④；chat-slice.ts:61 帧 shape | +4 |
| studio-meta | 同上 | onDestroy | 新增 | 回调内调用 onResumed 退订句柄（ref 存）；幂等 | MUST unmount 后 mutateCtx 调用安全（useLifecycle 内部守卫，UT 覆盖） | 决策⑧；use-lifecycle.ts 不变量③ | +8 |
| test | app/web/src/components/studio-page/__tests__/use-studio-unread-meta-hydration.test.tsx | 新文件：3 场景 | 新增 | a) 订阅前已 running：mock GET 返回 state=running → hydration 后 stateMap/runningMap 正确；b) 断连丢帧后重连：触发 onResumed → 重 GET 合并校正（模拟丢帧期间远端 state 变化）；c) 竞态：GET 在途新帧先到（updatedAt 新）→ GET 响应后到不回退 | MUST 沿用现有 vi.hoisted+绝对路径 mock SseClient 类 + mkMeta 模式；MUST 另 mock chat-api barrel（listSessionsByBiz）；MUST 全绿 | 现有 use-studio-unread-meta-singleton/running-state 测试模式；派单 UT 硬要求 | +110 |

## 影响面评估

- **范围**：纯前端，2 个模块（web/lib-api + studio-meta hook）+ 1 个 UT 新文件；后端/API 契约/外层 squad list 链路零改动。总影响约 +206/-3。
- **依赖顺序**：listSessionsByBiz 先行 → hook 改动 → UT（UT 依赖前两者签名）。
- **风险**：
  1. **双 mock 并存**：SseClient 类 mock + chat-api barrel mock 同文件，hoisted 时序需注意（vi.mock 提升不依赖声明序，低风险）。
  2. **unmount 后 GET resolve**：hydrate promise 在页面卸载后才 resolve → mutateCtx 落到已清理 hook；useLifecycle 有 cancelledRef 守卫（use-lifecycle.ts:105），UT 场景 b/c 需覆盖此路径确认不告警不泄漏。
  3. **updatedAt 字典序**：ISO8601 string 同格式字典序=时间序；若后端存在异构格式（带 ms/不带）需 UT 构造同构样例，coder 发现异构报 leader（勿自行改后端）。
  4. **重建语义的删除缺口**：响应缺失+ctx 帧更新的 sid 保留（新建会话帧先到场景优先），删除会话的幽灵清理靠下次 GET——会话删除同步链路（SSE 有无 delete 帧）超出本版范围，不扩大。
- **验证**：UT（bun run test + 全量 tsc -b）MANDATORY；纯前端状态同步修复，AT/ET 不新增持久 case（冒烟集回归即可），理由：无 API 契约变化、无新交互路径。
- **spec 同步**：版本收尾由 doc-modifier 同步 specs/tech/app/frontend 相关 spec（component_data_map 若含该 hook 数据源描述）+ 本 change_log。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
