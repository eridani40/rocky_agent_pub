# v0.0.276 变更计划书 — squad 首页进入即刷新（seats 激活重拉 detail）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> **背景**：squad 首页（seats 视图）每次进入/返回，成员状态（running/idle）+ presence 不刷新——detail 拉取只在初始 mount + selectSquad（切 squad）两处触发；`fallbackToSeats`（mutation 回落 + token-stats/member/member-create 返回）与 `handleChatBack`（chat 返回）只 `setMainView({kind:'seats'})`，**不调 reloadDetail** → detail 旧快照。老板要求：**每次进入/返回 seats 都重新拉取（倾向整个重新渲染页面）**。技术驱动版本（数据刷新时机，无新 UI）——跳 PRD 直接架构。测试全 UT（不新增 AT/ET 持久 case）。

## 架构裁决（req 关键裁决点落实）

| # | 裁决点 | 结论 | 理由 |
|---|--------|------|------|
| R1 | **机制选型（A reloadDetail vs B key remount）** | **方案 A：进/返 seats 调 reloadDetail（2 个调用点补全）**。fallbackToSeats（L68-71）加 `void reloadDetail(selectedSquadId)`（非空时）；handleChatBack（L145-148）加 `void reloadDetail(chatBackSquadId)`。**否决方案 B**（key remount）：key 只 remount SeatsPanel 子树，page-studio 不 remount、SeatsPanel 自己不拉 detail → key remount 不解决 detail 刷新（除非额外加机制）；方案 A 的 `setDetail(新对象)` → SeatsPanel re-render = **等效「整个重新渲染页面」**（SeatsPanel 是纯函数组件，detail 变化自然全量 re-render）且更简洁 | req §修复方向 A；老板「整个重新渲染页面」意图 = 数据新鲜 + 视图刷新，方案 A 达成；「方案宜简不宜繁」 |
| R2 | **SSE 覆盖评估** | **running/idle（presence 三态 + spinner）：已由 SSE 实时**（useStudioUnreadMeta 订阅 `session_meta _all` → stateMap[sid]；useSeatsData 的 derivePresence/isRunning 走 stateMap，SSE 一直推）。**presence 文本（currentWork）：无 SSE**——Member.currentWork 只在 SquadDetail.members[]（presence tool 写 member store，不推 session_meta）→ **reloadDetail 是唯一刷新途径**（bug 核心）。member.state（deployed/benched）：detail 静态（mutation 后 refresh 已处理），reloadDetail 兜底。**结论：SSE 已覆盖「状态」，不覆盖「presence 文本」→ 每次进/返 seats reloadDetail 补 presence + 兜底 SSE 漏推** | use-studio-unread-meta.ts（session_meta _all 订阅）；use-seats-data.ts derivePresence/isRunning/deriveStatusTextSource；squad-types.ts Member.currentWork |
| R3 | **不破坏保留** | selectSquad（L123-130）已有 reloadDetail ✅ 保留；初始 mount（L106-120）已有 ✅ 保留；mutation 后 refresh（reloadDetail + reloadSquads 并行）✅ 保留；member-panel 返回（L242-245 已有 reloadDetail）✅ 保留 | req「不破坏：切 squad 刷新保留、mutation 后 refresh 保留」 |
| R4 | **mutation 回落双拉** | fallbackToSeats 加 reloadDetail 后，mutation 路径（handleHire/Bench/Deploy）会 `refresh()`（内部 reloadDetail）+ `fallbackToHome()` → `fallbackToSeats()`（又 reloadDetail）**两次 GET /squad/:id**——**接受**（GET 轻量、频率低、幂等 setDetail 同值无害；不玩精细判断，对齐老板风格） | req「每次进入/返回都拉」；use-squad-mutations.ts refresh() |
| R5 | **异步期间 UI** | reloadDetail fire-and-forget（void）：进 seats 立即渲染旧 detail（L168 id 匹配则渲染），GET 返回 setDetail 新对象 → re-render；失败 setDetail(null) → loading 兜底（既有 selectSquad 行为一致）。**不阻塞渲染**（不进 loading 分支） | page-studio.tsx L168-208；use-squad-mutations.ts reloadDetail（失败 setDetail(null)） |

## 变更清单

