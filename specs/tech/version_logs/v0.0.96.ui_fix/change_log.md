# v0.0.96.ui_fix — Tech Change Log

> 跨版本发布说明（版本轴）。本目录级变更见各 KB `log.md`（位置轴）：`specs/tech/app/frontend/log.md`。
> 权威输入：`reqs/[working] v0.0.96.ui_fix/req.md` + `specs/tech/version_logs/v0.0.96.ui_fix/change_plan.md`。

## 概览

v0.0.96 是 UI 修复 + 内部重构三件套（用户无显著新功能感知，无 API 契约变更、无设计稿）：

1. **usage 面板累积消耗区格式 + 列宽固化**（Feature 1）：累积消耗表格 input/output/total 三列数字常达 K/M 量级，旧 `fmtNum`（toLocaleString）返「1,234,567」三位逗号长串在 280px 紧凑面板折行/撑宽。新增 `formatTraffic` 纯函数按 K/M/B/T 分级返短串「1.2M」+ grid-template-columns 固定列宽 + 值列 tabular-nums 防抖动。
2. **气泡 spinner 双源兜底**（Feature 2）：`ComponentMessageStream` 的 on-message spinner 渲染条件从 `runActive` 扩为 `runActive || sessionRunning`，覆盖切会话/SSE 重连的 sticky replay 失效窗口（sessionRunning 由 GET /session REST 保证）。
3. **studio chat 自给化**（Feature 3）：新增 `useStudioChatChrome` hook——chat 只认 sessionId 自查 chrome（member/squad/tag/modelDefault），router 脱 detail 门控（消除 MemberChatPage↔SquadChatPage 抖动 race）+ MemberChatPage/SquadChatPage props 收敛（删父透传 chrome 字段）。

**与 change_plan 的实际偏差**（已记录，无 critical）：

| 偏差项 | change_plan 原计划 | 实际实现 | 理由 |
|---|---|---|---|
| T1 cum-table 标签列宽 | `96px_minmax(56px,1fr)_minmax(48px,1fr)_minmax(56px,1fr)_minmax(56px,1fr)` | `84px_minmax(48px,1fr)×4` | coder 实测 280px 面板内 84px 标签列足够容「子 Agent」字样 + 4 值列 minmax(48px,1fr) 对称更稳；spec 已同步实际值 |
| T3 useStudioChatChrome 失败语义 | onInit 返 `{ chrome: StudioChatChrome \| null, ... }`（impl 暗示 null 返回） | onInit **throw → error 通道**（sessionId 空/squadId 缺失/network fail），useLifecycle 类型不许 null 返回 | useLifecycle 的 catch 捕获 throw 进 error 通道是契约正确用法；返 null 会与"loading 中 chrome=null"语义混淆。spec §6.2 已明化 throws |
| T4 router + Page 拆分 | router 调 chrome 拿 isGroup，Page 内 wrapper/inner 拆（wrapper 管 chrome loading 门控） | 同 plan，但 wrapper/inner 拆分是**强制需求**（React Hooks 规则禁止 conditional return 前调 hooks，wrapper 必须 hooks 之前 return 占位） | 这是 React 规则约束非设计选择，spec 已明化 |

无 API 契约变更、无 testid 破坏性变更（`chat-loading` 是新增占位 testid 不替代旧 testid；`cum-table`/`cum-row-*` 沿用）。

## §1 Feature 1：usage 面板 formatTraffic + 列宽固化

**before**：`component-usage-panel.tsx` CumCells 用 `fmtNum(row.input)`（toLocaleString 三位逗号「1,234,567」）+ grid `1fr auto auto auto auto`（值列 auto 在数字变长时撑宽邻列抖动）。

**after**：

