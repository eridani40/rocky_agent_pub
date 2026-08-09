# v0.0.282 变更计划书 — team.reset（mate 上下文重置）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名（新增 class/interface/type 各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置 |
| 预计影响行 |

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| team-tool | app/server/src/agent/tools/team-write-actions.ts | TEAM_INPUT_SCHEMA.action.enum | 修改 | enum 加 `'reset'`（`['list','query','hire','deploy','bench','edit','reset']`）；description 加 `reset` 说明 | MUST enum 闭合覆盖（action 分发 + isTeamAction 同步）；MUST reset 归入 WRITE_ACTIONS（leader/user only） | PRD §参数；squad_tools §2 | +2/-2 |
| team-tool | app/server/src/agent/tools/team-write-actions.ts | runReset() | 新增 | reset 写 action：①roleId 解析（resolveMemberId 同 deploy/bench/edit）②读 member 拿 sessionId ③running 保护：`store.getSession(sid).state ∈ {running,interrupting}` → errorResult('team.reset: agent is running') ④clearSession(sid)（复用 store.clearSession → clearSessionStoreOp 清 transcript/summary/runs/usage + 强制 idle + emit 3 事件）⑤清 presence：memberStore.putMember({ ...member, currentWork: null })（剥信封 read-modify-write，对齐 presence-tool.ts L78-86 模式）⑥清 todo：todoStore.removeAll(sid)（rtc.sessionDeps.todoStore）⑦返 { memberId, sessionId, cleared: true } | MUST running 保护优先（state ∈ {running,interrupting} → 拒绝，不等 abort）；MUST 复用 clearSession（不另起清理链路——行为同「清理上下文」按钮）；MUST NOT 动 memory（group 级 .rocky/memory/）；MUST NOT 动 agent md（定义层）；MUST 单体操作（roleId 单值，无批量）；MUST todoStore 缺省兜底（undefined → skip todo 清理不报错）；MUST presence 清失败不阻塞（putMember catch → 返 warning 不 fail） | PRD 铁律 1-4；session_clear §2/§3 | +45 |
| team-tool | app/server/src/agent/tools/team-tool.ts | TEAM_ACTIONS | 修改 | const 数组加 `'reset'` | MUST 与 enum 同步 | PRD §参数 | +1 |
| team-tool | app/server/src/agent/tools/team-tool.ts | WRITE_ACTIONS | 修改 | 数组加 `'reset'`（leader/user only，mate/subagent forbidden） | MUST reset 归入写 action 权限组 | PRD 铁律（leader 派活用）；team-tool L28 | +1 |
| team-tool | app/server/src/agent/tools/team-tool.ts | teamTool.definition.description | 修改 | 加 `action="reset" (roleId) clears mate session context (transcript+summary+presence+todo) — leader/user only` | MUST 描述含 running 保护语义提示 | PRD §参数 | +1 |
| team-tool | app/server/src/agent/tools/team-tool.ts | dispatch switch | 修改 | 加 `if (action === 'reset') return await runReset(input, rtc);` | MUST import runReset from team-write-actions | team-tool L91-93 | +2 |
| tests | app/server/src/agent/tools/__tests__/team-write-actions.test.ts（或 team-tool.test.ts） | runReset 4 分支 | 新增 | ①idle mate → 清理成功（clearSession + putMember currentWork=null + todoStore.removeAll 调用断言 + 返 cleared:true）②running mate → 拒绝 errorResult('agent is running')（clearSession 未调）③leader reset → 可执行（leader 自身不在 running 保护限制内）④todoStore undefined → skip todo 不报错 | MUST mock rtc.store.getSession 返 running/idle；MUST 断言 clearSession/putMember/removeAll 调用参数（不复制逻辑）；MUST 验证 memory/agent md 未触碰（无相关调用） | PRD 铁律 1-4 | +60 |

## 影响面评估

- **跨模块**：team-write-actions.ts（+runReset）+ team-tool.ts（enum/权限/dispatch/description）+ 1 测试文件。无跨包变更、无前端变更、无 IPC 变更、无 HTTP 端点变更（reset 是 agent 工具 action，不经 HTTP）。
- **无破坏性变更**：enum 扩展 additive（旧 action 不受影响）；reset 归入 WRITE_ACTIONS 不改现有权限语义。
- **AT 影响评估**（v0.0.131 教训排查）：grep tests/api/ 22 个 case.yaml 中 team 工具 stub 0 处命中（AT case 不 stub team 工具帧——team 工具是 leader agent 自主调用的管理工具，AT 场景不涉及）。**结论：不触发 AT 冒烟集 case 更新**，不新增持久 AT case（核心冒烟集纪律——reset 是确定性管理操作，非 LLM 不确定性场景）。
- **关键设计裁决**：
  1. **reset 落在 team-write-actions.ts**（不独立服务）：对齐 deploy/bench/edit 模式（roleId 解析 + rtc 依赖注入 + errorResult 返回），零新文件、零新服务。team-tool.ts 只加 dispatch 一行 + import。
  2. **transcript+summary 复用 `rtc.store.clearSession(sid)`**：clearSessionStoreOp 已清 transcript/summary/runs/usage + 强制 idle + emit 3 事件（session_status_update/session_usage_update/messages_cleared）——与聊天页「清理上下文」按钮完全同链路、同语义。不另起清理逻辑。
  3. **presence 清 = memberStore.putMember read-modify-write**：presence 存在 member.currentWork（schema member.ts L109-110），清 = currentWork=null。对齐 presence-tool.ts L78-86 模式（剥信封 + spread + putMember）。清失败不阻塞（catch → warning，因为核心目标 transcript 已清成功）。
  4. **todo 清 = todoStore.removeAll(sid)**：todo-store.ts L184 已有 removeAll（session 销毁 hook 用），直接复用。todoStore 从 rtc.sessionDeps.todoStore 读（对齐 todo-tool.ts L48-49 模式）；缺省 undefined → skip 不报错（旧 session 可能无 todo）。
  5. **running 保护 = store.getSession(sid).state**：与 session-clear handler L79 同源判定（`state ∈ {running, interrupting}`）。但 **reset 不 abort**（不同于 clear handler 的 force=false 默认 abort）——reset 是管理操作，running 时直接拒绝让 leader 知道「等 mate 跑完再 reset」，不擅自打断。
  6. **memory 不动**：memory 存在 group 级 `.rocky/memory/` 共享文件（全队可见），与 session transcript 独立——clearSession 不碰 memory 文件，reset 也不碰。
- **风险点**：member.sessionId 可能指向已失效 session（mate 被删但 member record 残留）→ clearSession throw SessionNotFoundError → runReset catch 返 errorResult。这是正确行为（member 无有效 session → reset 无意义）。todoStore.removeAll 对不存在文件 silently succeed（removeFileSync 容错），无风险。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
