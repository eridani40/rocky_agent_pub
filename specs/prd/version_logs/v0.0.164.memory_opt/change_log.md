# v0.0.164.memory_opt — memory 治理优化：squad scope + routing 强化 + tier2 质量/lock + 手动触发 — PRD 变更日志

> 引入版本 v0.0.164.memory_opt · 2026-07-17
> 一句话：给 memory + skill + consolidation 三块补齐 4 项治理短板——memory 新增 `squad` scope（skill 走 squad workspace 目录承载不改 enum）；强化 `routing_decision.md`「什么不该记 + scope 选 squad 的规则」；tier2 加质量审查段治「整完仍是坏 entry」+ 引入 `AppTaskLock` 防手动/cron 撞车；设置页新增「立即整理」按钮 + `POST /consolidation/run` 端点。
> overall 快照：本次产出仅 version_log；overall 同步（`09-memory.md` §9.2 追加 5 节 + §9.3 补 4 条路径 + §9.4 IN/OUT + §9.5 决策）由 doc-modifier 在阶段 5 完成。
> 概念权威源（PRD 对齐，非新发明）：
> - `specs/tech/agent/memory/[P0]memory_definition.md` §3（entry schema：scope 2 值，本版本扩到 3 值）
> - `specs/tech/agent/memory/[P0]memory_manage_tool.md` §5.2（路由提示词章节 + squad_id 自动填先例参考 v0.0.77 sessionId）
> - `specs/tech/agent/memory/[P0]memory_injection.md`（`selectMemoriesByQuota` 四类分组，本版本扩到 6 类）
> - `specs/tech/agent/memory/[P0]consolidation_tier2.md`（tier2 天级 job，本版本加质量审查段）
> - `specs/tech/agent/skills/[P0]skill_definition.md`（skill scope=app/workspace/builtin，本版本 squad 走 workspace 承载不改 enum）
> - `specs/tech/agent/session/[P0]session_task_lock.md`（SessionTaskLock 形态，本版本引入 `AppTaskLock` 参考此扩到 app 级）
> - `specs/tech/scheduling/[P1]consolidation_job.md`（tier2 cron 调度，本版本加手动触发端点）
> - `specs/api/overall/03-config-center.md` §2.6/§2.7（consolidation config + status，本版本新增 §2.8 `POST /consolidation/run`）
> - `specs/ui/components/app-dev-config-page/section-consolidation-config.md`（本版本加「立即整理」按钮，取代原「不提供该交互」的边界注记）
> - `app/server/src/prompts/content/routing_decision.md`（三处共享的单一源）
>
> 本质：**对 memory scope 分层维度补一档；对 routing 提示词补「什么不该记 + squad 选择规则」；对 tier2 补质量审查段 + 手动触发入口 + 并发锁——全部是对已有概念的行为/数据扩展，仅新增 `AppTaskLock` 一处新概念（形态参考 SessionTaskLock）。**

---

## 1. 背景与现状（先对齐，再改）

**问题 1 — memory scope 分不清 global vs session（现状）**：
- `memory_definition.md §3` 现有 scope enum = `global | session`，二分容纳不下「Leader 措辞纪律」这类**属于某个 squad 内某角色规则**的经验——落 global 会污染其他 squad、落 session 又只在一个会话有效。
- prod 环境用户实际操作时被迫误落，导致 global memory 混杂角色规则、squad memory 缺失。

**问题 2 — 不该记录的进展类被误当 project type 记入（现状）**：
- `routing_decision.md` 现只有「skill vs memory / global vs session」两步决策 + 「project 代码/架构不写」一句排除；对**里程碑/进展快照/一次性成就/用户情绪表达**类无排除说明。
- prod 环境实证：`novel-squad-100ch-complete-final-snapshot` 这类快照被 agent 当 `project` type 记入 memory，本质是「当前进展/一次性事件」而非「未来判断依据」，污染 memory 库。

**问题 3 — tier2 整理完还是现在的质量（现状）**：
- `consolidation_tier2.md`（v0.0.151 落地）只做**数量收敛**（合并/归档/禁用超容量 entry），不做**质量审查**——坏 entry（过程快照、scope 选错、被更好版本覆盖）只要不超容量就永远躺着，用户实测「整理任务看一下，感觉没效果」。
- 缺一道「按 routing 定案 2 的新原则重审每条 entry」的判断。

