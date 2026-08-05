# Prompt 注入质量治理 — 产品需求文档 [v0.0.238]

> version: 1.2 · 引入版本 v0.0.238 · 最后更新：2026-08-04（v1.2：补 §14.2.5 存储数量硬上限——v0.0.247 补 v0.0.238 注入配额的存储侧缺口；v1.1：scope 终裁——按 biz 可用表 + 写侧必填/按 biz 校验）
> 本文承载「agent 自定义内容（AGENTS.md / memory / skill）质量护栏」全量产品定义。增量见 `specs/prd/version_logs/v0.0.238/change_log.md`。
> 概念权威源（本 PRD 已读对齐）：`specs/prd/overall/13-agent-definition.md`（agent_profile §13.2.1 统一 mapper 铁律）+ `specs/prd/overall/09-memory.md`（memory scope = global/group/session §9.2.6）+ `specs/tech/agent/context/[P1]agent_profile.md`（stable/480 mapper）+ `specs/tech/agent/memory/[P0]consolidation_tier1.md`（T1 fork-2）+ `specs/tech/agent/memory/[P0]memory_injection.md`（L0 配额）+ `specs/tech/agent/skills/[P0]skill_definition.md`（skill L0 / scope 4 层）。
> 需求权威源：`reqs/[working] v0.0.238/req.md`（用户 2026-08-02 拍板 4 点）+ 调研底稿 `analysis.md`。

## 目录

| 章节 | 说明 |
|------|------|
| §14.1 产品概述 | 背景（自定义内容占 prompt ~75% 无质护栏）、定位、目标与非目标 |
| §14.2 功能需求 | 5 个功能：agent_profile 自律治理段 / T1 整理者化 / scope 分层配额 + 路由引导 / 写入硬长度检查 / 写入存储数量硬上限 |
| §14.3 关键用户路径（MANDATORY） | 6 条核心路径（测试最低覆盖） |
| §14.4 范围边界（IN / OUT） | v0.0.238 scope |
| §14.5 验收标准 | 可验证口径 |
| §14.6 概念落 spec 情况 | 待架构落 spec 清单 |

---

## 14.1 产品概述

### 14.1.1 背景与问题 [v0.0.238]

v0.0.232 把「自定义机制」透明化（agent_profile 导航 + AGENTS.md 两级注入 + scope 来源标注），打通了「能写、能注入、能溯源」，但**没配「质」的治理**。实测某 squad leader 的 system prompt（~62KB / ~20.7k tok）：agent 自定义内容（AGENTS.md 正文 + skills L0 + memory L0）≈ 46KB / ~15.6k tok，**占整 prompt ~75%**，且质量失控：

- AGENTS.md 混进业务流水（剧情/排期/过程记录），团队/个人内容大面积重复；截断上限虚设（代码 100000/50000 字符，注释承诺 ≤28000，注释与代码漂移）。
- skills L0 空 description 照进（路由失效）；配额只按时间倒序不管质量。
- memory L0 顶满统一 50 条配额，大半是时效性「拍板/流水」记录，无衰减。
- **T1（consolidate fork-2）是唯一定期在跑的整理机制，但只会加不会清**：工具权限只有 `[skill_manage, memory_manage]`（碰不到 AGENTS.md），指令里无「整理 AGENTS.md / 清理低质 / 控制体量」职责与标准。

**机制根因**：注入侧的护栏全是「量」（字符上限、条数配额、时间倒序），没有一条是「质」（写什么、怎么分层、何时删）。

### 14.1.2 定位 [v0.0.238]

给 agent 自定义内容配「质」的护栏，四刀组合：

1. **引导层**：「定义你的 agent」板块加自律治理段——prompt 级质量标准（最低成本、最先见效）。
2. **整理层**：T1 consolidate 从「只加不清」升级为「整理者」——放权读写 AGENTS.md，标准说清楚、红线划清楚。
3. **量的层**：scope 分层配额（session ≤20 / group ≤30 / global ≤50）+ 写侧 scope 必填与按 biz 校验。
4. **写侧硬门槛**：skill description / memory intro ≤50 字、memory 全文 ≤500 字硬检查，超限拒绝。

### 14.1.3 目标与非目标

