# v0.0.58 PRD Change Log — 定时任务（cron）：cron tool + session 级调度 + 管理 UI + 调度器公共化

> version: 1.0 · 2026-07-03
> 一句话定位：补**通用定时任务**——agent 用 `cron_create` 自建 cron job（归属 session），用户在右侧「定时任务」tab 用**人话频率**管理（看不到 raw expr），底层把现有 SquadScheduler 抽象成公共调度引擎，心跳与 cron 共享。
> 概念权威源（PRD 必须对齐）：
> - UI 契约：`specs/ui/components/chat-page/component-workspace-panel.md`（playground 右侧多 tab 框架，v0.0.55 多 tab 结构 + `component-ws-tab-bar`）+ `specs/ui/components/studio-page/section-right-tabs.md`（studio 右侧 tab 框架）+ `specs/ui/components/studio-page/heartbeat-config.md`（**心跳配置 section — 与 cron 完全独立，归属区分对比**）
> - tech 契约：`specs/tech/squad/[P1]scheduler.md`（v0.0.33.4 现有 SquadScheduler — 调度器抽象基线）+ `specs/tech/agent/message/`（`message/types.ts:251` 已预留 message 子类 `"cron"` 未实现 — 本版本落地）
> - 调研：`specs/research/v0.0.58-cron-scheduling.md`（竞品参考 + 5 条可借鉴建议）
> - 依赖：v0.0.55（[working]）定义「会话右侧 tab 区域」框架，cron 管理 tab 加在此
> 设计稿（视觉契约）：`reqs/[working] v0.0.58.cron/design/cron-manage-demo.html`（多场景：playground rocky / squad leader / squad mate + 空态 / 禁用 / 删除）

---

## 1. 版本目标

把 v0.0.58 三大需求产品化：

1. **cron tool**（agent 自建定时任务，归属 session）：agent 调 `cron_create(cron expr, prompt)` 在**当前 session** 创建 cron job；到点构造 `source:'system'` + 子类 `"cron"` 的 Message 投递到该 session，唤醒 agent 跑一轮（复用 `buildTickUserMessage` 模式 + gate chain）。配套 list/update/disable/enable/delete 工具。
2. **管理 UI**（人话化、不暴露 raw expr）：会话右侧 tab 区域新增「定时任务」tab（依赖 v0.0.55 框架），展示态 cronstrue 翻译成中文人话（「每 30 分钟」/「每天 18:00」）；编辑态用频率选择器；UI 专用 HTTP 端点（与 agent 工具正交）。
3. **调度器抽象公共化**：现有 SquadScheduler（强耦合 squad）→ 抽象为公共调度引擎（1s 轮询 + handler registry + fire-and-forget），心跳与 cron 都是其上的 job type。**回归红线**：v0.0.33.4 心跳行为零破坏。

---

## 2. 范围

### 2.1 IN-SCOPE