**问题 4 — 不支持手动点击整理（现状）**：
- `section-consolidation-config.md` 现明确注「不提供『立即整理』手动触发按钮（本版本明确排除该交互）」，配置只有 setting 类（开关/时间/模型）。
- 用户改完配置想立即验证一次整理效果 → 只能等到设置时间；或想在积累一段时间后手动触发一次 → 无路径。
- `consolidation_job.md` cron 触发链路已存在（tier2 job 自身可复用），只是缺一个端点触发入口 + 并发锁防撞车。

---

## 2. 本版本 4 项定案（产品化表达）

### 定案 1：memory 新增 `squad` scope + skill 走 squad workspace 目录承载 — P0

**用户故事**：作为使用多个 squad 的用户，我希望能把「只对某个 squad 内角色/规则有效」的经验落到 squad 层，不污染其他 squad 也不困在单会话里。

**memory 侧行为**：
- scope enum 从 `global | session` 扩为 `global | squad | session`（3 值）。
- **`squad_id` 从 ctx 自动填**：`memory_manage.write` 与 `memory.read/search` 的 input schema **不暴露 `squad_id` 参数**，值从 `ctx.config.squadId` 自动填（对齐 v0.0.77 sessionId 自动填的套路——防 LLM 传错 squad_id 记到别的 squad 或读到别的 squad）。
- **无 squad 会话回退策略（用户拍板 2026-07-17）**：`ctx.config.squadId` 缺失时（会话不属于任何 squad）→ `memory_manage.write(scope='squad', ...)` 与 `memory.read/search(scope='squad', ...)` 直接返回 `[invalid_input] not_in_squad` 错误（对齐 evolvable/300 词硬限的 `[invalid_input]` 错误码惯例），LLM 见错自修正（改 scope 或不写）。**不静默降级为 global**（避免 squad 规则悄悄污染 global）、**不写 orphan 分区**（避免读不回的死数据）。
- **存储介质：per-squad md 文件（用户拍板 2026-07-17，与 skill squad workspace 目录对称）**。路径约定示例 `<dataDir>/squads/<squadId>/memory.md`（或与 skill squad ws 同处 `<dataDir>/squads/<squadId>/.rocky/memory.md`）——具体路径由 architect 定，但**必须与 skill squad ws 目录位置对称/共处**（心智一致：一个 squad 的 memory + skill 都在同一 squad 目录树下，天然支持 git 共享）。存储机制**复用 `ManagedStore` per-file lock + atomicWrite + frontmatter/body 解析**（与 session memory 同构，只是目录键从 sessionId 改 squadId），不引入 app_config 分片键路线。
- **注入配额分组从 4 类扩为 6 类**：`selectMemoriesByQuota` 纯函数升级为 `scope(3) × source(2)` = 6 类，优先级顺序 = session 手动 → session 自动 → **squad 手动 → squad 自动** → 全局手动 → 全局自动（squad 层夹在 session 与 global 之间——比 global 更贴当前 squad 场景，比 session 更稳定）。
- **三 mapper 协同**：memory_user + memory_squad（**新**）+ memory_session **共享同一总量配额**（`maxMemoryInject` 不变，语义仍是 3 mapper 合并后 ≤ N）；架构上如何协同（共享 selector 前置 / mapper 内切分）由 architect 定，PRD 只约束最终 L0 条目数 ≤ N 且按 6 类顺序取前 N。

**skill 侧行为（走 squad workspace 目录承载，不改 scope enum）**：
- skill `scope` enum **不改**（保持 `app | workspace | builtin`）——用户裁决走「squad 目录下 `.rocky/skills/`」路线。
- skill resolver **加 squad workspace 目录源**：现在 skill 从 app（`<dataDir>/skills/`）+ workspace（`<workspaceDir>/.rocky/skills/`）+ builtin 三源加载，本版本加 squad workspace 目录源（约定路径由 architect 定，示例 `<dataDir>/squads/<squadId>/.rocky/skills/`）。
- **合并优先级 = squad > workspace > app**（squad 最贴用户当前 squad 任务；同名 skill 由 squad 覆盖 workspace 覆盖 app）。
- **skill UI 侧零改动**（用户本就没在 skill 卡片选过 scope，`skill_manage.create` 也不需要 squad_id 参数——skill 靠资源位置决定 scope 归属，非 metadata 决定）。

