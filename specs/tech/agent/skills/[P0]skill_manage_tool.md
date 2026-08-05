---
type: interface
title: skill_manage 工具
priority: P0
status: active
updated: 2026-08-02
since: v0.0.51
---

# skill_manage 工具

> 主文档：`index.md`（① 是什么）。skill 定义见 `[P0]skill_definition.md`。skill 读工具见 `[P0]skill_tool.md`。一级整理触发见 `../memory/[P0]consolidation_tier1.md`。

> **实现落点（v0.0.51；v0.0.55 改名 evolvable + 删 mutableLocked）**：`app/server/src/tools/skill-manage.ts`（6 action 全落地）+ `SkillResolver.resolveAll`（list 含 disabled/builtin）+ `withFileLock` per-file 锁串行化（`app/server/src/persistence/file-lock.ts`）+ create 自动注入 3 治理字段（`{source:'agent', production_method:'consolidation', evolvable:true}`）+ evolvable 强制（false 拒绝 patch/disable/enable）+ payload 不含 evolvable（agent 不碰治理元字段）。

## 1. 概述

`skill_manage` 是 agent 管理 skill 的 tool。agent 通过它 create / patch / disable / enable / list / read skill，支撑 self evolution。

**核心原则**：**不审批**——skill 写入由 agent 自主完成，无人工 gate（与 `memory_manage` 一致）。安全靠 evolvable 治理（evolvable=false skill 拒绝写）+ disable 替代 delete（可恢复）+ 归档不删。

**与 skill 读工具的边界**：

| 工具 | 用途 | 读 disabled? | list? |
|------|------|-------------|-------|
| `skill`（读工具） | 对话中按需加载（L1） | 否（只读 enabled） | 否（L0 常驻 prompt） |
| `skill_manage`（本工具） | 管理用 | 是（list 含 disabled，read 可读全文） | 是（管理场景需看全部） |

## 2. 接口定义（v0.0.238：scope 必填无默认 + 按 biz 校验 + 对外暴露 group）

**scope 对外命名（v0.0.238 加 group）**：工具 input `scope` 取值 `global` | `session` | `group`（`list` 另含 `all`）。映射只在**工具边界**（`skill-manage.ts`），底层 `SkillScope`（`builtin`/`app`/`workspace`/`group`）不变。

| 对外 scope（tool input/output） | 内部 SkillScope | 位置 |
|---|---|---|
| `global` | `app` | `<dataDir>/skills/`（跨项目/会话） |
| `session` | `workspace` | `<workspaceDir>/.rocky/skills/`（**项目级**，非单会话私有——见 §2.1） |
| `group` | `group` | `<groupWs>/.rocky/skills/`（groupWs 经 `resolveGroupWsDir(dataDir, {squadId})` 解析，squad=`<dataDir>/squads/<sid>/`；无 squadId → `not_in_group`） |
| （输出回显专用） | `builtin` | 打包内置层 → 对外回显映射为 `global` |

**[v0.0.238] scope 必填（去默认 global）+ 按 biz 校验可用 scope**：create/patch/disable/enable 不传 scope → `[invalid_input]` + `scopeRequiredErrorText(biz, 'skill')`；传当前 biz 不可用 scope（如 studio 传 session / playground 传 group）→ `[invalid_input]` + `scopeUnavailableErrorText(biz, scope, 'skill')`。可用表来自单源 `biz-scope-rules.ts AVAILABLE_SCOPES_BY_BIZ`（与 memory 同词表，见 `../memory/[P0]memory_manage_tool.md §2`）。biz 由 `resolveBizScopeKind(ctx.config)` 读 `ctx.config.kind.biz`，缺省 `'playground'`。read/list 保持现状（read 缺省合并层 fallback，list 必填含 all）。**studio 场景 group 与 workspace 物理同址**——写 group 落 squad 目录（resolver 同址双扫按 group 生效，entry scope='group'）。

> **[v0.0.112→v0.0.238] spec 演进**：v0.0.112 把 scope 标「可选默认 global」并仅 global/session；v0.0.238 起加 `group`（暴露 squad 团队层）+ scope 必填（去默认）+ 按 biz 校验。原「默认 global」语义退役。

