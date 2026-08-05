# v0.0.151.t2_consolidate — 天级 t2 整理任务（可进化 skill + memory）— PRD 变更日志

> 引入版本 v0.0.151.t2_consolidate · 2026-07-15
> 一句话：新增天级调度的整理任务，对 agent 自主产出（source='agent'）的 skill / memory 做冲突检测、合并与容量收敛（永不物理删除），配套设置新增「整理」tab 做开关 + 每日时间 + 整理模型配置；顺带消歧 default_models.summary 的 UI 文案。
> overall 快照：本次产出仅 version_log；overall 同步（`04-config-center-ui.md` + `06-skill.md` + `09-memory.md`）由 doc-modifier 在阶段 5 完成。
> 概念权威源（PRD 对齐，非新发明）：
> - `specs/tech/agent/memory/[P1]consolidation_tier2.md`（t2 方向占位：merge/prune/矛盾解决/容量回收 + 沙箱化 + 永不 delete 只 archive + 可回滚/可 pin）
> - `specs/tech/agent/memory/[P0]consolidation_tier1.md`（一级整理现状，t2 的姊妹机制）
> - `specs/tech/agent/skills/[P0]skill_manage_tool.md` + `specs/tech/agent/memory/[P0]memory_manage_tool.md`（create/patch/disable/enable、write/archive 动作 + evolvable gate，t2 复用）
> - `specs/tech/scheduling/index.md`（调度引擎 lastFiredAt 续接 + at-most-once 补偿不变量）
> - `specs/ui/components/app-dev-config-page/page-app-settings-merged.md`（tab→group 映射）+ `specs/ui/components/common/component-key-model-picker.md`（模型选择器复用）+ `specs/ui/components/app-dev-config-page/section-default-models-and-request.md`（default_models.summary 文案改动落点）
>
> 本质：**给「可进化 skill/memory 持续膨胀」补一道天级容量治理，产品层只定义配置入口 + 上限口径 + 用户可感知的行为语义；调度机制、专用 agent 装配、上下文供给方式留给架构。**

## 1. 背景与现状（先对齐，再改）

- **一级整理（tier1）已有，二级整理（t2）从无到有**：现有 fork-2（`post-compact-consolidation.ts`）只在 compact 时机把经验「写入」memory/skill，从无合并/淘汰/容量回收机制。`consolidation_tier2.md` 早已勾勒方向，本版本落地为天级调度任务。
- **两套「上限」不要混淆**：现有 `maxSkillInject`/`maxMemoryInject`（`app_config.session` group）是**注入截断配额**——构建 system prompt 时从全量条目里取前 N 塞进 prompt，条目本身不受影响。本版本的 100/100/30 是**全新的存储级上限**——约束 skill/memory 资产本身的条目数量，靠 t2 的合并/归档动作达成。
- **铁律不变**：skill 无 delete，只能 `disable`；memory 只能 `archive`，不删除。t2 的「淘汰超限条目」必须走这两个既有动作，不新增物理删除路径。
- **复用现有写操作，不加批量接口**：`skill_manage`（create/patch/disable/enable）+ `memory_manage`（write/archive）已覆盖「新建合并版 + 归档/禁用旧条」所需的全部动作，t2 靠多次调用组合完成，不新增批量整理接口。

## 2. 本版本需求（产品化表达）

### 需求 1：整理任务配置（设置新增「整理」tab） — P0

**用户故事**：作为用户，我希望能开启/关闭每日自动整理、指定整理发生的时间和使用的模型，并且清楚这项整理具体在做什么。