| # | 项 | 摘要 |
|---|---|---|
| **R1** | **cron tool（agent 端，归属 session）** | 6 工具：`cron_create(cron, prompt, name?, enabled?)` / `cron_list` / `cron_update(id, ...)` / `cron_disable(id)` / `cron_enable(id)` / `cron_delete(id)` — 在**当前 session** 创建/管理（与 UI 端点正交） |
| **R2** | **cron 触发链路** | 到点 → Message `source:'system'` + 子类 `"cron"`（content=prompt，metadata 含 job 信息）→ `deliverTo(sessionId)` 唤醒 agent（复用 buildTickUserMessage 模式 + gate chain）；落 `cron.json` per session 续接 |
| **R3** | **管理 UI tab** | playground / studio leader / mate 各 session 右侧 tab 新增「定时任务」：name / 人话频率 / prompt 摘要 / enabled / 下次触发 / 上次触发 + enable/disable toggle + 删除 + 新建（频率选择器） |
| **R4** | **人话化双向转换（UI 层）** | 展示态：cron expr → cronstrue zh_CN（fallback raw）；编辑态：频率选择器（每 N 分钟·每 N 小时·每天 HH:mm·每周 X HH:mm + 高级自定义 cron 折叠）→ 生成 expr；**工具层仍收 raw cron expr** |
| **R5** | **调度器抽象**（req.md 已定架构决策，作产品约束） | Scheduler 单例 = 纯 1s 轮询 + 回调分发，**不感知 budget / squad**；Job Handler Registry `{id,type,owner,schedule,payload,lastFiredAt}`，type 决定 handler；所有 gate（busy/budget/window/killswitch）下沉 handler；**fire-and-forget** |
| **R6** | **两种 job type** | `heartbeat`（owner=member，沿用 v0.0.33.4 配置，零回归）+ `cron`（owner=session，cron expr + 用户时区；gate=busy + 若 session 属 squad 查 squad budget / playground 无 budget gate） |
| **R7** | **重启续接** | heartbeat → `.rocky_squad/state/scheduler.json`（现状）；cron → session 级 `cron.json`（job 列表 + lastFiredAt）；scheduler 启动分别加载、按 type 重建 handler；session 销毁/归档 → 其 cron jobs 注销 |

### 2.2 OUT-OF-SCOPE（Non-goals）

- **cron 表达式扩展语法**（L/W/?/月份别名）— 5 字段 vixie-cron 标准（min-hour-dom-month-dow），对齐 refs/claude-code，不引入 croner 6 字段。
- **一次性定时（at）任务** — 本版本 cron 都是 recurring；one-shot missed 补偿（claude-code 的 onMissed 链路）留 backlog。
- **多进程部署 cron 锁** — 单进程部署（当前）无需 lockfile；多进程时再参考 claude-code `cronTasksLock`（[P1]scheduler.md §9 已留 hook）。
- **per-job tz override** — 「用户时区」来源 PRD §6 默认 session/user 级；per-job tz override 留 backlog。
- **心跳与 cron UI 合并** — 心跳 UI 留 `member-panel`「心跳」section（v0.0.33.4，squad 团队统管），cron 在右侧「定时任务」tab（session 级）；**两套独立 UI 不合并**（req.md 已定归属区分）。

---

## 3. 关键用户路径（MANDATORY — 测试最低覆盖）

> 每条路径 = 至少 1 个 API/E2E case。

| ID | 路径 | 涉及功能 | 测试类型 |
|----|------|---------|---------|
| **P1** | **playground cron**：用户在 playground session 对 rocky 说「每 5 分钟检查 todo.md 推进未完成任务」→ agent 调 `cron_create("*/5 * * * *", "检查 todo.md 推进未完成任务")` → 返 job id + 下次触发时间 → 用户在该 session 右侧「定时任务」tab 看到该 job（人话「每 5 分钟」+ prompt 摘要 + 下次触发）→ 推进时钟到点 → session 自动收 cron Message（子类 `"cron"`，content=prompt）→ agent 跑一轮 | R1 + R2 + R3 + R4 | API（cron_create + cron Message 触发）+ E2E（tab 看 job + 人话渲染） |
| **P2** | **UI 管理 cron（新建 / disable / enable / 删除）**：进 playground session 右侧「定时任务」tab → 点「新建」→ 频率选择器选「每 N 分钟」填 30 + 填 prompt「检查未读邮件」→ 列表新增一行（人话「每 30 分钟」+ enabled）→ 点 toggle disable → 行变灰 + 状态「已禁用」→ 推进时钟不再触发（mock 验证）→ 点 toggle enable → 恢复 → 点删除 → 弹确认 → 确认后行消失 + API DELETE 200 | R3 + R4 | E2E（频率选择器 → 人话 → toggle → 删除全链路；testid `cron-tab-*`） |
| **P3** | **squad member cron 归属**：squad mate session 内 mate agent 调 `cron_create("0 9 * * 1-5", "工作日早 9 点同步站会状态")` → 归属该 mate session（cron.json 写 mate session 目录）→ 推进时钟到点 → **只唤醒该 mate**（leader / 其他 mate session 不收 cron Message，断言跨 session 投递隔离） | R1 + R2 + R6 | API（创建 + 触发隔离，断言只 1 个 session inbox 入队） |
| **P4** | **重启续接（不丢 job）**：建 cron job（cron_create）→ 记 job id + lastFiredAt=null → 重启 server（env_shutdown → env_start）→ `cron.json` 加载 → job 续接（lastFiredAt 恢复）→ 推进时钟到下一到点 → job 按时触发不丢 → 落盘 lastFiredAt 更新 | R2 + R7 | API（重启后 cron.json 加载 + 触发链路） |
| **P5** | **调度器公共化回归（v0.0.33.4 心跳零破坏）**：squad enableHeartBeat=true + member.heartbeat 配置 → 心跳按窗口内每 interval 唤醒该 member → 同时该 squad leader 自建 cron job → 心跳与 cron 共存互不干扰 → killswitch（squad.enableHeartBeat=false）只停心跳，cron 继续触发（gate 隔离） | R5 + R6 | API（v0.0.33.4 心跳 AT 全回归 + 新增 cron 共存 case） |

