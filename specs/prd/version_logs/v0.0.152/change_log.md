# v0.0.152 — squad 支持 effort + 审批模式（v0.0.148 能力补齐到 studio）

> 把 v0.0.148 交付的两个 session 级能力（effort 推理强度 + 审批模式/绿灯）从 playground 补齐到 studio（squad leader/mate 单聊）；顺带修复 studio 单聊缺失 need_approval 审批卡导致的 run 悬挂缺陷。
> **本 PRD 不重定义任何产品语义**——effort 4 档 / 审批模式 2 档 / always 持久化 / 绿灯安全边界，全部原样引用 `specs/prd/version_logs/v0.0.148/change_log.md` + `specs/prd/overall/10-tool-permission.md §10.4/§10.7`。本版只做「UI 落点从 playground 扩到 studio 单聊」+「补渲染审批卡」两件事。
> 概念权威源：`specs/ui/components/chat-page/{component-input-effort-picker,component-input-approval-mode-picker,component-pending-approval-card}.md`（组件契约，playground 版，本版直接复用不改）+ `specs/ui/components/studio-page/{member-chat-page,squad-chat-page}.md`（studio 页面契约）+ `specs/tech/agent/tools/[P0]tool_permission.md`（策略/审批/绿灯机制）+ `specs/tech/squad/[P1]session_config_studio.md`（session→SessionConfig chokepoint，已天然连通）+ `specs/tech/agent/tools/[P0]tool_policy.md`（studio-squad/leader/mate 工具 bound）。
> 无设计稿 → 视觉保真度门禁跳过（复用既有组件视觉基线，非新增视觉设计）。

## 0. 背景与动机

- **能力已连通，产品未覆盖**：squad leader/mate 各有自己的普通 session record（`bizType=studio`，`role=leader|mate`），复用与 playground 同一条 `buildSessionConfigFromDeps` chokepoint（`bootstrap.ts:624-625` 不分 scope 读 `session.effort/approvalMode`）+ 同一 `ToolExecutionEngine`/`ApprovalManager` 单例。v0.0.148 只在 playground UI（`section-chat-detail.tsx`）挂了两个 picker，studio 侧从未调用 `PUT /session/:id` 写这两个字段，恒为缺省（`effort='default'`、`approvalMode='normal'`）——**运行时管道天然连通，纯粹缺 UI 入口**，产品能力未覆盖 squad。
- **叠加实洞（本版必修，非单纯能力扩展）**：`studio-leader`/`studio-mate` 工具 bound 含 `bash`（`[P0]tool_policy.md` studio-leader=19/studio-mate=19，含 bash），bash 挂了策略层 `ssh-read`(deny)/`rm-wildcard`(ask) 两条策略（`[P0]tool_permission.md §10.2`）。squad agent（leader/mate）触发 `rm-wildcard` 类 ask 时，引擎按 `[P0]tool_permission.md §4` 悬挂 session（suspended）等审批卡回填——但 `section-member-chat.tsx` 现状**只挂了提问卡（question card），没有挂审批卡（approval card）**（`squad-chat-page.md`/`member-chat-page.md` 均未声明 `component-pending-approval-card` 挂载点）。结果：**squad agent 一旦触发 bash ask，run 悬挂无出口**——用户在 studio 单聊界面看不到任何卡片、点不了任何按钮，会话卡死。这是本版本的强制修复项，不因「无设计稿」或「只是补齐」而降低优先级。

本版三件事：① effort picker 落 studio 单聊 input-bar；② 审批模式 picker 落 studio 单聊 input-bar；③ studio 单聊补渲染审批卡（修复上述悬挂缺陷，逻辑上是①②的前提——没有审批卡，绿灯以外的 ask 永远卡死，产品能力不完整）。

## 1. 已确认决策（用户裁决，直接引用不再讨论）

**配置落点 = session 级复用**：直接复用 v0.0.148 的 session 持久化字段（`session.effort` / `session.approvalMode` / `session.alwaysApprovedKeys`），**server 端注入链路零改**（`bootstrap.ts:624-625` 已不分 scope 读 session 字段）。前端只需在 studio 单聊 input-bar 挂 `InputEffortPicker` + `InputApprovalModePicker`，调用**既有** `updateSession(sid, {...})`（`chat-api.ts` 已含 effort/approvalMode 字段，`PUT /session/:id`）。不加 member/squad schema 字段、不加 squad 级默认——leader session 与 mate session 的 effort/approvalMode 各自独立持久化，与 playground session 完全同构。

## 2. 功能 A：studio 单聊 effort picker

### 2.1 产品语义

**与 v0.0.148 §1.1 完全一致**（4 档：默认/低/高/超高，wire 值同表），本节不重复。唯一差异是挂载位置从 playground `section-chat-detail.tsx` 扩到 studio `section-member-chat.tsx`（leader + mate 两类单聊）。