**期望行为**：
- **入口**：应用设置新增「整理」tab（复用既有 `page-app-settings-merged` tab 树机制，位置建议排在「记忆」tab 之后、系统配置收起区分割线之前——即 `general → session → models → tools → memory → 整理（新）→ [分割线] → observability → plugin`；具体最终位置由 architect/coder 定，不影响功能）。
- **说明文案**：tab 顶部固定一行说明，**必须包含**：「这个整理是对 skill 和 memory 进行整合整理」（用户裁决的固定文案要求，一字不改）。
- **开关**：`enabled`（boolean）。**关闭时整理任务完全不存在**——不占用调度、不产生任何 LLM 调用；下方「每日整理时间」「整理模型」两项禁用/隐藏输入价值（不阻止查看，但不生效）。开启才激活天级调度。
- **每日整理时间**：`dailyTime`（HH:mm，本地时区，简单时间输入，不需要 4 预设/高级折叠——这是固定「每天一次」的单一时间点，比 `component-cron-freq-picker` 的通用频率选择更简单；架构落地时可直接复用现有 KV group + key-card 的通用输入形态，不必新造完整 cron 组件）。从这个时间点开始调度（"从这后面开始调度" = 之后每天到点触发一次）。
- **整理模型**：`modelId`（复用 `ComponentKeyModelPicker` 概念，与 `default_models` group 的 chat/summary 两个 model picker 同一套交互——trigger + 按 provider 分组下拉 + x 清除）。从已配置（enabled provider × enabled 文本 model）中选择；未选 = 未配置。
- **保存交互**：对齐现有 config 页 group 独立保存语义（page-tab 级 dirty 检测 + 保存/取消），三个字段（enabled/dailyTime/modelId）同属一个 group，一起提交。
- **可选：轻量可见性**（用户裁决「可选、别增复杂度」，本版本按最轻量形态设计）：tab 内追加一处**纯只读展示**——「上次整理时间」+ 一句话结果摘要（如「合并 2 条 · 归档 5 条」「本次无需整理」「未配置整理模型，已跳过」）。**不做**列表、不做详情钻取、不做手动触发按钮；不进 dirty/保存流程（纯展示，类似 observability 详情的只读信息区）。若从未整理过，显示「尚未整理过」。

**边界**：不提供「立即整理」手动触发入口（本版本只做定时自动，手动触发留 backlog）；不提供整理历史列表（只留最近一次摘要）。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | 打开应用设置 → 点「整理」tab → 看到说明文案（含「整合整理」字样）+ 开关（默认关）+ 每日时间 + 整理模型选择器 | 三项配置完整渲染；说明文案含用户裁决的固定句子 |
| UC-2 | 开关关闭态下打开 tab → 尝试改时间/模型 | 开关开启前，时间/模型不生效（关闭=整理任务不存在）；开启后可正常配置 |
| UC-3 | 开启开关 → 设整理时间为 04:00 → 选一个已配置模型 → 保存 → 重启应用 | 三项配置持久化生效（重启后仍是设定值） |
| UC-4 | 从未整理过时打开 tab | 「上次整理」区显示「尚未整理过」 |
| UC-5 | 某次整理执行后再打开 tab | 「上次整理」区显示时间 + 一句话摘要（合并/归档条数或跳过原因），无需任何操作即可见 |

---

### 需求 2：整理行为的产品语义 — P0

**用户故事**：作为长期使用的用户，我希望系统能自动帮我把持续积累的 skill 和 memory 去重、合并冲突内容、清理没用的，并且总数不失控，同时不会误删任何东西。

**整理对象与独立上限（source='agent' 计数口径）**：

| 域 | 计数对象 | 上限 | 备注 |
|----|---------|------|------|
| 全局 skill | `source='agent'` 的 global skill | ≤ 100 | workspace（项目级）skill **本版本 out of scope**，不整理、不计入 |
| 全局 memory | `source='agent'` 的 global memory | ≤ 100 | 与全局 skill 各自独立限制，互不共享额度 |
| 单 session memory | 该 session 内 `source='agent'` 的 session memory | ≤ 30 | **每个 session 各自独立限制**（不是跨 session 共享一个池） |

- **计数口径 = `source='agent'`**：用户手动创建/编辑（`source='user'`）的条目不计入上限、也不是整理对象——t2 只管 agent 自主产出的资产。
- **⚠️ 计数与可操作性的边界**：条目计入上限的口径（`source='agent'`）与「整理能不能动它」的口径（`evolvable` 治理开关）是两件事。极端情况下，一条 `source='agent'` 但 `evolvable=false` 的条目**计入上限，但整理任务动不了它**（合并/归档动作复用既有 `skill_manage`/`memory_manage` 工具，受既有 evolvable gate 约束，`evolvable=false` 一律拒绝写）。此时整理任务会尽力在可操作范围内收敛，无法保证严格收敛到上限以内——这是既有治理铁律（用户对 evolvable=false 资产的保护优先级更高）与容量目标的正常张力，不视为 bug。