---

## 4. UI 概念对齐 + 新概念

### 4.1 对齐现有 ui spec（沿用概念，不发明）

| 概念 | 引用 spec | 在本版本的角色 |
|---|---|---|
| 右侧 tab 区域（chat-page ws-panel） | `chat-page/component-workspace-panel.md`（v0.0.55 多 tab：workspace + memory + `component-ws-tab-bar`） | playground chat 右侧新增「定时任务」tab，沿用多 tab 切换 + collapsed/width state |
| 右侧 tab 区域（studio leader/mate） | `studio-page/section-right-tabs.md`（v0.0.55） | studio leader/mate 右侧新增「定时任务」tab（**squad chat 群聊不挂 cron tab** — 群聊 session 不归单个 agent，cron 无主） |
| 心跳配置 section（squad-owned） | `studio-page/heartbeat-config.md`（v0.0.33.4） | **对比参照，归属区分**（cron 不在此 section — 心跳 squad 级，cron session 级，两套独立 UI） |
| Message 子类 `"cron"` | `specs/tech/agent/message/[P0]agent_message_interface.md`（`message/types.ts:251` 预留） | 本版本落地该预留子类（content=prompt + metadata 含 cron job 信息） |
| `buildTickUserMessage` + `deliverTo` | `[P1]scheduler.md §4` + `subagent_derivation §4.1` | cron handler 到点调此链路唤醒 session（沿用 v0.0.33.4 心跳唤醒机制） |
| scheduler 1s 轮询 + lastFiredAt 续接 | `[P1]scheduler.md §1/§3/§7` | 调度器抽象延续此设计（claude-code 模式），cron job 同走 1s 轮询 + lastFiredAt 落盘 |

### 4.2 新概念（PRD 仅描述；ui/tech spec 落地在 architect / coder 阶段）

| # | 新概念 | PRD 描述 | 落地阶段 |
|---|---|---|---|
| **C1** | **「定时任务」tab**（chat-page 右侧多 tab 新增） | 在 v0.0.55 多 tab 结构（workspace + memory）加第 3 tab「定时任务」；testid 命名族 `cron-tab-*`（具体 TBD architect） | architect 落 `chat-page/component-workspace-panel.md`（tab +1）+ `studio-page/section-right-tabs.md`（同步）+ 新建 `chat-page/component-cron-panel.md` |
| **C2** | **频率选择器组件** | UI 选择器：每 N 分钟 / 每 N 小时 / 每天 HH:mm / 每周 X HH:mm + 「高级：自定义 cron」折叠（默认收起）；选定后程序生成 cron expr（raw 仅高级折叠可见 + 可编辑）；testid `cron-freq-*` | architect 落 `chat-page/component-cron-freq-picker.md`（新建） |
| **C3** | **cron handler + cron.json schema**（tech 新概念） | cron handler = job type='cron' 的 handler（到点 → buildTickUserMessage + deliverTo + 落 lastFiredAt）；cron.json shape `{jobs: CronJob[]}`，CronJob `{id, cron, prompt, name?, enabled, createdAt, lastFiredAt?}` | architect 落 `specs/tech/squad/[P1]scheduler.md`（公共化重构 §13/§14）+ 新建 `[P1]scheduler_cron.md` |
| **C4** | **UI 专用 HTTP 端点** | UI 与 agent 路径正交（对齐 v0.0.55 长期记忆 UI 端点模式）：`GET/POST /session/:id/cron`、`PATCH/DELETE /session/:id/cron/:jid`；UI 端点 + agent 工具操作同一份 `cron.json` | architect 落 `specs/api/overall/` 新增章节 |