**断言落点**：
- memory：agent 在某 squad 会话写 memory 显式选 `scope='squad'` → 落该 squad 独立集合；同一 agent 换到别的 squad 会话 → 读不到；memory L0 注入含 squad 层且按 6 类顺序前 N 截断。
- skill：把一个 skill 文件放进 `<squadA>/.rocky/skills/`（squad workspace 目录）→ 只在 squad A 会话生效；squad A 与 workspace 同名 skill → squad A 版本覆盖 workspace 版本。

---

### 定案 2：`routing_decision.md` 强化 + 最小可见性 — P0

**用户故事**：作为用户，我希望 agent 自动总结时不再把进展快照/情绪表达误记为 memory，也能正确判断某条经验该落 squad 还是 global；这类底层规则我完全不用感知，是 agent 内部的事。

**修改文件**：`app/server/src/prompts/content/routing_decision.md`（三处共享的单一源——`memory_manage.description` / `skill_manage.description` / tier1 fork-2 prompt 三处消费，改一处三处生效）。

**加什么（第一步·该不该记，加反例清单）**：
- **进展快照/里程碑不记**：如「XX 章节完成」「G-0001 达成」「本季度目标已交付」——这些是「现在的事件」而非「未来判断依据」，写 **neither**。
- **当前状态/进行中不记**：如「今天在改 X」「本周计划 Y」——短期上下文，非长期规则，写 **neither**。
- **一次性成就不记**：如「破 XX 记录」「首次达成 YY」——纪念性事实无需 agent 「未来遵循」，写 **neither**。
- **用户情绪表达不记**：如「我今天很累」「这个方案让我很开心」——情绪状态非稳定偏好，写 **neither**。
- **短期上下文不记**：如「今天的会议纪要」「刚才聊过的 X」——过时即无用，写 **neither**。

**加什么（`project` type 定义澄清）**：
- **`project` type = 项目内需 agent 长期遵循的规则/约束**（例：「本项目所有 API 用 kebab-case」「本项目 review 必须两人签」），**不是**项目当前进展/状态快照（例：「XX 模块已完成」「本 sprint 达成 3/5」）。
- 三处消费该定义的地方（`memory_definition` type 说明 + `memory_manage` description + tier1 fork prompt）同步澄清（doc-modifier 阶段核对）。

**加什么（第二步·scope 选择加 squad 规则）**：
- **跨项目/跨会话通用** → **global**（默认，兜底）。
- **仅当前 squad 内规则/角色行为**（例：「本 squad 的 Leader 措辞纪律」「本 squad 编辑角色的复核规则」）→ **squad**。
- **仅当前会话有效**（例：「本次会话临时约定的调试变量名」）→ **session**。

**最小可见性（UI 侧零暴露、零编辑入口）**：
- routing prompt 是 **agent 内部提示词**，用户完全不感知——设置页不新增 routing prompt 编辑器、不新增「路由规则」tab、不暴露 prompt 内容。
- 三处共享自动同步生效（改单一源即完成，无需 UI 面板）。

**断言落点**：
- 真 LLM 会话触发自动总结「XX 章节完成」这类进展快照 → agent 判定 `neither`，不写入任何 memory/skill。
- 真 LLM 会话触发自动总结「本 squad 的 Leader 措辞纪律」→ agent 判定 `memory`（type=project，因是需长期遵循的规则）+ `scope=squad`。

---

### 定案 3：tier2 加质量审查段 + `AppTaskLock` 防撞车 — P0

**用户故事 A**：作为长期使用的用户，我希望 tier2 整理不仅收敛数量，也能识别「过程快照」「scope 选错」「已被更好 entry 覆盖」这类坏 entry 并归档，让整理真正提升 memory 质量。

