# Memory 子系统 — 产品需求文档 [v0.0.21] [v0.0.112 modified] [v0.0.149 modified] [v0.0.151.t2_consolidate modified] [v0.0.164.memory_opt modified]

> version: 2.4 · 引入版本 v0.0.21 · 最后更新：2026-07-26（v2.4：**[v0.0.205.t2_cons]** scope squad→group 全链改名（group=squad 或 classroom 团队共享）+ T1 一级整理 agent 路径默认 scope 翻 session（工具/UI 默认 global 不变）+ prod global memory 一次性清空（介质迁出 app_config 到 `<dataDir>/memory/` per-entry md，不迁移）；§9.2.6 modified。v2.3：**[v0.0.164.memory_opt]** memory scope 扩 3 值 `global|squad|session`（新加 squad 层承接 squad 内共享规则/角色行为）+ squad_id 从 ctx 自动填 + 无 squad 会话拒绝 `[invalid_input] not_in_squad`；注入配额 4 类 → 6 类（新增 squad 手/自，squad 层夹中间：session→squad→global）；tier2 加质量审查段（Phase 2.5）判 3 类质量问题；新增手动触发「立即整理」入口（`POST /consolidation/run` fire-and-forget + AppTaskLock 撞车防护 + 设置页按钮）；routing_decision 加反例清单 + squad 规则；skill resolver 加 squad ws 目录源（内部 4 层合并，对外 skill_manage/skill 工具 scope enum 零暴露）。v2.2：v0.0.151.t2_consolidate 二级整理天级落地；v2.1：v0.0.149：注入总量配额 + entry 加 source/updatedAt + migration；v0.0.112 长期记忆增强：按需加载 + evolvable 治理 + 300 词硬限制 + manage 路由提示词 + scope 统一命名）
> 本文承载 Memory 子系统全量产品定义。增量见 `specs/prd/version_logs/v0.0.112.memory/change_log.md` + `specs/prd/version_logs/v0.0.149.memory_opt/change_log.md` + `specs/prd/version_logs/v0.0.151.t2_consolidate/change_log.md`。
> 概念权威源：`specs/tech/agent/memory/`（memory_definition / memory_manage_tool / memory_injection / consolidation_tier1 / **consolidation_tier2**）+ `specs/tech/scheduling/[P1]consolidation_job.md` + `specs/tech/agent/skills/`（对齐样板）+ `specs/ui/components/chat-page/section-memory-panel.md` + `specs/ui/components/app-dev-config-page/section-user-memory.md` + `specs/ui/components/app-dev-config-page/section-consolidation-config.md` + `specs/api/overall/15-memory-ui.md`。

## 目录

| 章节 | 说明 |
|------|------|
| §9.1 产品概述 | memory 定位、目标用户、核心价值 |
| §9.2 功能需求 | 6 个功能：纯读工具 / 按需注入 / evolvable 治理 / 字符长度限制（intro ≤50 / body ≤500）/ manage 路由提示词 / scope 统一命名 |
| §9.3 关键用户路径（MANDATORY） | 7 条核心路径（测试最低覆盖） |
| §9.4 范围边界（IN / OUT） | v0.0.112 scope |
| §9.5 设计决策 | 与 skill 对称的模型选择 |

---

## 9.1 产品概述

### 9.1.1 定位

memory 是 agent 的**长期记忆**——跨 session/session 内沉淀的用户偏好、事实、决策、教训（结构化 md + frontmatter）。支撑 agent 越用越懂用户/项目。**三个 scope**：**global（跨 session 稳定，全局一份）** + **group（squad/classroom 团队内共享规则/角色行为，per-group 一份）** + **session（当前 session 工作上下文）**。

一句话：**agent 记住该记的，用户随时可看可改，加载不撑爆上下文。**

### 9.1.2 目标用户

- **终端用户**：在聊天区右上悬浮菜单「长期记忆」弹层（session 级，**[v0.0.131]** 从原 ws-panel tab 迁入，二级视图新建/编辑，见 `specs/ui/components/chat-page/component-memory-modal.md`）和应用设置「全局长期记忆」tab（global 级）查看/编辑/归档/新建 memory。
- **agent**：注入侧只见每条 memory 的 `name + intro`（L0）；需要正文时调 `memory` 纯读工具按需 `read`，或用 `search` 关键词定位。自动总结时按路由规则把经验落到 memory（而非 skill）。
- **自动化（verifier）**：curl memory API、真 LLM 验证 agent 触发 `memory` / `memory_manage` 工具。

### 9.1.3 核心价值 [v0.0.112]

