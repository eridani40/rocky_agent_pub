# v0.0.116 PRD — 心跳机制 squad 级升级 + 团队成员状态记录（presence）

> version: 1.0 · 引入版本 v0.0.116 · 2026-07-11
> 承载本版本两大块产品定义：① 心跳机制从 per-member 升级为 squad 级统一调度（AutoWork tab 内配置）；② 团队成员状态记录 presence（成员标记「当前在做的事」+ leader 团队当前状态段）。
> 概念权威源（本 PRD 引用皆对齐，不发明新概念）：`specs/tech/squad/[P1]data_model.md §1.1a/§1.2b`、`specs/tech/scheduling/[P1]heartbeat_handler.md §0`、`specs/tech/squad/[P1]squad_tools.md §6a`、`specs/tech/squad/[P1]squad_reminder_providers.md §4.6`、`specs/api/overall/11a-squad-endpoints.md`、`specs/ui/components/studio-page/{heartbeat-config,budget-meter,squad-autonomy-toggle,component-autowork-tab,member-panel}.md`。
> overall 落点：`specs/prd/overall/08-squad-studio.md` §8.9（本版本追加章节）。

---

## 1. 背景与目标

v0.0.33.4 交付的自主性 infra 是 **per-member 心跳**：每个 deployed member 一份 `member.heartbeat`（各自 activeWindow + interval），一个 heartbeat job per member。用户实际使用中发现：

- **配置粒度太碎**：一个团队几十号人，逐个配心跳时段/间隔既繁琐又易漏。
- **缺团队级总控**：没有「整队自主工作」的一键总开关 + 预算护栏 + 统一工作时段。
- **成员状态不可见**：leader 无法一眼知道「谁正在忙什么」，难以调度。

本版本把心跳**上收到 squad 级**（一队一份配置，到点整队一次调度），并新增**成员状态记录（presence）**让 leader 感知团队实时状态。

**目标**：
1. AutoWork tab 成为团队自主工作的**统一控制面**：总开关 + 预算 + 工作时段 + 心跳范围 + 心跳间隔，一处配全队。
2. 成员用轻量 `presence` 工具标记「当前在做的事」，leader system prompt 自动汇总活跃成员状态。
3. **废弃 per-member 心跳**（字段/端点/UI 全撤），不做兼容迁移。

---

## 2. 功能需求 A — 心跳机制 squad 级升级 [v0.0.116]

**优先级**：P1
**用户故事**：作为团队老板（用户），我希望在一个面板里为整个团队开关自主工作、设预算上限、划工作时段、选唤醒范围和心跳间隔，让符合条件的成员在时段内按节奏主动干活，以便团队 7×24 自主推进而我只需宏观把控。

### 2.1 落点与总体交互

心跳配置全部落在 **Squad 面板「自动工作」tab**（`component-autowork-tab`），tab 内垂直堆叠四块（`component-autowork-tab.md`）：

1. **总开关**（`squad-autonomy-toggle`）
2. **心跳配置**（`heartbeat-config` — 本版本新增到本 tab，从 member-panel 迁入：间隔 + 工作时段 + 范围）
3. **预算**（`budget-meter` — 本版本加配置交互）
4. **自动工作历史**（`auto-work-history` — 沿用）

写入统一走 `PATCH /squad/:id`（合并字段），后端写后 `scheduler.reloadSquad()` 实时刷新 squad heartbeat job。

### 2.2 子功能

#### 2.2a 总开关（enableHeartBeat）

- **默认关闭**（新建 squad 时 `enableHeartBeat=false`）。
- 关闭态：**下面的心跳/预算/时段/范围配置全部收起或禁用**（`heartbeat-config` 显示「自主性总开关已关，配置保存但暂不生效」提示，不阻断保存）。
- 开启前展示提示文案：**「开启自动工作（可能会带来较大 token 消耗）」**。
- 开启态：scheduler 心跳调度生效；关闭态：下一 tick（≤1s）整体跳过心跳触发。**群聊/单聊 reactive 对话不受总开关影响**（reactive 不走 scheduler gate）。

