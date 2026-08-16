# v0.0.361 变更计划书 — Session States + Reminder Queue 重构（full/incremental 双模式）【v2，老板 20:21 终版修订】

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 0. 需求与拍板演进（时间轴，后者覆盖前者）

| 时间 | 拍板 | 内容 |
|---|---|---|
| 19:53-19:56 | 老板 7 点 | 栏目改名 session states/queue 持久化 KV/ingest 收集/assemble 零逻辑+cache 不避让/时间留 reminder/ingest 后清 queue 拿锁/ingest=消费=poll |
| 20:04 | 老板第 8 点 | run 首消息/summary 重建后首消息全量构建+清 queue，之后纯增量；哲学「业务都填 queue，每项自主决定怎么用」 |
| 20:05 | 老板第 9 点（修正版） | `useFullReminder` 放现有 **RunState**（非持久化）；run 开始默认 true → 首 ingest 全量+清 queue+置 false；summary 版本更新置回 true |
| 20:07 | 老板简化 | ①8 handler 改名映射表交付取消 ②心智模型=system_reminder 内部 full/incremental 两套逻辑（full=既有 handler 链照跑）③handler 改名非必须 |
| 20:08 | 老板再简化 | time provider 退役：时间写死为 injector 内部固定段（incremental 每轮固定输出；full 照旧含时间） |
| **20:21** | **老板终版（覆盖所有分桶/迁移口径）** | ①**本期就迁移 system prompt 不遗留**：静态项（env/workspace/团队盘路径/member 名单）进 prompt 新段（session states 类命名），对应 provider 退役 ②分桶终版修正：**task 走 reminder（全部变化，不进基线）**；squad_agents_status 拆两半（名单→prompt 静态半，状态/presence→queue 动态半） ③queue=**有序队列**本质：key 不注入、value 才是注入内容；同 key 写新删旧追队尾；drain 按序读 value |
| 20:24 | 老板补充 | queue = **通用开放通道非注册制**：无 provider 注册/类型绑定/写入方身份追踪；write(key,value) 下轮 ingest 即进 reminder；本期接线只是已知调用点样例 |
| 20:24 | 老板未来用例锚点 | skill 变化（skill:{name} installed/disabled）一条 write → 下轮感知，免「重启 session 才注入」死角；**本期不接线**，记 spec 开放通道锚点 |
| 20:26 | 老板实现载体 | session states 段与 reminder 双模**全走 plugins 机制**（rocky_context 内）：静态迁移不写死核心 server/assemble；核心层仅接口对接（详见 §1.8 分层表） |
| **20:34** | **老板终版补丁（已确认开工）** | cache_control 确保三断点：system prompt 末 + **tools 末** + messages 末；代码实证 tools 末现状缺失（encodeTools 纯映射）→ encodeTools 末位 tool 注入 cache_control 为本版新增；详见 §1.3 三断点体系 |

ROI 背景（reminder-ratio-analysis.md）：现状每轮全量 reminder 4498c ≈1124 tok，占非缓存新增 72%。本版目标 = 静态项一次性进 system prompt（缓存段）+ run 内轮次只发增量。

## 1. 方案设计

### 1.1 心智模型（20:21 终版）：session states 进 system prompt（静态半）+ system_reminder 内部 full/incremental（动态半）

```
┌─ system prompt（session states 静态段，本期迁移，老板点 1）────────────┐
│ 新 session_states mapper 段：env / workspace / 团队盘路径              │
│ 成员名单：team_roster mapper 已承载（name+role+sessionId+intro，       │
│   v0.0.33.2 起）——不重复建段，即老板口径「member 名单进 prompt」的落点 │
│ 构建时机不变：session 启动 / summary 重建（run 间复用 prevSnapshot）   │
└──────────────────────────────────────────────────────────────────┘
ingest（每条 user/tool/a2a 消息）
  └─ injector 检查 RunState.useFullReminder
       ├─ true（full：run 首 / summary 重建后首）
       │    ① 跑瘦身后的动态 provider 链全量产出
       │      （todo / squad_task / squad_agents_status 动态半=状态行；
       │       env/workspace/squad_workspace/time 已退役不在链）
       │    ② + injector 内部时间固定段
       │    ③ 渲染 full 块（动态项全量）→ 追加到 message 末尾（进 transcript）
       │    ④ 拿锁清空 queue（full 已涵盖最新态，pending 作废）
       │    ⑤ RunState.useFullReminder = false
       └─ false（incremental：run 内后续轮）
            ① injector 内部时间固定段
            ② 拿锁 drain queue（按序读 value + 清空）
            ③ 渲染增量块 → 追加到 message 末尾（进 transcript，永久保留）
```