**目标（IN）**：① agent_profile 自律治理段（全 kind 注入）；② T1 整理者化（文件工具扩权 + AGENTS.md 整理职责 + 标准 + 红线）；③ memory/skill L0 注入 scope 分层配额；④ 写侧 scope 必填（去默认 global）+ 按 biz 校验可用 scope（可用表：playground=session/global、studio=group/global、academy=三层）+ 工具描述按 biz 说明各 scope 用法；⑤ skill/memory 写入硬长度检查。
**非目标（OUT）**：不清理存量团队既有内容（只改机制，不动现有 squad 实例数据）；不改 skills resolver 4 层优先级语义（group>workspace>app>builtin 不变）；不改 memory/skill 三层存储模型与目录布局（本版只限定各 biz 写侧可用 scope 词汇）；L2「使用价值×衰减排序」后续增强；不做 AGENTS.md 的 frontmatter 治理机制（如 evolvable 类硬护栏）——本版红线靠指令层表述；UI 手动新建 memory/skill 的交互形态（选择器按 biz 过滤、同样必填）——机制口径同写侧，落地形态待架构/UI 落 spec。

---

## 14.2 功能需求

### 14.2.1 agent_profile 自律治理段 [v0.0.238]

**描述**：「定义你的 agent」section 在现有 a/b/c 三条机制导航之后，新增 **d) 自律治理（质量标准）** 段——明确告诉 agent 写 AGENTS.md / memory / skill 时的质量约束。全 session kind 注入（与 a/b/c 同范围）。
**优先级**：P0
**用户故事**：作为 agent，我在写自定义内容之前就知道「该写成什么样才算好、写错了有什么后果」，以便自定义内容保持克制、分层、可路由，而不是无边界膨胀。

#### 统一 mapper 铁律不变

自律段走**同一个 `agent_profile` mapper** 渲染（a/b/c/d 一个 section），禁止拆新 mapper 或新模板文件（§13.2.1 铁律延续）。stable tier、priority 480 不变，永不被 budget_truncate 裁掉。挂载范围与 a/b/c 完全一致（主 session 挂；subagent/summary/consolidate 等辅助 runKind 由 scope yaml 决定，默认不挂——**但 T1 consolidate 的整理标准由 §14.2.2 指令承担，不依赖本段**）。

#### d) 段文案方向（4 条质量标准 + 按 biz 渲染的 scope 规则）

```
## d) 自律治理（质量标准）

写 AGENTS.md / memory / skill 时遵守：
1. 分层归位：AGENTS.md 只写角色定位与规则；业务流水、过程记录、
   临时状态下沉 memory 或 outputs 文件，不进角色层。
2. 个人只写差异：个人 AGENTS.md 只写与团队定义不同的部分；
   团队已有的规则不重复抄写。
3. 描述即路由：skill description / memory intro 是路由语言——
   写「什么时候该用它」，一句话（≤50 字）；写不好路由就失效。
4. 会删比会写重要：定期清理——过时 memory 归档、失效 skill 禁用、
   AGENTS.md 保持精简；各 scope 有配额上限（session ≤20 /
   group ≤30 / global ≤50），写满前先把旧的清掉。

scope 规则（按本 session 的 biz 渲染可用层）：
- 语义：session=仅本会话；group=本团队（squad/classroom）共享；
  global=跨团队/跨项目全局。
- 你可用的 scope：{playground → session / global；
  studio(squad) → group / global（团队场景无 session）；
  academy → session / group / global}
- 写入必须显式指定 scope（无默认值）；不写或写错层会被工具
  拒绝并引导，别猜。
```

- 具体措辞由 coder 落稿，但 4 条标准 + 按 biz 渲染的 scope 可用表 + scope 必填规则缺一不可。
- 与 b) 条的关系：b) 条讲「memory 用什么工具管」（机制导航），d) 段讲「写成什么样算好」（质量契约），职责不重复。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | 新建 squad leader/mate session → 查看 system prompt | 「定义你的 agent」含 d) 自律治理段：4 条质量标准 + scope 可用表按 studio 渲染（group/global，无 session）+ scope 必填规则 |
| UC-2 | 新建 playground session → 查看 system prompt | d) 段同样注入（全 kind 一致）；scope 可用表按 playground 渲染（session/global，无 group） |

### 14.2.2 T1 consolidate 整理者化 [v0.0.238]