---

## 5. cron 人话化产品规则（MANDATORY）

> **核心约束**：raw cron expr **不直接暴露给用户**（工具层仍收 raw cron expr，UI 层做双向翻译）。

### 5.1 展示态（cron expr → 人话）

- **库选型**（architect 阶段定，PRD 给候选）：推荐 `cronstrue`（zh_CN 内置 i18n，覆盖最全）；fallback：库翻译不出的 expr 直接展示 raw（claude-code 模式，仅高级用户场景）。
- **覆盖范围**（典型场景必须翻译）：
  - `*/N * * * *` → 「每 N 分钟」
  - `0 */N * * *` → 「每 N 小时」
  - `M H * * *` → 「每天 HH:mm」（24h，跟 session 时区）
  - `M H * * 1-5` → 「工作日 HH:mm」
  - `M H * * D` → 「每周{周几中文} HH:mm」（D=0/7=周日，1=周一…）
- **不翻译**：复合 expr（如 `0 9,12,18 * * *`）库支持则展示「每天 09:00/12:00/18:00」，否则 fallback raw；UI 不强制全翻译（频率选择器创建的 job 都能翻译，自定义 cron 高级选项接受的 expr 可能翻不出）。

### 5.2 编辑态（频率选择器 → cron expr）

**默认选项（4 个，覆盖 90% 场景）**：

| 选择器 UI | 用户输入 | 程序生成 cron expr |
|---|---|---|
| 每 N 分钟 | 数字 N（5/10/15/30，或自定义数字 ≥1） | `*/N * * * *` |
| 每 N 小时 | 数字 N（1/2/4/6/12，或自定义） | `0 */N * * *` |
| 每天 HH:mm | 时间选择器（24h，跟 session 时区） | `M H * * *` |
| 每周 X HH:mm | 周几选择（周一-周日）+ 时间选择器 | `M H * * D`（D=1-7，1=周一…7/0=周日） |

**高级自定义（折叠，默认收起）**：展开 → raw cron expr input（5 字段）+ 实时预览翻译（cronstrue 实时）+ parseCronExpression 校验。仅高级用户场景；折叠态默认不展示，避免普通用户被 raw expr 干扰。

### 5.3 工具层不变

agent 的 `cron_create` / `cron_update` 工具**仍收 raw cron expr**（程序生成 / 解析；agent 可自己写 expr）。人话 ↔ expr 双向翻译**只在 UI 层**。后端 / cron handler 不感知「人话」，只处理 cron expr。

---

## 6. 归属区分产品语义（cron vs heartbeat，MANDATORY）

> **核心约束（req.md 已定）**：cron 任务归属 session；心跳团队统一管理（squad 级）。两套**独立配置 + 独立 UI**，共享底层调度引擎。

