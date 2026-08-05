# v0.0.144 — 运行状态气泡增加「重试中」外显

> 类型：用户可感知的 UI 变化（PRD 覆盖本项）
> 范围：仅需求 3。需求 1（分层失败日志）、需求 2（llm_request config 生效）属纯技术层，**不在本 PRD**（无用户可感知行为/界面变化，走 change_plan 直达）。
> 前置概念权威源（已读对齐，不发明新组件）：
> - `specs/ui/components/chat-page/_overview.md` §4.10 `ComponentLoadingStatus`（testid `chat-run-spinner`，4 态 thinking/answering/tool_calling/tool_executing，`runActive||sessionRunning` 挂载、`run_end` 消失）
> - `specs/ui/components/chat-page/_overview.md` §4.13 `component-run-finish`（`sessionRunning===false` 渲染；error 态 = ⚠️ icon + `displayReason` + hover tooltip 显 `detail`）——**本版本不改**，仅衔接说明
> - `specs/api/overall/02-llm-chat.md` §SSE + `specs/api/version_logs/v0.0.25/change_log.md` §1.4（`llm_attempt` SSE 现有字段：`category`/`providerId`/`modelId`/`keyRef`/`attempt`/`action`；**无 `maxAttempts`、无 error message 文本**；前端目前零消费）

## 1. 背景

LLM 请求出错时，Caller 会按配置自动重试 / 切换凭证 / 切换备用模型（`action` = RETRY / ROTATE_KEY / FALLBACK），耗尽后最终失败（`action` = FAIL）。这段重试过程**目前对用户完全不可见**：运行气泡（`chat-run-spinner`）只显「思考中…」等常规运行态，用户看不出「正在重试、第几次、什么错误」。

最糟糕的体感是 TTFB（首字节）超时——每次重试要干等约 45s，3 次连续超时≈135s 的静默，用户完全无法判断是「AI 在慢慢想」还是「卡死了」，只能盲等或误以为故障而手动中断。

后端已具备 `llm_attempt` SSE 事件（每次 decide 产 action 时实时发一次，走同一 SSE 流），但前端从不消费。本版本让运行气泡实时消费该事件，把重试进度外显给用户。

## 2. 功能需求

### 2.1 运行气泡「重试中」态 [v0.0.144]

**描述**：运行气泡（`ComponentLoadingStatus` / `chat-run-spinner`）在 LLM 出错重试期间，从常规运行态（思考中…等）切换到「重试中 {当前次}/{总次}」态，并在文案后附一个惊叹号（！）图标；hover 惊叹号显示本次错误的用户可读 message。让用户在长静默的重试窗口里始终知道「系统在重试、进行到第几次、遇到什么错误」。

**优先级**：P0

**用户故事**：作为对话区用户，当 AI 请求出错并自动重试时，我希望运行气泡明确告诉我「正在重试（第几次 / 共几次）」并能看到错误原因，这样我在等待时不会误以为卡死，也能判断是否需要中断或去检查配置（如 API Key / 限流）。

**触发（进入重试态）**：

- 前端消费 SSE `llm_attempt` 事件。当 `action` 属**重试类动作**（`RETRY` / `ROTATE_KEY` / `FALLBACK`）时，气泡从常规运行态切换到「重试中」态。
- `action = FAIL`（整链耗尽、最终失败）**不进入重试态**——FAIL 无「下一次」可等，气泡不切「重试中」，维持当前显示直至 `run_end`，由 run-finish 交棒呈现最终错误（见退出规则）。

**显示（重试态）**：

- **文案**：「重试中 {attempt}/{maxAttempts}」——分子 = 当前进行到第几次尝试（来自事件 `attempt` 字段），分母 = 该请求允许的最大尝试次数（来自新增字段 `maxAttempts`）。文案读感应为「第 N 次 / 共 M 次」，让用户对进度有确定预期（尤其超时场景知道「还剩几次」）。
  - 分子/分母的精确语义（`attempt` 是「刚失败的第几次」还是「即将开始的第几次」）由架构统一定义，保证显示读起来自然、连续递增、不出现 `4/3` 越界。