**整理动作**：
- **查冲突/查无用**：识别内容重复、相互矛盾（新旧结论冲突）、长期无实际作用的条目。
- **合并**：把重复/相关的多条整合成一条更完整精炼的版本——建一条新的（`create`/`write`）+ 归档/禁用旧的（`disable`/`archive`），而非直接改写其一。
- **归档/禁用收敛超限**：当某域超过上限时，对可操作范围内价值较低（如已被合并、过时、冲突后判定为旧信息）的条目做归档/禁用，把数量收敛到限内。
- **永不物理删除**：所有淘汰动作都是 skill `disable` / memory `archive`（铁律，见「背景」），资产仍在磁盘，可恢复。

**执行顺序（用户裁决：严格串行，不并行）**：整理任务内部按「全局 skill → 全局 memory → 各 session memory」**逐个串行**执行，不并发；session 之间的整理也**逐 session 串行**（处理完一个再进下一个）。串行既让用户可预期「整理是依次进行、需要一定时间」，也天然规避了对同一批 skill/memory 资产的并发写冲突与资源争抢。

**session 整理范围**：只检查/整理**当天有新对话**的 session 的 session memory；当天无新对话的 session 不打扰、不整理。**若该 session 没有任何个人 skill/memory（即 session memory 为空——skill 无单会话层，此处仅看 session memory）→ 同样跳过，不做任何检查、不产生任何 LLM 调用**，即使当天确实有新对话。

**跳过语义（到点必发射，跳过在任务内部判断）**：
- 每日到点，整理任务**一定会触发**（不因「预判无事可做」而不触发）。
- 任务内部判断某个域/某个 session 当前无需整理（无冲突、无超限、无新增内容）→ 该域快速结束（fast finish），不代表任务没有执行。
- **无论是否有实际改动，本次调度都算「执行了一次」**——用户在设置页看到的「上次整理时间」会前进到本次触发时间，即使摘要是「本次无需整理」。

**错过补偿**：沿用调度器现有的补偿语义——如果预定时间到了但应用未开机（错过），下次开机后会自动补跑一次（不会因为错过多天而连续补多次，只补一次，从补跑那一刻起重新按每日周期排下一次）。用户只需理解「没开机错过了，开机后会补跑一次」，具体机制不在产品层展开。

**耗时与体量提示**：整理量可能较大（尤其首次整理积累已久的资产），执行可能需要一定时间；这属于后台任务，不阻塞用户当前会话使用，也不会打断用户正在进行的对话。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-6 | 全局 skill 数（source='agent'）积累超过 100 → 到达整理时间 → 整理任务执行 | 执行后全局 skill（source='agent'）数量收敛到 ≤100（可操作范围内）；被淘汰的条目状态为 disabled、非物理删除 |
| UC-7 | 某 session 当天有新对话且 session memory 存在重复/冲突内容 → 到达整理时间 | 该 session memory 出现合并后的新条目 + 旧条目被 archive（非删除） |
| UC-8 | 某 session 当天**没有**新对话 → 到达整理时间 | 该 session 的 session memory 不被检查/不被改动 |
| UC-8b | 某 session 当天**有**新对话，但该 session **没有任何** session memory（个人 skill/memory 均为空）→ 到达整理时间 | 该 session 不被检查、**不产生任何 LLM 调用**（与 UC-8 触发条件不同：本条是「有新对话但无记忆内容」而非「无新对话」） |
| UC-9 | 某域当前无冲突/无超限/无需整理 → 到达整理时间 | 该域快速结束（无改动），但「上次整理时间」仍前进到本次触发时间 |
| UC-10 | 应用在预定整理时间处于关机状态，错过一次 → 之后开机 | 开机后自动补跑一次整理（不追加成多次）；补跑完成后设置页可见更新的「上次整理时间」 |
| UC-10b | 到达整理时间，观测整理执行过程（全局 skill / 全局 memory / 各 session memory 均需处理） | 三块工作严格按「全局 skill → 全局 memory → 各 session」顺序逐个串行执行，任意时刻只有一块在跑；多个待整理 session 也逐个串行处理，不并发 |

