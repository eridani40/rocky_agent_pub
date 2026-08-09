# v0.0.276 tech change log — squad 首页进入即刷新（seats 激活重拉 detail）

> 对应需求：`reqs/[working] v0.0.276/req.md`（老板 2026-08-07 提 bug：squad 首页每次进入/返回成员状态 + presence 不刷新，要求每次进入/返回都重新拉取，最好整个重新渲染页面）。
> 权威契约：`specs/tech/version_logs/v0.0.276/change_plan.md`（5 架构裁决 R1-R5，frozen）。
> 技术驱动版本（数据刷新时机，无新 UI）——跳 PRD 直接架构。测试全 UT（不新增 AT/ET 持久 case）。

## 变更摘要

### 需求与动机

squad 首页（seats 视图）每次进入，成员状态（running/idle）+ presence **没更新**——`detail`（SquadDetail，含成员状态 + presence）拉取只在**初始 mount + selectSquad（切 squad）**两处触发；`fallbackToSeats`（mutation 回落 + token-stats/member/member-create 返回）与 `handleChatBack`（chat 返回）只 `setMainView({kind:'seats'})`，**不调 reloadDetail** → detail 停留在进入对话前的旧快照 → 成员状态/presence 过时。老板要求：**每次进入/返回 squad 首页都重新拉取（倾向整个重新渲染页面）**。

### 方案（5 架构裁决，详见 change_plan「架构裁决」）

1. **R1 机制选型 = reloadDetail（2 调用点补全）**：fallbackToSeats 加 `void reloadDetail(selectedSquadId)`（非空时）；handleChatBack 加 `void reloadDetail(chatBackSquadId)`。**否决方案 B（key remount）**——key 只 remount SeatsPanel 子树，page-studio 不 remount、SeatsPanel 自己不拉 detail → 不解决 detail 刷新；方案 A 的 `setDetail(新对象)` → SeatsPanel re-render = **等效「整个重新渲染页面」**（SeatsPanel 是纯函数组件，detail 变化自然全量 re-render）且更简洁。
2. **R2 SSE 覆盖评估**：**running/idle（presence 三态 + spinner）：已由 SSE 实时**（useStudioUnreadMeta 订阅 `session_meta _all` → stateMap[sid]；useSeatsData 的 derivePresence/isRunning 走 stateMap）。**presence 文本（currentWork）：无 SSE**——Member.currentWork 只在 SquadDetail.members[]（presence tool 写 member store，不推 session_meta）→ **reloadDetail 是唯一刷新途径（bug 核心）**。member.state（deployed/benched）：detail 静态（mutation 后 refresh 已处理），reloadDetail 兜底。
3. **R3 不破坏保留**：selectSquad（L123-132）已有 reloadDetail ✅ 保留；初始 mount（L106-120）已有 ✅ 保留；mutation 后 refresh（reloadDetail + reloadSquads 并行）✅ 保留；member-panel 返回（L242-245 已有 reloadDetail）✅ 保留。
4. **R4 mutation 回落双拉接受**：mutation 路径（handleHire/Bench/Deploy 成功 → refresh() 内部 reloadDetail + fallbackToHome → fallbackToSeats 又 reloadDetail）**两次 GET /squad/:id**——接受（GET 轻量、频率低、幂等 setDetail 同值无害；不玩精细判断，对齐老板风格）。
5. **R5 异步期间 UI**：reloadDetail fire-and-forget（void）：进 seats 立即渲染旧 detail，GET 返回 setDetail 新对象 → re-render；失败 setDetail(null) → loading 兜底（既有 selectSquad 行为一致）。不阻塞渲染（不进 loading 分支）。

### T1 — 前端 2 处补 reloadDetail（commit a374b4ddb）