1. **按需加载（对齐 skill L0/L1）**：注入只带 name+intro，正文经 `memory` 工具按需读——条目再多也不撑爆上下文。
2. **用户完全控制**：`evolvable` 只挡 agent 自动进化路径；UI 用户永远全字段可编辑，无置灰、无防呆。
3. **精炼强制**：单条正文硬限 intro ≤50 字符 / body ≤500 字符，逼密度、防膨胀。
4. **记对地方**：manage 工具提示词写清「skill vs memory / global vs session」两步路由，agent 自动总结不落错。

---

## 9.2 功能需求

### 9.2.1 memory 纯读工具（`memory`）[v0.0.112]

**描述**：新增独立 `memory` 纯读工具（与写侧 `memory_manage` 分离，对称 `skill` 与 `skill_manage`），供对话中按需加载记忆正文（progressive disclosure L1）。
**优先级**：P0
**用户故事**：作为 agent，我希望注入侧只看到记忆名+简介、需要时再按需读正文，以便记忆条数增长时上下文不被撑爆。

| action | 入参 | 返回 | 说明 |
|--------|------|------|------|
| `read` | `{scope?, name}` | 单条**完整正文**（body + why + howToApply） | L1 按需读，等价 `skill.read` |
| `search` | `{keyword, scope?}` | 命中条目 **name + intro 列表（不含正文）** | 匹配所有字段（name/intro/type/正文），返回轻量索引供定位 |

- **read vs search 边界**：只有 `read` 返回正文；`search` 只回 name+desc（定位后再 read），避免 search 把正文倒进上下文。
- **scope 取值**：`global | session`，可选（不传则跨两 scope 搜/读）。
- **读取实现共享**：与 `memory_manage.read` 共用同一份读取逻辑（复用不新造）。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-M1 | 真 LLM 会话中要求 agent 回忆某条已存记忆 → agent 调 `memory.read(name)` | 工具返回该条完整正文（body+why+how），agent 据此响应 |
| UC-M2 | 会话中给关键词 → agent 调 `memory.search(keyword)` | 工具返回命中条目 name+intro 列表，**不含正文** |

### 9.2.2 按需注入（翻转整文件注入）[v0.0.112]

**描述**：`memory_injection` 的 user/session 两个 mapper 改为**只注入 name + intro（L0）**，不再 whole-file 注入正文。正文一律经 `memory` 工具按需读。
**优先级**：P0
**用户故事**：作为用户，我希望积累大量长期记忆后 system prompt 不被正文撑爆，agent 仍能按名索引到需要的记忆。

- 翻转 `memory_injection.md §3`「whole-file 整体注入」现状与 `index.md ④ 核心设计原则 4`——此为**核心设计原则变更**，需架构同步（见版本 change_log「spec 影响」）。
- 注入内容 = 每条 memory 的 `name + intro`（对齐 skill L0 catalog）。session_memory 仍是 context tier（超预算可裁）；global(user) 是 stable tier。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-M3 | 存在若干 memory → 新建 session → 查首条 system message / system-prompt 调试端点 | fragment 含各条 name+intro，**不含 body 正文** |

### 9.2.3 evolvable 治理 [v0.0.112]

**描述**：memory 引入 `evolvable` 字段（同 skill 语义），只约束 agent 自动进化路径；UI 用户永远全字段可编辑。
**优先级**：P0
**用户故事**：作为用户，我希望内置/我手写的记忆不被 agent 擅自改写，但我自己想改时随时能改（不置灰、不防呆）。

- **默认值按来源**：agent 自动总结生成（consolidation/工具写）= `evolvable=true`；用户 UI 手写 / 内置 = `evolvable=false`。
- **agent 路径受限**：`memory_manage` 对 `evolvable=false` 记忆的进化性写（更新既有条目 / 归档）拒绝（具体 gating 由架构定）。
- **UI 全开**：UI 用户可改一切——正文、type、把 evolvable 从 false 切 true、归档/恢复。**无 lock、不置灰、不防呆**（用户对自己 dataDir 资产有完全控制权）。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-M4 | 应用设置「全局长期记忆」→ 打开一条 evolvable=false 的内置/手写记忆 → 改正文并保存 | 保存成功，正文更新，编辑器无任何字段置灰 |

### 9.2.4 正文长度硬限制（intro ≤50 / body ≤500 字符）

**描述**：单条 memory 的 intro 限制 ≤50 字符、body 限制 ≤500 字符（trim 后 `str.length`），`memory_manage.write`（及 UI POST/PATCH）创建/更新时超限 hard error 拒绝。
**优先级**：P0
**用户故事**：作为系统，我希望强制记忆精炼，逼 agent 写结论而非流水账。