**描述**：T1（consolidate fork-2，compact 时机触发的整理 agent）从「只加不清」升级为「整理者」：打开文件读写工具权限，放权改 AGENTS.md，指令里指明整理对象位置 + 整理标准 + 红线。
**优先级**：P0（本版本核心交付）
**用户故事**：作为团队配置者，我希望每次 compact 后触发的整理 agent 不只是继续往 memory/skill 里加东西，还能回头收拾 AGENTS.md——把混进去的业务流水下沉、把团队/个人重复内容去重、把低质 description 修好，以便自定义内容不随时间腐烂。

#### 功能交互细节

- **工具权限扩权**：T1 fork-2 的 allowed tools 从 `[skill_manage, memory_manage]` 扩为 `[skill_manage, memory_manage, read, write, edit, glob, grep]`（文件读写五件套全给，碰得到 AGENTS.md 与任意自定义文件）。**待架构落 spec**（consolidate profile toolBound + scope yaml）。
- **指令指明整理对象位置**（按 session kind 渲染，与 agent_profile a) 条路径表同源语义）：
  - squad 场景：团队 `squads/{sid}/AGENTS.md` + 个人 `squads/{sid}/.rocky/agents/{name}-{memberId}.md`（该 member 有则列）；
  - playground：`{workdir}/AGENTS.md`；academy 学员：课程 ws AGENTS.md（维持单份）。
  - 现状 consolidation.md 是纯 directive 模板（不读动态 vars），路径渲染需要指令模板支持按 kind 注入路径——**待架构落 spec**。
- **整理标准（指令核心，5 条）**：
  1. **AGENTS.md 只留角色 + 规则**：业务流水、排期、过程事实、临时状态**下沉**（团队级事实 → group memory；产出类 → outputs 文件）；删后 AGENTS.md 保持「角色定位 + 协作规则 + 铁律」骨架。
  2. **团队/个人不重复**：个人 AGENTS.md 与团队重复的内容删掉，个人文件只留差异。
  3. **skill description 是路由语言**：空 description 补写或禁用该 skill；非触发器语言（写的是「这是什么」而非「何时用它」）改写；一句话 ≤50 字。
  4. **memory 是长期事实非流水**：时效性过程记录（拍板/流水/一次性事件）归档（archive）；intro ≤50 字、body ≤500 字，超限收缩。
  5. **控制总体量**：整理后各 scope 条目数回到配额内（session ≤20 / group ≤30 / global ≤50），AGENTS.md 保持精简。
- **红线（指令显式声明）**：
  - **禁删用户钦定铁律 / 角色定位**：AGENTS.md 中的角色定位段落、用户明确写下的规则铁律，不得删除或改写其语义；拿不准的段落一律保留不动（保守原则）。
  - 不做破坏性操作：不删除文件本身（write/edit 改内容，不 rm）；memory 只 archive 不物理删（对齐现有 memory_manage 语义）；skill 只 disable 不物理删。
  - evolvable=false 的 memory/skill 维持现有治理拒绝（不被整理改写），不变。
- **scope 引导按 biz**：T1（runKind=consolidate）继承主 session 的 biz scope 规则，不另立——指令按主 session 的 biz 渲染可用表（studio → group/global；playground → session/global；academy → 三层）；写 memory/skill 必须显式指定 scope，校验规则与主会话写侧一致（§14.2.3）。
- **触发与失败语义不变**：compact 时机 sibling 双发、fire-and-forget、锁失败静默跳过、不审批直接落盘——全部沿用 T1 现有契约（`consolidation_tier1.md`），本版只扩职责与工具，不改触发机制。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-3 | squad session 对话触发 compact → T1 fork-2 运行 → 查看其工具调用 | fork-2 可用 read/glob/grep 读团队 + 个人 AGENTS.md（工具不再拒绝）；指令中含两份文件的具体路径 |
| UC-4 | 团队 AGENTS.md 混入业务流水段落 → T1 整理后查看文件 | 流水段落被下沉（group memory 或 outputs），AGENTS.md 只留角色 + 规则；角色定位与铁律段落原样保留 |
| UC-5 | 个人 AGENTS.md 与团队重复 → T1 整理后查看 | 个人文件重复内容删除、只留差异；团队文件不动 |
| UC-6 | 存在空/超长 description 的 evolvable skill → T1 整理后 | description 被补写/改写为触发器语言且 ≤50 字，或 skill 被禁用 |