- **`page-studio.tsx` fallbackToSeats（L86-90）**：`const id = selectedSquadId; setMainView({kind:'seats', squadId: id ?? ''}); if (id) void reloadDetail(id);` — deps `[selectedSquadId, reloadDetail]`；覆盖 mutation 回落 + token-stats/member/member-create 返回 seats。
- **`page-studio.tsx` handleChatBack（L148-153）**：`if (chatBackSquadId) { setMainView({kind:'seats', squadId: chatBackSquadId}); void reloadDetail(chatBackSquadId); } else fallbackToSeats();` — deps `[chatBackSquadId, fallbackToSeats, reloadDetail]`；覆盖 chat 返回 seats。
- **R3 零改动确认**：selectSquad（L126-133 `void reloadDetail(id)`）/ 初始 mount useEffect（L109-123 `await reloadDetail(id)`）/ member-panel onBack（L247-250 既有 reloadDetail）/ use-squad-mutations.ts reloadDetail 实现（L81-83 GET → setDetail，失败置 null）全部保留未动。
- **测试**：`page-studio.test.tsx` 新增 2 用例——chat 返回（渲染 → 等 seats → 记录 getSquad 计数 → 点 mate「进入对话」→ 点 chat-topbar 返回 → 断言 seats 恢复 + `getSquad ≥ before+1`）+ member-create 返回（点「新增成员」→ 返回 → 断言 seats 恢复 + `getSquad ≥ before+1`）；断言用 `mocks.getSquad.mock.calls.length` 计数 + **≥ +1 宽松口径**（防 R4 双拉误报）。独立复验：10/10 全绿（原 8 + 新增 2）+ studio-page 397/397 + tsc 0。
- **行数**：生产 page-studio.tsx 300 行（≤300 压线，change_plan 预估 +6 实际 +5 净增）；测试 424 行（≤920 豁免）。

### 代码↔spec 核实（doc-modifier 阶段 5，MANDATORY 3 项）

| 契约点 | 代码 | 结果 |
|---|---|---|
| fallbackToSeats + handleChatBack 两处 reloadDetail（fire-and-forget） | page-studio.tsx L86-90（`if (id) void reloadDetail(id)`）+ L148-153（`void reloadDetail(chatBackSquadId)`），均 void 不 await | ✅ |
| selectSquad / 初始 mount / member-panel 返回调用点零改动（R3） | selectSquad L126-133 + 初始 mount L109-123 + member-panel onBack L247-250 + use-squad-mutations reloadDetail L81-83 均保留未动 | ✅ |
| TDZ 偏离必要等价（函数体延迟解析无 TDZ + inline 箭头行为等价） | fallbackToSeats 移到 useSquadMutations 之后（L86 引用 reloadDetail 延迟解析）+ fallbackToHome 改 inline 箭头 `() => fallbackToSeats()`（L80）——调用时求值无 TDZ，语义零变化 | ✅ |

### 设计决策

- **reloadDetail 而非 key remount（R1）**：SeatsPanel 纯函数组件，detail 变化自然全量 re-render——等效「整个重新渲染页面」且更简洁；key remount 不解决 detail 刷新（SeatsPanel 自己不拉 detail）。
- **SSE 覆盖边界（R2）**：running/idle 由 SSE session_meta 实时（stateMap），presence 文本（currentWork）无 SSE 靠 reloadDetail——**reloadDetail 是 presence 文本唯一刷新途径**（bug 核心修复语义）。
- **fire-and-forget（R5）**：进 seats 立即渲染旧 detail（不阻塞），GET 返回 setDetail 新对象 → re-render；本地 server GET 快，用户几乎无感。
- **双拉接受（R4）**：mutation 路径两次 GET /squad/:id 幂等无害，不玩精细判断（对齐老板「每次进入/返回都拉」风格）。

### 偏离记录

- **TDZ 偏离（coder2 自报，必要等价）**：fallbackToSeats 原定义在 useSquadMutations（L70-73）之前，而 reloadDetail 从 useSquadMutations 解构——`useCallback` 的 deps 数组**在调用点立即求值**（`[selectedSquadId, reloadDetail]` 求值时 reloadDetail 还是 TDZ 未初始化）→ 直接加 reloadDetail 会 `Cannot access before initialization`。修复：① **fallbackToSeats 移到 useSquadMutations 之后**（L86）——函数体引用 reloadDetail 是延迟解析（调用时求值，此时已定义）无 TDZ；② **fallbackToHome 改 inline 箭头** `() => fallbackToSeats()`（L80）——只在 mutation handler 被调用时执行（延迟解析）无 TDZ；③ 引用稳定性：fallbackToSeats 是 useCallback（deps 稳定），inline 箭头每次 render 重建但只在 mutation 时调用 → 无 stale closure；④ 语义零变化（fallbackToHome 仍是回落 seats 函数）。已 code-review PASSED（6 项核对全过）。

## 文档同步

- **ui components**：`specs/ui/components/studio-page/component-seats-panel.md` 补「数据刷新语义（seats 激活即刷新）」节——进入/返回入口表（初始 mount / selectSquad / fallbackToSeats / handleChatBack）+ SSE 覆盖边界（running/idle 实时 + presence 文本靠 reloadDetail）+ fire-and-forget + 保留与双拉接受。
- **tech version_logs**：本 change_log.md（5 裁决 R1-R5 + T1 详情 + 核实表 + TDZ 偏离记录）。
- 无 tech OKF KB 影响（纯前端行为，数据流/组件契约不变——useSeatsData 派生规则零改动）。