分派哲学（老板点 8）：**业务需要都填 queue，每 states 项自主决定怎么用**——静态半选择「进 system prompt 基线」（run 间字节稳定，缓存命中），动态半选择「full 全量 + queue 增量」。终版分桶见 §1.7。

### 1.2 queue 设计（本质 = 有序队列；KV 形态只是去重机制——老板 20:21 点 3 精确定义）

**定位（老板 20:24）：queue = 通用开放通道，非注册制**。任何业务想进提醒直接 `write(key, value)`，下轮 ingest 即进 reminder——没有 provider 注册、没有类型绑定、没有写入方身份追踪（queue 不挂「谁来的」）。本期接线的 todo/presence/task/member 状态（§1.5）只是**已知调用点样例**，不是 queue 的封闭成员表；后续新业务零改造接入。与旧模式的本质区别：旧 = provider 注册进链 + injector 拉取；新 = 业务直写 + injector 只 drain。

**介质**：`{DATA_DIR}/sessions/{sid}/reminder_queue.json`。**内部结构 = 有序 entries 数组**（持久化形态），运行时以 `Map<key, value>` 索引去重：

```json
{ "entries": [
  { "key": "task:T12", "value": "T12「实现 T1」→ 进行中（owner: coder）",
    "recordedAt": "2026-08-15T20:20:11+08:00" },
  { "key": "todo:01M02GM2", "value": "item「落四件套」step「写 change_plan」→ done",
    "recordedAt": "2026-08-15T20:15:03+08:00" }
] }
```

- **key 不注入、value 才是注入内容**：value = 已渲染的注入行（人类可读原文，drain 时直接拼块，不再二次渲染 payload）。key 仅用于去重寻址：`{栏目}:{实体id}`（todo:{itemId} / presence:{memberId} / task:{taskId} / member_state:{sessionId}）。
- **同 key 写入 = 删旧 value + 新 value 追加队尾**（有序队列语义：最新变化总在队尾，drain 按序注入）。
- **删除语义 = 显式空 value 行**（不用 tombstone 标志）：删除/清空类变化（todo delete_item / presence clear）写 value 为「item「X」已删除」类文本行——与「value 才是注入内容」正交（注入的就是这行「已删除」文本），LLM 可感知消失；随 full 清空/drain 消费自然回收。写入方各自定义删除行文案（样例见 §2）。
- **锁**：进程内 per-sid Promise mutex（写/drain/clear 全走锁）。单 Electron server 进程独占 sessions 目录；原子写（tmp+rename，todo-store 同款）防半文件。
- **生命周期**：写入方 upsert → drain（incremental ingest 拿锁按序读 value+清，点 6/7 字面：ingest=消费=poll、清理拿锁）→ clearAll（full 时拿锁清）。「只记变化」：drain 后队列空，直到新变化再进。

### 1.3 wire 语义裁决（leader 两难：「累积视图重渲染」vs「wire 累积保留」）→ 选后者

**选 B'（wire 累积保留）**：历史 reminder 块（full 块 + 增量块）**不 drop、全保留**进 wire；encode 删掉 wire 层 reminder 过滤 + `injectLastNonReminderCacheControl` 避让扫描，bp#2 固定打最末 message 的最末 block（点 4 字面全满足：assemble/protocol 零 reminder 逻辑 + 不再避让）。

**三断点体系（老板 20:34 终版补丁）**：wire body 断点齐三处——**bp#1** system prompt 末（protocol-encode.ts:102-106 既有✅）+ **bp#T** tools 末（**新增**：encodeTools 末位 tool 注入 cache_control；现状 helpers:191-215 纯映射无注入）+ **bp#2** messages 末（最末 message 最末 block）。Anthropic 上限 4 断点，三断点合规。三层各自锚定：system 段变更（session states 刷新/summary 重建）→ bp#T/bp#2 命中 tools+messages 前缀；tools 变更 → bp#1/bp#2 命中 system+messages；messages 每轮 append → bp#2 命中。