### 2.2 UI 落点

`member-chat-page`（`section-member-chat.tsx`）input-bar 现状（`member-chat-page.md` v2.5）只有 `[InputModelPicker][ChatComposer][stop][send]`。本版对齐 playground v0.0.148 的顺序，在 InputModelPicker 左侧插入 effort picker：

```
┌──────────────────────────────────────────┐
│   ChatComposer / textarea（上段）          │
├──────────────────────────────────────────┤
│ [审批模式][effort][模型选择][停止][发送]    │  ← 两新 picker 插入模型选择左侧
└──────────────────────────────────────────┘
```

- **组件复用，不新建**：直接挂载既有 `component-input-effort-picker`（`app/web/src/components/chat-page/component-input-effort-picker.tsx`），props 契约不变（`effort` / `disabled` / `onChange`）。**本版不建新组件 spec**——playground 版契约已是权威源，studio 只是新增一个挂载点。
- **数据源**：`useStudioChatChrome(sessionId)` 已查得 chrome（`member-chat-page.md` v2.6），或直接从 `useSessionRunState` 引擎持有的 session 快照读 `effort`；`onChange` 调 `updateSession(sessionId, { effort: level })`。
- **disabled 语义同 playground**：`sessionRunning` 时 trigger disabled 但仍可见。
- **leader/mate 两类单聊共用同一挂载逻辑**（`section-member-chat.tsx` 对 leader/mate 无渲染分支差异，同一组件树）。

## 3. 功能 B：studio 单聊审批模式 picker

### 3.1 产品语义

**与 v0.0.148 §2.1/§2.2 完全一致**（normal/greenlight 2 档；绿灯只动审批层，deny 路径 + 执行层沙箱保留），本节不重复。

### 3.2 UI 落点

同上 input-bar，`component-input-approval-mode-picker` 挂在最左位（effort picker 左侧）：`onChange` 调 `updateSession(sessionId, { approvalMode: mode })`。**本版不建新组件 spec**，复用 playground 版契约。

## 4. 功能 C：studio 单聊补渲染审批卡（缺陷修复，MANDATORY）

### 4.1 现状缺陷

`section-member-chat.tsx` 只挂 `component-pending-question-card`（提问卡），未挂 `component-pending-approval-card`（审批卡）。`[P0]tool_permission.md §4` 的 ask 分支悬挂 session 后，playground 靠 `section-chat-detail.tsx` 的 `subState` 分流（`need_approval`→审批卡 / `need_feedback`→提问卡）挂载对应卡片；studio 单聊没有这套分流，`need_approval` 悬挂在 studio 侧**无卡可渲染**，用户唯一能做的是绕过卡片直接发消息（`component-pending-approval-card.md §状态/交互 3` c 路径），但这不是产品设计的正常出口——normal 模式下的用户体验是「卡死」。

### 4.2 修复方案

镜像 playground `section-chat-detail.tsx` 挂载方式（`component-pending-approval-card.md §复用关系`）：`section-member-chat.tsx` 在提问卡挂载点加 `subState` 分流——`need_approval` → `ComponentPendingApprovalCard`，`need_feedback` → 保留原提问卡。组件本身零改（直接复用 playground 组件+props 契约），只是 studio 侧补一个挂载路径。

### 4.3 产品价值

- **绿灯模式下无感**：`approvalMode='greenlight'` 时审批层短路，ask 从不悬挂，审批卡根本不 mount——绿灯用户体感不到这个修复（符合 v0.0.148 §2.2「绿灯模式下卡片根本不渲染」的既有语义）。
- **normal 模式（缺省）下是刚需**：squad leader/mate 缺省 `approvalMode='normal'`，只要 agent 触发 `rm-wildcard` 类 ask，此修复是 studio 侧唯一的正常出口。没有这个修复，功能 A/B 交付了 approvalMode 选择器也无意义——用户切回 normal 后照样卡死。

## 5. 群聊（SquadChat）界面裁决：不放选择器

### 5.1 结论

**只在 member 单聊（leader/mate）落两个 picker，squad 群聊（`squad-chat-page.md`/`section-squad-chat.tsx`）不放。**

### 5.2 理由（对 req.md 开放点的产品视角确认，并纠正一处表述）