| 维度 | cron 任务（本版本 R1-R4） | 心跳（v0.0.33.4 现有） |
|---|---|---|
| 归属 | **session**（playground / squad member / squad leader 各自，cron.json per session） | **squad**（团队统一，scheduler.json per squad） |
| 配置形态 | cron expr（5 字段）+ prompt + name? + enabled? | interval（分钟）+ activeWindow（HH:mm start/end） |
| 触发载荷 | Message 子类 `"cron"`（content=prompt，metadata 含 job 信息） | TickMessage（`reason:"heartbeat"`） |
| 管理 UI | 会话右侧「定时任务」tab（**本版本新建**，session 级） | member-panel「心跳」section（v0.0.33.4，squad 级） |
| killswitch | 无（cron 是 session 自己定的，无团队级开关） | squad.enableHeartBeat（团队统管） |
| 生命周期 | session 创建装载 / 销毁注销（cron.json 跟 session） | squad 启停（SquadRuntime） |
| gate | busy + 若 session 属 squad 查 squad budget / playground 无 budget gate | busy + budget + activeWindow + enableHeartBeat（[P1]scheduler.md §4） |
| 共享 | **底层调度引擎**（Scheduler 单例 + 1s 轮询 + handler registry） | 同左 |

**UI 边界**：
- playground session 右侧 tab：**只有「定时任务」tab**（playground 不属 squad，无心跳）。
- studio leader / mate 右侧 tab：**有「定时任务」tab**（session 级 cron）。
- studio member-panel：**有「心跳」section**（squad 级心跳配置；不与 cron 混）。
- 同一 squad member session 既有心跳（团队统管）也可有 cron（member 自建），**互不干扰**：到点各自触发 handler（gate 隔离：心跳 gate 含 enableHeartBeat，cron gate 不含）。

---

## 7. 数据 / API（architect 阶段细化）

### 7.1 agent 工具（R1，6 个）

| 工具 | 参数 | 行为 |
|---|---|---|
| `cron_create` | `{cron: string (5 字段), prompt: string, name?: string, enabled?: bool (default true)}` | 当前 session 创建 cron job；返 job id + 下次触发时间 |
| `cron_list` | `{}` | 列出当前 session 所有 cron jobs（含 enabled/disabled） |
| `cron_update` | `{id, cron?, prompt?, name?}` | 更新字段（不含 enabled，用 enable/disable） |
| `cron_disable` | `{id}` | enabled=false（暂停触发） |
| `cron_enable` | `{id}` | enabled=true（恢复触发） |
| `cron_delete` | `{id}` | 删除 cron job |

### 7.2 UI 专用 HTTP 端点（R3，与 agent 工具正交）

| 端点 | 用途 |
|---|---|
| `GET /session/:id/cron` | 列出 session 所有 cron jobs（cron expr + 人话 + lastFiredAt + nextFireAt） |
| `POST /session/:id/cron` | 新建（body：cron expr + prompt + name? + enabled?） |
| `PATCH /session/:id/cron/:jid` | 更新（cron / prompt / name / enabled 任一字段） |
| `DELETE /session/:id/cron/:jid` | 删除 |

> UI 端点 + agent 工具操作同一份 `cron.json`（per session）。两路写入由 architect 定锁策略（单进程无需 lockfile，in-memory mutex 即可）。

### 7.3 持久化（R7）

- **heartbeat**（沿用 v0.0.33.4）：`.rocky_squad/state/scheduler.json`（per squad）。
- **cron**（新增）：session 级 `cron.json`（路径 TBD architect，候选 `<sessionWorkspaceDir>/cron.json` 或 `<sessionStateDir>/cron.json`）。shape `{jobs: CronJob[]}`，CronJob `{id, cron, prompt, name?, enabled, createdAt, lastFiredAt?}`。
- **重启加载**：scheduler 启动 → 读 squad scheduler.json（重建 heartbeat handler）+ 遍历所有 session cron.json（重建 cron handler）；按 type 重建（req.md 已决）。
- **session 销毁**：cron.json 跟 session 生命周期（销毁即删 jobs，照 claude-code teammate orphan 清理模式）。

---

## 8. 验收标准

### 8.1 功能验收