**cache 论证**：历史块进 transcript 后字节不变（append-only）→ bp#2 前缀 = 稳定历史 + 本轮新块 → 每轮命中上一轮缓存条目，只有新块计费。若选 A（drop 历史 + 每轮重渲染累积视图）：最末块每轮重写 → bp#2 落变化位，前缀于 m11 尾分叉 → 历史断流 miss，cache_creation 1.25x 重算——比现状更贵。**token 账（5 run × 10 轮）**：现状 4498c×50 轮非缓存 ≈225KB；B' = 每轮新增量块 60-300c 非缓存 + 历史 full 块 4498c×5 run ≈22KB 缓存读（0.1x）——**大胜且语义自洽**（历史块 = run 内状态演进轨迹，LLM 可追溯）。

- 备选 C（保留 drop+避让、只缩块）token 更省但违背点 4，不取；change_log 记录裁决。
- `TextBlock.isSystemReminder` 标记**保留**（前端隐藏块用，现状契约不变）；仅 wire encode 不再读它过滤。

### 1.4 useFullReminder 状态机（点 9 修正版：进 RunState，零持久化）

- `RunState` 加 `useFullReminder?: boolean`（agent-loop-helpers.ts；undefined 视同 true——run 开始新建 RunState 天然 full，零额外初始化接线）。
- 消费：injector.handle 读 ctx.runState（IngestCtx 扩展透传，context-ingest-pipeline.ts 接线）→ full 分支末尾置 false。
- **summary 触发**：run 内 assemble 后 `prevSnapshot.summary?.version !== snapshot.summary?.version` → `state.useFullReminder = true`（run-react-loop ② callLLM 成功后、下次 ingest 前检查；RunState.snapshot 每次 assemble 更新，version 可及）。run 跨越 summary 更新（少见，通常 summary 后 run 重建）由此覆盖：下一轮 ingest 回 full。
- forked/subagent：RunState 同样新建 → 恒 full（provider 链现状行为保持），不接增量（单次任务 run 无交互轮次，full 开销可接受；scopeId=forked 的 ingest 管线现状照跑）。

### 1.5 已知调用点接线（4 处样例）+ fan-out

> 定位重申（§1.2）：下表是**本期接线的已知调用点**，非 queue 封闭成员表——后续新业务直接 write 即接入，无需扩表。

| 调用点 | 文件 | 变化 → key | value（已渲染注入行） | 写入范围 |
|---|---|---|---|---|
| todo 工具 | app/server/src/agent/tools/todo-tool.ts（6 action 执行点） | `todo:{itemId}` | item/step 变化行（含 status）；delete → 「item「X」已删除」空 value 行 | 仅本 session（todo 是 session 级） |
| presence 工具 | app/server/src/agent/tools/presence-tool.ts（set/clear） | `presence:{memberId}` | 「{member} presence: {text}」/ clear → 「{member} presence 已清除」 | squad 全员（§fan-out） |
| task transition | app/server/src/squad/panorama/tool/panorama-tool-actions.ts + http transition handler（两入口同调 helper） | `task:{taskId}` | 「T{id}「{title}」→ {status}（owner: {owner}）」 | audience 过滤：leader ∪ task.owner ∪ dependencies[].owner（写侧过滤，mate 不收不相关 task 噪声——对齐 squad_task provider 的 viewer filter 语义） |
| member 状态机 | app/server/src/agent/session-state-machine.ts（markRunning/markIdle/markSuspended/markError 的 emitStatus 处） | `member_state:{sessionId}` | 「{member} → {state}」 | squad 全员 |

**fan-out helper（新增）**：app/server/src/squad/squad-states-fanout.ts——`fanoutStates(squadId, key, value)`：读 squad members[].sessionId + squadChatSessionId（squad-aggregate-service 直连 session 集合同款）→ 逐 session queue write。调用点各自已有 squadId 可及（config.squadId / squadContext）。

**未来用例示意（老板 20:24 亲口例子，本期不接线，锚定开放通道语义）**：skill 变化（安装/禁用/更新）→ `skill:{name}` 一条 write（value「skill X installed/disabled」），下轮 ingest agent 即感知——免现在「skill 变了要重启 session 才注入」的死角。任何新业务零改造接入同此模式。