#### 2.2b 预算（budget，switch off/on）

- **switch off = 不限量**（写 `budget=null`）：gate 放行，仪表显示「无预算限制」态（consumed 仍统计展示）。
- **switch on = 限量**：展开总量输入 `budget-limit-input`，**默认 1,000,000 token/天**（`budget={limit, window:'daily', scope:'team'}`）。
- **消耗口径**：只记录**团队总 token 消耗/天**（`Σ team session_usage`，reactive + proactive 都计入 consumed）；**不新增调度分桶**（决策 4）。
- **超限行为**：当日团队总消耗 ≥ limit → 当日心跳调度停止（proactive 被跳过）；**reactive 对话仍正常响应**（consumption always-on，gate 仅拦 proactive）。次日 squad tz 0 点回血。

#### 2.2c 工作时间段（activeWindows，多段）

- 可**添加多个工作时间段**（`heartbeat-window-add`），每段 start/end（`HH:mm` 24h）。
- **约束**：段间不重叠；单段不跨 0 点（`start < end` 同日）。前端可先提示，最终由后端 `400` 校验兜底。
- **空列表 = 全天可调度**（显示「未设时段 = 全天可调度」提示 `heartbeat-windows-empty`）。
- activeWindows 跟随 `squad.timezone`（时区在管理 tab 改，不在本 section）。
- 交互：点「添加工作时间段」追加空段；每段带删除按钮（`heartbeat-window-{idx}-remove`）。

#### 2.2d 心跳范围（scope，off=全员 / on=白名单）

- **switch off = 全 member**（`scope.mode='all'`）：唤醒全部 deployed 成员（**含 leader**）。
- **switch on = 自定义白名单**（`scope.mode='whitelist'`）：展开成员勾选列表，勾选的成员进 `scope.memberIds` —— **只唤醒白名单内成员，后续新增成员不自动纳入**（提示「仅唤醒勾选成员，后续新增成员不自动纳入」）。
- **任何模式下 benched 成员都不唤醒**（调度层 filter）；SquadChat 无 member record 天然不在范围内。

#### 2.2e 心跳间隔（interval，单选）

- 四选一：**5 / 15 / 30 / 60 分钟**（`heartbeat-interval-{5|15|30|60}`），**默认 15 分钟**。
- 单选控件用 segmented chip（非原生 `<select>`）。

### 2.3 心跳触发机制（后端行为）

- **定时调度粒度 = squad 级**：一个 squad 一个 heartbeat job（`Job.id = heartbeat:<squadId>`）。到点整队一次调度。
- **gate 链**（队级 → 逐成员）：`killswitch(enableHeartBeat) → activeWindows(多段/空=全天) → budget(null=放行) → 逐成员 filter(scope ∩ deployed ∩ 非 busy) → deliverTo`。
  - 队级任一 gate 不通过 → 本轮整队 skip（不发心跳）。
  - 队级全通过 → 逐成员展开：非白名单跳过 / benched 跳过 / 无 session 跳过 / session busy 跳过；其余每个成员 `deliverTo` 固定心跳提示词。
- **固定心跳提示词**（写死，含 `<EOS>` 出口句，权威文案 `heartbeat_handler.md §0.1`）：

  ```
  这是团队自动工作的提醒。
  你可以检查现在属于你的任务、需求、目标等，或者之前被中断的工作。如果无需继续工作，则可以直接输出<EOS>并退出。
  ```

- **`<EOS>` 零机制改动**（决策 3，硬约束）：`<EOS>` 只作为提示词文案里的**软出口引导**，不扩展 stop token、不给 leader/mate 加 EOS 处理、不动 SquadChat 现有机制。成员被唤醒后有活干活、无活输出 `<EOS>` 后无工具调用 → 自然 `no_tool_call` 结束 run。

### 2.4 废弃：per-member 心跳