**用户故事 B**：作为用户，我希望手动触发整理与天级 cron 撞车时后到者能静默跳过（不并发跑两次、不冲突），我也能在设置页看到「整理中」状态。

**tier2 prompt 加质量审查段**：
- 整理 agent（`consolidation_tier2.md` 的专用 scope agent）在跑合并/归档动作**之前/期间**，对每条 `source='agent'` 的 entry 做质量判断：
  - **过程快照 → archive**：内容属于「XX 完成 / YY 进展」这类当前事件（对齐定案 2 反例清单）。
  - **scope 选错 → 建议调整 scope 或 archive**：例如原本应是 `squad` 层规则却记在 `global`（污染其他 squad）→ 若可确定所属 squad 则**建议调整 scope**；若无法定位则 archive。
  - **已被更好 entry 覆盖 → archive**：内容与已有另一条 entry 表达同一规则但更粗糙/更过时 → archive 旧的，保留新的。
- **判据 = 定案 2 的新原则**（三处共享的 routing 提示词，与整理 prompt 天然同源，改 routing 即改整理判据，无需两处维护）。
- **evolvable gate 依旧生效**：`evolvable=false` 的 entry 即使被判定为坏 entry，整理任务动不了（如实反映而非报错，对齐 v0.0.151 既有铁律）。

**`AppTaskLock`（新概念，参考 `SessionTaskLock` 扩到 app 级）**：
- **同 API**：`acquire / markDone / markFailed / release / getState / reconcileOnStartup`（形态参考 `specs/tech/agent/session/[P0]session_task_lock.md`）。
- **taskType**：`'tier2_consolidation'`（本版本唯一 app 级 task type；未来其他 app 级任务可复用同一 lock）。
- **撞车语义**：手动触发（定案 4）与天级 cron 到点触发时**后到者 `acquire` 返回 `false` → 静默跳过**（不报错、不并排跑两次、不冲突）；用户在设置页看到「整理中」状态。
- **`acquire` 成功即 emit `consolidation_task_update` 事件**推给设置页 status 面板（沿用 `consolidation-status` testid 承载 running 态）。
- **实现路径**（架构决）：`AppTaskLock` 可能是**新独立 class**，也可能**让 `SessionTaskLock` 支持特殊 `sid='__app__'` 承载 app 级任务**——PRD 只约束 API 形态与撞车语义，不约束实现路径。

**断言落点**：
- 造一批「明显是过程快照 + scope 选错 + 被覆盖」的 `source='agent'` entry → 到点跑 tier2 → 这些坏 entry 状态变 archived，非仅超容量的部分被处理。
- 已开着 tier2 job（cron 触发中）→ 用户点「立即整理」按钮 → 后到者 `acquire` 返 false，用户看到「整理中」提示，不重复跑。

---

### 定案 4：手动触发「立即整理」按钮 + `POST /consolidation/run` — P0

**用户故事**：作为用户，我改完 tier2 配置想立即验证一次整理效果，或积累一段时间想手动触发一次而不等每日时间，能在设置页点一个按钮触发一次整理并看到执行状态。

**UI 变更**：
- `section-consolidation-config.md` 加「立即整理」按钮（在整理 tab 内、tab 说明文案下方或 status 区旁——**具体视觉位置由 coder 编码前 UI spec pass 定稿**，本 PRD 只约束「有该按钮 + 按钮 disabled 状态 = running」）。
- 按钮 **disabled 状态 = 整理任务当前正在跑**（数据来源：`GET /consolidation/status` 或事件订阅 `consolidation_task_update` 感知 running 态）；空闲态可点。
- **取代边界注记**：`section-consolidation-config.md` 现有的「不提供『立即整理』手动触发按钮（本版本明确排除该交互）」这条边界由本版本明确废除（doc-modifier 阶段核对更新）。

**API 变更**：
- 新增 `POST /consolidation/run`（`specs/api/overall/03-config-center.md §2.8`，具体路由/schema 由 architect 落）：
  - `AppTaskLock.acquire('tier2_consolidation')` **成功** → **fire-and-forget 跑 tier2 job**（不等完成）→ 立即返 `202 Accepted { ok: true, runId }`。
  - `acquire` **失败**（已有整理跑着）→ 返 `409 Conflict { error: 'consolidation_in_progress' }`。