- **R1**：6 工具全部实现，结构对齐 §7.1。
- **R2**：cron job 到点 → session inbox 入队 Message 子类 `"cron"`（content=prompt + metadata）→ agent loop drain 跑一轮；落盘 lastFiredAt。
- **R3**：playground / studio leader / mate 右侧「定时任务」tab 渲染本 session cron jobs（name / 人话 / prompt 摘要 / enabled toggle / 下次触发 / 上次触发）+ 新建（频率选择器）+ 删除；studio squad chat 群聊**无** cron tab。
- **R4**：展示态 cronstrue zh 翻译典型场景；编辑态 4 频率选择器 + 高级折叠；raw expr 不在普通用户路径暴露。
- **R5**：Scheduler 单例（去耦 squad）+ handler registry（type 决定）+ gate 下沉 handler + fire-and-forget。
- **R6**：heartbeat owner=member + cron owner=session，handler 各异，互不干扰。
- **R7**：cron.json + scheduler.json 分别加载，job 不丢；session 销毁 cron jobs 注销。

### 8.2 行为保持（回归守护）

- **v0.0.33.4 心跳行为零破坏**：现有心跳 AT case（gate chain / window / budget / killswitch / deliverTo / tickMessage）回归全 pass。
- **squad scheduler.json schema 不变**：heartbeat 落盘格式向后兼容（迁移到公共引擎后仍能读 v0.0.33.4 写入的文件）。
- **Message 子类 `"cron"` schema 与 `message/types.ts:251` 预留一致**（content + metadata 字段名对齐）。

### 8.3 测试 / 视觉保真门禁

- **API**：P1/P3/P4/P5 关键路径 case 全 pass（cron_create + 触发 + 跨 session 隔离 + 重启续接 + 心跳回归）。
- **E2E**：P2 关键路径 case 全 pass（频率选择器 → 人话展示 → toggle → 删除全链路 + vision_check 看 cron tab 视觉）。
- **视觉保真 compare（MANDATORY — 有设计稿）**：对 `cron-manage-demo.html` 多场景跑 `vision_check.py compare` 逐维度（layout / font / border / color）比对实现截图；明显偏差建 BUG。
- **代码质量**：`bun run typecheck` 通过；调度器抽象重构后 SquadScheduler 旧路径无残留死代码（grep `SquadScheduler` 仅新公共引擎 + 历史 log）。

---

## 9. 与现有 overall PRD 的关系

本版本**新增 cron 功能模块**（agent 自建定时任务 + 管理 UI + 调度器公共化），按 prd-spec-rules「增量更新规则 1」**必须在 §3 追加功能章节**——阶段 5 由 doc-modifier 同步：

- `specs/prd/overall/08-squad-studio.md` 加 `[v0.0.58 modified]` 标注（调度器公共化：SquadScheduler → 公共引擎 + 心跳/cron 两 job type）；
- 新建 `specs/prd/overall/09-cron.md`（cron 功能模块全量定义：cron tool + 管理 UI + 人话化规则 + 归属区分）；
- `specs/prd/overall/01-product-framework.md` §3 功能全景表新增「定时任务（cron）」条目。

---

## 10. 与 req.md 已定架构决策的对齐（无偏离）

本 PRD 严格遵循 `reqs/[working] v0.0.58.cron/req.md` 已定的核心架构决策（**权威，不推翻**）：

| req.md 决策 | PRD 落实章节 | 状态 |
|---|---|---|
| cron 归属 session / 心跳团队统管（两套独立配置+独立 UI） | §6 归属区分产品语义 | ✅ 完全对齐 |
| Scheduler 单例纯调度 + handler registry + gate 下沉 + fire-and-forget | §1 目标 #3 + §4.2 C3 + §8.1 R5 | ✅ 完全对齐（**作为产品约束写入，不发明**） |
| 两种 job type（heartbeat owner=member + cron owner=session） | §4.1 对齐 + §6 归属表 + §8.1 R6 | ✅ 完全对齐 |
| cron 人话化在 UI 层（工具层仍收 cron expr） | §5 人话化产品规则 | ✅ 完全对齐 |
| UI 专用 HTTP 端点（不复用 agent 工具） | §4.2 C4 + §7.2 | ✅ 完全对齐 |
| 持久化（heartbeat scheduler.json + cron cron.json，分别加载） | §7.3 | ✅ 完全对齐 |
| session 销毁注销其 cron jobs | §7.3（orphan 清理） | ✅ 完全对齐 |