### 2.1 ⚠️ session ≠ 单会话私有（消歧，MANDATORY 写进 description）

skill 的对外 `session`（底层 workspace）是**项目级 workspace 存储**（`<workspaceDir>/.rocky/skills/`，一个项目多会话共享、可随 git 团队共享），**并非严格单会话私有**。命名统一后用户/agent 易误以为 skill session 是单会话——**tool description + spec 必须显式消歧**：skill `session` = 本项目（workspace）级，memory `session` 才是真·单会话私有。

```typescript
interface SkillManageTool {
  /** 新建 skill（自动 source=agent, method=consolidation, evolvable=true）。scope 默认 global。 */
  create(input: {
    name: string; description: string; body: string; allowedTools?: string[];
    scope?: "global" | "session";        // 默认 global；映射 global→app / session→workspace
  }): void;
  /** 改 body + frontmatter（除 evolvable）；只作用于 evolvable=true。scope 默认 global。 */
  patch(input: { name: string; scope?: "global" | "session"; description?: string; body?: string; allowedTools?: string[]; }): void;
  disable(input: { name: string; scope?: "global" | "session" }): void;   // evolvable=true 才允许
  enable(input: { name: string; scope?: "global" | "session" }): void;    // evolvable=true 才允许
  list(input: { scope: "global" | "session" | "all" }): SkillManageMeta[];
  read(input: { name: string; scope?: "global" | "session" }): SkillContent;
}

interface SkillManageMeta {
  name: string; description: string; evolvable: boolean; enabled: boolean;
  scope: "global" | "session";           // 输出回显对外命名（内部 app→global / workspace→session / builtin→global）
}
```

## 3. action 语义

| action | 用途 | 约束 |
|--------|------|------|
| `create` | 新建 skill | 自动设 `source=agent, method=consolidation, evolvable=true`；name 唯一（同 scope 内已存在则拒绝）；**[v0.0.238] description 必填且 ≤50 字符硬检查**（trim 后 str.length，超限 `[invalid_input] skill description exceeds 50 chars (current: <n>)`） |
| `patch` | 修改 body + frontmatter | **evolvable=true 才允许**；evolvable=false 拒绝；**不可改 evolvable 字段本身**；**[v0.0.238] payload 带 description 时同 ≤50 字符硬检查** |
| `disable` | 设 enabled=false | **evolvable=true 才允许**；复用 app_config `skill_state` group |
| `enable` | 设 enabled=true | **evolvable=true 才允许** |
| `list` | 列全部 skill 元数据 | **含 disabled**（关键：agent 需知道有哪些 skill 避免创建撞车的重复 skill） |
| `read` | 读任意 skill 全文 | 含 disabled skill 的完整 SKILL.md |

**不可 delete**：用 `disable` 替代（设 enabled=false，skill 仍在磁盘可恢复）。

> **[v0.0.238] description ≤50 字符硬检查**只覆盖 agent 工具路径（executeCreate/executePatch）。UI 市场安装（`skill_manage install` / `POST /skills/market/install`）走 `executeMarketInstall` 直写 SKILL.md（第三方 description 常远超 50 字），不经过 executeCreate，**不受硬限影响**——这是有意为之：第三方 description 是源数据，不入 ≤50 硬约束；T1 整理负责修低质 description。

## 4. evolvable 强制规则（agent 工具路径）

```
patch(name)  → if skill.evolvable === false → REJECT
disable(name) → if skill.evolvable === false → REJECT
enable(name)  → if skill.evolvable === false → REJECT
```

- `evolvable=false` 的 skill（用户手写 / 下载 / 系统内置）：patch/disable/enable 全部拒绝。
- `evolvable=true` 的 skill（agent create 产出 / consolidation 产出）：允许。
- **evolvable 字段本身不可被 agent 修改**（patch 的 payload 不含 evolvable 字段；agent 不碰治理元字段）。
- 创建时设定：`create` 自动 `evolvable=true`；用户手写/下载 `evolvable=false`；系统内置 `evolvable=false`（见 `skill_definition.md` §6.2/§6.3）。