---

### 需求 3：default_models.summary 文案消歧 — P0（本版顺带）

**背景**：`default_models` group 的 `summary` 字段现有 UI 文案为「默认整理模型」，但该字段实际用于**对话压缩**（compact 时的 summary 任务），与本版本新引入的「整理模型」（t2 概念）字面撞车、语义不同，极易混淆。

**变更**：把 `section-default-models-and-request`（会话 tab）中 `summary` 字段的 UI 文案从「默认整理模型」改为「**默认上下文压缩模型**」。**仅改前端展示文案**，字段名（`summary`）、数据契约、保存语义、testid（`key-card-summary` / `key-model-picker-summary` 等）**全部不变**。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-11 | 打开应用设置「会话」tab → 看 playground 默认模型 group 的第二个字段 label | 字段 label 显示「默认上下文压缩模型」，不再是「默认整理模型」 |

---

## 3. 关键用户路径（MANDATORY — 测试最低覆盖）

| ID | 用户操作链路 | 预期结果 | 类型 |
|----|-------------|---------|------|
| 路径 1 | 打开「整理」tab → 开启开关 → 配置每日时间 + 整理模型 → 保存 → 到达设定时间 → 整理任务自动触发执行 → （可选）回到 tab 查看「上次整理时间 + 结果摘要」 | 配置生效；到点自动整理；可选摘要区如实反映执行结果 | E2E + UT/API |
| 路径 2 | 已开启整理、设定时间已过 → 应用当天关机错过该时间点 → 之后开机 | 开机后自动补跑一次整理（at-most-once，不追加成多次） | UT（调度语义，无 LLM 不确定性） |
| 路径 3 | 到达整理时间，但某域当前无冲突/无超限/无新增内容 | 该域 fast finish（无改动）；但本次调度仍计为「已执行」，上次整理时间前进 | UT + API |
| 路径 4 | 某域（全局 skill / 全局 memory / 单 session memory）条目数（source='agent'）超过对应上限 → 整理执行 | 通过合并 + 归档/禁用，把该域收敛到上限以内（evolvable=false 的不可操作条目除外，如实反映而非报错） | API（真 LLM，整理动作） |
| 路径 5 | 开启整理开关但「整理模型」未配置 → 到达整理时间 | 任务静默 fast finish（不报错、不打扰用户），可选摘要区可如实显示「未配置整理模型，已跳过」 | UT + API |

**路径数**：5 条，覆盖配置生效、补偿、跳过语义、容量收敛、模型未配置降级。每条至少一个 UT/API/E2E case（v0.0.149 先例：调度/容量收敛属确定性逻辑走 UT 为主；真实合并/归档动作因涉及 LLM 判断走 API 真 LLM）。

---

## 4. 范围边界

### IN [v0.0.151.t2_consolidate]
1. 设置新增「整理」tab：开关 + 每日整理时间 + 整理模型（复用 `ComponentKeyModelPicker`）+ 固定说明文案
2. 全局 skill（source='agent'）冲突/无用检测 + 合并 + 归档/禁用收敛 ≤100
3. 全局 memory（source='agent'）同上，≤100
4. 当天有新对话的 session 的 session memory（source='agent'）整理，单 session ≤30
5. 到点必发射 + 内部 fast finish 判断（跳过也算执行）
6. 错过补偿（沿用调度器现有 at-most-once 语义）
7. 可选轻量可见性：「上次整理时间 + 一句话结果摘要」只读展示
8. default_models.summary UI 文案消歧为「默认上下文压缩模型」