**不接线**（本期）：tool_error（现状 no-op 无数据源）、skill 变化（未来用例）、team hire/bench/deploy（低频，team_roster 已在 prompt；后续要感知再接）。

### 1.6 provider 退役清单（time + 静态三件）

- **time**（老板 20:08）：reminder/time.ts 删 + plugin.json 去注册行；injector 内部固定段 `Current date and time: YYYY-MM-DD HH:MM (TZ)`（Intl 本地时区，逻辑平移）。full 与 incremental 都由 injector 出时间。
- **env / workspace / squad_workspace**（老板 20:21：静态半进 system prompt）：三个 reminder provider 文件删 + plugin.json 去注册行，逻辑平移进新 session_states mapper（env/workspace/团队盘路径三小节）。plugin.json 同时注册新 mapper EP 行 + i18n __MSG key。
- **squad_agents_status 拆两半**：静态半（成员名单）不迁移——team_roster mapper 已在 system prompt 承载（零改动）；动态半（状态行/presence）保留在 reminder 链，full 模式继续全量产出（injector 的 full 分支数据源）。
- **保留在 reminder 链**：todo / squad_task / squad_agents_status（动态半）/ tool_error（no-op 现状）。

### 1.7 分桶终版（老板 20:21，**本期实施**——静态半进 system prompt，动态半走 reminder 体系）

| 栏目 | 终版桶 | 载体 | 迁移动作（本期） |
|---|---|---|---|
| env | **system prompt** | 新 session_states mapper 段 | reminder/env.ts 退役（逻辑平移 mapper） |
| workspace | **system prompt** | 同上 | reminder/workspace.ts 退役（同） |
| squad_workspace（团队盘路径） | **system prompt** | 同上（合入 workspace 段或独立小节） | reminder/squad_workspace.ts 退役（同） |
| **member 名单（静态）** | **system prompt** | **team_roster mapper 已承载**（v0.0.33.2 起在链：name+role+sessionId+intro） | **零迁移**——即老板口径「member 名单进 prompt」的既有落点；squad_agents_status 拆分后名单不重复 |
| task（全部变化） | **reminder 体系** | full 块（动态链）+ queue `task:{id}` | **不进基线**（老板终版修正：leader 前判「task 列表低频进基线」作废） |
| member 状态（presence / idle-running） | reminder 体系 | full 块 + queue `presence:{mid}` / `member_state:{sid}` | squad_agents_status 拆两半：名单→team_roster（已有），状态行→本桶 |
| todo | reminder 体系 | full 块 + queue `todo:{itemId}` | 不变（v2 §1.5） |
| 系统时间 | reminder 固定段 | injector 内部固定段 | time 退役（§1.6，点 5） |
| tool_error | —（no-op 现状） | 无数据源 | 文件保留（未来接入时不进桶讨论） |

**cache 语义**（rebaseline 坑的终版规避）：静态半全部进 system prompt 后，prompt 字节在 run 间稳定（env/workspace/盘路径 session 级恒定；member 名单 hire/bench 罕见——变化触发下次 buildSystemPrompt 重建属既有语义，与 reminder 无关）。summary 重建时 useFullReminder=true 走 full 动态链，**不触碰 system prompt 重建时机**（buildSystemPrompt 的 shouldRebuild 判定不变）。

### 1.8 实现载体与依赖分层（老板 20:26 拍板：session states 段 + reminder 双模全走 plugins 机制）

**拍板含义**：静态四项迁移不在核心 server/assemble 里写死——session_states 段由 plugin（rocky_context）贡献 system prompt mapper（同 team_roster/identity 等既有段的断逻辑）；reminder 双模在 rocky_context 内原位改造。**核心层仅接口对接**。

**分层归位（按项目依赖方向铁律 protocol → plugin-sdk → plugins → server 单向；server 不得 import plugins 目录）**：

