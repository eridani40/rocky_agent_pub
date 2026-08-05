# v0.0.149.memory_opt — 限制 skill/memory 注入数量 + 会话 config tab — PRD 变更日志

> 引入版本 v0.0.149.memory_opt · 2026-07-15
> 一句话：给 system prompt 的 skill / memory 注入加「按来源分组 + 总量上限」配额，避免条目膨胀挤占上下文；并在应用设置新增「会话」tab，集中管理注入数量 + playground 默认模型 + LLM 请求参数。
> overall 快照：本次产出仅 version_log；overall 同步由 doc-modifier 在阶段 5 完成（`04-config-center-ui.md` + `06-skill.md` + `09-memory.md`）。
> 概念权威源（PRD 对齐，非新发明）：
> - `specs/tech/agent/context/[P0]system_prompt.md` §4（注入链：skills mapper order4 / memory_user order6 / memory_session order7）
> - `specs/tech/agent/skills/[P0]skill_definition.md` §2（skill frontmatter 已有 `source` system/user/agent + `production_method`）
> - `specs/tech/agent/memory/[P0]memory_definition.md` §3（memory entry 结构；**缺 source/updatedAt**，本版本补）
> - `specs/tech/agent/memory/[P0]memory_injection.md`（memory_user / memory_session 两 mapper）
> - `specs/tech/config/[P0]app_config.md` §3（config group 结构：§3.4 llm_request / §3.7 default_models）
> - `specs/ui/components/app-dev-config-page/page-app-settings-merged.md`（config 页 tab→group 映射）
>
> 本质：**对已有注入链加一道「分组排序截断」逻辑；memory 补 source/updatedAt 两字段对齐 skill；UI 纯 section 重组。无新功能概念。**

## 1. 背景与现状（先对齐，再改）

**注入链现状（要加配额的痛点）**：
- skill 经 `system_prompt.md §4` 的 `skills` mapper（order 4，stable tier）注入 L0 catalog（`{{skills_list}}` ← `config.skills.entries`），**所有 active skill 全量进 prompt**。
- memory 经 §4 的 `memory_user`（order 6，stable）+ `memory_session`（order 7，context）两 mapper 注入 L0（name+intro，v0.0.112 翻转），**两 scope 全量 active entry 进 prompt**。
- **共同痛点**：L0 catalog/index 无数量上限——条目持续增长（用户积累 skill、agent 自动整理产 memory）→ stable/context 段持续膨胀；而 `budget_truncate` reducer **只裁 context/volatile，不裁 stable**（skill + user_memory 都是 stable），stable 段超量无自愈机制，挤占 prompt cache 命中率与有效预算。

**数据模型现状（memory 的数据缺口）**：
- skill frontmatter 已有 `source: user|agent|system`（skill_definition §2）+ `production_method`——「按来源分组」数据现成，**纯链路接线**。
- memory entry（memory_definition §3）有 name/intro/type/body/why/howToApply/archived/evolvable，**缺 `source` + `updatedAt`**——分组与组内排序无法做。memory 两介质（user = app_config record entries[] / session = per-session md frontmatter）多 entry 共享一个 record/md 文件，**无 per-entry 文件 mtime**，组内排序必须靠 entry 内 `updatedAt` 字段。

**config 现状（tab 与 group 解耦）**：
- `page-app-settings-merged.md` tab 树：general / models / tools / memory / observability / plugin。模型 tab 含 providers + default_models + llm_request 三 group。
- tab 与 group 是解耦的（§tab→group 映射只是渲染组织）——把 default_models / llm_request 从模型 tab 挪到新「会话」tab 是**纯 UI section 重组，group 名不变、后端不动**。

## 2. 本版本 4 条需求（产品化表达）

### 需求 1：限制 skill 注入数量（按来源分组 + 总量上限） — P0

**用户故事**：作为深度用户，我希望系统提示注入的 skill 有数量上限并按重要性排序，以便 skill 积累多了也不会把系统提示撑爆、能保留最该用的那些。

**注入顺序（分组优先级，先组间后组内）**：
1. **builtin**（系统内置，source=`system`）
2. **用户手动**（用户安装/手写/create，source=`user`）
3. **ai 维护**（agent create/整理产出，source=`agent`）
- 组内按 `updatedAt` 倒序（最近更新的优先）。