### 14.2.3 scope 分层配额 + 写侧 scope 必填与按 biz 校验 [v0.0.238]

**描述**：memory / skill 的 L0 注入配额从「三源共享统一 50 条」改为**按 scope 分层配额**；写入侧新建两道机制——**scope 必填（去默认 global）** + **按 biz 校验可用 scope**。
**优先级**：P0
**用户故事**：作为团队配置者，我希望 agent 写 memory/skill 时必须想清楚「这条该落在哪一层」、且只能落在当前场景合法的层，以便全局层不被噪声污染、每层的 L0 注入都保持高价值密度。

#### 最终 scope 可用表（按 biz，写侧）

| biz | 可用 scope（写 memory/skill） |
|---|---|
| playground | **session** / **global**（无 group） |
| studio（squad） | **group** / **global**（无 session——团队场景记忆只留团队级） |
| academy（整个 biz） | **session** / **group** / **global**（三层都有） |

#### 功能交互细节

- **分层配额（注入侧，物理层）**：session ≤ **20** 条 / group ≤ **30** 条 / global ≤ **50** 条——覆盖现有统一 `maxMemoryInject=50` / `maxSkillInject=50` 的总量配额语义。各 scope 独立计数、独立截断；层内排序规则不变（6 类分组顺序 + 组内 updatedAt 倒序 + tiebreak name 升序）。memory 与 skill 同构适用。**注入侧按 biz 对齐可用层**：playground 无 group 层、studio 无 session 层（squad 的 session/group 物理同址，现有同址去重规则已保证只经 group 源注入，本版把它升格为写侧词汇约定）、academy 三层。**待架构落 spec**（`selectMemoriesByQuota` / `selectSkillsByQuota` 分层语义；app_config 调参；skill 底层 4 层 builtin/app/workspace/group 与分层配额的归组映射——builtin 平台资产是否计入配额）。
- **机制一 · scope 必填（本版新建，现状不存在）**：去掉「默认 global」（现状 memory `parseScope` 缺省 global、skill `toInternalSkillScope` 缺省 global→app）。不传 scope → **工具报错拒绝**，错误信息按 biz 引导：列出当前 biz 可用 scope + 各 scope 语义（什么场景落哪个）。
- **机制二 · 按 biz 校验可用 scope（本版新建，现状不存在）**：传了当前 biz 不可用的 scope → **工具报错拒绝 + 引导**（例：studio 传 session → 「squad 场景无 session scope，请用 group/global」；playground 传 group → 「playground 场景无 group scope，请用 session/global」）。
- **工具 schema/description**：按 biz 写清每种可用 scope 的用法（什么场景落哪个）；路由提示词 `ROUTING_DECISION_PROMPT` 单一常量三处同源机制不变，但内容从「两步路由 + 默认 global」改为「按 biz 可用表 + 必填 + 各 scope 用法」。
- **skill 侧补齐 group**：现状 skill 对外只有 global/session（工具不暴露 group），底层 app/workspace，squad 时 workspace 与 group 物理同址。studio 写侧要能用 group → **暴露 group 或在工具层映射，方案待架构落 spec**。
- **T1 的 scope 规则**：T1（runKind=consolidate）继承主 session 的 biz scope 规则，指令按主 session biz 渲染可用表（见 §14.2.2）。
- **与 v0.0.205 的关系**：v0.0.205「T1 默认翻 session、工具/UI 默认 global」被「scope 必填」**整体取代**——不再有任何默认值。UI 手动新建路径是否同步（选择器按 biz 过滤可选项、同样必填）**待架构/UI 落 spec**。
- **scope 语义唯一口径**：session=仅本会话；group=本团队（squad/classroom）共享；global=跨团队/跨项目全局——对齐 `09-memory.md §9.2.6` 与 `skill_definition.md §4`，本版不改三层存储语义本身。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-7 | 某 scope 条目数超过其层配额（如 group 31+ 条）→ 新建 session 查看 prompt L0 | 该 scope 注入条目 ≤30（层内 updatedAt 倒序取前 N）；其他 scope 互不影响 |
| UC-8 | agent 调 manage 工具写 memory/skill **不传 scope** | 工具拒绝 + 错误按 biz 引导（列出当前 biz 可用 scope 与语义）；不落盘 |
| UC-9 | studio session 中 agent 传 `scope=session`（或 playground 传 `scope=group`） | 工具拒绝 + 报错引导正确层（squad 请用 group/global）；不落盘 |

