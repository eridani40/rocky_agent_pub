# v0.0.116 tech change_log — 心跳 squad 级统一调度 + team presence

> 跨版本发布说明（版本轴，doc-modifier 版本收口写）。位置轴变更见各 KB `log.md`。
> method 级变更契约见同目录 `change_plan.md`(+part2)。

## 设计原则（本版本沉淀的跨文件不变量）

1. **心跳粒度 squad 级（一 squad 一 job）**——`Job.id=heartbeat:<squadId>`、`HeartbeatPayload={squadId}`。到点整队一次：队级 gate（killswitch→activeWindows 多段→budget）通过后**逐成员展开**（scope: all/whitelist ∩ deployed ∩ 有 session ∩ 非 busy）各 `deliverTo` 固定心跳提示词。废弃 per-member job/role。
2. **engine 保持纯调度（activeWindows 全下沉 handler）**——engine `IntervalSchedule` 只承载 `interval.ms`，**不带 activeWindows**；多段时段判定在 `HeartbeatHandler.tryFire gate1`，来源 = `getSquad().heartbeatConfig.activeWindows`。守「引擎不感知业务」原则（开放点1裁决）。
3. **killswitch = job 恒注册 + 每-tick 动态 gate0**——`SquadRuntime.shouldSchedule` 删除；squad 存在即恒注册 heartbeat job，`enableHeartBeat` 由 `tryFire` gate0 每 tick 现取判 `skipped_killswitch`（toggle ≤1s 生效 + history 有记录，无需 unregister/reload）。只有 interval/activeWindows/scope/tz 变才 `reloadSquad` 重建 schedule。
4. **默认 30s tick（`SCHEDULER_TICK_MS` seam）+ per-job inFlight**——engine 轮询默认 30_000ms（测试环境 1000），最小调度粒度分钟级无漏拍；per-job inFlight 守卫防同 job 未 settle 重入。
5. **lastFiredAt 双面：运行期内存 / reload 从文件恢复**——fire 成功 `updateJobLastFiredAt` 写内存 + writeSquad 落盘；gate skip 不推进。任何 PATCH /squad 触发 `reloadSquad` → `loadJobs` 从 scheduler.json 文件恢复 lastFiredAt（v1 忽略返 null=从当前重排）。
6. **budget cache 时序 + lazy-baseline**——gate2 读 boot.ts sync `budgetCache`（30s 周期后台刷新，budget=null 不入 cache、miss 返 Infinity 放行）→ PATCH budget 后最长 30s 才对心跳 gate 生效。consumed 走 baseline-delta（窗口内首次查某 session 播 baseline、consumed 从 0 起算，非 always-on）。
7. **presence = 独立工具 + 只写 selfMemberId**——`presence(set/clear)` read-modify-write `member.currentWork`，从 runtime-context 取 selfMemberId（不接受 memberId 入参，防越权）。leader/mate 可用，SquadChat 不加。
8. **team-status reminder（leader only）**——`squad_team_status` provider 只列 session `state==='running'` 的成员 + currentWork，每轮直接产出（不走 shouldProduce 变化检测）。

## 破坏性变更

- `HeartbeatPayload` schema 变（去 memberId/sessionId）——per-member job 全废弃。
- `PATCH /squad/:id/member/:mid/heartbeat` 端点 + `handlers/squad-heartbeat-handler.ts` 删除（旧 client 调 → 404）；`PatchMemberBody.heartbeat` 转 dead accept-and-ignore + warn（不写盘）。
- scheduler.json v1→v2（`{version:2, lastFiredAt, lastResult}` 平铺，去 roles 分桶）；旧 v1 roles 读时忽略 + 存时收敛（不运行时破坏性清理，memory `runtime-no-ext-policy-write`）。
- `member.heartbeat` schema 字段保留（dead，避免历史 record 迁移风险），代码停读写。

## 主要文件