- **复用 tier2 job 逻辑**：手动触发跟 cron 触发**走完全同一段代码**（同一整理 agent 装配、同一 fast finish 判断、同一 skip 逻辑、同一 status 回写）——触发源不同（cron scheduler / HTTP endpoint），执行路径一致。
- **skip 逻辑挡用户误点**：手动触发同样受 tier2 既有 skip 语义保护（无新对话/session memory 为空/未配置整理模型 → fast finish + status 回写「本次无需整理」/「未配置整理模型，已跳过」），用户点空也不会跑白工。

**断言落点**：
- 空闲态点按钮 → 返回 `202 { ok, runId }` → status 面板出「整理中」→ 跑完出「上次整理时间 + 摘要」。
- 已有整理跑着时点按钮 → 返回 `409 { error: 'consolidation_in_progress' }` → 前端提示 + 按钮保持 disabled，不并排跑。
- 点按钮但当天无新对话/未配置模型 → `202` 立即返回 + status 秒回「本次无需整理」/「未配置整理模型，已跳过」，不启动 LLM 调用。

---

## 3. 关键用户路径（MANDATORY — 测试最低覆盖）

> **UC 编号注记**：`09-memory.md` 现有 UC-M1~UC-M9（M1-M7=v0.0.112，M8-M9=v0.0.149）。本版本续编 UC-M10~UC-M13。

| ID | 用户操作链路 | 预期结果 | 类型 |
|----|-------------|---------|------|
| UC-M10 | 用户在 squad A 会话中让 agent 记「本 squad 的 Leader 措辞纪律」→ agent 调 `memory_manage.write(scope='squad', ...)`；再切换到 squad B 会话构建 system prompt | squad A 会话中 memory L0 含该条；squad B 会话读不到；memory 数据集中该条 `scope=squad`、`squad_id` 从 ctx 自动填、非用户显式传参 | API（真 LLM）|
| UC-M11 | 真 LLM 会话触发自动总结「XX 章节完成」这类进展快照类内容 | agent 判定 `neither`（既不落 skill 也不落 memory），memory 数据集无新增该类快照条目；同理对「情绪表达」「一次性成就」「当前进展」测试 | API（真 LLM）|
| UC-M12 | 用户在应用设置「整理」tab 点「立即整理」按钮（空闲态）| API 返 `202 { ok, runId }`；tier2 job 立即启动跑；status 面板出「整理中」→ 完成后出「上次整理时间 + 一句话摘要」；按钮从 disabled 恢复可点 | E2E + API |
| UC-M13 | tier2 job 正跑着（cron 触发或上一次手动触发未完），用户再点「立即整理」 | 后到者 API 返 `409 { error: 'consolidation_in_progress' }`；前端不启动第二次；status 面板保持「整理中」（不出现两次执行痕迹） | E2E + API |

**路径数**：4 条新增，覆盖 squad scope 数据隔离 + routing 反例清单生效 + 手动触发 + 并发锁撞车。测试策略参考 v0.0.151 惯例：squad scope 存储/注入配额升级、routing 提示词修改后 agent 行为判定 → 走 UT + API 真 LLM；手动触发按钮 + 409 撞车走 E2E。**tier2 质量审查段（定案 3 前半）已被 UC-M11（routing 反例）+ 「造坏 entry 跑 tier2」的 API 断言覆盖，无需单独路径**。

---

## 4. 范围边界

### IN [v0.0.164.memory_opt]
1. memory scope 从 2 值扩为 3 值（`global | squad | session`）；`squad_id` 从 ctx 自动填；注入配额分组 4 类扩为 6 类
2. skill resolver 加 squad workspace 目录源（squad > workspace > app），skill scope enum 不改、UI 零改动
3. `routing_decision.md` 加反例清单（进展/状态/成就/情绪/短期不写）+ `project` type 定义澄清 + scope 加 squad 规则；UI 侧零暴露
4. tier2 prompt 加质量审查段（过程快照/scope 选错/已被覆盖 → archive）；判据与 routing 提示词同源
5. `AppTaskLock` 新概念（参考 `SessionTaskLock` 形态扩到 app 级，taskType='tier2_consolidation'），撞车静默跳过 + 事件推送
6. `section-consolidation-config` 加「立即整理」按钮；`POST /consolidation/run` 端点（202/409）；复用 tier2 job 完整逻辑