- **计数口径（字符数）**：trim 后 `str.length`（CJK 与 ASCII 均计 1），intro > 50 或 body > 500 拒绝。单点 `app/server/src/memory/policy.ts INTRO_CHAR_LIMIT`/`BODY_CHAR_LIMIT` + `MemoryCharLimitError`。
- **执行时机**：仅写入侧（write/patch）创建/更新校验；纯读侧不校验。落 dir store `writeLocked` 服务层单点（覆盖 agent 工具 + UI HTTP 两路径）。超限返回明确错误（含 field + 当前计数 + 上限）。
- **存量豁免**：只卡新写入/更新；已存在的超长记忆不追溯报错（grandfather）。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-M5 | 触发 agent/UI 写一条 body 超 500 字符的 memory | write 被拒（hard error），返回 field + 当前计数 + 上限；条目未落盘 |

### 9.2.5 manage 工具路由提示词 [v0.0.112]

**描述**：在 `skill_manage` / `memory_manage` 工具 description + 自动总结 fork prompt 三处写清「两步决策」路由规则，避免 agent 用混。
**优先级**：P0
**用户故事**：作为 agent，我在自动总结时能正确判断该经验落 skill 还是 memory、落 global 还是 session。

- **第一步（skill vs memory）**：一套要照着执行的步骤/方法（how-to）→ skill；会改变后续判断的事实/偏好/约束/教训（what & why）→ memory；项目代码/架构事实 → 都不写（归 specs/代码）。
- **第二步（global vs session）**：跨项目/会话通用 → global；仅本项目/本会话有效 → session。
- **三处落点**：`memory_manage` description、`skill_manage` description、consolidation fork prompt（`post-compact-consolidation`，主战场）。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-M6 | 真 LLM 会话含「可复用方法」+「用户偏好结论」两类信息 → 触发自动总结 | 方法落 skill、结论落 memory，未落错子系统 |

### 9.2.6 scope 统一命名 global/group/session + 默认 global [v0.0.112] [v0.0.205.t2_cons modified]

**描述**：memory / skill 对外 scope 词汇统一为 `global` / `session`（仅改名不改底层粒度）；`memory_manage.write` / `skill_manage.create` 默认 `global`。
**[v0.0.205.t2_cons modified]**：
- memory scope 扩三层 `global|group|session` 全链统一（`group` = squad 或 classroom 团队共享，替代旧 `squad` 命名；UI 端点仍只暴露 global/session 两值，group 不进 UI）。
- **T1 一级整理（compact 后 fork-2）agent 路径默认 scope 翻转为 `session`**（fork prompt 专属覆盖段；`memory_manage.write` 工具默认与 UI 手动新建默认仍 `global` 不变——只修 agent 自动路径误判，保留用户对全局的显式控制权）。
- **prod global memory 一次性清空**：global 介质从 `app_config/user_memory` record 迁出到 `<dataDir>/memory/<name>.md`（per-entry md），**不做数据迁移**——升级后旧 record 内容不再可见（应用设置「全局长期记忆」tab 与 chat 记忆面板 global tab 均空），新介质从零开始；session/group memory 不受影响。
**优先级**：P0
**用户故事**：作为用户/agent，我用统一的 global/session 词汇理解两个子系统的记忆/技能范围，创建时默认落全局。

**命名映射（对外统一 ↔ 底层）**：

| 对外 scope | skill 底层 | memory 底层 |
|-----------|-----------|-------------|
| `global` | `app`（`<dataDir>/skills/`，跨项目/会话） | `global`（`<dataDir>/memory/<name>.md`，跨会话，全局一份） |
| `session` | `workspace`（`<workspaceDir>/.rocky/skills/`，**项目级**） | `session`（`<session.workspaceDir>/.rocky/memory/<name>.md`，**会话级**） |

> ⚠️ **语义注解（避免误导）**：skill 的 `session` 底层是**项目级 workspace 存储**（一个项目多会话共享、可 git 团队共享），**并非严格单会话私有**；memory 的 `session` 才是真·单会话私有。命名统一只在**接口/工具入参/UI 层**；底层存储路径与覆盖语义（skill workspace 覆盖 app）保持现状。

- **默认 global**：create/write 不指定 scope 时落 global；仅当经验「只对本项目/本会话有效」才显式选 session。写进两个 manage 工具 description。**例外 [v0.0.205.t2_cons]**：T1 一级整理 fork prompt 默认翻 session（见上）。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-M7 | agent 写一条 memory 不指定 scope | 落 global（`<dataDir>/memory/`），非 session |