**总量上限**：取前 N（默认 50），N 可在应用设置「会话」tab 配置。**数量语义 = 总量**（非 per-source 配额），按上述分组优先级连续取，取到 N 截止（例：80 条 skill、上限 50 → builtin 全要 + user 取够配额 + agent 不进）。

**断言落点**：system prompt 中 `skills` mapper 输出的 catalog 条目数 ≤ N，且按分组顺序取前 N。

### 需求 2：限制 memory 注入数量（按四类分组 + 总量上限） — P0

**用户故事**：作为深度用户，我希望长期记忆注入有数量上限并按「会话手记优先于全局、手动优先于自动」排序，以便记忆积累多了也能保住当前最相关的。

**注入顺序（四类分组优先级）**：
1. **session 手动**（session 级 + 用户手动增加）
2. **session 自动**（session 级 + agent 自动增加）
3. **全局手动**（user/global 级 + 用户手动增加）
4. **全局自动**（user/global 级 + agent 自动增加）
- 组内按 `updatedAt` 倒序。

**总量上限**：取前 N（默认 50），N 可在应用设置「会话」tab 配置。**数量语义 = 总量**（同需求 1，跨两 scope 四类连续取到 N 截止）。

**两 scope 合并视图**：memory_user（stable）+ memory_session（context）两 mapper 的合并 L0 在分组截断后，仍分别由各自 mapper 贡献 fragment（tier 不变），但**两 mapper 协同共享同一总量配额**——架构上由 architect 决定具体协同方式（如统一在 mapper 前做全局 selection，再分发给两 mapper；或在 reducer 层处理）。PRD 只约束「最终注入的 memory L0 条目数 ≤ N 且按四类顺序取前 N」。

**断言落点**：system prompt 中 memory L0（name+intro）条目数 ≤ N，且按四类顺序取前 N。

### 需求 3：memory 数据模型补 source + updatedAt + migration — P0

**数据缺口（对齐 skill 的 source 命名）**：
- memory entry 新增字段 `source: 'user' | 'agent'`：
  - `user` = UI 手动入口写入（用户手动增加）
  - `agent` = `memory_manage` 工具 create 写入（agent 自动增加）
- memory entry 新增字段 `updatedAt`（ISO 时间戳）：组内排序依据。
- **`evolvable` 不参与 source 推断**——evolvable 只管「是否可进化」（memory_definition §5.1），不滥用做来源判定。

**存量数据 migration**：
- **source**：存量 entry 统一标 `agent`（保守默认，对齐「多数记忆由 agent 整理产出」的现实分布；不阻断用户后续编辑改 source）。
- **updatedAt**：存量 entry 按创建时间补齐（无创建时间则用 migration 执行时刻）。
- migration 范式：**bootstrap 启动一次性**、**字段缺失为 marker**（幂等非破坏，对齐 `migrateWebSearchProviderId` 范式，见 context.md migration 节）——只补缺失字段，不覆盖已有值、不清其他字段、不 throw 阻塞启动。
- migration 覆盖两介质：
  - user memory：遍历 `app_config` record `user_memory/default` 的 `entries[]`
  - session memory：遍历 `sessions/*/session_memory.md` frontmatter

**断言落点**：旧数据首次启动后，每条 memory entry 有 source + updatedAt；注入排序按 updatedAt 正常工作（路径 4）。

### 需求 4：会话 config tab（新 tab + section 重组 + 新 group） — P0

**用户故事**：作为用户，我希望在一个地方集中管理「影响每次会话构建」的配置（注入数量、默认模型、LLM 请求），而不是分散在多个 tab。

**4.1 新 tab「会话」**：
- 位置：通用（general）tab 下，**排第二**（即 tab 树顺序：general → **session（新）** → models → tools → memory → observability → plugin）。
- tab id 建议沿用 group 名 `session`（对齐既有 tab/group 命名习惯，最终由 architect/coder 定）。

**4.2 新 group `session`（注入数量配置）**：
- 新 KV group `session`（app_config），单 record（`key` 固定 `"default"`），两个 key：
  - `maxSkillInject`：最大注入 skill 数量（数字，默认 50，范围 ≥ 0 的整数）
  - `maxMemoryInject`：最大注入 memory 数量（数字，默认 50，范围 ≥ 0 的整数）
- **缺失回退 50**：record 缺失 / key 缺失 → 回退默认 50（属「可选覆盖调参组」语义，对齐 app_config §3.14）。
- UI 交互：两个 number input（对齐现有 `key-number` 形态，见 section-default-models-and-request §testid），随会话 tab 整组延迟保存（page-tab 级 save-bar）。