### 14.2.4 写入硬长度检查 [v0.0.238]

**描述**：`skill_manage` / `memory_manage` 写入侧新增硬长度检查，超限直接拒绝（工具报错返回），把「描述即路由」从引导升级为门槛。
**优先级**：P0
**用户故事**：作为平台，我拒绝接受超长的 description/intro/body 写入，以便 L0 注入的每一行都是紧凑的路由语言，prompt 不被臃肿索引吃掉。

#### 功能交互细节

- **检查口径（写侧硬拒绝）**：
  - `skill_manage.create` / `skill_manage.patch`：`description` **必填**且 ≤ **50 字**，缺省或超限 → 拒绝并返回错误提示（提示收缩方向：一句话说清何时用它）。
  - `memory_manage.write`：`intro` ≤ **50 字**、`body` 全文 ≤ **500 字**，超限 → 拒绝并返回错误提示。
- **「字」的口径**：字符数（characters；中英文统一按字符计）。是否含空白/标点、截断提示文案等细节**待架构落 spec**。
- **覆盖旧口径**：skill description 旧上限 1024 字符收紧为 50 字（`skill_definition.md §2` 相应修改）；memory body 旧「300 词」口径统一为 500 字符（`09-memory.md §9.2.4` 相应修改）——统一为字符数单一口径。
- **存量不追溯**：既有超限内容不强制清理（对齐「不清理存量」非目标）；由 T1 整理（§14.2.2）按新标准逐步收敛；UI 手动编辑路径是否加同款校验**待架构落 spec**（产品口径：应加，同一标准对人对 agent 一致，但实现位置——工具层 vs 服务层——由架构定）。
- **错误可见**：拒绝错误经工具调用结果返回给 agent（含当前长度与上限），agent 可收缩后重试；evolvable=false 拒绝语义不变。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-10 | agent 调 `skill_manage.create` 写 >50 字 description | 工具拒绝 + 错误提示含上限；不落盘；收缩后重试成功 |
| UC-11 | agent 调 `memory_manage.write` 写 >50 字 intro 或 >500 字 body | 工具拒绝 + 错误提示；不落盘；收缩后重试成功 |

### 14.2.5 写入存储数量硬上限 [v0.0.247]

**描述**：`skill_manage.create` / `memory_manage.write`（新建路径）在写入侧加**存储条目数量硬上限**——补 v0.0.238 注入分层配额只截「注入 prompt 条数」、不限「磁盘存储条数」的缺口。阈值跟注入配额同值（global 50 / group 30 / session 20），超限**硬拒绝**并引导 agent 先 archive/disable 旧条目腾位。
**优先级**：P0
**用户故事**：作为团队配置者，我希望 agent 不能无限往 memory/skill 里堆条目（某 squad group memory 曾堆到 72 条），以便存储增长受控、逼 agent 主动收敛而非靠 T1 软整理兜底。

#### 功能交互细节