### OUT [v0.0.164.memory_opt]
- **skill 的 squad 层元数据表达**（skill scope enum 不改；squad 层完全由资源位置决定，不引入 metadata scope='squad'）
- **routing prompt 的 UI 编辑器/暴露**（本版本最小可见性 = 零 UI）
- **手动触发的整理范围裁剪**（手动触发跑完整 tier2 三段：全局 skill + 全局 memory + 各 session；不支持「只跑某一段」）
- **整理运行详情钻取/进度条**（status 面板仅「running / 上次时间 + 摘要」，与 v0.0.151 保持一致）
- **移动/复制 memory 到别的 scope 的 UI 入口**（scope 一次性写入，不做迁移工具；未来 backlog）
- **squad memory 的团队共享/git 同步**（本版本 squad memory 是本机 dataDir 内的 squad 分片，不涉及跨设备共享；skill 侧的 squad workspace 目录若走 git 共享属产品既有 workspace 机制延伸，非本版本改动）

---

## 5. 设计决策增量

| 决策 | 选择 | 理由 |
|------|------|------|
| skill squad 层承载方式 | 走 squad workspace 目录（`<squadDir>/.rocky/skills/`），**不改 scope enum** | (1) skill UI 用户从未选过 scope（UI 无此入口）→ 保持零改动是最小侵入；(2) skill 靠资源位置决定 scope 是既有惯例（app 目录 = app scope、workspace 目录 = workspace scope），squad 目录顺延同一惯例；(3) 不加 `scope='squad'` metadata 避免同一物理 skill 文件的 scope 判定与位置判定二分裂 |
| memory squad_id 参数策略 | **不暴露 input schema**，从 `ctx.config.squadId` 自动填 | 对齐 v0.0.77 `sessionId` 自动填先例——防 LLM 传错 squad_id 记到别的 squad 或读到别的 squad；用户在 squad A 会话内的所有 memory 操作天然作用于 squad A，无需 LLM 判断 |
| 无 squad 会话 scope='squad' 回退 | **拒绝 + 报错**（`[invalid_input] not_in_squad`）— 用户拍板 2026-07-17 | 静默降级为 global 会让 squad 规则悄悄污染 global；orphan 分区语义模糊后续读不回；错误码让 LLM 自修正是最干净的语义 |
| squad memory 存储介质 | **per-squad md 文件**（`<dataDir>/squads/<squadId>/`，与 skill squad ws 目录对称）— 用户拍板 2026-07-17 | (1) 与 skill squad ws 目录位置对称，一个 squad 的 memory + skill 同处 squad 目录树，心智一致；(2) 天然支持 git 共享（与 skill squad ws 同处）；(3) 复用 ManagedStore per-file lock + atomicWrite（与 session memory 同构，只换目录键 sessionId→squadId），零新基础设施 |
| 6 类注入顺序 | session 手/自 → **squad 手/自** → global 手/自（squad 夹中间）— 用户拍板 2026-07-17 | session 最贴当前会话上下文；squad 比 global 更贴当前任务、比 session 更稳定；global 最兜底 |
| AppTaskLock 实现路径 | 交 architect 决定（新独立 class / SessionTaskLock 扩 sid='__app__'）— 用户拍板 2026-07-17 | PRD 只约束 API 形态与撞车语义，实现路径由架构基于现有代码权衡 |
| routing prompt 最小可见性 | UI 零暴露、零编辑入口，纯 agent 内部提示词 | (1) routing 是 agent 内部机制，用户理解「memory 是什么/怎么用」即可，不需感知「agent 靠什么规则决定 memory 该记哪」；(2) 暴露 routing 编辑器会引导用户过度调参，长期维护成本高；(3) 三处共享单一源架构（v0.0.112 已建立）改一处三处生效，无需 UI 面板协助 |
| tier2 质量审查段判据源 | 复用 routing_decision.md（不做整理专属 prompt 段） | 单一真理源——routing 定案 2 的反例清单与「什么该记 / 什么不该记」判据本就是整理 agent 复用的判定依据；tier2 单独维护判据 = 双份提示词、易漂移 |
| `AppTaskLock` 引入方式 | 参考 `SessionTaskLock` 扩到 app 级（API 形态、CAS 语义、事件推送均对齐） | (1) SessionTaskLock 已在 session 级验证 CAS + reconcileOnStartup 崩溃恢复 + emit 事件形态可靠；(2) app 级任务与 session 级任务在锁语义上同构（只是 owner scope 差异），复用形态避免重复设计；(3) 具体实现（新 class / 扩展 `sid='__app__'` 特殊 key）由架构决 |
| 手动触发与 cron 触发同代码 | 完全同一段 tier2 job 逻辑，仅触发源不同 | 保证行为一致（手动触发≠简化版）；skip 逻辑对手动触发同样生效（无新对话/未配置模型静默跳过），用户误点也不会跑白工 |