- **member 面板不再有心跳 section**（`member-panel.md` 心跳 section 移除）——用户不再在成员卡片里配心跳。
- 后端 per-member 调度全废弃：`member.heartbeat` 字段标 dead（保留 schema 避免历史 record 迁移风险，但代码停读写）；`PATCH /squad/:id/member/:mid/heartbeat` 端点删除。
- 旧 member 级 job 不再触发；旧 scheduler.json 的 per-member 分桶读取时忽略（不 migrate、不破坏性清理），保存时自然收敛为 squad 级单条。

### 2.5 E2E Use Cases — 心跳机制

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 配置生效 | 打开 squad → 自动工作 tab → 开总开关 → 选间隔 15min → 加工作时段 09:00–18:00 → 预算 switch on 填 1,000,000 → 范围 off（全员）→ 保存 | PATCH /squad heartbeatConfig+budget+enableHeartBeat 成功；重新 GET /squad 各字段回显与所配一致；scheduler 重建 squad job |
| UC-2 白名单范围 | 范围 switch 切 on → 勾选部分成员 → 保存 | scope.mode=whitelist + memberIds 含勾选成员；新增成员不自动进白名单 |
| UC-3 心跳触发干活 | 总开关开 + 时段内 + 预算未超 + 成员 deployed 非 busy → 到点 | 白名单内 deployed 成员收到固定心跳提示词；有活的成员开始干活 |
| UC-4 心跳自然结束 | 心跳唤醒无活可干的成员 | 成员输出 `<EOS>` 后无工具调用，run 自然结束（不特判 EOS token） |
| UC-5 预算拦截 | 当日团队总消耗 ≥ limit → 到点 | 心跳整队停发（proactive skip）；同时对该 squad 发 reactive 消息仍正常响应 |
| UC-6 时段拦截 | 当前时间在全部 activeWindows 之外 → 到点 | 不发心跳（skipped_window）；时段内则正常发 |
| UC-7 总开关关拦截 | 总开关关 → 到点 | 整队跳过心跳（skipped_killswitch）；下方配置收起 |
| UC-8 段校验 | 加两段重叠时段 或 单段 start≥end（跨 0 点）→ 保存 | 后端返 400 + error banner；配置不生效 |
| UC-9 废弃回归 | 打开成员管理面板 | 不再有心跳配置 section；旧 member 级调度不再触发 |

---

## 3. 功能需求 B — 团队成员状态记录（presence）[v0.0.116]

**优先级**：P1
**用户故事**：作为团队成员（leader/mate），我希望在接到任务或被唤醒后标记「我当前在做什么」，并在结束时清除，以便 leader 能一眼看到团队里谁正忙什么；作为 leader，我希望 system prompt 里有一段「团队当前状态」列出所有正在活跃工作的成员及其标记，以便更好地调度。

### 3.1 presence 标记（成员侧）

- **维护入口 = 独立 `presence` 工具**（不塞进 task 工具，决策 5）：
  - `presence(set, text)`：把自己的「当前正在做的事」标记为 `text`（自由文本），覆盖上一条。
  - `presence(clear)`：取消标记（置空，代表当前没在忙）。
- **每个成员只有一条**（set 即覆盖上一条 / clear 取消）。
- **只能写自己**：caller 只能写自己 session 对应 member 的 `currentWork`（`SessionConfig.memberId`），不带 memberId 参数（防越权改他人）。
- **谁可用**：leader / mate 均可用；SquadChat 不需要。
- **prompt 维护提醒**（决策 5）：leader/mate system prompt 加一句「被唤醒/接任务后先 `presence(set)` 标记，工作结束/无事时 `presence(clear)`」。

### 3.2 leader 团队当前状态段（leader 侧）

- leader system prompt 新增「团队当前状态」段（`squad_team_status` reminder provider，`squad_reminder_providers.md §4.6`）。
- **只展示 session 正在 running 的成员及其 presence 标记**（`member.currentWork`，可能为空）——「活跃用户」= session `state==='running'` 的成员（决策 5）；**睡着（idle/非 running）的成员不展示**。
- 产出格式（示意）：

  ```
  [squad:team-status] 团队当前状态（活跃成员）：
  - {memberName}（{role}）：{currentWork.text}   （currentWork=null 时显示「（未标记）」）
  ...
  （无 running 成员时：「当前无成员在活跃工作」）
  ```