### 9.2.7 注入总量配额（四类分组 + 总量上限）[v0.0.149]

**描述**：memory 注入加「四类分组顺序 + 总量上限」配额，避免长期记忆条目持续增长挤占 system prompt cache 命中率与有效预算。**entry schema 同步补 source/updatedAt 两字段**支撑分组与组内排序；**存量数据 migration** 补字段。
**优先级**：P0
**用户故事**：作为深度用户，我希望长期记忆注入有数量上限并按「会话手记优先于全局、手动优先于自动」排序，以便记忆积累多了也能保住当前最相关的。

**核心规则（注入顺序 = 四类分组优先级，先组间后组内）**：

| 顺序 | 分组 | 语义 |
|------|------|------|
| 1 | session 手动 | session 级 + 用户手动增加（source=user） |
| 2 | session 自动 | session 级 + agent 自动增加（source=agent） |
| 3 | 全局手动 | user/global 级 + 用户手动增加 |
| 4 | 全局自动 | user/global 级 + agent 自动增加 |

- **组内排序**：`updatedAt` 倒序（最近更新的优先）。
- **总量上限**：取前 N（默认 50），N 在应用设置「会话」tab 配置（`maxMemoryInject`）。**数量语义 = 总量**（非 per-source 配额），按上述分组优先级连续取到 N 截止。
- **两 mapper 协同共享配额**：memory_user（stable）+ memory_session（context）两 mapper 经共享纯函数 `selectMemoriesByQuota` 协同（同输入同输出，各自仍按本 tier 贡献 fragment，reducer/builder 无感）；具体协同方式由架构定，PRD 只约束最终注入条目数 ≤ N 且按四类顺序取前 N。

**数据模型补字段（对齐 skill source 命名）**：

| 字段 | 类型 | 含义 |
|------|------|------|
| `source` | `'user' \| 'agent'` | originator：`user`=UI 手动入口 / `agent`=memory_manage create。**存量统一 `agent`**；**origin 不可变**（update 保留既有 source） |
| `updatedAt` | string (ISO 8601) | 最后修改时间，组内排序依据；写侧 create/update 刷新为 now；**存量按 migration 执行时刻补**（两介质多 entry 共享一个 record/md，无 per-entry mtime） |

- **`evolvable` 不参与 source 推断**——evolvable 只管「是否可进化」，不滥用做来源判定（两字段正交）。