**4.3 section 重组（纯 UI 迁移，group 名不变、后端不动）**：
- 把 `default_models`（playground 默认模型）group 从「模型」tab 挪到「会话」tab。
- 把 `llm_request`（LLM 请求）group 从「模型」tab 挪到「会话」tab。
- 模型 tab 剩余：providers（含 detail 二级页行为，保持不变）。
- 两 group 的 group 名、data 契约、testid、保存语义**全部不变**（只是渲染容器换了 tab）。

**断言落点**：
- 会话 tab 选中时右栏渲染 `session` + `default_models` + `llm_request` 三 group（dom 可断言 group 容器存在）。
- 模型 tab 选中时右栏不再含 `default_models` / `llm_request` group 容器。
- 配置注入数量 + 看到 default_models / llm_request 字段 + 保存生效。

## 3. 关键用户路径（MANDATORY — 测试最低覆盖）

> 本版本无新 AT/ET case（纯确定性逻辑：分组排序截断 + config CRUD + migration，无 LLM 不确定性场景）。验证 = **UT 为主 + system prompt chain 验证 + 冒烟集回归**。每条路径供 UT 覆盖参考；冒烟集回归保证 config/skill/memory 注入主链路无回归。

| ID | 用户操作链路 | 预期结果（断言落用户价值） |
|----|-------------|----------------------------|
| 路径 A | 打开应用设置 → 点「会话」tab → 看到「最大注入 skill 数量」/「最大注入 memory 数量」两个 number input（默认 50）+ playground 默认模型（chat/summary）+ LLM 请求（stall_tool_s / max_attempts）group → 改 maxSkillInject=5 → 点保存 → 重启 → 仍为 5 | 会话 tab 集中承载注入数量 + 默认模型 + LLM 请求；配置持久化生效 |
| 路径 B | 环境有 80 条 skill（30 builtin + 40 user + 10 agent），maxSkillInject=50 → 构建一次 system prompt | skills mapper catalog 只含 50 条：30 builtin 全要 + user 前 20（updatedAt 倒序）+ agent 不进 |
| 路径 C | 环境有 80 条 memory（30 session 手动 + 30 session 自动 + 10 全局手动 + 10 全局自动），maxMemoryInject=50 → 构建一次 system prompt | memory L0（两 mapper 合并）只含 50 条：30 session 手动全要 + 20 session 自动（updatedAt 倒序）+ 全局两类不进 |
| 路径 D | 旧数据首次启动（user_memory entries[] 无 source/updatedAt + sessions/*/session_memory.md frontmatter 无 source/updatedAt）→ migration 跑 → 构建一次 system prompt | 每条 memory entry 有 source（存量=agent）+ updatedAt（按创建时间补）；memory L0 按 updatedAt 倒序正常注入 |
| 路径 E | 模型 tab 选中 → 右栏只含 providers group（list/detail） | default_models / llm_request group 容器不在模型 tab（已迁会话 tab） |

> 路径 B/C 是核心断言：分组顺序 + 总量上限 + 组内 updatedAt 倒序。UT 直接测 mapper 输出（catalog / L0 条目集合），不需要真 LLM。
> 路径 D 是 migration 幂等性 + 排序接通：UT 测 migration 函数（marker 判定、字段补齐、二次执行幂等）+ 注入链路用迁移后数据正常排序。

## 4. spec 影响面（架构阶段细化 — PRD 不擅改 tech/ui spec）

| spec | 变更点（PRD 给方向，architect 落具体） |
|------|----------------------------------------|
| `tech/agent/memory/[P0]memory_definition.md` §3 | entry schema **新增 `source: user\|agent` + `updatedAt`**；§5.1 evolvable 注明「不参与 source 推断」；存量默认 source=agent + updatedAt 按创建时间补 |
| `tech/agent/memory/[P0]memory_injection.md` §2/§3 | 注入加「四类分组顺序 + 总量上限」逻辑；两 mapper 如何协同共享配额由 architect 定 |
| `tech/agent/context/[P0]system_prompt.md` §4 skills mapper | skills 注入加「三类分组顺序（builtin→user→agent）+ 总量上限」逻辑（读 `app_config/session` 的 maxSkillInject） |
| `tech/config/[P0]app_config.md` §3 | **新增 `session` group**（§3.X：key=default，data={maxSkillInject, maxMemoryInject}，默认 50，缺失回退 50，属「可选覆盖调参组」§3.14 语义） |
| `tech/config/[P0]app_config.md` §3 集合声明 | group 集合追加 `session` |
| `ui/components/app-dev-config-page/page-app-settings-merged.md` | tab 树新增 `session`（排第二，general 下）；`session` tab 映射 groups = {session, default_models, llm_request}；`models` tab 映射 groups 减为 {providers} |
| `ui/components/app-dev-config-page/section-default-models-and-request.md` | 文档注 tab 归属变更（会话 tab），文件本身（渲染/testid/数据契约）不变 |
| 新增 `ui/components/app-dev-config-page/section-session-config.md`（建议） | 新 group `session` 的 section spec（两个 number input + testid 契约），由 coder 编码前产出（先 spec 后实现） |
| `tech/config/[P0]app_config.md` §3.7 default_models / §3.4 llm_request | 文档注 UI tab 归属变更（group 名/契约不变，仅渲染 tab 迁移） |
| migration（bootstrap 调用点） | 新增 `migrateMemorySourceUpdatedAt`（对齐 migrateWebSearchProviderId 范式，bootstrap 启动一次性、字段缺失为 marker、幂等非破坏），覆盖 user memory（app_config record entries[]）+ session memory（sessions/*/session_memory.md frontmatter） |