---

## 6. spec 影响面（架构阶段细化 — PRD 不擅改 tech/ui spec）

| spec | 变更点（PRD 给方向，architect 落具体） |
|------|----------------------------------------|
| `tech/agent/memory/[P0]memory_definition.md` §3 | entry scope enum 从 `global\|session` 扩为 `global\|squad\|session`；type 说明澄清「project = 项目内需 agent 长期遵循的规则/约束，不是进展快照」 |
| `tech/agent/memory/[P0]memory_manage_tool.md` §5.2 | 路由提示词章节引用 `routing_decision.md` 已更新（反例清单 + squad 规则 + project type 澄清），无自身内容重复；`squad_id` 从 ctx 自动填的 input schema 声明 |
| `tech/agent/memory/[P0]memory_injection.md` §2/§3 | `selectMemoriesByQuota` 纯函数从 4 类扩为 6 类；新增第三 mapper `memory_squad`；三 mapper 协同方式（共享 selector / mapper 内切分）由 architect 定 |
| `tech/agent/memory/[P0]consolidation_tier2.md` | 整理 agent prompt 加质量审查段（判据引用 routing_decision.md）；`AppTaskLock` 接入方式（acquire/release 时机、事件 emit） |
| 新增 `tech/agent/memory/app_task_lock.md`（建议） | `AppTaskLock` 概念定义（形态对齐 `session_task_lock.md`，taskType='tier2_consolidation'，acquire/markDone/markFailed/release/getState/reconcileOnStartup + CAS + 事件 emit）；或作为 `session_task_lock.md` 的扩展章节由 architect 定 |
| `tech/agent/skills/[P0]skill_definition.md` | skill 加载源加 squad workspace 目录（路径约定示例 `<dataDir>/squads/<squadId>/.rocky/skills/`）；合并优先级 = squad > workspace > app；enum 不改 |
| `tech/scheduling/[P1]consolidation_job.md` | 手动触发路径引入（cron 与手动触发同代码不同触发源）；`AppTaskLock` 接入点 |
| `api/overall/03-config-center.md` §2.8（新增） | `POST /consolidation/run`：request 空 body；response 202 `{ok, runId}` / 409 `{error:'consolidation_in_progress'}`；受 `AppTaskLock` 保护 |
| `ui/components/app-dev-config-page/section-consolidation-config.md` | 加「立即整理」按钮（testid 由 coder 定，disabled=running）；废除现有「不提供该交互」边界注记；status 面板补 running 态展示 |
| `app/server/src/prompts/content/routing_decision.md`（code 层 spec 附属） | 步骤 1 加反例清单（进展/状态/成就/情绪/短期不写）+ project type 澄清；步骤 2 加 squad 规则；三处共享自动同步 |

---

## 7. 对齐 spec 核对结论

PRD 引用的概念绝大多数对齐已有 ui/tech spec；新概念清单如下（需先落 tech spec，交 architect）：