```typescript
// app/web/src/lib/format-traffic.ts（新增纯函数）
export function formatTraffic(n: number): string {
  if (!Number.isFinite(n) || n < 0) return String(n);  // 边界兜底
  if (n < 1000) return String(n);
  if (n < 1e6) return (n / 1e3).toFixed(1) + 'K';
  if (n < 1e9) return (n / 1e6).toFixed(1) + 'M';
  if (n < 1e12) return (n / 1e9).toFixed(1) + 'B';
  return (n / 1e12).toFixed(1) + 'T';
}

// component-usage-panel.tsx CumCells 改调 formatTraffic（input/output/total 三列）
// grid-template-columns 从 1fr auto×4 → 84px_minmax(48px,1fr)×4 + 值列 tabular-nums
```

**约束落地**：
- 仅累积消耗区 4 列值（input/output/total 用 formatTraffic；cache 列百分比不动）。
- 概览「已用/总」`fmtK` 不动（O1 裁决：痛点在累积区，不动 spec §4.3 现有 k 格式）。
- panel 容器宽度 280px 沿用（不动）。

**spec 同步**：`specs/ui/components/chat-page/component-usage-panel.md §4.3`（fmtK 注明仅收起态/大圆环用）+ `§4.7`（累积表格 grid/值格式/列宽固化），v1.2。

## §2 Feature 2：spinner 双源门控（runActive || sessionRunning）

**before**：`component-message-stream.tsx:290` `{runActive && <ComponentLoadingStatus phase={loadingPhase ?? 'thinking'} />}`。

**after**：

```typescript
// component-message-stream.tsx:292（行号 +2 因注释扩）
{(runActive || sessionRunning) && <ComponentLoadingStatus phase={loadingPhase ?? 'thinking'} />}
```

**约束落地**：
- ComponentMessageStream 已有双 prop（`runActive` + `sessionRunning`，:46-48），两个父组件早已分别传（page-chat:267/271、section-member-chat:208/209）——**父组件零改**。
- ComponentToolBatch 的 `runActive`（:275）保持精确不污染（tool-batch 进度须用精确 runActive 非 union）。
- run-finish 条件（:293 `!sessionRunning && lastRunFinish`）不变。
- phase 兜底 thinking（sessionRunning 触发时 loadingPhase=null 显默认「思考中」）。
- SquadChatPage 不订 useRunState（无 runActive），不在范围（chat_area_hooks §5）。

**已知代价（接受）**：run_end 后 sessionRunning 滞留约一个 GET 延迟（useRunState run_end GET 校正），气泡多停一瞬。

**spec 同步**：`specs/ui/components/chat-page/_overview.md §4.10`（spinner 可见性双源门控明化 + 数据源章节扩双源兜底说明）。

## §3 Feature 3：studio chat 自给化（useStudioChatChrome + router 脱 detail + props 收敛）

**before**：`component-studio-chat-router.tsx` 收 `detail: SquadDetail | null` prop，用 `detail.squadChatSessionId === node.sessionId` 判 isGroup + detail 缺失时渲 chat-loading 占位。`MemberChatPage`/`SquadChatPage` props 含 `member`/`squadId`/`squadModelDefault`/`tag`/`title` 等父透传 chrome 字段。

**after**：

```typescript
// app/web/src/components/studio-page/use-studio-chat-chrome.ts（新增 hook）
export function useStudioChatChrome(sessionId: string): {
  chrome: StudioChatChrome | null;
  loading: boolean;
  error: Error | null;
}
// 走 useLifecycle 四方法契约但不订 SSE（GET-once）；onInit 失败 throw → error 通道

// component-studio-chat-router.tsx：删 detail prop + 自调 useStudioChatChrome 拿 chrome.isGroup
// section-{member,squad}-chat.tsx：删父透传 chrome props + 拆 wrapper/inner（wrapper 管 chrome loading 门控）
// page-studio.tsx：删 detail={detail} 透传
```