**拒绝时返回的稳定 error code**（v0.0.55 落地，对齐 `app/server/src/tools/types.ts ToolErrorCode`）：

| 触发条件 | errorResult 前缀（iota） | ToolErrorCode 值 | 说明 |
|---|---|---|---|
| `patch/disable/enable` 命中 `evolvable=false` skill | `[invalid_input] skill "<name>" is non-evolvable ...` | `invalid_input` | 调用方据 iota `invalid_input` 归类为可重试/可处理的输入类错误（非 `runtime_error` / `not_found`） |
| `patch` payload 含 `evolvable` 字段 | （静默忽略，不写入） | — | agent 不碰治理元字段；payload 字段被丢弃，patch 仍按其他字段继续 |
| skill 不存在（patch/disable/enable/read） | `[not_found] skill "<name>" not found` | `not_found` | scope 解析后查不到 skill |
| action 非法 / name 缺失 / workspace 缺失 | `[invalid_input] ...` | `invalid_input` | 输入校验类 |
| 落盘失败（atomicWrite IO 错） | `[runtime_error] failed to write SKILL.md: <msg>` | `runtime_error` | 系统级 IO 异常 |

> errorResult 文本格式 = `[<code>] <human message>`，调用方/UT 按前缀 iota 判定归类（详见 `app/server/src/tools/types.ts ToolErrorCode`）。

> **UI 改 evolvable 走另一路径**（不走 `skill_manage` 工具）：UI 通过独立 HTTP 端点（SkillsService `PATCH /skill/:name/governance`）改 `evolvable` 字段，无 lock 约束（v0.0.55 删 mutableLocked，见 `skill_definition.md §8`）。`skill_manage` 工具的 evolvable 强制只管 agent 路径；UI 路径的强制在 service 层独立实现。

## 5. list 语义（含 disabled — 关键设计）

`list` 返回**全部** skill（含 disabled），带 `name/description/evolvable/enabled/scope` 元数据。

**为什么 list 含 disabled**：agent 在判断是否要 create 新 skill 前，需要知道是否已有类似 skill（即使被 disabled）。如果 disabled skill 不可见，agent 可能创建撞车的重复 skill。disabled ≠ 不存在——只是不注入 L0 catalog，但 skill 资产仍在。

**与 L0 catalog 的关系**：
- L0 catalog（system prompt 注入）= 仅 **enabled** skill 的 `name + description + evolvable`。
- `skill_manage.list` = **全部** skill（含 disabled）的元数据。
- disabled skill 不进 L0 catalog（不注入 system prompt），但 `skill_manage.list` 可见。

## 6. 触发时机

- **时机 A · session 内实时**：agent 判断有可复用的工作流值得沉淀为 skill，随时调 `skill_manage.create` / `skill_manage.patch`。
- **时机 B · compact 时机**：整理 forked agent（见 `../memory/[P0]consolidation_tier1.md` §时机 B）从完整对话提炼，**直接调** `skill_manage` 工具落盘（不审批）。

## 7. 注册范围 + 并发写：原子串行化

### 7.1 注册范围（仅记录，不实现）

`skill_manage` + `memory_manage` 工具注册给**所有 agent**（user_memory / skill 资产全局共享，所有 agent 都可写）：
- `playground-rocky`
- `studio-leader`
- `studio-mate`

依赖 v0.0.48 的 `tool_list` 机制（per-agent 工具集），待 v0.0.48 merge 后实现。本版本只记录范围约束，实现细节留给后续版本。

### 7.2 并发写：原子串行化（v0.0.51 v2 新增）

`skill_manage` 的写操作（create / patch / disable / enable）必须**原子串行化（文件锁）**：

- 多 agent 并发写同一 skill 文件（如 studio-leader 与 studio-mate 同时 patch 同一 skill）→ 由**文件锁序列化**，保证 SKILL.md 结构一致（不被并发写撕裂 frontmatter / 正文）。
- 锁粒度：**per-file**（同一 SKILL.md 文件一把锁；不同 skill 不互斥）。
- 锁范围：写操作全期持锁（读 frontmatter → 改 → 写回），读完即释放；读操作（list / read）**不持锁**（无读锁，多读并发无碍）。
- 锁实现：用 `proper-lockfile`（或等价 file lock lib），lock 文件路径 `<skill_dir>/.<name>.lock`（gitignore）。