<!-- 每行一个函数/符号；相关方法的行放在一起（同模块/同文件相邻） -->

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| studio-page(前端) | app/web/src/components/studio-page/page-studio.tsx | fallbackToSeats() | 修改 | 加 `if (selectedSquadId) void reloadDetail(selectedSquadId)`——mutation 回落 + token-stats/member/member-create 返回 seats 时重新拉 detail（成员状态 + presence 新鲜） | MUST fire-and-forget（void，不 await 阻塞渲染）；MUST 仅 selectedSquadId 非空时拉；MUST deps 加 reloadDetail（useCallback 稳定）；MUST 保留 setMainView({kind:'seats'}) 既有行为 | req §修复方向 A；本 change_plan R1/R5 | +3/-0 |
| studio-page(前端) | app/web/src/components/studio-page/page-studio.tsx | handleChatBack() | 修改 | 加 `if (chatBackSquadId) void reloadDetail(chatBackSquadId)`——chat 返回 seats 时重新拉 detail | MUST fire-and-forget（void）；MUST deps 加 reloadDetail；MUST 保留 setMainView seats 既有行为 | req §修复方向 A；本 change_plan R1 | +3/-0 |
| studio-page(前端) | app/web/src/components/studio-page/page-studio.tsx | selectSquad() / 初始 mount useEffect | （零改动） | 明确声明：切 squad reloadDetail（L127）+ 初始 mount reloadDetail（L114）保留不动 | MUST NOT 改既有 reloadDetail 调用点 | req「不破坏」；本 change_plan R3 | +0 |
| studio-page(前端) | app/web/src/components/studio-page/use-squad-mutations.ts | reloadDetail() | （零改动） | 明确声明：GET /squad/:id → setDetail（失败置 null）契约不变 | MUST NOT 改 reloadDetail 实现 | req；本 change_plan R5 | +0 |
| test | app/web/src/components/studio-page/__tests__/page-studio.test.tsx | chat 返回触发 reloadDetail 用例 | 新增 | 渲染 PageStudio → 等 seats → 记录 `mocks.getSquad.mock.calls.length` → 点 mate「进入对话」→ 点返回（onBack）→ 断言 seats 恢复 + `getSquad` 调用次数 +1（reloadDetail 触发） | MUST 用 mocks.getSquad 调用计数断言（vi.fn() 天然计数）；MUST 复用既有 mateEnterBtn/chat 返回流程 | req 验收（UT）；本 change_plan R1 | +25/-0 |
| test | app/web/src/components/studio-page/__tests__/page-studio.test.tsx | member-create 返回触发 reloadDetail 用例 | 新增 | 渲染 PageStudio → 等 seats → 记录 getSquad 次数 → 点「新增成员」→ 点返回 → 断言 seats 恢复 + getSquad 次数 +1 | MUST 复用既有 member-create 返回流程（L321-335 改造/扩展）；MUST 断言次数增量（防重复双拉断言宽松：≥ +1） | req 验收（UT）；本 change_plan R1/R4 | +20/-0 |
| spec-sync(T2) | specs/ui/components/studio-page/component-seats-panel.md | 数据刷新语义 | 修改 | 补「每次进入/返回 seats 都重新拉 detail（进/返即刷新）」：seats 激活触发 reloadDetail（fallbackToSeats + handleChatBack 两返回入口）；说明 running/idle 由 SSE session_meta 实时 + presence 文本（currentWork）靠 reloadDetail 刷新；selectSquad/mutation refresh 保留 | MUST 与实现一致；MUST NOT 改 seats 渲染数据流（useSeatsData 派生规则不变）；MUST 验证代码实现 == spec 契约 | 本 change_plan R1/R2；06-studio.md §2.3 | +15/-0 |

## 影响面评估

- **跨模块**：纯前端（page-studio.tsx 2 个调用点 + page-studio.test.tsx）+ spec 文档（component-seats-panel.md）
- **破坏性变更**：无。reloadDetail 契约不变（GET /squad/:id）；SSE 订阅不变；seats 渲染数据流不变（useSeatsData 零改动）；mutation/selectSquad 刷新保留
- **依赖顺序**：T1（前端 2 处 + 测试）→ T2（spec 同步）。改动小，单 task 串行
- **风险点**：
  1. **mutation 回落双拉**（refresh + fallbackToSeats 各一次 reloadDetail）——两次 GET 幂等无害，可接受（R4）；测试断言用 ≥ +1 宽松口径
  2. **reloadDetail 失败置 null** → seats 短暂 loading（L205-208 分支）——既有行为（selectSquad 同），网络抖动可接受
  3. **async 期间旧 detail 闪现**——进 seats 先渲染旧 detail，GET 返回后 re-render 更新；本地 server GET 快，用户几乎无感（R5）
  4. **SSE 与 reloadDetail 竞态**——独立（stateMap 在 page-studio 级 SSE、detail 在 useSquadMutations），useSeatsData 同时依赖两者任一更新都 re-render，无冲突

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