**无任何与 req.md 决策偏离**。

---

## 11. 实施状态（阶段 5 文档同步 — 2026-07-04）

5 用户路径实施 + AT 状态：

| PRD 路径 | 实施状态 | AT 状态 |
|---|---|---|
| **P1** playground cron 触发（cron_create + cron Message 触发） | ✅ 实施（cron-tool.ts 6 工具 + CronHandler + buildCronUserMessage + deliverTo） | △ `playground_cron_fire_tc1.cron_create_tool_invoked` fail — **非 cron 实现 BUG**：BUG-001 LLM usage 丢失致 agent loop 没拿到 tool_use，cron 子系统本身（crud/restart/fire）全 PASS |
| **P2** UI 管理 cron（新建/disable/enable/删除 + 人话渲染） | ✅ 实施（section-cron-panel + component-cron-freq-picker + cron-humanize cronstrue zh_CN + 三处 cron-tab 接入：playground/leader/mate；群聊 isGroup 不挂） | ✅ ET DOM 20/20 + vision 11/12 PASS |
| **P3** squad mate cron 归属（cron.json 写 mate session，跨 session 投递隔离） | ✅ 实施（cron.json per session，CronHandler gate payload.sessionId） | △ `squad_mate_cron_tc1.budget_gate_skip_new_cron` fail — **非 cron 实现 BUG**：BUG-001 同源（LLM usage 丢失致 budget consumed=0，CronHandler budget gate 不 skip） |
| **P4** 重启续接（cron.json 加载 + lastFiredAt 续接） | ✅ 实施（boot.ts 双源 loadJobs + CronPersistenceAdapter.loadJobs） | ✅ `cron_restart_resume_tc1` PASS |
| **P5** 调度器公共化回归（v0.0.33.4 心跳零破坏） | ✅ 实施（HeartbeatHandler 从 SquadScheduler.tryFire 迁移 + SquadScheduler retire 到 soft_deleted/） | ✅ heartbeat 回归全 PASS（27 次 fire 成功，gate/window/budget/killswitch 不变量保持） |

### 11.1 cron 子系统健康（AT round-4 实证）

- **crud PASS**：T4 API 契约 8/8（6 UI HTTP + 6 agent 工具端点）
- **restart PASS**：cron.json 持久化 + 双源 loadJobs + lastFiredAt 续接
- **fire 健康**：27 次 CronHandler fire 全成功（gate 通过 → deliverTo → engine.updateJobLastFiredAt → cronStore.upsertJob）
- **工具注入健康**：21/21 session-config 含 6 cron 工具（T6 boot.ts wire 健康）
- **CronHandler budget gate 代码逐链验证正确**（gate2 逻辑 / aggregator / squadBudgetRemaining fresh 调用）

### 11.2 BUG-001（known-issue，用户确认带合并）

- **现象**：minimax 调用成功但 response `usage=None, stopReason=None`（不完整）→ `accumulateUsage` 不触发 → squad budget consumed=0 → CronHandler budget gate 不 skip（应为 skip）；同时 agent loop 没拿到 tool_use → cron_create 未被调用。
- **归属**：疑跨版本（dev1 v0.0.61 langfuse opt），**非 v0.0.58 cron 实现 BUG**。
- **证据**：5000+ 调用 usage 正常 vs cron case 窗口 35/44 None（集中在 merge dev1 后）。
- **决策**：用户确认（2026-07-04）cron 带 BUG-001 known-issue 合并；本 BUG 合并后单独追查（若确认 langfuse 回归则归 dev1 v0.0.61 修）。
- **BUG 文件**：`states/v0.0.58.cron/bugs/BUG-001-llm-usage-lost-[open].md`
