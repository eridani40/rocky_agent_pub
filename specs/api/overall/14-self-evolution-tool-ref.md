# Self-Evolution Agent Tools 索引（v0.0.51 · v0.0.112 modified · v0.0.238 modified）

> version: 2.3 · 引入版本 v0.0.51 · 最后更新 2026-08-02（v0.0.238：scope 必填无默认 + 按 biz 校验（memory write/archive + skill create/patch/disable/enable）+ skill scope 加 `group`（暴露 squad 团队层）+ 长度口径改字符：memory intro ≤50 / body ≤500、skill description ≤50。v0.0.205.t2_cons：memory scope `squad`→`group` 全链改名 + 存储介质统一 per-entry md dir store + `not_in_squad`→`not_in_group`。v0.0.164：memory 工具 scope 扩 3 值 `global|group|session`。v2.0 · v0.0.112：新增 `memory` 纯读工具 + scope 统一 global/session + memory evolvable + mutable→evolvable drift 订正）
> 管什么：self-evolution agent tool（`memory` / `memory_manage` / `skill` / `skill_manage`）的 API 索引——**指明契约权威源（tech spec）+ AT 验证方式**。本文件是 AT（API Test）self-evolution 域的入口；具体 tool 接口定义不在本文件复述（→ tech spec 权威）。
> 不管什么：tool 接口定义自身（→ tech spec）；UI HTTP 端点（→ `06-skill.md` + `06a-skill-governance.md`）。
> **本文件是 AT designer 的导航**：从本文件跳 tech spec 拿契约 → 设计 case（断言基于契约，不读代码）。

## 1. 概述

self-evolution agent tool 集（v0.0.51 引入两写侧工具；**v0.0.112 新增 `memory` 纯读工具**）：

| 工具 | 用途 | LLM 调用方式 | 契约权威 |
|------|------|-------------|---------|
| `memory`（v0.0.112） | **纯读** memory：read（单条正文）/ search（关键词全字段匹配，回 name+desc） | tool_use（非 HTTP） | `specs/tech/agent/memory/[P0]memory_tool.md` |
| `memory_manage` | 写侧：write（upsert）/archive/list/read memory entry | tool_use（非 HTTP） | `specs/tech/agent/memory/[P0]memory_manage_tool.md` |
| `skill_manage` | create/patch/disable/enable/list/read skill | tool_use（非 HTTP） | `specs/tech/agent/skills/[P0]skill_manage_tool.md` |
| `skill`（v0.0.21） | 纯读 skill（read 全文） | tool_use（非 HTTP） | `specs/tech/agent/skills/[P0]skill_tool.md` |

写侧**不审批**——agent 自主落盘，无人工 gate（self evolution 哲学）。安全靠：**evolvable 治理**（`evolvable=false` skill/进化性写 memory 拒绝）+ disable/archive 替代 delete（可恢复）+ **memory intro ≤50 字符 / body ≤500 字符硬限** + **scope 必填无默认 + 按 biz 校验**（v0.0.238）。

> **scope 对外统一命名 + 必填（v0.0.238 起）**：memory / skill 工具 input/output 的 scope 统一 `global` | `session` | `group`（memory；`list` 另含 `all`），skill 同三值。**写侧 scope 必填无默认**——不传 scope 返回 `[invalid_input]` + 本 biz 可用层引导；传本 biz 不可用层同样拒绝。可用层按 biz：playground→session/global、studio→group/global、academy→session/group/global（来自 `biz-scope-rules.ts`，biz 由 `resolveBizScopeKind(ctx.config)` 读 `kind.biz` 缺省 playground）。read 保留缺省 global（读侧宽容）。映射在工具边界（memory: global↔app / session↔workspace / group↔group；skill: global↔app / session↔workspace / group↔group）。

## 2. memory_manage 工具

### 2.1 契约权威源

- 接口定义 + action 语义：`specs/tech/agent/memory/[P0]memory_manage_tool.md` §2（TypeScript interface）+ §3（action 表）
- 资源模型（memory entry 结构 + 文件位置）：`specs/tech/agent/memory/[P0]memory_definition.md`
- 注入路径（native 自动注入，非本工具）：`specs/tech/agent/memory/[P0]memory_injection.md`
- 并发写（per-file lock 原子串行化）：`memory_manage_tool.md §7.2`

### 2.2 action 列表（详见 tech spec §3）