**约束落地**：
- chat 只认 sessionId，自己根据 sessionId 拉齐所需 chrome（squad/member/tag/modelDefault），行为与进入路径解耦。
- router + Page 各调 useStudioChatChrome（2× GET /session + 2× GET /squad）——O3 YAGNI 接受（GET /squad 体积小，本地 dev < 50ms）。
- MemberChatPage 保留 `onOpenMember`（进 member 面板路由归父）+ `prefill`（看板 @ 预填）；删 member/squadId/squadModelDefault/tag。
- SquadChatPage 保留 `prefill`；删 squadModelDefault/tag/title。
- chrome 期间不变（GET-once 不订 SSE）；需刷新靠切 sessionId remount（key={node.sessionId} 已保证）。
- chrome loading/error 期间三处（router/member/squad wrapper）统一渲 `<div data-testid="chat-loading">…</div>` 占位（不 mount area-hooks 避免无 sessionId 残留）。
- onInit 失败一律 throw → error 通道（sessionId 空 / squadId 缺失 / network fail），useLifecycle 类型不许 null 返回。
- member 缺失兜底：单聊 session.memberId 非空但 squad.members 无匹配（数据不一致）→ 群聊兜底 + dev warn（**不 throw**）。

**取舍（方案 A，接受）**：chat 自查重复拉一份 GET /squad（page-studio 仍持 detail 管 squad 面板/看板），换彻底解耦。不加 client cache（YAGNI）。

**spec 同步**：
- `specs/tech/app/frontend/[P0]component_data_map.md §6`（useStudioChatChrome 完整契约，§6.2 onInit 失败 throws 明化）+ §2 全组件映射表 MemberChatPage/SquadChatPage 行 + useStudioChatChrome 行。
- `specs/ui/components/studio-page/_overview.md §4b`（chat 自给化背景/思路/接口签名/chat-loading testid）+ §4a 接口签名更新 + §5 version 1.5。
- `specs/ui/components/studio-page/member-chat-page.md` Props v2.6 + testid 加 chat-loading。
- `specs/ui/components/studio-page/squad-chat-page.md` Props v2.6 + testid 加 chat-loading。

## §4 API spec 对齐（doc-sync，无契约变更）

`specs/api/overall/04-agent-session.md §2.1` Session interface 补 `squadId?: string` + `memberId?: string`（11-squad §2 自 v0.0.33.1 已声明此二字段，04 漏定义——v0.0.56 重构遗留）。后端早已返（session-store.ts 持久化 + handler 序列化），仅前端 chat-page/types.ts v0.0.96 补字段对齐（useStudioChatChrome 据此 GET /squad/:squadId）。**无 API 契约变更**（已存在的字段，仅 doc 对齐）。

## §5 验证

- **UT**：formatTraffic 纯函数单测全绿（覆盖 123/1234/1234567/1234567890/1e12 量级 + 0/-1/NaN/Infinity 边界 + K/M/B/T 4 临界切换点）。
- **AT**：无 API 契约变更（本版本豁免 AT，仅 UT + ET）。
- **ET**：hard_fail=0 门禁达标（PRD 关键用户路径覆盖：studio 切 chat 节点 / 群聊单聊切换 / chrome loading 占位 / usage 面板展开累积区渲染）。chrome 自查重复拉 GET /squad 不卡（本地 dev < 50ms 验证通过）。

## §6 影响文件清单

**新增**：
- `app/web/src/lib/format-traffic.ts`（+28 行，纯函数）
- `app/web/src/lib/format-traffic.test.ts`（+35 行，UT）
- `app/web/src/components/studio-page/use-studio-chat-chrome.ts`（+148 行，hook）

**修改**：
- `app/web/src/components/chat-page/types.ts`（Session 加 squadId?/memberId?）
- `app/web/src/components/chat-page/component-usage-panel.tsx`（CumCells 改 formatTraffic + cum-table grid 列宽 + tabular-nums）
- `app/web/src/components/chat-page/component-message-stream.tsx`（:292 spinner 双源门控）
- `app/web/src/components/studio-page/component-studio-chat-router.tsx`（删 detail prop + 自调 chrome）
- `app/web/src/components/studio-page/section-member-chat.tsx`（props 收敛 + 拆 wrapper/inner）
- `app/web/src/components/studio-page/section-squad-chat.tsx`（props 收敛 + 拆 wrapper/inner）
- `app/web/src/components/studio-page/page-studio.tsx`（删 detail 透传）

**spec 同步**（见各 Feature §spec 同步 段）：7 spec 文件 + 1 新增 change_log（本文件）。