| 层 | 文件 | 性质 |
|---|---|---|
| plugin 本体（迁移/双模逻辑） | rocky_context/prompt/session_states.ts（新 mapper）/ ingest/system_reminder_injector.ts（双模）/ reminder/（退役+拆分） | 老板口径的「全部落在 plugin 目录内」 |
| 核心接口对接 | agent/system-reminder-queue.ts（持久化基建）/ context-ingest-pipeline.ts（ctx 透传）/ agent-loop-helpers.ts（RunState 字段）/ run-react-loop.ts（summary 检查） | queue 是 server 侧多写入方（todo-tool/状态机/panorama 均 server 模块）共用的基础设施，**必须**在核心层；plugin injector 经 ctx 拿 handle 消费，不反向 import |
| 核心调用点（写 queue） | todo-tool / presence-tool / session-state-machine / squad-states-fanout / panorama actions | 本就是核心模块，写 queue = 调用核心层接口 |
| plugin 契约变更 | llm_anthropic/protocol-encode*（bp#2 落位+删过滤） | 独立 plugin 内改造 |

**推论（钉死歧义）**：queue store 不搬进 plugin 目录——搬进去则 server 写入方反向 import plugin 违反依赖方向铁律；「核心层仅接口对接」的准确语义 = 核心层只提供 queue 基建 + ctx 透传 + RunState 挂点，**不承载任何 session states 业务逻辑**（渲染格式/栏目分派/退役迁移全在 plugin）。



## 2. 硬性交付：变化注入样例（queue 记录原文 + reminder 渲染原文）

### 样例 A：todo step 完成（本 session）

queue 记录（reminder_queue.json entries 内一条，value 已渲染）：
```json
{ "key": "todo:01M02GM2T6MCTRMEWJDYY2RTAP",
  "value": "[todo] item「落四件套」step「写 change_plan」→ done",
  "recordedAt": "2026-08-15T20:15:03+08:00" }
```
（150 bytes。再变同 item → 同 key 旧行删、新行追队尾）

ingest 后 reminder 增量块（追加到本轮 message 末尾的 text block 原文）：
```
[system_reminder]
Current date and time: 2026-08-15 20:16 (Asia/Shanghai)
[todo] item「落四件套」step「写 change_plan」→ done
```
（114 chars ≈29 tok）。对比现状 [todo] 全量段 300-600c/轮。

### 样例 B：task transition（跨 session fan-out，audience=leader+owner+blockers）

queue 记录（写入 coder session）：
```json
{ "key": "task:T12",
  "value": "[task] T12「实现 T1 成功 target registry」→ 进行中（owner: coder）",
  "recordedAt": "2026-08-15T20:20:11+08:00" }
```
（148 bytes）

coder 下轮 ingest 渲染：
```
[system_reminder]
Current date and time: 2026-08-15 20:21 (Asia/Shanghai)
[task] T12「实现 T1 成功 target registry」→ 进行中（owner: coder）
```
（123 chars ≈31 tok）

### 样例 C：member presence + 状态（leader 视角，两条 queue 记录同轮 drain 合并）

queue 记录（leader session 内两条，按写入顺序）：
```json
{ "key": "member_state:01KZA6D529GA2A9XRDRD19A6HB",
  "value": "[squad:agents] architect → running", "recordedAt": "...T20:21:40+08:00" }
{ "key": "presence:architect",
  "value": "[squad:agents] architect presence: v0.0.361 架构设计", "recordedAt": "...T20:21:41+08:00" }
```

leader 下轮 ingest 渲染（drain 按序，同轮多 value 拼一块）：
```
[system_reminder]
Current date and time: 2026-08-15 20:22 (Asia/Shanghai)
[squad:agents] architect → running
[squad:agents] architect presence: v0.0.361 架构设计
```
（173 chars ≈43 tok）。对比现状 [squad:agents] 全量 18 行 ≈1800c/轮——**同信息量约 12-15 倍缩减**。

### 样例 D：member 名单静态半进 system prompt（session states 段渲染样例）

system prompt 内新段（session 启动/summary 重建时构建，run 间字节稳定进缓存）：
```
# Session States
- Environment: app=prod, platform=darwin
- Workspace: <squad-workspace>
- Squad workspace: {DATA_DIR}/squads/01KZA61YTQBB05NBSWEWWCFWMX
- Team roster（既有 team_roster 段，零改动）:
  - Darvin(leader, 01KZA61YTQ...) — 团队 leader...
  - prd(mate, 01KZA6D51...) — 产品经理...
  （18 行，与现状 team_roster 输出一致）
```
（≈350 chars 静态，进 system prompt 缓存段；每轮零重发——现状这部分占 reminder 每轮 ~700c）