- **每轮直接产出**（不做变化检测/去重）——running 态是运行时瞬时值、每轮可能变，交 dedup reducer 收敛。
- 该段仅 leader 产出；mate / SquadChat / subagent 不产出。

### 3.3 数据与展示

- `member.currentWork` 落 member record（`presence` 工具 read-modify-write 复用现有 member 写路径）。
- 无 presence 专用 HTTP 端点：写走 `presence` agent 工具，读走 `GET /squad/:id` 的 `SquadDetail.members[].currentWork` 回显（UI 若展示 team status 时用）。

### 3.4 E2E Use Cases — presence

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-10 set 标记 | 成员被唤醒/接任务 → 调 `presence(set, "正在写登录模块")` | 该成员 `member.currentWork.text = "正在写登录模块"`；GET /squad members[] 回显 |
| UC-11 leader 可见 | 成员 running 中且已 set → leader 触发一轮 | leader system prompt「团队当前状态」段列出该成员及其标记 |
| UC-12 clear 清除 | 成员工作结束 → 调 `presence(clear)` | `member.currentWork = null`；leader 段内该成员标记显示「（未标记）」（若仍 running）或不出现（若已 idle） |
| UC-13 睡着不展示 | 成员非 running（idle/睡着）→ leader 触发一轮 | 该成员不出现在 leader「团队当前状态」段（即便有历史 currentWork） |
| UC-14 越权防护 | 成员尝试写他人 currentWork | `presence` 工具只写自己 session 对应 member，无法改他人 |

---

## 4. 关键用户路径（MANDATORY — 测试最低覆盖）

> 每条路径 = 至少一个 API/E2E case。标注验证层。

| # | 路径 | 链路 | 验证层 |
|---|------|------|--------|
| P1 | **配置路径** | 开总开关 → 配间隔/时段/预算/白名单 → 保存 → `PATCH /squad` heartbeatConfig+budget+enableHeartBeat → GET 反映 → scheduler 热加载重建 squad job | API + E2E |
| P2 | **心跳触发路径** | 到点 → gate 链（killswitch→window→budget）通过 → 白名单内 deployed 非 busy 成员收到固定心跳提示词 → 有活干活 / 无活输出 `<EOS>` 自然结束 run | API |
| P3 | **预算拦截路径** | 当日团队总消耗超 limit → 心跳整队停发（skipped_budget）；同 squad reactive 消息不受影响仍响应 | API |
| P4 | **时段拦截路径** | 当前时间在 activeWindows 之外 → 不发心跳（skipped_window）；时段内正常发 | API |
| P5 | **presence 路径** | 成员被唤醒/接任务 → `presence(set)` → leader prompt「团队当前状态」段可见该成员标记 → 成员 `presence(clear)` → 段内标记为空；睡着（非 running）成员不出现在该段 | API + E2E |
| P6 | **废弃路径** | member 面板不再有心跳配置 section；旧 member 级调度不再触发 | E2E |

**路径验证层说明**：
- P2/P3/P4 依赖真实 LLM + scheduler 时序，走 **API 测试**（黑盒 curl + 真调度/工具直调）；触发时序可用 test-only 手段推进。
- P1/P5 配置面与 presence 既有 API 面（PATCH /squad、GET /squad members[].currentWork）也有 UI 面 → **API + E2E** 双层。
- P6 纯 UI（心跳 section 移除）→ **E2E**（member-panel 无 `heartbeat-config`）。

---

## 5. 范围边界

### IN SCOPE
- 心跳 per-member → squad 级统一调度（Job/gate/逐成员展开/固定提示词）。
- AutoWork tab 四块：总开关 + 心跳配置（间隔/时段/范围）+ 预算配置（switch off/on + 默认 1M）+ 历史。
- `presence` 独立工具（set/clear）+ leader team-status reminder 段。
- 废弃 per-member 心跳（字段 dead / 端点删除 / member-panel 心跳 section 移除）。