- **纠正**：req.md 原表述「群聊 session 本身不发 LLM 请求」不准确——SquadChat 是哑路由分拣器，但仍会跑 agent loop 发 LLM 请求做路由决策（调 `send_message` 分派到 leader/mate，输出 `<EOS>` 收尾），只是**不产出 final text、不执行工具（除 `send_message` 外）**。effort 技术上对这条 LLM 调用是能生效的。
- **approvalMode 在群聊语义空洞（决定性理由）**：`[P0]tool_policy.md` 明确 `studio-squad` bound = `['send_message']`，**不含 bash**——群聊 session 永远不会触发策略层 ask/deny（`checkPermission` 只挂在 bash 上）。放一个「审批模式」选择器在一个永远不会弹审批卡的界面里，用户点了绿灯/普通也观察不到任何行为差异，是纯噪音 UI。
- **effort 放了也不对称、认知负担大于收益**：即便 effort 单独对群聊路由 LLM 调用生效，v0.0.148 两个 picker 在设计上是**成对出现**的固定搭档（`_overview.md §4.11b` 契约，紧邻布局）。只放 effort、不放 approvalMode 会造成不对称——用户会疑惑「群聊能调推理强度，为什么审批模式没有」，增加认知负担。且群聊是纯路由分拣任务（决定转发给谁），复杂度低，不构成需要用户手动调推理强度的场景。
- **与既有工具边界一致**：`[P0]tool_policy.md` 已经用 bound 数量（squad=1 vs leader/mate=19）明确区分了「路由器」与「真正干活的 agent」这两类角色。产品设计延续这个边界——两个新能力只服务「会执行危险操作、需要用户把关」的 leader/mate，不下沉到路由器。

### 5.3 范围声明

squad 群聊 input-bar 保持现状（`[InputModelPicker][ChatComposer][send]`），不新增任何 picker；**UC-8（见 §7）显式验证此边界**，防止未来误加。

## 6. Session 字段（零变更，纯引用）

不新增/修改任何 schema 字段。直接复用 v0.0.148 已落地的 3 个 session 持久化字段（`effort`/`approvalMode`/`alwaysApprovedKeys`，见 `change_log.md v0.0.148 §3`）与既有 `PUT /session/:id`（`UpdateSessionBody`）。studio leader/mate session 与 playground session 是同一张表、同一套字段——本版本零 API 契约变更。

## 7. 关键用户路径（MANDATORY — 测试最低覆盖要求）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| **UC-1**（effort 设置+持久化） | 打开 studio leader（或 mate）单聊 → input-bar 点 effort picker → 选「高」→ 发消息触发 LLM 调用 | session.effort 持久化为 `'high'`（PUT /session/:id）；LLM 请求 wire body 含 `output_config.effort:'high'`；刷新页面/重启 app 回同 session 仍显示「高」 |
| **UC-2**（绿灯自动放行） | studio 单聊切绿灯（approvalMode picker 选 greenlight）→ agent 触发 `rm *`（策略 ask） | session.approvalMode 持久化为 `'greenlight'`；命令直接执行，**不弹审批卡**，run 不悬挂，continues 正常续跑 |
| **UC-3**（normal 模式审批卡出现+批准，核心缺陷修复验证） | studio 单聊（approvalMode 缺省 normal）→ agent 触发 `rm *` | session 悬挂（suspended）→ 单聊界面渲染审批卡（`pending-approval-{toolCallId}`，展示命令 + 拦截原因）→ 用户点「同意」→ 命令执行 → 卡片 unmount → run 续跑 |
| **UC-4**（审批卡拒绝分支） | 同 UC-3 场景 → 用户点「拒绝」 | 占位编辑为 isError「用户拒绝执行」回填 LLM，run 继续（命令未执行），卡片 unmount |
| **UC-5**（绿灯不绕 deny，回归） | studio 单聊绿灯模式 → agent 触发 `ls ~/.ssh`（策略 deny） | 策略层仍 deny，命令不执行，LLM 收拒绝理由（绿灯只动审批层，deny 路径不受影响，同 v0.0.148 UC-C2） |
| **UC-6**（跨重启 + 跨 session 隔离持久化） | leader session A 设 effort=`max` + approvalMode=`greenlight` → 重启 app → 回同 session A；再切到 mate session B | session A 两字段仍为 `max`/`greenlight`；session B 各自独立（仍为缺省 `default`/`normal`，未被 A 影响） |
| **UC-7**（悬挂修复回归，等价 UC-3 的负向验证） | studio 单聊 normal 模式 → agent 触发 `rm-wildcard` ask 前后对比 | run **不再**无出口悬挂——审批卡必然 mount（对齐修复前 studio 侧「无卡可批、绿灯又无处开」的缺陷描述，验证已修复） |
| **UC-8**（squad 群聊无 picker，边界确认） | 打开 squad 群聊界面（squadChat 树节点） | input-bar **不渲染** effort/approval-mode picker（`chat-effort-picker`/`chat-approval-mode-picker` 均不存在于该页面 DOM），群聊 input-bar 维持 `[InputModelPicker][ChatComposer][send]` 现状 |