- **阈值跟注入配额同值同源**：global 50 / group 30 / session 20，复用 v0.0.238 已有 config（`maxMemoryInject`/`maxMemoryInjectGroup`/`maxMemoryInjectSession` + skill 同构三 key）。注入侧与存储侧**值同源、概念解耦**（独立 type，未来可拆 key 互不影响）。
- **溢出行为 = 硬拒绝 + 引导腾位**：超 `quotas[scope]` 拒写，返回错误文案 `memory/skill <scope> quota exceeded (<current>/<limit>); archive/disable N 旧条目腾位后再写`（memory 引导 archive / skill 引导 disable）。守「永不自动删」铁律，逼 agent 主动收敛——自动 archive 方案弃用（agent 无感、不学着整理）。
- **触发边界 = 只在 create 路径**：memory `writeLocked` 锁内 `!existing` 分支 + skill `executeCreate`。**update / archive / disable 不触发**（archive 是减少 active 条目，被自己拦会自锁）——这条钉死。
- **不计入配额的条目**：memory `archived=true`（`listEntries({includeArchived:false})`）+ skill `enabled=false`（disabled）+ skill `scope=builtin`（builtin 平台资产，agent/用户物理不会写 builtin 层）。
- **evolvable=false 计入配额**（防全标 false 绕过），但溢出错误文案**如实告知** `其中 X 条 evolvable=false 无法 archive/disable，需手动处理`——守 v0.0.151「如实反映、不视为 bug」立场。
- **count + write 原子**：嵌套 dir 级虚拟锁（`path.resolve(dir, '.quota.lock')`，仅 create 分支），count+check+write 全在 dir 锁内串行（防并发 TOCTOU race）；嵌套顺序固定 entry 锁（外）→ dir 锁（内），全路径一致无死锁。
- **覆盖两路径**：memory 经服务层 `writeLocked` 单点（覆盖 agent 工具 writeEntry + UI createEntry 两路）；skill 经 `executeCreate`（skill 走工具路径，无 UI HTTP 直写）。
- **错误码映射**：memory `MemoryQuotaExceededError` → HTTP 400（`quotaTo400`，UI 路径）+ 工具 `[invalid_input]`（agent 路径）；skill `SkillQuotaExceededError` → 工具 `[INVALID_INPUT]`（不抛 HTTP）。
- **存量不追溯**：现存超限条目（如 72 条 group memory）不强制清理，靠硬拦截驱动收敛（每次写新被拒→被迫 archive 旧的→逐步压到上限内）。建议上线后手动触发一轮 T1 consolidate 把存量压到上限内。

#### E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-12 | 某 scope active 条目数已达上限（如 group 30 条）→ agent 调 `memory_manage.write` 新建 | 工具拒绝 + 错误文案 `archive 1 旧条目腾位`；不落盘；agent archive 旧的后重试成功 |
| UC-13 | agent 调 `skill_manage.create` 新建超上限（如 global 50 条）| 工具拒绝 + 错误文案 `disable an old skill to free space`；不落盘 |
| UC-14 | 已满配额且其中含 evolvable=false 条目 → agent 写新建被拒 | 错误文案附 `其中 X 条 evolvable=false 无法 archive/disable，需手动处理` |
| UC-15 | agent archive 旧 memory / disable 旧 skill（减少 active）→ 再写新建 | 配额检查通过、正常落盘（archive/disable 不自锁） |

---

## 14.3 关键用户路径（MANDATORY — 测试最低覆盖）

1. **新建 squad session → 查看 system prompt**：「定义你的 agent」含 d) 自律治理段（4 条标准 + 按 biz 渲染的 scope 可用表 + scope 必填规则）。（UC-1/2）
2. **agent 写超限 skill description / memory intro / memory body → 工具拒绝 → 收缩重试成功**。（UC-10/11）
3. **scope 条目超层配额 → 新 session 的 L0 注入按分层配额截断**（session ≤20 / group ≤30 / global ≤50，按 biz 对齐可用层）。（UC-7）
4. **agent 写 memory/skill 的 scope 校验**：不传 scope → 报错按 biz 引导；传当前 biz 不可用 scope（studio 传 session / playground 传 group）→ 报错引导。（UC-8/9）
5. **squad session 触发 compact → T1 fork-2 读 AGENTS.md → 按标准整理**：流水下沉、团队/个人去重、skill description 修复、memory 流水归档；红线段落（角色定位/铁律）原样保留；T1 写 memory/skill 遵循主 session biz 的 scope 可用表。（UC-3/4/5/6）
6. **存量不回归**：既有超限 memory/skill 不被强制清理、evolvable=false 资产不被 T1 改写、resolver 4 层优先级与三层存储语义不变。

## 14.4 范围边界

**IN（v0.0.238）**：agent_profile d) 自律治理段（全 kind）；T1 工具扩权（read/write/edit/glob/grep）+ 指令整理职责（AGENTS.md 位置 + 5 条标准 + 红线 + scope 按 biz 引导）；memory/skill L0 分层配额（20/30/50，按 biz 对齐可用层）；写侧 scope 必填（去默认 global）+ 按 biz 校验可用 scope + 工具描述按 biz 说明用法；写侧硬长度检查（50/50/500）。
**OUT**：不清理存量团队既有内容；不改 skills resolver 4 层优先级语义（group>workspace>app>builtin）与 memory/skill 三层存储模型/目录布局（本版只限定各 biz 写侧可用 scope 词汇）；L2「使用价值×衰减排序」（后续增强）；AGENTS.md frontmatter 治理机制（本版红线为指令层）；UI 手动新建路径的交互形态（机制口径同写侧：必填 + 按 biz 过滤，落地形态待架构/UI 定）；T1 触发机制（sibling 双发/锁/fire-and-forget 不变）；academy 课程 AGENTS.md 的整理职责（维持 T1 现有 memory/skill 范围，AGENTS.md 整理聚焦 squad/playground 场景，academy 是否纳入待架构评估）；budget_truncate reducer 链接线/参数调优（独立议题，本版不处理）。