### OUT [v0.0.151.t2_consolidate]
- workspace（项目级）skill 的整理（本版本只做 global skill）
- 手动「立即整理」触发入口（只做定时自动）
- 整理历史列表/详情钻取（只留最近一次摘要）
- 批量整理专用接口（复用现有 `skill_manage`/`memory_manage` 多次调用）
- 跨域共享额度 / per-source 细分配额（100/100/30 各自独立，不做更细粒度配额）
- 调度 job type 设计、独立 scope 整理 agent 的 prompt/tools 装配、单 session 上下文供给方式、锁/回滚机制（技术实现，architect 定）

---

## 5. 产品默认值（PRD 建议，需用户确认）

| 配置项 | 建议默认值 | 理由 |
|--------|-----------|------|
| 整理开关 `enabled` | **默认关闭** | 整理会产生真实 LLM 调用与资产改动，属新引入的自动化行为；对齐项目惯例（如 observability 默认关、web_search 需显式配置）——新增的、会消耗成本/改动用户资产的功能默认不自动开启，由用户主动选择开启 |
| 每日整理时间 `dailyTime` | **默认 04:00**（本地时区） | 凌晨低峰期，用户通常不在使用应用，避免整理任务与用户实时对话争抢注意力/资源；对齐竞品参考（claude-code dreaming 同样倾向选空闲时段） |
| 整理模型 `modelId` 未配置时的行为 | **fast finish + 记录跳过原因，不报错、不打扰用户** | 与「到点必发射，内部判断跳过」的既定语义一致——未配置模型 = 无法执行的前置条件缺失，视同「本次无需/无法整理」，静默跳过而非中断用户或弹错误提示；可选摘要区如实展示跳过原因供用户知晓 |

---

## 6. spec 影响面（架构阶段细化 — PRD 不擅改 tech/ui spec）

| spec | 变更点（PRD 给方向，architect 落具体） |
|------|----------------------------------------|
| `tech/agent/memory/[P1]consolidation_tier2.md` | 从 P1 占位转为本版本落地：merge/prune/矛盾解决/容量回收的具体机制、沙箱化独立 scope agent 设计、防递归、失败隔离 |
| `tech/scheduling/`（新 job type） | 新增 app 级调度 job（无 owner session，区别于现有 heartbeat=squad 级/cron=session 级）；lastFiredAt/at-most-once 补偿语义复用现有引擎不变量 |
| `tech/config/[P0]app_config.md` §3 | **新增 `consolidation` group**（建议 key=default，data={enabled, dailyTime, modelId?}，默认 enabled=false / dailyTime='04:00' / modelId=undefined），group 集合追加声明 |
| `ui/components/app-dev-config-page/page-app-settings-merged.md` | tab 树新增「整理」（tab id 建议 `consolidation`）+ group 映射；系统配置收起区维持不变 |
| 新增 `ui/components/app-dev-config-page/section-consolidation-config.md`（建议） | 新 group `consolidation` 的 section spec（开关 + 时间输入 + model picker + 只读摘要区，testid 契约），由 coder 编码前产出（先 spec 后实现） |
| `ui/components/app-dev-config-page/section-default-models-and-request.md` | `summary` 字段 label 文案由「默认整理模型」改「默认上下文压缩模型」；testid/契约不变 |
| `tech/agent/skills/[P0]skill_manage_tool.md` + `tech/agent/memory/[P0]memory_manage_tool.md` | 无接口变更（t2 复用现有 action），仅需在触发时机章节补充「时机 C·天级 t2 调度」引用 |
| `tech/agent/multi_agent/[P1]subagent_templates.md` | 若采用剪裁 agent 方案，t2 整理 agent 的 systemPrompt/tools/modelId 数据结构参照 |

---

## 7. 对齐 spec 核对结论

PRD 引用的概念绝大多数对齐已有 ui/tech spec；以下为新概念清单（需先落 ui/tech spec，交 architect）：