## 8. 范围与非目标

- ✅ studio leader/mate 单聊 input-bar 加 effort picker（复用 `component-input-effort-picker`，无需新建组件 spec）。
- ✅ studio leader/mate 单聊 input-bar 加审批模式 picker（复用 `component-input-approval-mode-picker`）。
- ✅ studio 单聊补渲染审批卡（`component-pending-approval-card`，修复 need_approval 悬挂无出口缺陷）——**MANDATORY，不因「无设计稿」降级**。
- ✅ 两个 picker 选中值走既有 `PUT /session/:id`，跨重启持久化、per-session 隔离（复用 v0.0.148 机制，零后端改动）。
- ❌ 不加 member/squad schema 字段、不加 squad 级默认（session 级复用足够）。
- ❌ squad 群聊（SquadChat）界面**不放**任何一个 picker（§5 裁决 + UC-8 显式验证）。
- ❌ 不扩大 bash 审批策略范围（仍仅 `ssh-read`/`rm-wildcard`，继承 v0.0.122/v0.0.148 现状）。
- ❌ 不改 `checkPermission`/`ApprovalManager`/`SecureBashEngine` 任何后端逻辑（本版纯 studio 前端 UI 补齐 + 挂载点补齐，server 端零改动——`session-config.ts`/`bootstrap.ts`/`engine.ts` 均已在 v0.0.148 就绪）。
- ❌ 不新建 UI 组件 spec（两个 picker 与审批卡均复用 playground 已有契约，不重定义）。
- ❌ 无设计稿 → 视觉保真度比对门禁跳过（复用既有组件视觉基线）。

## 9. E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-E2E-1 | 打开 studio leader 单聊 → input-bar 见 `[审批模式][effort][模型选择][停止][发送]`（默认 effort=「默认」、approvalMode=「普通」）→ 点 effort picker 选「高」→ 刷新页面 | 两 picker 渲染在模型选择左侧，位置/尺寸对齐 playground 契约（21px trigger + 脱流菜单不位移）；选中后 GET /session 反映 `effort:'high'`；刷新后 trigger 仍显「高」 |
| UC-E2E-2 | studio mate 单聊 → approval-mode picker 切绿灯 → 触发 agent 执行 `rm *`（真实 bash ask） | rm 直接执行不弹卡（DOM 无 `pending-approval-*` 元素出现）；session.approvalMode 持久化为 greenlight |
| UC-E2E-3（核心缺陷回归） | studio leader 单聊（normal 缺省）→ 触发 agent 执行 `rm *` | DOM 出现 `pending-approval-{toolCallId}` 审批卡（展示 `approval-command`/`approval-reason`）→ 点 `approval-allow-btn` → 卡片 unmount，命令执行结果回对话 |
| UC-E2E-4 | 打开 squad 群聊（squadChat 节点） | input-bar DOM 中 `chat-effort-picker`/`chat-approval-mode-picker` 均不存在（边界确认） |

## 10. spec 待同步清单（doc-modifier 阶段处理，本 PRD 不改 spec）

| spec 文件 | 待同步内容 | 处理阶段 |
|---|---|---|
| `specs/ui/components/studio-page/member-chat-page.md` | input-bar 布局从 3 控件（InputModelPicker/stop/send）扩到 5 控件（approval-mode/effort/InputModelPicker/stop/send）；新增审批卡挂载点声明（`subState` 分流，同 playground `section-chat-detail.tsx`） | 架构期落 change_plan，doc-modifier 阶段 5 |
| `specs/ui/components/studio-page/squad-chat-page.md` | 显式补一句「不挂两个 picker（studio-squad tool bound 无 bash，审批语义空洞）」，防止未来误加 | doc-modifier 阶段 5 |
| `specs/ui/components/chat-page/component-pending-approval-card.md §复用关系` | 补一行 studio 单聊挂载点（`section-member-chat`），与 `section-chat-detail` 并列 | doc-modifier 阶段 5 |
| `specs/prd/overall/08-squad-studio.md` | 新增 §8.10 引用本版本，与 §8.9（心跳/presence）同级承接表追加一行 | doc-modifier 阶段 5 |
| `specs/prd/overall/10-tool-permission.md §10.7` | 补一句「studio leader/mate 单聊已接入绿灯 picker（v0.0.152）」 | doc-modifier 阶段 5 |

> 本 PRD 引用的全部概念（effort 4 档 / approvalMode 2 档 / always 持久化 / 审批卡三按钮 / SessionConfig chokepoint / tool_policy bound）均已在 `specs/prd/version_logs/v0.0.148/` + `specs/prd/overall/10-tool-permission.md` + `specs/tech/` 中定义，本版本零发明新概念，只做「已有能力挂载点扩展」+「已有组件补渲染」。