### OUT OF SCOPE（显式不做）
| 排除项 | 理由 |
|---|---|
| `<EOS>` / stop token 机制改动 | 决策 3：`<EOS>` 只进提示词文案，零机制改动 |
| 调度消耗单独分桶统计 | 决策 4：只记团队总消耗/天（现有口径） |
| 跨午夜工作时段（单段跨 0 点） | 约束：单段 start<end；跨午夜需用户拆两段（不跨 0 点约束下暂不支持跨午夜） |
| presence 专用 HTTP 读/写端点 | 写走工具、读走 SquadDetail.members[].currentWork 回显；本版本不新增专用端点 |
| SquadChat 心跳 | 决策 6：SquadChat 保持无心跳 |
| 旧 member.heartbeat 数据破坏性迁移 | runtime 不做破坏性清理；读取忽略 + 保存收敛 |

---

## 6. 设计决策（用户已确认 2026-07-11）

1. **心跳粒度 squad 级**：一队一份配置，废弃 per-member heartbeat（字段/端点/UI），删旧 member 调度信息。
2. **工作时间段**：squad 级 `activeWindows[]`，多段、段间不重叠、不跨 0 点，空 = 全天。
3. **`<EOS>` 零机制改动**：只写进心跳提示词文案，成员无工具调用自然结束 run。
4. **消耗统计**：只记团队总 token 消耗/天（现有口径），不单独记调度消耗。
5. **presence 自由文本**：独立小工具 set/clear；leader/mate prompt 加「被唤醒后先维护、结束时维护」；leader system prompt 加「团队当前状态」段（running session + 各自标记）。
6. **范围细节**：全 member 默认含 leader；benched 不唤醒；SquadChat 保持无心跳。
7. **UI 落点**：studio AutoWork tab；复杂交互可先出设计（本版本无设计师权威稿，功能 PASS 即验收）。

---

## 7. 验收口径

- **功能**：本版本关键用户路径 P1–P6 全通过（API 达阈值 ≥90% + E2E ≥70%，无阻塞性 issue）。
- **视觉保真**：本版本**无设计师权威稿**（req 附方向 HTML 原型，orchestrator 看着办）——**不强制视觉保真 compare**，UI 对齐既有 autowork-tab / studio token，功能 PASS 即验收。
- **废弃验证**：member 面板确认无心跳 section；旧 `PATCH /member/:mid/heartbeat` 端点已删除。

---

## 8. 概念对齐索引（PRD 引用 ↔ spec 定义）

| PRD 概念 | 权威 spec 定义 |
|---|---|
| `SquadHeartbeatConfig`（interval/activeWindows/scope） | `specs/tech/squad/[P1]data_model.md §1.1a` |
| `budget` off/on 语义（null=不限量） | `data_model.md §1.1a` + `11a §1.4` |
| `enableHeartBeat` 总开关 | `data_model.md §1.1`（`squad-autonomy-toggle.md`） |
| squad 级 heartbeat job + gate 链 + 逐成员展开 | `specs/tech/scheduling/[P1]heartbeat_handler.md §0/§2` |
| 固定心跳提示词 + `<EOS>` 零机制 | `heartbeat_handler.md §0.1` |
| `member.currentWork` presence 数据 | `data_model.md §1.2b` |
| `presence` 工具（set/clear） | `specs/tech/squad/[P1]squad_tools.md §6a` |
| `squad_team_status` reminder 段 | `specs/tech/squad/[P1]squad_reminder_providers.md §4.6` |
| `PATCH /squad heartbeatConfig` + 废弃 `PATCH /member/:mid/heartbeat` | `specs/api/overall/11a-squad-endpoints.md §1.4/§4.2` |
| `heartbeat-config` / `budget-meter` / `component-autowork-tab` / `member-panel`（心跳 section 移除） | `specs/ui/components/studio-page/*.md` |