**理由**：skill 资产跨 session / 跨 agent 共享（user 全局），并发安全靠**锁**而非**分区**（不按 agent / session 切分 skill 空间）。锁是协作式串行化，不阻塞读，仅序列化写。与 `memory_manage_tool.md §7` 同构。

## 8. 设计决策

- **不审批**：self evolution 哲学，agent 自主 create/patch/disable skill。
- **不可 delete**：用 disable 替代（可恢复，安全网）。
- **evolvable 强制**：evolvable=false skill 拒绝写操作，保护用户手写/下载资产。
- **evolvable 不可改**：agent 不能 true→false 或 false→true，防止自我锁定或越权。
- **list 含 disabled**：防创建撞车重复 skill（disabled ≠ 不存在）。
- **read 含 disabled**：管理场景需查看全部 skill 全文。
- **create 自动 evolvable=true**：agent 创建的 skill 可被后续整理修改。
- **patch 全文替换**：不做 section 级 patch（复杂度高，LLM 产全文更可靠）。

## 9. 文件级变更清单

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/tools/skill-manage.ts`（或 plugin） | 新增 | `SkillManageTool`（create/patch/disable/enable/list/read action） |
| `app/server/src/skills/enabled-store.ts` | 修改 | 复用现有 `skill_state` group（disable/enable 复用 enable/disable 逻辑） |
| `app/server/src/skills/resolver.ts` | 修改 | 新增 `resolveAll()`（含 disabled，供 list 用；现有 resolve 只返回 enabled） |

> 精确文件路径在 coder 阶段按实际代码结构确定；本表给职责粒度。

## 11. 路由提示词（v0.0.238：scope 必填无默认 + 按 biz 可用表）

`skill_manage` tool description 内嵌**两步决策**路由规则（single source `app/server/src/prompts/routing-decision.ts ROUTING_DECISION_PROMPT`，与 `memory_manage` description + consolidation fork prompt + consolidation-tier2 prompt **4 处同源**）：

- **第一步（skill vs memory vs 都不写）**：一套要照着执行的步骤/方法（how-to，可带 references/scripts）→ **skill**；会改变后续判断的事实/偏好/约束/教训 → **memory**；项目代码/架构事实 → 都不写（归 specs/代码）。
- **第二步（[v0.0.238] scope 必填无默认 + 按 biz 可用表）**：scope 语义（session=项目级 workspace / group=本团队共享 / global=跨项目全局）；写入**必须显式指定 scope**（无默认）；当前 biz 可用表（playground→session/global；studio→group/global；academy→三层）；传错或不传会被工具拒并按 biz 引导。

见 `../memory/[P0]memory_manage_tool.md §5.2` + `../memory/[P0]consolidation_tier1.md §6` + `biz-scope-rules.ts`（可用表数据源 + 错误文案函数）。

> **本版本 scope 命名范围（bounded）**：v0.0.238 起 **`skill_manage` 工具 input/output** 扩为 global/session/group（暴露 squad 团队层，session=项目级 workspace，与 memory 同词表）；skill **UI HTTP 端点**（`06-skill.md` / `06a-skill-governance.md`）+ skill 管理页 UI 仍用内部 `app`/`workspace`（UI 同步是后续一致性项，本版 OUT）。

## 10. 待定（P1）

- skill patch 的 diff 策略（全文替换 vs section 级）
- create 时的 allowedTools 默认值（继承父 agent 工具集 vs 空）
- skill 之间的依赖关系（create 的 skill 依赖另一个 skill）
- [v0.0.112 open] skill UI/HTTP（06/06a）+ 管理页 scope 是否也统一 global/session（当前保 app/workspace）

> 变更历史见 `log.md`（本 KB 位置轴）+ `specs/tech/version_logs/vX.Y/change_log.md`（跨版本发布说明）。