## 5. 对齐 spec 核对结论

PRD 引用的概念全部对齐已有 ui/tech spec，**无矛盾、无新发明概念**。具体：

| PRD 引用 | spec 对齐 | 是否需新增/改 spec |
|----------|-----------|---------------------|
| skills mapper（order4, stable） | `system_prompt.md §4` 已有 | **改**：mapper 加分组排序截断逻辑（architect） |
| memory_user/memory_session mapper（order6/7） | `system_prompt.md §4` + `memory_injection.md §2` 已有 | **改**：mapper 加分组排序截断 + 两 mapper 协同配额（architect） |
| skill source（system/user/agent） | `skill_definition.md §2` 已有 | 纯引用，无需改 |
| memory source/updatedAt | `memory_definition.md §3` **缺** | **改**：entry schema 加两字段（architect） |
| evolvable 不参与 source 推断 | `memory_definition.md §5.1` 已有 evolvable 定义 | 纯引用 + 一句注记，无需结构性改 |
| app_config session group | `app_config.md §3` group 集合**无** session | **改**：新增 session group 条目（architect） |
| default_models / llm_request group | `app_config.md §3.4/§3.7` 已有 | 纯引用（UI 归属变更不改 group 契约） |
| config 页 tab 树 | `page-app-settings-merged.md` 已有 | **改**：tab 树加 session + group 映射调整（coder 编码前由 ui spec 落） |
| default_models/llm_request section | `section-default-models-and-request.md` 已有 | 纯引用（tab 归属注记，文件/testid 不变） |
| migration 范式 | context.md 引用的 `migrateWebSearchProviderId` 范式 | 纯引用 + 新增 migration 实现（architect/coder） |
| `key-number` number input 形态 | `section-default-models-and-request.md §testid` 已有 key-number-* 模式 | 纯引用（新 section 复用既有 number input 组件） |

**对齐结论**：
- **纯引用现有概念（无需新发明）**：skill source / evolvable / app_config group 机制 / config 页 tab 机制 / key-number input / migration 范式 / mapper→reducer→builder 注入链。
- **需 architect/coder 落的 spec 改动**（PRD 不擅改，列在 §4）：memory_definition 加两字段、memory_injection + system_prompt skills mapper 加分组排序截断逻辑、app_config 加 session group、page-app-settings-merged tab 树调整 + 新 section spec。这些是**对已有概念的行为/数据扩展**，非新概念——属于 architect 阶段 work（概念已在，PRD 给方向）。
- **无偏离已确认决策**：4 条需求逐字对齐用户确认的 4 项决策（限制 skill 注入 / 限制 memory 注入 / memory 补字段 + migration / 会话 tab）；测试策略照实写（无新 AT/ET，UT + chain 验证 + 冒烟集回归）。

## 6. 版本

> 本文档为 version_log 增量；overall 同步（`04-config-center-ui.md` + `06-skill.md` + `09-memory.md`）由 doc-modifier 在阶段 5 完成。变更历史归 `specs/tech/<KB>/log.md` + `specs/tech/version_logs/v0.0.149.memory_opt/change_log.md`（架构阶段产出）。