### 对照（before 活证据）：architect session 19:58-20:24 十二轮收到同一 [squad:agents] 18 行全量块 + [todo] 段，每轮 4498c 中约 4200c 为零变化重发。

## 3. 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent | app/server/src/agent/system-reminder-queue.ts | ReminderQueueStore（write/drain/clearAll） | 新增 | per-session 有序队列（sessions/{sid}/reminder_queue.json，entries 数组持久化 + Map 索引去重）：write(key,value) 同 key 删旧+新 value 追队尾 / drain() 拿锁按序读 value+清 / clearAll() 拿锁清；原子写 tmp+rename；per-sid Promise mutex；**通用开放通道——无注册/类型绑定/身份追踪** | MUST：单文件 ≤300 行；MUST NOT：不写 DATA_DIR 外路径、不做写入方身份校验 | 本表 §1.2 | +140 |
| rocky_context | app/plugins/builtins/rocky_context/prompt/session_states.ts | SessionStatesMapper | 新增 | system prompt 新段（id=session_states，tier=stable）：env / workspace / 团队盘路径三小节，逻辑自三个退役 reminder provider 平移；member 名单由既有 team_roster 承载（零改动） | MUST：输出格式与原 reminder 行文等价（平移非重写）；MUST NOT：不拼装动态项（task/todo/状态不进本段） | 本表 §1.1/§1.7 | +90 |
| rocky_context | app/plugins/builtins/rocky_context/reminder/{env,workspace,squad_workspace,time}.ts + plugin.json | 4 个静态 provider + time | 删除 | 静态三件+time 退役：文件删 + plugin.json 去 4 个 EP 注册行 + 补 session_states mapper 注册行 + i18n __MSG key 清理/新增 | MUST：plugin.json 注册变更与文件删除同 commit | 本表 §1.6 | -320 |
| rocky_context | app/plugins/builtins/rocky_context/reminder/squad_agents_status.ts | SquadAgentsStatusReminderProvider | 修改 | 拆动态半：成员名单行删除（team_roster 已承载），保留状态行（running/idle + presence）；full 模式数据源 | MUST：动态半输出格式不变（状态行原文） | 本表 §1.6 | +12/-15 |
| rocky_context | app/plugins/builtins/rocky_context/ingest/system_reminder_injector.ts | SystemReminderInjectorHandler.handle | 修改 | 双模式重构：读 ctx.runState.useFullReminder（undefined 视 true）→ full=跑瘦身动态链（todo/squad_task/squad_agents_status 动态半）+ 时间固定段 + queueClearAll + 置 false；incremental=时间固定段 + queueDrain 按序拼 value 渲染增量块；时间固定段逻辑自 time.ts 平移 | MUST：触发条件（user/tool/a2a）与 isSystemReminder 块标记不变；MUST NOT：不做写入方识别（queue 内容通吃） | 本表 §1.1/§1.6 | +70/-20 |
| agent | app/server/src/agent/context-ingest-pipeline.ts | applyIngestPipeline + IngestCtx | 修改 | ctx 扩展透传 runState + queueDrain/queueClearAll closure（ContextEngine 构造期注入，同 reminderRunner 模式） | MUST：closure 注入避免 handler 持 store | 现有 reminderRunner 模式 | +25 |
| agent | app/server/src/agent/agent-loop-helpers.ts | RunState | 修改 | 加 `useFullReminder?: boolean`（注释钉语义：undefined=true；full 消费后置 false；summary 版本变置 true） | MUST NOT：不持久化（RunState run 结束销毁） | 本表 §1.4 | +8 |
| agent | app/server/src/agent/run-react-loop.ts | ② 后 summary 检查 | 修改 | assemble 后 prev/cur snapshot summary.version 不等 → state.useFullReminder = true | MUST：检查点在下次 ingest 前 | 本表 §1.4 | +8 |
| agent | app/server/src/agent/tools/todo-tool.ts | 6 action 执行点 | 修改 | 每操作成功后 queue.write(`todo:{itemId}`, 已渲染行)；delete → 「已删除」行 | MUST：写失败不阻断工具返回（catch 吞+warn） | 本表 §1.5 | +35 |
| agent | app/server/src/agent/tools/presence-tool.ts | set/clear | 修改 | 成功后 queue.write + fanoutStates | 同上 | 本表 §1.5 | +15 |
| squad | app/server/src/squad/squad-states-fanout.ts | fanoutStates | 新增 | 读 squad members[].sessionId + squadChatSessionId → 逐 session queue.write(key,value)；task 变化带 audience 过滤参数（leader ∪ owner ∪ blockers）；失败逐 session 隔离 | MUST：member 读取走既有 squadContext/store | 本表 §1.5 | +80 |
| squad | app/server/src/squad/panorama/tool/panorama-tool-actions.ts + http transition handler | transition 动作 | 修改 | 状态变更成功后 queue.write(`task:{taskId}`) + fanout（两入口同调 fanout helper） | MUST：done 也是状态变化照写 | 本表 §1.5 | +20 |
| agent | app/server/src/agent/session-state-machine.ts | markRunning/markIdle/markSuspended/markError | 修改 | emitStatus 处 queue.write(`member_state:{sessionId}`) + fanout（仅 squad session） | MUST：非 squad session 跳过 | 本表 §1.5 | +18 |
| llm_anthropic | app/plugins/builtins/llm_anthropic/protocol-encode.ts + protocol-encode-helpers.ts | encode + encodeTools + injectLastNonReminderCacheControl + isReminderBlock | 修改/删除 | 删 wire 层 reminder 过滤（历史块保留）+ 删避让扫描；bp#2 固定打最末 message 最末 block；**encodeTools 末位 tool 注入 cache_control（bp#T 新增，老板 20:34）** | MUST：bp#1（system 尾）不动；wire body 三断点齐（system/tools/messages）；MUST NOT：isSystemReminder 字段本身保留（前端契约） | 本表 §1.3 | -60/+15 |
| 测试 | __tests__（mapper/injector/queue/todo-tool/presence-tool/encode 各面） | describe 新增 | 修改 | session_states mapper 输出等价 / queue 有序+去重+锁序 / injector 双模式（full 动态半+置 false；incremental drain 按序+清）/ summary 触发 / fan-out audience / encode 历史块保留+bp2 落位 / 4 provider 退役回归（旧 reminder 面断言删） | MUST：全绿 + tsc -b 0 error | — | +200 |

