# v0.0.282 tech change log — team.reset（mate 上下文重置）

> 权威契约：`specs/tech/version_logs/v0.0.282/change_plan.md`（method 级 5 行表，frozen）。
> 纯技术驱动版本（agent 工具新增 action，无用户可感知行为变化）→ 跳 PRD。

## 变更摘要

### 需求与动机

team 工具 6 action（list/query/hire/deploy/bench/edit）缺一个「重置 mate 会话上下文」能力。leader 需要在 mate 上下文被污染/过载/卡死时，通过工具直接清理 mate 的 transcript+summary+presence+todo，而非 HTTP 端点或手动操作。reset = 聊天页「清理上下文」按钮的 agent 工具入口。

### 方案（6 项架构裁决，详见 change_plan）

1. **reset 落 team-write-actions.ts**（不独立服务）：对齐 deploy/bench/edit 模式（roleId 解析 + rtc 依赖注入 + errorResult 返回），零新文件、零新服务。team-tool.ts 只加 dispatch 一行 + import。
2. **transcript+summary 复用 `store.clearSession(sid)`**：clearSessionStoreOp 已清 transcript/summary/runs/usage + 强制 idle + emit 3 事件（session_status_update / session_usage_update / messages_cleared）——与聊天页「清理上下文」按钮（POST /session/:id/clear）完全同链路、同语义。不另起清理逻辑。
3. **presence 清 = `memberStore.putMember` read-modify-write**：presence 存在 `member.currentWork`，清 = currentWork=null。对齐 `presence-tool.ts L78-86` 模式（剥信封 createdAt/updatedAt/version + spread + putMember）。清失败不阻塞（catch → warning，核心目标 transcript 已清成功）。
4. **todo 清 = `todoStore.removeAll(sid)`**：复用 todo-store.ts L184 既有方法。todoStore 从 `rtc.sessionDeps.todoStore` 读（类型 unknown 需 cast 探测）；缺省 undefined → skip 不报错。
5. **running 保护 = `store.getSession(sid).state`**：与 session-clear handler L78 同源判定（`state ∈ {running, interrupting}`）。但 **reset 不 abort**——reset 是管理操作，running 时直接拒绝让 leader 知道「等 mate 跑完再 reset」，不擅自打断。
6. **memory 不动**：memory 存在 group 级 `.rocky/memory/` 共享文件，与 session transcript 独立。clearSession 不碰 memory 文件，reset 也不碰。agent md（定义层）不动。

### T1 — runReset 实现（commit c086a92e3，8 files +252/-21）

- **team-write-actions.ts**（298 行 ≤300）：`runReset(input, rtc)` 4 步清理链路：
  1. running 保护（L252-255）：`getSession(sid).state ∈ {running,interrupting}` → `errorResult('team.reset: agent is running')`（不 abort）
  2. clearSession（L259-262）：`rtc.store.clearSession(sid)` → clearSessionStoreOp（清 transcript/summary/runs/usage + 强制 idle + emit 3 事件）
  3. presence 清（L264-270）：`getMember` → 剥信封 `{ createdAt, updatedAt, version, ...rest }` → `putMember({ ...rest, currentWork: null })`；catch → warning 不阻塞
  4. todo 清（L276-282）：`rtc.sessionDeps?.todoStore as { removeAll?: ... }` cast 探测 → `removeAll(sid)`；缺省 skip；catch → warning
  - 返回 `{ memberId, sessionId, cleared: true }` + warnings（如有）
  - inputSchema enum 加 `'reset'`（L36）+ description 加 reset 说明（L45）

- **team-tool.ts**（149 行 ≤300）：TEAM_ACTIONS 加 `'reset'`（L26）+ WRITE_ACTIONS 加 `'reset'`（L29）+ description 加 reset 行（L45）+ dispatch `if (action === 'reset') return await runReset(input, rtc)`（L98）

- **UT**（66 tests 全绿，bun --bun 独立复验）：
  - team-write-actions.test.ts 43（含 6 新 runReset 用例：idle 成功 / running 拒绝 / leader reset / todoStore undefined skip / roleId 空 / roleId 不存在）
  - team-tool.test.ts 23（回归：enum 断言 6→7 两文件同步更新）
  - tsc 0 errors

### T1 review — PASSED（code-reviewer，无偏离）

6 裁决逐条核过：clearSession 复用同聊天页链路 ✅ / running 保护同源 session-clear handler 不 abort ✅ / presence read-modify-write 剥信封对齐 presence-tool.ts ✅ / todoStore cast 探测 + 缺省 skip ✅ / memory+agent md grep 零触碰 ✅ / team-tool 四处同步 ✅。report: `states/v0.0.282/verify/review/code-review-task1.md`

## 代码↔spec 核实表（doc-modifier）

| 核实项 | 代码位置 | 核实结果 |
|---|---|---|
| runReset 清理链路 = clearSession | `team-write-actions.ts L259-262`（`rtc.store.clearSession(sid)` → `clearSessionStoreOp`）| ✅ 同聊天页「清理上下文」按钮链路（`POST /session/:id/clear → store.clearSession`） |
| running 保护（state∈{running,interrupting}→拒绝不 abort） | `team-write-actions.ts L252-255`（直接 return errorResult，不调 manager.abort）| ✅ 同源 session-clear handler L78 判定，但 reset 不 abort |
| presence 清（putMember currentWork=null） | `team-write-actions.ts L264-270`（read-modify-write 剥信封）| ✅ 对齐 presence-tool.ts L78-86 模式 |
| todo 清（todoStore.removeAll + 缺省 skip） | `team-write-actions.ts L276-282`（cast 探测 + catch warning）| ✅ 复用 todo-store.ts L184 |
| memory / agent md 不动 | runReset 函数体 + clearSessionStoreOp + session-store grep `memory`/`agent md`/`writeFile.*md`：0 命中 | ✅ 零触碰 |
| 工具 schema 7 action | enum L36 / TEAM_ACTIONS L26 / WRITE_ACTIONS L29 / dispatch L98 / description L45 + isTeamAction 隐式闭合 | ✅ 四处 + 闭合全同步 |

## 文档同步

| 文件 | 变更 |
|------|------|
| `specs/tech/squad/[P1]squad_tools.md` | §1 收敛原则枚举加 reset / §2 标题 6→7 action + action 全表加 reset 行 + member 只读段补 reset / 写 action 单源段补 reset 说明 |
| `specs/tech/squad/log.md` | 加 v0.0.282 条目 |

## 偏离

无（T1 实现精确符合 change_plan 6 裁决，review PASSED 无偏离）。