**存量 migration（bootstrap 启动一次性，字段缺失为 marker，幂等非破坏）**：
- marker = per-entry 字段缺失：source 缺 → 补 `'agent'`；updatedAt 缺 → 补 `now`（ISO）。
- 覆盖两介质：user memory（app_config record entries[]）+ session memory（sessions/`*`/session_memory.md frontmatter）。
- 仅缺字段才补（不覆盖已有值/不清其他字段/catch warn 不阻塞 bootstrap）；幂等（二次运行所有 entry 已有两字段 → no-op）。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-M8 | 环境有 80 条 memory（30 session 手动 + 30 session 自动 + 10 全局手动 + 10 全局自动），maxMemoryInject=50 → 构建一次 system prompt | memory L0（两 mapper 合并）只含 50 条：30 session 手动全要 + 20 session 自动（updatedAt 倒序）+ 全局两类不进 |
| UC-M9 | 旧数据首次启动（user_memory entries[] 无 source/updatedAt + sessions/*/session_memory.md frontmatter 无 source/updatedAt）→ migration 跑 → 构建一次 system prompt | 每条 memory entry 有 source（存量=agent）+ updatedAt（按 migration 执行时刻补）；memory L0 按 updatedAt 倒序正常注入 |

---

## 9.3 关键用户路径（MANDATORY — 测试最低覆盖）

| ID | 用户操作链路 | 预期结果 | 类型 |
|----|-------------|---------|------|
| 路径 A | agent 按需 `memory.read(name)` | 返回单条完整正文（body+why+how） | API（真 LLM） |
| 路径 B | agent `memory.search(keyword)` | 返回命中条目 name+intro 列表，不含正文 | API（真 LLM） |
| 路径 C | 存在 memory → 新 session → 查 system prompt fragment | 只含 name+intro，不含正文 | API |
| 路径 D | 会话含「方法」+「结论」→ 自动总结 | 方法落 skill、结论落 memory（路由正确） | API（真 LLM） |
| 路径 E | agent/UI 写超 300 词 memory | write 被拒（hard error + 计数），未落盘 | API |
| 路径 F | UI 编辑 evolvable=false 内置/手写记忆正文并保存 | 保存成功、正文更新、无字段置灰 | E2E + API |
| 路径 G | agent 写 memory 不指定 scope | 落 global（`<dataDir>/memory/`），非 session | API |
| 路径 H | [v0.0.149] 80 条 memory 四类分布 + maxMemoryInject=50 → 构建 system prompt | memory L0 只含 50 条：session 手动全要 + 部分 session 自动 + 全局两类不进（UT 直测 mapper） | UT（无新 AT，纯确定性） |
| 路径 I | [v0.0.149] 旧数据首次启动 → migration 跑 → 构建 system prompt | 每条 entry 有 source（=agent）+ updatedAt；memory L0 按 updatedAt 倒序注入（UT 测 migration 幂等 + 排序接通） | UT |

**路径数**：9 条（A-I），每条至少 1 个 API/E2E/UT case（v0.0.149 路径 H/I 走 UT，无新 AT——纯确定性逻辑无 LLM 不确定性，用户铁律）。

---

## 9.4 范围边界

### IN [v0.0.112]
1. `memory` 纯读工具（read / search，独立于 memory_manage）
2. 注入翻转（memory_user/memory_session mapper 只注入 name+intro）
3. memory `evolvable` 字段（默认按来源；agent 受限 / UI 全开）
4. 正文 300 词硬限制（write/patch 校验，存量豁免）
5. skill_manage / memory_manage 路由提示词 + consolidation fork prompt
6. scope 对外统一命名 global/session + 默认 global（memory + skill）

### IN [v0.0.149]
7. 注入总量配额（四类分组顺序 + 总量上限，纯函数 `selectMemoriesByQuota` 协同两 mapper）
8. entry schema 加 `source`/`updatedAt`（originator 标签 + 组内排序依据）
9. 存量 migration（bootstrap 字段-marker 幂等非破坏，覆盖两介质）

### OUT [v0.0.112]
- memory 检索排序/相关度（`search` 仅全字段包含匹配，无排序 — 决策 D）
- 二级整理（P1）/ 矛盾检测（P1）
- session_memory 归档提升到 user_memory 策略（P1）
- 文件总容量硬限（本版本只做 per-entry 300 词硬限；file-total soft-warn 去留由架构定）

### OUT [v0.0.149]
- per-source 配额（不做 per-source 上限，只做总量上限 + 分组优先级连续取前 N）
- memory 检索相关度排序/向量召回（仍走全字段子串匹配，P1）
- 改变 source 的 UI 入口（source 是 originator 一次性盖戳字段，origin 不可变，update 保留既有 source）

### IN [v0.0.151.t2_consolidate]
10. 二级整理（tier2）天级落地：app 级调度 job（`Job.type='consolidation'`，每日到点触发）对 `source='agent'` 的 global skill（≤100）/ global memory（≤100）/ 各 session memory（≤30）做合并 + 归档/禁用容量收敛（永不物理删除）；三段严格串行 + 双重 skip（无新对话/session memory 为空零 LLM）；boot-time-only 注册（`enabled`/`dailyTime`/`modelId` 改动需重启生效，对齐 observability 先例）；可选轻量可见性（`GET /consolidation/status` 上次整理时间 + 一句话摘要）。技术权威 `specs/tech/agent/memory/[P0]consolidation_tier2.md`（spec 转正）+ `specs/tech/scheduling/[P1]consolidation_job.md`。OUT of scope：workspace（项目级）skill 整理 / 手动「立即整理」触发 / 整理历史列表。

---

## 9.5 设计决策 [v0.0.112]

| 决策 | 选择 | 理由 |
|------|------|------|
| memory 纯读工具（决策 A） | **独立 `memory` 工具** | 与 skill 对称（纯读 vs 管理分离），注入侧只暴露纯读工具 |
| 300 计数（决策 C） | 中文按字 + 英文按词 | 中英统一，不纠结纯字符/纯分词 |
| search 能力（决策 D） | 简单全字段包含匹配 + 返回 name/desc | 先简单，排序/相关度留后续 |
| evolvable（决策 B） | UI 全开、不置灰、无 immutableReason | 用户对自己资产有完全控制权，根除「点了没反应」困惑 |
| scope 命名（决策 E） | 统一 global/session，仅改名不改底层 | skill session=项目级 workspace（spec 注明），memory session=单会话 |

---

version: 2.0（v0.0.21 引入 memory 子系统；v0.0.112 长期记忆增强，对齐 skill 渐进披露模型）