- **惊叹号（！）图标**：文案后紧跟一个警告性惊叹号图标，作为「本次是错误重试而非正常运行」的视觉信号，并作为 hover 展开错误详情的触发点。
- **hover 显示错误 message**：hover（及键盘 focus / 触屏兜底）惊叹号 → 显示本次 attempt 的错误 message（用户可读文案，来自新增的 message 字段）。message 承载「为什么在重试」（如「模型限流」「认证失败，请检查 API Key」「首字节响应超时」）。
- 其余视觉（胶囊形态、spinner 旋转、位置=贴消息流尾部）沿用 §4.10 现状，重试态是该气泡的**新增显示态**，不新建独立组件。

**多次重试的更新**：run 未停、连续多次重试时，气泡随每个新到的 `llm_attempt` 事件更新分子（1/3 → 2/3 → 3/3）和 hover message（反映最近一次错误）。气泡始终只有一个，不堆叠。

**退出（重试态解除）**：

- **重试后成功恢复**：某次重试成功、run 继续（后续正常收到 `message_*` / phase 事件流）→ 气泡从「重试中」态**回到常规运行态**（思考中 / 生成回答…），惊叹号消失。即重试态是临时叠加态，被后续正常运行事件覆盖。
- **run 停止（最终失败或中断）**：收到 `run_end` → 气泡整体消失（沿用 §4.10 现状，不留 DOM）→ 整个 run 的错误由**现有** `component-run-finish` 呈现（⚠️ + `displayReason` + hover tooltip 显 `detail`，§4.13，**本版本不改其逻辑**）。重试态到 run-finish 是自然交棒：气泡消失后 `sessionRunning===false`，run-finish 满足渲染前提即出现。

**约束**：

- **不改 `component-run-finish` 现有 error 呈现逻辑**（§4.13）——run 最终失败的 error 展示保持不变，本版本只做「重试中」气泡态 + 闭环衔接说明。
- **不新建组件概念**——重试态是 `ComponentLoadingStatus` 的新增显示态，复用现有 `chat-run-spinner` 挂载 / 消失时机（`runActive||sessionRunning` 挂载、`run_end` 消失）。
- **不改变主流程收尾契约**——气泡消费 `llm_attempt` 仅影响自身显示，不阻塞、不改写 `message_*` / `run_end` / error 事件流。旧行为（不消费该事件时）零回归。
- **布局稳定性（MANDATORY）**：重试态 ↔ 常规态切换、惊叹号出现/消失，绝不导致消息流或相邻元素位移（惊叹号预留固定空间或绝对定位；文案宽度变化在气泡内部吸收）。
- **分母真实性依赖需求 2**：`maxAttempts` 分母 = 生效的 `retry.max_attempts`。需求 2 修复 config 装配断链前，运行时恒为默认 3；修好后分母才反映用户 PUT 的配置。本项显示逻辑不依赖具体数值，但分母的**真实性**由需求 2 保证（同版本一并修复）。

## 3. 关键用户路径（MANDATORY — 测试最低覆盖要求）

| 路径 | 描述 | 覆盖 |
|------|------|------|
| **A（重试后成功）** | 发消息 → LLM 首次失败可重试（`llm_attempt` action=RETRY，attempt=1）→ 气泡显「重试中 1/3」+ ！ → 重试成功、run 继续 → 气泡回常规态（思考中/生成回答…）→ 正常收到回复 | AT：消费 `llm_attempt` 后 run 成功收尾（message + run_end 正常）；ET：气泡出现「重试中」文案 + ！ → 恢复常规态 → 正常回复 |
| **B（耗尽重试失败）** | 发消息 → LLM 连续失败耗尽重试 → 气泡依次显「重试中 1/3」「重试中 2/3」「重试中 3/3」→ 最终 action=FAIL、`run_end`（stopReason=error）→ 气泡消失 → `component-run-finish` 显示 error（⚠️ + displayReason） | AT：run 以 stopReason=error 收尾、error payload 含 category/displayReason；ET：气泡历经重试态 → 消失 → run-finish error 呈现 |
| **C（hover 看错误）** | 处于「重试中」态 → hover 惊叹号（！）→ 显示本次错误的 message tooltip（用户可读，如「模型限流」/「首字节超时」） | ET：hover `!` → tooltip 内容非空、含错误可读文案 |