| PRD 引用 | spec 对齐情况 | 处置 |
|----------|--------------|------|
| memory scope enum 扩 3 值 | `memory_definition.md §3` 现为 2 值 | **改**：enum 扩到 3 值（architect） |
| memory `squad_id` 从 ctx 自动填 | v0.0.77 `sessionId` 自动填先例 | 纯引用范式，`memory_manage_tool.md` 声明新增（architect） |
| `selectMemoriesByQuota` 6 类分组 | v0.0.149 `memory_injection.md` 现为 4 类 | **改**：纯函数升级（architect） |
| 三 mapper 协同（memory_squad 新增） | v0.0.149 两 mapper 协同机制现存 | **改**：新增 memory_squad mapper + 协同方式（architect） |
| skill squad workspace 目录源 | `skill_definition.md` 现有 app/workspace/builtin 三源 | **改**：加 squad 源、合并优先级 squad > workspace > app（architect） |
| routing_decision.md 反例清单 + squad 规则 | `routing_decision.md` 现有两步决策 | **改**：追加反例清单 + squad 规则 + project type 澄清（三处共享自动同步） |
| tier2 prompt 加质量审查段 | `consolidation_tier2.md` 现只做数量收敛 | **改**：prompt 段扩展（architect） |
| `AppTaskLock` | 无对应 spec，参考 `session_task_lock.md` 形态 | **新概念，需先落 tech spec**（新独立文件 or 扩展 SessionTaskLock，由 architect 定）|
| `POST /consolidation/run` | `03-config-center.md` 现有 §2.6/§2.7 config + status | **改**：新增 §2.8（architect） |
| 「立即整理」按钮 | `section-consolidation-config.md` 现明确排除该交互 | **改**：废除排除注记 + 加按钮 testid（architect / coder 编码前 UI spec pass 定稿） |
| tier2 job 手动/cron 同代码 | `consolidation_job.md` 现只有 cron 触发链路 | **改**：加手动触发路径 + `AppTaskLock` 接入（architect） |

**对齐结论**：
- **纯引用现有概念（无需新发明）**：memory entry schema / skill 资源位置决定 scope 机制 / routing 三处共享单一源架构 / v0.0.149 selectMemoriesByQuota 纯函数配额 / v0.0.151 tier2 job 与 skip 语义 / SessionTaskLock CAS 形态 / config 页 tab/group 保存机制。
- **需 architect 落的新概念**（PRD 已给产品方向，见 §6）：`AppTaskLock`（唯一新概念）；scope enum/mapper/lock/端点/按钮均为对已有概念的扩展。
- **无偏离已确认决策**：本 PRD 逐条对齐 `states/user_query.md` v0.0.164 段与 task-board.md 4 项定案（scope 分层：memory 扩 3 值 + skill 走 squad workspace；routing 最小可见 UI 零暴露；tier2 加质量审查段 + `AppTaskLock` 参考 SessionTaskLock；手动触发按钮 + `POST /consolidation/run` 202/409）。

---

## 8. 版本

```yaml
version: 1.0
intro_version: v0.0.164.memory_opt
note: |
  v0.0.164.memory_opt 补齐 memory + skill + consolidation 三块 4 项治理短板：
  (1) memory scope 从 2 值扩为 3 值加 squad 层（squad_id 从 ctx 自动填），
      skill 走 squad workspace 目录承载不改 enum（合并优先级 squad > workspace > app）；
  (2) routing_decision.md 加反例清单（进展/状态/成就/情绪/短期不写）+ project type 定义澄清
      + scope 选 squad 的规则；UI 侧零暴露、零编辑入口；
  (3) tier2 prompt 加质量审查段（判据源复用 routing 提示词），
      引入 AppTaskLock（参考 SessionTaskLock 形态，taskType='tier2_consolidation'）
      防手动/cron 撞车；
  (4) 设置页加「立即整理」按钮 + POST /consolidation/run（202/409），
      复用 tier2 job 完整逻辑与 skip 语义。
  本文档为 version_log 增量；overall 同步（09-memory.md 追 5 节 + 4 条路径）
  由 doc-modifier 在阶段 5 完成。技术实现（squad memory 存储介质、AppTaskLock class 形态、
  三 mapper 协同方式、手动触发端点 schema、按钮 testid）留给 specs/tech/ + specs/api/
  + specs/ui/ + change_plan.md，本 PRD 不展开。
```
