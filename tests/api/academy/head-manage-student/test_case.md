# head-manage-student — v0.0.221 head 教室层主权（manage-classroom + head 不进 task 内场）

**模块**：academy
**断言面**：SSE 工具面（manage-classroom tool_call + 边界 absent manage-task/manage-student/train-student）+ messages action 级（start_task / update_task）+ 结果落盘（task paused + maxTurns patch）+ 防假能用（认输话术 !~=）
**版本**：v0.0.221（三工具→两工具：manage-student 并入 manage-classroom；train-student 改名 manage-task；head 退教室层）

## 覆盖核心逻辑

验证 v0.0.221 两工具拆分后 head 真能完成全链路（design §3 两工具 + design §7.5 update_task 续训）：

1. **setup 事务链**：建教室（同建 head session，§1.1）→ 验 head 身份（biz=academy/role=head_teacher）→
   建学生"记录员1"（同建 0.0 初始 formal 版，§1.5）→ 建 dataset + em grader（multi 训练前提，§3.1/§3.6）。
2. **run1「训练记录员1，最多 1 轮」**（POST /session/:id/messages 生产路径）：
   - head 用 `manage-classroom.start_task`（原 manage-student.start_training 改名；薄壳调
     createTrainingTaskAndCoach 同核心）建成任务
   - SSE 硬断言：`tool_call_start toolName=manage-classroom >= 1` +
     **边界 absent**：`toolName=manage-task`（coach 专属）/ `manage-student`（已删）/ `train-student`（已改名）+
     run 完整结束（run_start/run_end 各 >= 1 + 顺序）+ 无全局 error 帧
   - messages 硬断言：持久化 ToolCallBlock `.content[name=manage-classroom].arguments.action == "start_task"`
3. **coach 自主跑到 paused**：poll GET classroom 直到 `tasks[0].status == "paused"`（maxTurns=1 →
   coach 1 轮即到顶 → status=paused + pausedReason='maxturns'；三态机终态，替原 awaiting_confirm）。
4. **run2「调大 maxTurns 到 3」**（新核心场景 design §7.5）：
   - head 用 `manage-classroom.update_task`（NEW action；patch {maxTurns?, directive?} 仅此两字段）
   - poll messages 直到 update_task 工具块落盘 → poll idle → GET task 验 `maxTurns == 3`（原 1）
   - update_task 是静默 patch（不改 status/candidate/baseline，不触发 coach 自动 resume）
5. **防假能用**：两轮最终回复 `!~=` 5 条认输话术（不认识学生/没有学生列表/没有管学生/找不到学生/没有持久化的学生）。

## 防"假能用"硬断言（本版本核心教训延续）

| 闸 | 断言 | 假能用形态 |
|---|---|---|
| 工具真实调用 | SSE `tool_call_start toolName=manage-classroom >= 1` + run 完整 + 无全局 error | head 嘴上说管学生但实际没调/调了全报错 |
| 工具边界 | SSE absent `tool_call_start toolName=manage-task/manage-student/train-student` | coach 专属工具/旧工具泄漏到 head 工具列表 |
| action 级决策 | messages ToolCallBlock filter：`start_task`（run1）/ `update_task`（run2） | head 调了工具但没干正事（只 list 不 start） |
| 认输话术 | 两轮最终回复 `!~=` 不认识学生等 5 条 | head 直接认输（messages.log 实证旧行为） |

## 关键设计决策

- **run1 maxTurns=1 + run2 update_task**：复刻新「maxTurns 到顶 → head update_task 续训」核心场景
  （design §7.5）。run1 maxTurns=1 使 task 快速 paused（coach 1 轮即到顶，缩短 coach run 时间）；
  run2 head 调 update_task 调大 maxTurns=3（patch 生效但 coach 不自动 resume——update_task 是静默 patch，
  resume 须另调 manage-task.resume 或 HTTP /resume）。
- **边界 absent 断言**：head profile.toolBound 从根隔离（head 工具列表不含 manage-task），LLM 不知
  manage-task 存在 → 自然不调。absent 断言是 sanity check（若 fail 说明工具泄漏到 head 工具列表）。
  manage-student/train-student absent 验证旧工具/旧名完全清除。
- **studentId 匹配 = 单学生结构保证**：教室仅 1 名学生，tasks[0] 必属记录员1；check 右侧不插值
  （DSL 陷阱 1）无法逐字比对 `.studentId == "{sid}"`，结构唯一 = 等价强断言。