> 路径 A/B 是「重试→恢复」和「重试→失败」两条主链路，覆盖气泡进入、更新、两种退出（回常规态 / 交棒 run-finish）。路径 C 覆盖 hover 详情交互。测试形态（AT/ET 具体 case + record/replay）由 test-plan 与 designer 按版本白名单裁定；重试类 LLM 不确定性场景符合 AT 入选标准。

## 4. 对齐检查（PRD ↔ 现有 ui/api spec）

**已对齐（引用现有概念，无矛盾）**：

- **组件**：`ComponentLoadingStatus`（`chat-run-spinner`，§4.10）——重试态是其新增显示态，复用现有挂载/消失时机，不新建组件。
- **组件**：`component-run-finish`（§4.13）——最终错误呈现沿用现状，本版本不改，仅做交棒衔接说明。
- **SSE 事件**：`llm_attempt`（API §1.4 v0.0.25）——已 emit、走同 SSE 流，前端从零消费改为消费，无需新建 SSE 通道。
- **action 语义**：RETRY / ROTATE_KEY / FALLBACK = 重试类（进重试态）；FAIL = 终态（不进重试态，交 run-finish）——与 API §1.4「caller 语义」一致。

**待架构解决的契约缺口（PRD 描述产品需要什么，不定技术实现）**：

- **G1 — `llm_attempt` 事件补 `maxAttempts` 字段**：作为「重试中 x/x」的分母（x/**maxAttempts**）。当前事件无此字段。需在 API spec（`02-llm-chat.md` + version_log）+ 事件类型（tech spec `LlmAttemptEvent`）补充。
- **G2 — `llm_attempt` 事件补 error message 文本**：hover 惊叹号展示的用户可读错误文案。结构化（复用 `displayReason` 语义）或直接文本形态由架构决定。当前事件仅有 `category`（枚举），无可读 message。
- **G3 — `ComponentLoadingStatus` 新增「重试中」显示态 + 相关 testid**：这是 UI 契约变更，需**先落 `_overview.md` §4.10**（新增显示态描述 + 新 testid，如 `chat-run-spinner-retry` / 惊叹号 hover 触发点 testid，供 ET DOM 断言 + tooltip 内容锚点），再进编码。testid 命名由架构/coder 按 `_conventions.md` 定。
- **G4 — 分子/分母精确语义**：`attempt` 显示为「第几次」的口径（刚失败 vs 即将开始）+ 保证不越界（不出现 `4/3`），由架构统一定义。
- **G5（依赖需求 2）**：`maxAttempts` 真实性依赖需求 2 修复 config 装配断链——同版本一并修复，PRD 仅指明依赖关系。

## 5. 回归面（不能回归的既有行为）

| 既有行为 | 说明 |
|---------|------|
| 常规运行气泡 4 态（thinking/answering/tool_calling/tool_executing）正常显示/切换 | 重试态是叠加/覆盖态，不删改现有 4 态；无 `llm_attempt` 时行为完全不变 |
| 气泡 `run_end` 后消失、run-finish 按 `sessionRunning===false` 呈现最终态 | 重试态不改变消失时机与 run-finish 渲染前提 |
| `component-run-finish` 的 error 呈现（⚠️+displayReason+hover detail） | 本版本不改，交棒衔接不动其逻辑 |
| 主流程收尾契约（message_* / run_end / error 事件）不受气泡消费 `llm_attempt` 影响 | 消费仅影响气泡显示，不阻塞主流程 |
| 布局稳定性（消息流 / 输入区不因气泡态切换位移） | 重试态切换、惊叹号出现/消失零位移 |