## 4. 影响面评估

- **跨模块**：agent（queue+RunState+ingest 管线+run-react-loop+工具/状态机接线）/ rocky_context（session_states mapper 新增+injector 双模式+5 provider 退役+squad_agents_status 拆分）/ squad（panorama+fanout）/ llm_anthropic（encode）。依赖方向单向：tools/squad → queue ← injector；mapper 只读 config；无循环。
- **行为变更**：①静态半（env/workspace/盘路径）从 reminder 每轮重发 → system prompt 一次性进缓存段（~700c/轮节省+缓存读）②run 内第 2 轮起动态项从全量 → 增量（~3500c/轮→ 30-45 tok/轮）③历史 reminder 块进 wire 不再 drop（§1.3 cache 账）④time/静态三件 provider 出链（输出内容等价，位置变化）⑤成员名单去重（原 reminder 与 system prompt team_roster 双份 → 单份）。
- **风险点**：①system prompt 段新增 → 全量 prompt 字节变化 → 升级后首个请求全量 cache_creation 一次（一次性成本，之后稳定命中）；②encode 删 drop 后历史块累积——compact/summary 天然吸收；③fan-out 写 19 个 session 文件（低频，逐个原子写，可接受）；④queue 写失败静默（统计类容错语义，同 token-subscriber 先例）；⑤provider 退役触碰 plugin.json 注册表——注册变更与文件删除必须同 commit（加载失败=链断）。
- **验证**：UT 必须（7 面：mapper 输出等价/queue 有序去重锁序/injector 双模式/summary 触发/fan-out audience/encode/退役回归）；AT 豁免（纯 server 内部行为，无 API 形状变化）；ET 豁免（前端隐藏逻辑不变）。老板验收走真实对话 langfuse trace 对比（轮 2+ 非缓存 input 降幅）。
- **specs 同步**（doc-modifier 收尾）：system_reminder.md（双模式+queue 开放通道契约+skill 未来用例锚点）/ cache_control.md §3.2/§3.3（避让+drop 删除）/ squad_reminder_providers.md（静态半迁移+动态半保留）/ todo_tools.md §6 / system_prompt.md（session_states 段）。

## 5. 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
