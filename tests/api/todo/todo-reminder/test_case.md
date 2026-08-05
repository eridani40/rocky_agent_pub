# todo-reminder — session 有未结束 todo → reminder 注入 [todo] 段

**模块**：todo（新板块，v0.0.223 引入）
**断言面**：Resp（GET /messages 读末条 user message 的 reminder block 文本）+ 真调 minimax（ingest 触发 reminder 注入）
**版本**：v0.0.223（新建）；v0.0.190 真实调 API 范式

## 覆盖核心逻辑

本 case 覆盖 UC-223-TODO-REMIND（PRD §3 / §2.5）——验证 `TodoReminderProvider` 填壳产出真注入到 user message（v0.0.223 把 reminder/todo.ts 从 no-op 空壳填为 session todo 进度，system_reminder.md §3 row 5 重定义）。

### 链路

```
预置未结束 todo 主 item（HTTP POST /todos 直建 todo store，status=in_progress）
  → 真调 minimax 发一条 user message（无工具路径）
  → ingest 期 system_reminder_injector（context_ingest_handler）跑 todo provider
  → todo provider 读 ctx.todoStore.listBySession(sid) 产出 [todo] 段
  → injector 把 reminder 聚合文本以 TextBlock(isSystemReminder=true) 追加到末条 user message content
  → 落库持久化进 transcript
  → GET /messages 读 items[-2]（末条 user message）content[] 含 "[todo]" 文本 block
```

### 步骤断言

| 步 | 行为面 | 断言 |
|---|---|---|
| setup | 建 playground session（parent.main，minimax） | `.id`/`.state == "idle"` |
| 1 | POST /todos 预置未结束主 item（in_progress） | `.itemId exists` |
| 2 | run（真调 minimax，无工具路径，transcript=[user,assistant]） | `.state == "idle"` |
| 3 | GET /messages 读末条 user message 的 reminder block | `.items exists` + `.items[-2].content[] any .text ~= "[todo]"` |

**核心断言 `.items[-2].content[] any .text ~= "[todo]"`**：
- `items[-2]` = 末条 user message（单次 run + 无工具 → transcript=[user, assistant]，-2=user）
- `content[] any .text ~= "[todo]"` = 该 user message 的 content block 数组中，至少一个 text block 含 `[todo]` 标头（todo_tools.md §6 产出格式 `[todo] 进行中：...` 的契约标头）
- 证明 todo provider 填壳产出 + injector 落库 + HTTP 可读 三段链路打通

## 为什么 GET /messages 能读到 reminder（机制依据）

reminder 落库持久化（system_reminder.md §4：`system_reminder_injector` 在 ingest 时把 reminder 加到末条 user message content 并落库进 transcript，非临时视图）。GET /messages 返原始 transcript，**server 侧不过滤 isSystemReminder block**（前端 `DEFAULT_BLOCK_FILTER` 才隐，02-llm-chat.md §3）—— 故 HTTP 黑盒可直接读到 `[todo]` block 文本。

## 已知边界（AT 表达范围）

- **items[-2] 索引依赖无工具路径**：run prompt 显式「只回复继续 / 不调工具」→ minimax 产 2 条消息（user+assistant），items[-2]=user。若 LLM 偏离调了工具，消息数变 → 索引偏 → fail（真信号：prompt 未约束住 / reminder 未注入，executor 归因）。
- **`[todo]` 标头是契约 marker**：todo_tools.md §6 定义产出格式 `[todo] ...`；若 impl 措辞偏差（如 `[Todo]` 大写），`~=` 区分大小写会 fail → 真 impl 偏差信号。
- **todo provider 仅 parent.main 产出**（todo_tools.md §6）：playground = parent.main 适用；subagent/forked 不产（UC-223-TODO-3 由 UT 覆盖 toolBound）。

## DSL 写不出的目标（转 UT 兜底）

| 目标 | 为什么 AT 写不出 | UT 兜底 |
|---|---|---|
| reminder 段含步骤进度 `(done/total 步骤)` 精确格式 | 格式 impl-defined，硬断字面 flaky；只断 `[todo]` 标头更稳 | TodoReminderProvider UT（产出格式 + 步骤计数） |
| 全部 todo 已结束清理 → reminder 不注入（空） | 否定（无 absent over reminder block；且需「items[-2] 无 [todo] block」=否定） | TodoReminderProvider UT（空 store → no-op 返 []） |
| todo provider 不读 task_tools（语义隔离） | 跨工具隔离白盒，AT 黑盒不可观测 | TodoReminderProvider UT（不引用 task store） |
| subagent/forked 不产 todo reminder | 需建 subagent session（重）+ 否定断言 | TodoReminderProvider UT（parent.main only 角色过滤） |

## 引用

- `specs/tech/agent/context/[P0]system_reminder.md` §3/§4 — todo provider（order 5，[v0.0.223] 重定义）+ injector 落库机制
- `specs/tech/agent/tools/[P1]todo_tools.md` §6 — `[todo]` 产出格式 + parent.main only
- `specs/api/overall/04-agent-session.md` §3.1 — GET /session/:id/messages（{items, hasMore}，不过滤 reminder block）
- `specs/tech/agent/message/[P0]agent_message_interface.md` §4.1 — TextBlock {type, text, isSystemReminder?}
- `specs/prd/version_logs/v0.0.223.md` §3 UC-223-TODO-REMIND / §2.5 — 填壳 + 语义重定义需求