## 14.5 验收标准

1. squad leader + mate 的 system prompt（经 `GET /session/:id/debug/system-prompt` 验证）含 d) 自律治理段：4 条质量标准 + 按 biz 渲染的 scope 可用表 + scope 必填规则。
2. `skill_manage.create/patch` description >50 字或缺失 → 拒绝且不落盘；`memory_manage.write` intro >50 字或 body >500 字 → 拒绝且不落盘；收缩后重试均成功。
3. 注入侧分层配额生效：session ≤20 / group ≤30 / global ≤50，各 scope 独立截断，且按 biz 对齐可用层（studio 无 session 层、playground 无 group 层）（debug 端点可验证）。
4. T1 fork-2 的 allowed tools 含 read/write/edit/glob/grep；指令含团队 + 个人 AGENTS.md 具体路径与 5 条整理标准 + 红线声明。
5. T1 整理实测：混流水的 AGENTS.md 被下沉瘦身、团队/个人去重、空 description 被修复；角色定位与用户铁律段落原样保留（红线）。
6. 写侧 scope 校验：manage 工具不传 scope → 报错并按 biz 引导可用层；studio 传 session / playground 传 group → 报错引导；合法 scope 写入正常落盘。
7. 存量兼容：既有超限内容不强制清理；evolvable=false 资产不被 T1 改写；resolver 优先级与 memory scope 语义不回归。

## 14.6 概念落 spec 情况（待架构落地）

> 以下概念为 v0.0.238 新引入/变更，**待架构阶段落 tech spec**（PRD 不擅自发明实现契约）：

| 新概念/变更 | 待落 spec 位置 | 要点 |
|---|---|---|
| agent_profile d) 自律治理段 | `specs/tech/agent/context/[P1]agent_profile.md`（修改） | 同一 mapper 渲染 a/b/c/d；全 kind 一致；stable/480 不变；b) 条 squad 行可用 scope 列表同步为 group/global（去 session）；d) 段 scope 可用表按 biz 渲染 |
| T1 整理者化（工具扩权 + 指令职责） | `specs/tech/agent/memory/[P0]consolidation_tier1.md`（修改）+ consolidate profile/scope yaml | toolBound 加文件五件套；指令模板支持按 kind 注入 AGENTS.md 路径（破纯 directive 现状）；红线与 5 条标准文案；scope 引导按主 session biz |
| 分层配额（20/30/50） | `specs/tech/agent/memory/[P0]memory_injection.md` §2 + skills 侧（`skill_definition.md` / system_prompt §4） | `selectMemoriesByQuota`/`selectSkillsByQuota` 分层语义；注入侧按 biz 对齐可用层（playground 无 group / studio 无 session / academy 三层）；skill 底层 4 层归组映射；builtin 是否计入；app_config 调参 |
| 写侧 scope 必填 + 按 biz 校验 | memory_manage / skill_manage 工具 spec + `ROUTING_DECISION_PROMPT` | 去默认 global（memory `parseScope`、skill `toInternalSkillScope` 缺省逻辑移除）；不传/传错层 → 报错按 biz 引导；工具 description 按 biz 写各 scope 用法；UI 手动新建是否同步（待架构） |
| skill 侧 studio 暴露 group | `specs/tech/agent/skills/[P0]skill_manage_tool.md` / `skill_definition.md` §4 | 现状对外仅 global/session（不暴露 group），squad workspace↔group 同址；暴露 group 或工具层映射——方案待架构定 |
| 写入硬长度检查 | `specs/tech/agent/skills/[P0]skill_manage_tool.md` + memory manage 工具 spec | description ≤50 必填 / intro ≤50 / body ≤500；拒绝错误格式；UI 路径是否同款校验 |
| UI 影响排查 | — | 预期前端零改动（prompt/工具层）；memory/skill UI 编辑路径若加校验/按 biz 过滤需评估 |