- **action 断言用 eval_path filter（`[name=X]`）而非块索引**：assistant 消息 content 块序随 LLM 输出
  变化，硬索引 flaky；filter 定位每消息首个 name=X 的 tool_call 块 + `any` 跨消息扫描，块序无关。
- **长等待全走 poll 不走 wait**：head run 真实 >60s（6 轮 message + bash ~28s/次，transcript 实证）、
  coach run ~44s（多 case 连续真调 minimax 累计更慢）——单 wait/poll 60s 窗恰逢/累计超时误判钉死
  （v0.0.215 round1 step07 fail 根因）。框架 poll.timeout 上限 180（v0.0.203 用户裁决专为 trainer
  真 LLM 多 turn 链路放宽），wait 上限仍 60 不碰：run1/run2 完成等待转双相 poll（先 state=running
  确认 activate 防假完成，再 state=idle 等完成），coach 等待 poll 窗拉 150s。
- **不认输断言只达最终回复**：DSL 数组谓词不支持嵌套，中间 assistant 文本块不可达（UT/人工覆盖）。
- **teardown 用 /pause（替原 /stop）**：v0.0.221 /stop 路由删，改 /pause。已 paused 则 409 幂等。
  条件停 task（tid_td 现取），防 coach 泄漏烧 minimax 引发后续 case 429。

## setup 结构

5 步：建教室（minimax pool defaultModel）→ 验 head 身份 → 建学生 → 建 dataset → 建 em grader。
教室无 DELETE 端点 → 残留无害（每轮新教室，id 全 save 派生）。em grader 纯函数 grade（0 LLM）。

## 真调 LLM 调用次数

| 阶段 | LLM 调用 | 说明 |
|---|---|---|
| head run1（决策+工具轮+最终回复） | ~2-4 | manage-classroom start_task 调用链 |
| auto_naming（首消息并发） | 1 | session_meta topic，不在 main 流 |
| coach 自主循环（≤1 轮） | ~2-3 | maxTurns=1 快速 paused（决策 + sample；em grade 0 次） |
| head run2（update_task+回复） | ~2-3 | manage-classroom update_task 调用 |
| **合计** | **~8-12** | 429/529/503 → 框架自动 skipped |

## 已知 flaky 点（fail 归因指引）

- `tasks[0].status` 停 running 不进 paused → coach 卡住或 maxTurns 未到顶（读 events.jsonl 确认 coach
  是否在跑；可能是 LLM 决策慢，非 bug）
- `.content[name=manage-classroom].arguments.action` fail 但 SSE 有调用 → head 把多调用塞同一消息且
  start_task/update_task 非首个 filter 命中（罕见）；读 last_run responses.json 消息实况后放宽
- phase 2 poll idle 150s timeout → head 工具轮过多/极慢（mapper 上下文大 + 多轮工具 + bash ~28s/次）；
  读 events.jsonl + responses.json 实况确认是「真挂死」还是「还差一点」再调窗
- run2 update_task 未调 → head LLM 未理解"调大 maxTurns"意图（head_role mapper 应指引 update_task
  用途）；读 messages 确认 head 回复内容

## spec↔change_plan 冲突点（doc-sync 待办）

- `specs/api/overall/18-academy.md` §2.4-§2.6 accept/reject/stop 路由仍存在（spec 落后代码）；本 case
  teardown 用 /pause（change_plan E 节新路由）。doc-modifier 阶段 5 同步 spec。
- `specs/api/overall/18-academy.md` 未列 manage-classroom 工具 20 action 矩阵（工具层契约在
  `specs/tech/academy/[P0]session_kind_extension.md §7`）；spec 待同步补 manage-classroom 工具描述。

## 引用

- `specs/tech/version_logs/v0.0.221/change_plan.md` C 节（三工具→两工具）+ D 节（head profile.toolBound）+
  E 节（/pause /resume /adopt /update-task 路由）
- `specs/tech/academy/[P0]session_kind_extension.md` §3.1（head toolBound）+ §7（manage-classroom 20 action）
- `specs/api/overall/18-academy.md` §1.1/§1.3/§1.5/§1.8/§3.1/§3.6 — academy HTTP 契约
- `specs/api/overall/04-agent-session.md` §3.2 — POST /messages 202 + {runId, enqueueId}
- `specs/tech/agent/agent_interface_and_loop/[P0]agent_event.md` §5.4/5.5 — tool_call_start/tool_result_end 事件
- `specs/tech/agent/message/[P0]agent_message_interface.md` §4.6 — 持久化 ToolCallBlock 形状
- `states/v0.0.221/verify/test-plan.md` §4 AT 白名单 — 本 case 定义