- **scheduling**：`handlers/heartbeat-handler.ts`（tryFire squad 级 gate + 逐成员展开）、`persistence/heartbeat-adapter.ts`（loadJobs 返 0/1 squad job + getHeartbeatConfig）、`payloads.ts`（HeartbeatPayload={squadId}）、`boot.ts`（HeartbeatHandler deps + budgetCache 30s 刷新 + listMembers 委托 squad-runtime）、`engine.ts`（per-job inFlight + 默认 30s）。
- **squad**：`scheduler/scheduler-state.ts`（readSquad/writeSquad v2，删 readRole/writeRole）、`scheduler/tick-message.ts`（HEARTBEAT_TICK_PROMPT + buildHeartbeatTickMessage）、`scheduler/types.ts`（SquadHeartbeatConfig/MemberSnapshot，删 RoleHeartbeat）、`squad-runtime.ts`（恒注册 + getHeartbeatConfig + listMembersSnapshot，删 listHeartbeatRoles/reloadRole/shouldSchedule）、`squad-runtime-helpers.ts`（buildSquadHeartbeatJob/projectSquadHeartbeatConfig，删 buildHeartbeatJob/projectMemberHeartbeat/reloadRole）、`schema_defs/squad/squad.ts`（heartbeatConfig）、`schema_defs/squad/member.ts`（currentWork + heartbeat dead）。
- **squad-api**：`handlers/squad.ts`（validateHeartbeatConfig + handlePatchSquad + toDetail 回显）、`handlers/member.ts`（heartbeat dead warn-and-ignore）、`router.ts`（删 heartbeat route）、`handlers/squad-heartbeat-handler.ts`（整删）。
- **presence/reminder/prompt**：`agent/tools/presence-tool.ts`（新）、`agent/tools/runtime-context.ts`（selfMemberId）、`tools/registry.ts` + `agent/tool-policy.ts`（presence 注册 + leader/mate bound）、`agent/squad-reminder-deps.ts`（isSessionRunning）、`plugins/builtins/rocky_context/reminder/squad_team_status.ts`（新 provider）+ `plugin.json` EP + i18n、`prompts/content/squad/{leader,mate}.md`（presence 维护句）、`bootstrap.ts`（selfMemberId + isSessionRunning + memberStore 注入）。
- **前端**：`studio-page/component-autowork-tab.tsx`（四块）、`section-heartbeat-config.tsx`（重写 squad 级）+ `heartbeat-window-list.tsx` + `heartbeat-scope-picker.tsx`（新）、`component-budget-meter.tsx`（配置交互）、`section-member-panel.tsx` + `use-member-panel-handlers.ts`（移除心跳 section）、`squad-types.ts`、`lib/squad-api.ts`。

## 验证

- 本版相关 AT 7/7 + ET 2/2 全绿（round-4）：config_crud / heartbeat_trigger_gates（tick 文案+EOS+killswitch skip+window skip/pass）/ budget_gate（真消耗 limit=1 拦截 skipped_budget + reactive 不受影响 + null 放行）/ presence_tool（set/clear/越权）/ presence_leader_prompt / autowork ET / member_panel ET。PRD P1-P6 关键路径全覆盖，无阻塞 issue（hard_fail=0）。
- **doc-sync 校验（代码 == spec 契约）**：逐项核实 heartbeat-handler.ts / heartbeat-adapter.ts / squad-runtime.ts / scheduler-state.ts / boot.ts / squad.ts / member.ts / presence-tool.ts / squad_team_status.ts 与 spec 一致。修正 spec 3 处代码漂移：① heartbeat_handler.md §2 伪码 activeWindows 来源改 `getSquad().heartbeatConfig`（不读 job.schedule）；② scheduling/index.md「1s 轮询」→ 默认 30s（SCHEDULER_TICK_MS）；③ 11a §1.4 member PATCH heartbeat 从「写存储 + reloadRole」改 dead accept-and-ignore。补记 budget 30s cache 延迟 + lazy-baseline 口径 + PATCH 重排 lastFiredAt from file（heartbeat_handler.md §3.1/§5）。