| action | 用途 | 持久化（per-entry md dir store） | 备注 |
|--------|------|--------|------|
| `write` | upsert entry（同 name 更新）；**scope 必填无默认**；**3 值 `global\|group\|session`** | global→`<dataDir>/memory/<name>.md`；**group→`<groupWs>/.rocky/memory/<name>.md`（groupWs 经 resolveGroupWsDir 解析：squad/classroom 团队 ws）**；session→`<session.workspaceDir>/.rocky/memory/<name>.md` | intro >50 字符 / body >500 字符 **hard error**；更新既有 `evolvable=false` → 拒绝；新建 `evolvable=true`；**group scope 无 group 会话 → `[invalid_input] not_in_group`**；**scope 缺失/本 biz 不可用 → `[invalid_input]`** |
| `archive` | 归档（不删，可恢复） | entry 标 archived | [v0.0.112] `evolvable=false` → 拒绝 |
| `list` | 列 metadata（name/description/type/**evolvable**） | 读 | 不返全文（控 token） |
| `read` | 读单条全文（共享 `memory` 工具实现） | 读 | agent 显式查阅（非注入路径） |

### 2.3 AT 可测点（real LLM ark glm-5.2，真落盘验证）

| 测点 | AT 验证手段 |
|------|------------|
| write 新建 entry | 真 LLM session 中 user 说"记住我的偏好 X" → LLM tool_use `memory_manage.write` → 查真落盘 global→`<dataDir>/memory/<name>.md`（per-entry md）含该 entry |
| write upsert（同 name 更新） | 同 name 二次 write（不同 description/body） → 查文件 entry 已更新（不重复创建） |
| archive | user 说"忘掉 entry X" → tool_use archive → 查文件 frontmatter `archived: true`（文件保留不删） |
| list metadata | tool_use list → tool 响应含 `name/description/type`，**不含 body 全文** |
| read 单条 | tool_use read(name) → 响应含完整 body + why + howToApply |
| scope 区分 | `scope=global` 落 `<dataDir>/memory/<name>.md`；`scope=session` 落 `<session.workspaceDir>/.rocky/memory/<name>.md`（不同介质位置，不同生命周期） |
| 不审批契约 | write 后无中间态/审批队列；直接落盘（AT 不断言「等待审批」） |

### 2.4 scope 语义（3 值，全链统一无映射）

- `global`：跨 session / 跨 agent 全局共享（用户长期偏好 / 项目决策）。
- `group`：团队（squad 或 classroom）内共享的规则/角色行为约束（仅本 group 生效）。groupWs 从 `ctx.config.squadId` / `ctx.config.sessionContext?.classroomId` 经 `resolveGroupWsDir` 自动解析（input schema 不暴露 id）；**无 group 会话 → `[invalid_input] not_in_group`**（不静默降级）。跨 scope 兜底（未指定 scope）**严格不含 group**（防跨组数据污染）。
- `session`：当前 session 专属（本次对话上下文；ws 取自 `ctx.config.workdir`）。

> **写侧 scope 必填 + 按 biz 校验（v0.0.238）**：write/archive 不传 scope → `[invalid_input]` + biz 可用层引导；传本 biz 不可用层 → 同样拒绝。read 保留缺省 global（读侧宽容）。

### 2.5 [v0.0.112] 新增 AT 可测点

| 测点 | AT 验证手段 |
|------|------------|
| intro/body 字符硬限（路径 E） | user 让 agent 写超 500 字符 body 的 memory → tool 返回 hard error（含 field + current count + 上限）；查文件**未落盘** |
| scope 必填（路径 G） | agent write 不指定 scope → tool 返回 `[invalid_input]` + biz 可用层引导；查文件未落盘 |
| evolvable 新建=true | agent write 新建 → 落盘 entry `evolvable=true`（list meta 含 evolvable=true） |
| evolvable gate（进化性写拒绝） | 预置 `evolvable=false` entry → agent write 更新同 name / archive → tool 返回 `[invalid_input] non-evolvable`；查文件未变 |

### 2.6 memory 纯读工具（`memory`，v0.0.112）

契约权威：`specs/tech/agent/memory/[P0]memory_tool.md`。

| action | 入参 | 返回 | AT 验证（real LLM） |
|--------|------|------|--------------------|
| `read` | `{scope?, name}` | 单条完整正文（body+why+how） | 会话中让 agent 回忆某条已存记忆 → tool_use `memory.read(name)` → 响应含完整 body（路径 A） |
| `search` | `{keyword, scope?}` | 命中 name+description 列表（**不含 body**） | 给关键词 → tool_use `memory.search(keyword)` → 响应含命中 name+desc，**不含 body 正文**（路径 B） |

### 2.7 不在 AT 覆盖（roadmap）

- 二级整理（P1，本期不实现）
- 矛盾检测（P1）
- search 排序/相关度（本期仅全字段包含匹配）

## 3. skill_manage 工具

### 3.1 契约权威源

- 接口定义 + action 语义：`specs/tech/agent/skills/[P0]skill_manage_tool.md` §2 + §3
- skill 定义（SKILL.md 协议 + 治理字段）：`specs/tech/agent/skills/[P0]skill_definition.md`
- **evolvable 强制规则（agent 路径）**：`skill_manage_tool.md §4` + `skill_definition.md §6.1`
- 并发写（per-file lock 原子串行化）：`skill_manage_tool.md §7.2`

### 3.2 action 列表（详见 tech spec §3）

> **[drift 订正] `mutable`/`mutableLocked` → `evolvable`**：代码自 v0.0.55 起用单维度 `evolvable`（删 `mutableLocked`）；本 API 文档旧版仍写 `mutable`——过时，订正为 `evolvable`。scope 对外 `global`/`session`/`group`（`list` 另含 `all`）；**写侧 scope 必填无默认 + 按 biz 校验**（v0.0.238，同 memory 侧规则）；内部 app/workspace/group，见 skill_manage_tool §2。**skill description ≤50 字符硬限**（v0.0.238，create/patch 超 50 字符 → `[invalid_input]`；market install 直写不受影响）。

| action | 用途 | 受 evolvable 强制？ | 备注 |
|--------|------|------------------|------|
| `create` | 新建 skill（自动 `source=agent, method=consolidation, evolvable=true`）；**scope 必填无默认** | 否（新建） | name 同 scope 已存在 → REJECT；description >50 字符 → `[invalid_input]` |
| `patch` | 改 body + frontmatter（除 evolvable） | **是**（evolvable=false 拒绝） | payload 不含 evolvable（agent 永远不能改 evolvable）；带 description 时同 ≤50 硬检查 |
| `disable` | 设 enabled=false（复用 app_config skill_state） | **是** | 用 disable 替代 delete（可恢复） |
| `enable` | 设 enabled=true | **是** | — |
| `list` | 列全部 skill 元数据（含 disabled，带 evolvable） | 否（读） | 防创建撞车重复 skill |
| `read` | 读任意 skill 全文（含 disabled） | 否（读） | 管理场景需看全部 |

### 3.3 AT 可测点（real LLM ark glm-5.2，真落盘验证）

| 测点 | AT 验证手段 |
|------|------------|
| create 新 skill | user 说"把刚才的工作流存成 skill" → tool_use create → 查真落盘 `<scope>/skills/<name>/SKILL.md`，frontmatter 含 `source=agent, method=consolidation, evolvable=true` |
| patch（evolvable=true，agent 资产） | tool_use patch on agent-created skill → 查 SKILL.md body/description 更新 |
| **patch REJECT（evolvable=false，用户资产）** | tool_use patch on user-download skill（evolvable=false） → tool 返回 `[invalid_input] non-evolvable`；查 SKILL.md body 不变 |
| disable（evolvable=true） | tool_use disable on evolvable=true skill → 查 app_config `skill_state` group enabled=false |
| **disable REJECT（evolvable=false）** | tool_use disable on user skill → tool 返回 reject；app_config 不变 |
| enable（evolvable=true） | tool_use enable → 查 app_config skill_state enabled=true |
| list 含 disabled | 预先 disable 一个 skill → tool_use list → 响应含该 skill（`enabled=false`） |
| read 全文（含 disabled） | tool_use read on disabled skill → 响应含完整 SKILL.md（不因 disabled 拒绝） |
| create 撞名拒绝 | tool_use create with existing name（同 scope）→ tool 返回 reject |
| patch payload 无 evolvable | tool_use patch 响应或落盘 → 查 frontmatter `evolvable` 字段不变（agent 不可改 evolvable 本身） |

### 3.4 evolvable 强制契约（agent 路径，**AT 必须断言**）

```
patch(name)   → if skill.evolvable === false → REJECT  ([invalid_input] non-evolvable)
disable(name) → if skill.evolvable === false → REJECT
enable(name)  → if skill.evolvable === false → REJECT
```

- `evolvable=false` 的 skill（用户手写 / 下载 / 系统内置）：三个写 action 全部 REJECT。
- agent 工具 payload 不含 `evolvable`——agent 永远不能改 evolvable。
- AT 必须**正向 + 反向都验**：evolvable=true 允许 + evolvable=false 拒绝（双向断言）。

### 3.5 不在 AT 覆盖（roadmap / UT 覆盖）

- 并发写 per-file lock 序列化（UT 覆盖，AT 用单 session 验落盘语义即可）
- allowedTools 默认值策略（P1）
- skill 间依赖关系（P1）

## 4. UI HTTP 路径与 agent 工具路径的边界（正交分离）

| 操作 | agent 工具（LLM tool_use） | UI HTTP 端点 |
|------|---------------------------|-------------|
| 改 evolvable 字段 | **不可改**（payload 不含 evolvable） | `PATCH /skill/:name/governance`（无 lock，v0.0.55 删 mutableLocked，见 `06a-skill-governance.md`） |
| 改 enabled 字段 | `skill_manage.disable/enable`（受 evolvable 强制） | `PATCH /skill/:name`（无 evolvable 约束，见 `06-skill.md §4`） |
| 改 body 字段 | `skill_manage.patch`（受 evolvable 强制） | （无 UI 端点，UI 走 install/preview） |
| 新建 skill | `skill_manage.create` | `POST /skill/install`（用户上传） |
| 查 list | `skill_manage.list`（含 disabled） | `GET /skill`（仅 enabled 合并层） |

**关键不变量**：agent 工具不能改 evolvable；UI 不能改 body（只能改 evolvable/enabled）。两条路径正交，强制规则各自独立。

> **memory 的对称约束（v0.0.112）**：agent `memory_manage` 进化性写受 evolvable gate；UI `/memory/*` 不 gate、可改 evolvable（PATCH body 携带，见 `15-memory-ui.md`）。memory 无「UI 不能改 body」限制——UI 全字段可编辑。

## 5. 注册范围（`TOOL_POLICY`，已实现）

- **写侧 `memory_manage` + `skill_manage`**：`playground-rocky` / `studio-leader` / `studio-mate`（`subagent` / `studio-squad` 不绑，避免派生递归整理）。
- **[v0.0.112] 纯读 `memory`**：`playground-rocky` / `studio-leader` / `studio-mate` / `subagent`（对齐 `skill` 读工具 4 角色——凡被注入 memory L0 的角色都需 `memory` 读正文；`studio-squad` 不绑）。

见 `specs/tech/agent/tools/[P0]tool_policy.md TOOL_POLICY`。

## 6. 关键用户路径映射（测试覆盖）

| PRD 路径（v0.0.112 见 `specs/prd/overall/09-memory.md §9.3`） | case 类型 | case 所在 |
|---------|----------|----------|
| 路径 A：agent `memory.read(name)` → 完整正文 | memory AT（real LLM） | `tests/api/memory/` |
| 路径 B：agent `memory.search(keyword)` → name+desc（不含正文） | memory AT（real LLM） | `tests/api/memory/` |
| 路径 D：会话含方法+结论 → 自动总结路由（方法落 skill / 结论落 memory） | consolidation AT（real LLM） | `tests/api/memory/` |
| 路径 E：写超 500 字符 memory body → hard error，未落盘 | memory_manage AT | `tests/api/memory/` |
| 路径 G：agent write 不指定 scope → 落 global(user) | memory_manage AT（real LLM） | `tests/api/memory/` |
| session 内沉淀 skill（agent create） | skill_manage.create AT | `tests/api/skill/` |
| non-evolvable skill 拒绝改（agent 路径） | skill_manage.patch/disable REJECT AT | `tests/api/skill/` |
| UI 改 evolvable（手写 skill 解锁） | PATCH governance AT（HTTP） | `tests/api/skill/` |

## 7. AT 共同约定

- **real LLM**：ark glm-5.2（不 mock）。memory_manage / skill_manage 通过 user 自然语言 prompt 触发 LLM tool_use，不绕过 LLM 直调工具（验证完整 chain）。
- **真落盘验证**：每个 case 必须查磁盘真实文件确认最终态，不停在 tool 响应层。memory 真落盘位置（per-entry md dir store）：global→`<dataDir>/memory/<name>.md`；group→`<groupWs>/.rocky/memory/<name>.md`；session→`<session.workspaceDir>/.rocky/memory/<name>.md`（见 `15-memory-ui.md §11`）。skill→`<scope>/skills/<name>/SKILL.md`。
- **不查代码**：AT designer 从本文件 + tech spec 拿契约设计 case，不扒 `app/`。