| PRD 引用 | spec 对齐情况 | 处置 |
|----------|--------------|------|
| skill/memory 只 archive/disable 不删 | `skill_manage_tool.md §3/§8` + `memory_manage_tool.md §3/§6` 已有 | 纯引用，无需改 |
| evolvable gate（agent 路径受限） | `skill_manage_tool.md §4` + `memory_manage_tool.md §5.1` 已有 | 纯引用，t2 复用既有 gate，不新增豁免 |
| source='agent' 计数口径 | `memory_definition.md`（v0.0.149 新增 source 字段）+ skill frontmatter 既有 source | 纯引用；skill 侧目前 source 枚举含 system/user/agent，t2 只认 agent，无需扩展枚举 |
| 调度器 lastFiredAt/at-most-once 补偿 | `scheduling/index.md ④` 已有 | 纯引用，无需改 |
| `ComponentKeyModelPicker` 模型选择 | `common/component-key-model-picker.md` 已有 | 纯引用，t2 整理模型复用同一组件 |
| config 页 tab/group 独立保存机制 | `page-app-settings-merged.md` 已有机制 | 纯引用既有机制 |
| **「整理」新 tab + 新 `consolidation` group** | tab 树/group 集合当前均**无**此项 | **新概念，需先落 ui/tech spec**（`page-app-settings-merged.md` 加 tab、`app_config.md` §3 加 group）——本文档 §6 已给方向，architect 落具体 |
| **新 app 级调度 job type（无 owner session）** | `scheduling/index.md` 现有 job type 仅 heartbeat（squad 级）/cron（session 级），无「无 session 的系统任务」先例 | **新概念，需先落 tech spec**（`scheduling/` 新增 job type 文档）——不属本 PRD 范围，仅记方向 |
| **独立 scope 整理 agent（专用 system prompt + tools，无 skill 注入）** | `agent_interface_and_loop/[P0]agent_loop_forked.md`（forked 不变量）+ `multi_agent/[P1]subagent_templates.md`（剪裁 agent 数据结构）已有相邻概念，但「t2 专用整理 agent」本身未定义 | **新概念，需先落 tech spec** —— 技术实现细节（属 PRD 范围外，仅在 §4 OUT 中标注） |
| 单 session 上下文供给方式（预组装/工具/assemble 处理器） | 无对应 spec，用户已在裁决中给出三选范围 + 推荐方向（context.md findings） | **新概念，需先落 tech spec** —— 纯技术选型，PRD 不展开 |

**对齐结论**：
- **纯引用现有概念（无需新发明）**：skill/memory 治理铁律（disable/archive）、evolvable gate、source 字段语义、调度器补偿不变量、`ComponentKeyModelPicker`、config 页 tab/group 保存机制。
- **需 architect 落的新概念**（PRD 已给产品方向，见 §6）：「整理」tab + `consolidation` group、新调度 job type、独立整理 agent 装配、单 session 上下文供给方式。这些是本版本核心的新功能载体，PRD 只约束「用户可感知的配置项/行为语义/默认值」，不越权定义技术实现。
- **无偏离已确认决策**：本 PRD 逐条对齐 `states/user_query.md` v0.0.151 段的用户裁决（到点必发射/独立 scope agent/复用现有 manage 接口/source='agent' 计数口径/可选轻量可见性/沿用现有补偿语义/两处文案）。

---

## 8. 版本

```yaml
version: 1.1
intro_version: v0.0.151.t2_consolidate
note: |
  v0.0.151.t2_consolidate 引入天级 t2 整理任务：设置新增「整理」tab（开关+每日时间+整理模型）；
  对 source='agent' 的 skill(global≤100)/memory(global≤100，session≤30) 做冲突检测+合并+归档/禁用容量收敛；
  复用现有调度补偿语义（at-most-once）+ 现有 skill_manage/memory_manage 写操作（不新增批量接口）；
  顺带消歧 default_models.summary UI 文案为「默认上下文压缩模型」。
  [1.1 补充裁决] 整理三块工作（全局 skill/全局 memory/各 session memory）严格串行执行，不并行；
  session 之间也逐个串行。session 当天有新对话但 session memory 为空（无个人 skill/memory）→
  同样跳过，不检查、不产生 LLM 调用。
  本文档为 version_log 增量；overall 同步（04-config-center-ui.md + 06-skill.md + 09-memory.md）
  由 doc-modifier 在阶段 5 完成。技术实现（调度 job type、独立整理 agent 装配、单 session 上下文
  供给方式、锁/回滚机制）留给 specs/tech/ 与 change_plan.md，本 PRD 不展开。
```
