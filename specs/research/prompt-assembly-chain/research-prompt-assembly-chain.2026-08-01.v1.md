---
type: research
req: v0.0.232.agents_md_injection
topic: prompt-assembly-chain
date: 2026-08-01
version: v1
author: researcher
---

# Prompt 组装链路调研：AGENTS.md 注入断链定位

> 调研范围：squad session（leader + mate）的 system prompt 组装链路 + AGENTS.md 为何未注入。
> 结论先行：**`context_files` mapper 配置正确、handler 实现正确，断链点在「cwd 来源」——squad session 的 `SessionConfig.workdir` 未指向 `workspaces/{memberId}/`，或指对了但 leader 的 AGENTS.md 缺失导致 readFirst 返回空。根因二选一，需 PRD 阶段决策修法。**

---

## 1. Prompt 组装链路图（session 创建 → system prompt 生成）

```
┌─ session 创建 ───────────────────────────────────────────────────────────┐
│                                                                            │
│  leader: squad-service.createSquad()                                      │
│    workspaceDir = squads/{squadId}/workspaces/{leaderMemberId}  (L155)    │
│    → sessionStore.createSession({ role:'leader', workspaceDir })           │
│                                                                            │
│  mate:   member-service.createMember()                                    │
│    workspaceDir = squads/{squadId}/workspaces/{memberId}        (L214)    │
│    → sessionStore.createSession({ role:'mate', workspaceDir })  (L223-233)│
│                                                                            │
│  academy 学员: handlers/academy-student.startVersionSession()              │
│    workspaceDir = versions/{label}/ws/                          (L229)    │
│    → sessionStore.createSession({ role:'student', workspaceDir })          │
└────────────────────────────────┬───────────────────────────────────────────┘
                                 │ session.workspaceDir 持久化
                                 ▼
┌─ run 时 config 装配（buildSessionConfigFromDeps, session-config.ts）────────┐
│  workdir = session.workspaceDir (非空)  否则回退 <DATA_DIR>/workspace (L235)│
│  → SessionConfig.workdir                                            (L317)│
└────────────────────────────────┬───────────────────────────────────────────┘
                                 │ config 传入 assemble
                                 ▼
┌─ context-engine.assemble → buildSystemPrompt(pluginManager, config, scopeId)│
│  （agent/system-prompt-builder.ts）                                        │
│  mappers = pluginManager.getExtensionImpls(system_prompt_mapper, scopeId) │
│  scopeId = kind.canonicalId（如 studio-leader:parent:main）               │
└────────────────────────────────┬───────────────────────────────────────────┘
                                 │ 按 scope yaml 取 impls 列表
                                 ▼
┌─ rocky_context plugin mapper 链（按 default.yaml 顺序）─────────────────────┐
│  identity → rules → tool_guidance → skills → ★context_files★ →            │
│  memory_user → memory_session → memory_group → squad_role →               │
│  team_roster → parent_task                                                │
└────────────────────────────────┬───────────────────────────────────────────┘
                                 ▼
┌─ ContextFilesMapper（plugins/builtins/rocky_context/prompt/context_files.ts）│
│  cwd = resolveCwd(ctx) = config.workdir ?? config.cwd            (L46-51) │
│  content = ContextFilesHandler.build({cwd}).content               (L32)   │
│  → 包 fragment { id:'context_files', tier:'context', priority:400 }        │
└────────────────────────────────┬───────────────────────────────────────────┘
                                 ▼
┌─ ContextFilesHandler（server/src/prompts/handlers/context-files-handler.ts）│
│  readFirst(cwd): for name in ['AGENTS.md','CLAUDE.md']:                   │
│    if exists(cwd/name) && 非空 → 读 + 截断 20000 char → return            │
│  找到 → "# Project Context (AGENTS.md)\n\n来自本会话工作目录：{fullPath}\n\n{正文}"│
│  找不到 → content:'' → mapper 返 [] → fragment 缺失                       │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. context_files mapper 配置在哪个文件？

**两处配合**：

| 层 | 文件 | 内容 |
|---|---|---|
| scope 定义 | `app/plugins/scopes/default.yaml` (L88-100) | `system_prompt_mapper` impls 列表含 `context_files`（第 5 个） |
| scope 继承 | `app/plugins/scopes/studio-leader.parent.main.yaml` / `studio-mate.parent.main.yaml` | `extends: default`，未覆写 `system-prompt` 组 → **继承 default 全量列表（含 context_files）** |
| impl 注册 | `app/plugins/builtins/rocky_context/plugin.json` | 注册 `context_files` impl 类（ContextFilesMapper） |

> 老板贴的配置片段 = `default.yaml` 的 `system-prompt` 组。leader/mate scope 只 `extends: default`，**没有独立覆写**，所以 impls 列表与 default 一致（含 `context_files`）。

---

## 3. context-files-handler 被调用了吗？结论：**配置上有，运行时是否生效取决于 cwd**

### 3.1 调用链是否走到 handler？

**会走到**。链路无断裂：
- `context_files` 在 default.yaml impls 列表里 ✓
- leader/mate scope `extends: default` 继承该列表 ✓
- plugin.json 注册了 `context_files` impl（ContextFilesMapper）✓
- ContextFilesMapper.map() 无条件 `new ContextFilesHandler().build({cwd})` ✓

### 3.2 但 handler 是否「读到文件」取决于 `cwd` 是否 = `workspaces/{memberId}/`

**`cwd` 来源链**（session-config.ts L235 + context_files.ts L46-51）：

```
ctx.config.workdir  ← SessionConfig.workdir  ← session.workspaceDir（session 持久化字段）
```

- leader：`session.workspaceDir = squads/{squadId}/workspaces/{leaderMemberId}`（squad-service L155）→ **workdir 正确**
- mate：`session.workspaceDir = squads/{squadId}/workspaces/{memberId}`（member-service L214, L231）→ **workdir 正确**

**所以 cwd 理论上是正确的 `workspaces/{memberId}/`**。

### 3.3 那为什么 leader 的 system prompt 里没有「Project Context」？

实测数据（`~/.rocky_agent_prod/squads/<squad-id>/workspaces/`）：

| memberId | workspaces/{id}/AGENTS.md 是否存在 |
|---|---|
| `<member-id>`（leader session ws，注：leader memberId 的 workspace 目录） | ✅ **存在**（含 `.claude/` 等） |
| 其余 14 个 mate | ✅ 大部分存在（仅 3 个缺失） |

> ⚠️ **注意**：leader sessionId = `<session-id>`，但其 workspace 目录名 = `<member-id>`（差一个字符，leader memberId）。需确认 squad-service 里 leader 的 workspaceDir 用的是 memberId 还是别的 id。

**leader 的 AGENTS.md 是存在的**（`workspaces/<member-id>/AGENTS.md`）。那 handler 应该读到。

### 3.4 候选断链点（按概率排序）

| 假设 | 验证方式 | 概率 |
|---|---|---|
| **H1. leader 的 session.workspaceDir 不是那个含 AGENTS.md 的目录**（id 错位：`...V8` vs `...V9`） | 查 session record 的 workspaceDir 字段 | 高 |
| **H2. 读到了，但「Project Context」片段在 budget_truncate reducer 被截断**（context tier priority=400 较低） | 看 leader prompt 全文是否有截断标记 | 中 |
| **H3. AGENTS.md 存在但内容为空**（readFirst 跳过空文件） | cat leader AGENTS.md 确认非空 | 低 |
| **H4. leader 的 scopeId 解析异常**（studio-leader scope 没生效，走了别的 scope 缺 context_files） | 查 session.kind.canonicalId | 低 |

> **实测**：leader AGENTS.md 存在且非空（含 `.claude/` 配套），H3 排除。**最可能是 H1（workspaceDir 指向错误目录）或 H2（被截断）**。

### 3.5 「handler 被调用了吗」的机械结论

- **配置层**：`context_files` 在 default.yaml，被 leader/mate scope 继承 → **被注册**
- **代码层**：ContextFilesMapper.map() 无条件调 handler → **被调用**
- **文件层**：handler 的 readFirst(cwd) 能否命中，**取决于 cwd 目录下是否真有 AGENTS.md/CLAUDE.md**
- **输出层**：handler 返空 → mapper 返 `[]` → fragment 缺失 → prompt 无「Project Context」；handler 读到 → fragment 存在，但可能被 reducer 截断

---

## 4. skills resolver 4 层来源如何传给 prompt？目前有没有标注？

### 4.1 4 层来源（skills/resolver.ts L15-25）

| 层 | 路径 | 优先级 |
|---|---|---|
| builtin（最低） | `app/plugins/builtins/skills/`（随 app 发版） | 4 |
| app | `<dataDir>/skills/`（全局安装） | 3 |
| workspace | `<workspace>/.rocky/skills/`（项目级） | 2 |
| group（最高） | `<groupWsDir>/.rocky/skills/`（squad 共享） | 1 |

合并语义：同名时高层胜出（group > workspace > app > builtin）。

### 4.2 如何传入 prompt

```
SkillResolver.resolve(dataDir, workdir, enabledStore, builtinSkillRoot(), groupDir)
  → catalog.entries[]（每个 entry 带 scope: 'builtin'|'app'|'workspace'|'group'）
  → SessionConfig.skills
  → skills mapper（plugins/builtins/rocky_context/prompt/skills.ts）
  → 拼 skills_list 字符串 → SkillsHandler 替换 skills.md 模板的 {{skills_list}}
  → fragment { id:'skills', tier:'stable', priority:500 }
```

### 4.3 有没有标注来源？**没有（只标注 system/user/agent 三分组）**

skills.ts L34-90 的 `deriveGroup(scope, source)` 把 4 层**压缩成 3 组**：

| scope | source | 归到组 |
|---|---|---|
| `builtin` | （任意） | `system`（随 app 发版内置） |
| 非 builtin | `user` | `user` |
| 非 builtin | `agent` | `agent` |

**L0 渲染格式**（skills.ts L66）：
```
- {name} [evolvable=true|false]: {description}
```

**没有 scope（builtin/app/workspace/group）标注，也没有路径标注**。`group` 字段只用于配额截断的组内排序（system→user→agent），**不进 L0 文本**。

> 这就是需求点 4（注入来源标注）的现状：**AGENTS.md 有路径标注（"来自本会话工作目录：xxx"），skills 完全无来源标注**。

---

## 5. academy 学员的 AGENTS.md 注入和 squad session 是同一套链路吗？

**是同一套链路**（同一 ContextFilesHandler + 同一 context_files mapper），区别仅在 `cwd`（即 `session.workspaceDir`）指向不同目录。

| 维度 | squad leader/mate | academy 学员 |
|---|---|---|
| scope yaml | `studio-leader.parent.main.yaml` / `studio-mate.parent.main.yaml`（extends default） | `academy-student.parent.main.yaml`（extends default + 覆写 system-prompt 组） |
| system_prompt_mapper impls | 含 `context_files`（继承 default） | 含 `context_files`（显式列出，L19） |
| context_files mapper | 同一个 ContextFilesMapper | 同一个 ContextFilesMapper |
| handler | 同一个 ContextFilesHandler | 同一个 ContextFilesHandler |
| `session.workspaceDir` | `squads/{squadId}/workspaces/{memberId}/` | `academy/{cid}/students/{sid}/versions/{label}/ws/` |
| AGENTS.md 位置 | `workspaces/{memberId}/AGENTS.md` | `versions/{label}/ws/AGENTS.md` |
| AGENTS.md 生效前提 | cwd 目录下有 AGENTS.md | cwd 目录下有 AGENTS.md |

**差异点**：
- academy 学员 scope **显式覆写** `system-prompt` 组（academy-student.parent.main.yaml L11-23），在 default 基础上加了 `academy_classroom_role`、去掉 squad 专属 mappers（squad_role/team_roster/parent_task/memory_group）。`context_files` 保留（L19）。
- academy 学员的 workspaceDir 由 `handlers/academy-student.ts` L229 赋为 `versions/{label}/ws/`（academy-paths.ts L53-62 派生），该目录下必有 AGENTS.md（academy 创建版本时生成）。
- squad 的 workspaceDir 由 squad-service/member-service 赋为 `workspaces/{memberId}/`，**AGENTS.md 是否存在不保证**（当前实测 leader 有、部分 mate 有、3 个 mate 缺）。

> **结论：同一套注入链路，academy 不回归的前提是「versions/{label}/ws/AGENTS.md 存在」（创建版本时强制生成）。squad 的断链不是机制问题，是「workspaces/{memberId}/AGENTS.md 缺失或 workspaceDir 指错」的数据/接线问题。**

---

## 6. 断链的具体位置 + 修复建议

### 6.1 断链定位（结论）

**机制上无断链**（配置 → mapper → handler → 文件读取全通）。**断在「数据/接线层」**，二选一（或叠加）：

1. **workspaceDir 指向的目录下没有 AGENTS.md**（3 个 mate 缺失；leader 实测有但需确认 session.workspaceDir 是否指向含文件的那个 id 目录——`...V8` vs `...V9` 差一字符）
2. **prompt 里有但 leader 没认出**（「Project Context」标题被 budget_truncate 截断，或 leader 看的 prompt 是旧 session 缓存）

### 6.2 修复建议（按需求 1-6 映射）

| 需求 | 修法 | 涉及文件 |
|---|---|---|
| **1. 修复断链（P0）** | ① 排查并修正 leader session.workspaceDir（确认是否指向 `workspaces/{leaderMemberId}/` 且该目录有 AGENTS.md）；② 对缺失 AGENTS.md 的 mate workspace 补建（或需求 5 兜底文案） | `services/squad-service.ts` L155, `services/member-service.ts` L214 |
| **2. 读取模块显式化（P0）** | 已显式化（ContextFilesHandler 就是唯一读取模块）；建议增强：handler 在「找不到文件」时返 `{content:'', diagnostic:'未配置（可选）：workspaces/{memberId}/AGENTS.md 不存在'}` 供 mapper 决定注入兜底片段 | `prompts/handlers/context-files-handler.ts` |
| **3. 2 级 AGENTS.md 支持（P1）** | 机制已支持（同一 handler，cwd 不同即路径不同）；需 PRD 明确「squad=workspaces/{memberId}/AGENTS.md，classroom=versions/{label}/ws/AGENTS.md」的约定 + session 类型选路径的逻辑（当前已由 session.workspaceDir 天然区分，无需额外选路） | 无需改代码，改约定文档 |
| **4. 注入来源标注（P1）** | ① AGENTS.md 已有路径标注（保留）；② skills 在 L0 加 `[scope=builtin/app/workspace/group]` 标注 + 可选路径标注（改 skills.ts L66 的 lines 拼接） | `plugins/builtins/rocky_context/prompt/skills.ts` |
| **5. 未配置兜底文案（P2）** | handler 找不到文件时，mapper 可选注入温和片段（如「# Project Context\n\n未配置（可选）：{cwd}/AGENTS.md 不存在」）而非返空；需 PRD 决策是否注入兜底片段（当前行为=静默缺失） | `context_files.ts`（mapper 层） |
| **6. 验收验证（P1）** | ① 用 `GET /session/:id/debug/system-prompt`（handlers/session-debug.ts）验证 leader+1 mate 的 prompt 含「Project Context」+ 标注；② 改 AGENTS.md 新建 session 复验 | `handlers/session-debug.ts`（已有 debug 端点） |

### 6.3 给 PRD 的关键决策点

1. **「ws 里有 AGENTS.md → prompt 里就有」的「有」怎么定义**：现状是静默缺失（找不到=prompt 无该片段）。要改成「找不到也注入兜底片段」还是「保持静默但提供 debug 可查」？（需求 5 倾向后者 + 温和标注）
2. **leader 的 workspaceDir id 错位**（`...V8` vs `...V9`）是 bug 还是设计？需 squad-service 代码复核（L155 用 leaderMemberId 是否正确）。
3. **skills 来源标注的粒度**：只标 4 层（builtin/app/workspace/group）还是连路径一起标？路径可能很长（group 层 `squads/{squadId}/.rocky/skills/`），建议标 scope + 短路径。
4. **budget_truncate 是否会吃掉 context tier**（priority=400 较低）：需确认 reducer 的截断策略，避免修好了注入却被截断。

---

## 8. 追加调研：budget_truncate 截断逻辑 + 两层 prompt 结构（leader 第 2/3 次追问）

> 老板贴了 system prompt 原文（末尾有 `…[dynamic context truncated by budget_truncate reducer]`）+ system_reminder 内容（含 Environment/Working directory/Reachable agents/squad:charter/squad:team-status，**无 AGENTS.md**）。
> leader 推断：「AGENTS.md 被读到了，但在 budget_truncate 阶段被截掉了」。本节验证该推断。

### 8.1 system prompt 主体 vs system_reminder 是两层吗？**是，完全两条链**

| 维度 | system prompt 主体 | system_reminder |
|---|---|---|
| 注入位置 | LLM 请求的 `system` 字段 | transcript 尾部的 user/system 消息块（随每轮对话） |
| 组装链 | `buildSystemPrompt` → mapper/reducer 链（system_prompt_mapper / system_prompt_reducer EP） | `runReminderProviders`（system_reminder EP，context-ingest-pipeline.ts L140） |
| EP | `system_prompt_mapper` + `system_prompt_reducer` | `system_reminder`（default.yaml L26-38） |
| 内容 | identity/rules/tool_guidance/skills/**context_files**/memory/squad_role/team_roster/parent_task | env/time/workspace/tool_error/todo/reachable_agents/squad_charter/task/squad_board/squad_workspace/squad_team_status |
| 是否过 budget_truncate | **是**（reducer 链含 budget_truncate） | **否**（reminder 不走 system prompt 的 reducer 链） |
| 老板贴的内容 | 含 `…[dynamic context truncated by budget_truncate reducer]` | Environment/Working directory/Reachable agents/charter/team-status |

> **结论：context_files（AGENTS.md）在 system prompt 主体层（mapper 链），不在 system_reminder 层。老板在 reminder 里看不到 AGENTS.md 是正常的（它本来就不该在那）。**

### 8.2 budget_truncate 是什么？在哪个文件？

**文件**：`app/plugins/builtins/rocky_context/prompt/budget_truncate.ts`
**EP**：`system_prompt_reducer`，priority 700（在 default.yaml L101-105 的 reducer 链第 3 个：`tier_sort → dedup → budget_truncate`）

### 8.3 截断逻辑（budget_truncate.ts L45-84）

```
① budget = clamp(contextWindow × budgetFraction, floor, ceiling)
   默认 budgetFraction=0.06, floor=20000, ceiling=500000
   token 估算 = char × ratio（ratio=1.0，char 直接当 token）

② 分池：stable 全保留（不裁，裁了破坏 LLM 行为）；context + volatile 进裁剪候选池（dynamic）

③ dynamicChars = dynamic 各 fragment content.length 之和
   if dynamicChars <= budget → 不动（原样返回）

④ 超阈值 → 从 dynamic **头部开始保留**，直到 budget 用尽；第一个放不下的 fragment 起**整段丢弃**（break）
   → 尾部追加标记 fragment：'…[dynamic context truncated by budget_truncate reducer]'
```

**截断顺序 = tier_sort 后的顺序**（budget_truncate 在 tier_sort 之后跑）：
- tier 间固定：stable(0) → context(1) → volatile(2)
- 同 tier 内：priority **降序**（大者靠前，先被保留）

### 8.4 各 fragment 的 tier / priority（实测各 mapper 源码）

| fragment | tier | priority | 是否进 dynamic 裁剪池 |
|---|---|---|---|
| identity | stable | 1000 | 否（stable 全保留） |
| squad_role | stable | 950 | 否 |
| rules | stable | 800 | 否 |
| parent_task | stable | 700 | 否 |
| team_roster | stable | 650 | 否 |
| tool_guidance | stable | 600 | 否 |
| skills | stable | 500 | 否 |
| memory_user | stable | 450 | 否（memory_injection §5 明确 stable 不被裁） |
| memory_group | stable | 400 | 否 |
| **context_files（AGENTS.md）** | **context** | **400** | **是（dynamic 池）** |
| memory_session | context | 350 | 是（dynamic 池） |

### 8.5 context_files 在截断优先级里的位置

**dynamic 池内（tier_sort 后，priority 降序）**：
```
context tier: context_files(400) → memory_session(350)
volatile tier: （budget_truncate_note 等）
```
**context_files 是 dynamic 池里 priority 最高的（400），排最前，最先被保留。**

### 8.6 关键验算：context_files 会不会被 budget_truncate 砍掉？

**实测数据**：
- 模型 k3 `contextWindow = 300000`（`~/.rocky_agent_prod/app_config/providers/app_config/<provider-id>.json`）
- `budget = clamp(300000 × 0.06, 20000, 500000) = clamp(18000, 20000, 500000) = 20000 char`（**floor 兜底 = 20000**）
- leader AGENTS.md = **65334 char**（`workspaces/<member-id>/AGENTS.md`）
- context-files-handler 截断到 **20000 char**（MAX_FILE_CHARS）

**budget_truncate 阶段验算**（dynamic 池只有 context_files + memory_session）：
```
budget = 20000
context_files = 20000（已被 handler 截断）→ used=20000，刚好放下，保留
memory_session ≈ 500 → 20000+500 > 20000 → ✂ 整段丢弃 + 追加 truncate_note
```

> **数值结论：context_files（20000）单独刚好填满 budget（20000），会被保留；被砍的是排在它后面的 memory_session。**

### 8.7 ⚠️ 与 leader 推断的矛盾点（诚实上报）

**leader 推断「AGENTS.md 被 budget_truncate 截掉」——数值上不成立**：

1. **budget_truncate 只裁 dynamic 段，且 budget=20000 只量 dynamic 段总长**（stable 不计入 budget）。context tier 只有 context_files(20000) + memory_session(~500)，context_files 恰好=20000 ≤ budget，**不会被砍**。
2. **被砍的是 memory_session**（priority 350 < context_files 400，排后，20000+500>20000 触发 break）。
3. 老板贴的 prompt 末尾有 truncate 标记，**只能证明 dynamicChars > budget**，即 `context_files + memory_session > 20000`——**恰好证明 context_files 被读到了（否则 dynamicChars ≈ 500 < 20000，不会触发截断，也不会有 truncate_note）**。

> **truncate_note 的存在反而是 context_files 已注入的证据**（它把 budget 占满了）。

### 8.8 那「leader prompt 里没有 Project Context」怎么解释？（修正后假设）

| 假设 | 依据 | 概率 |
|---|---|---|
| **H-A. Project Context 在 prompt 里，但 leader/老板没翻到**（20000 char 的 Project Context 片段夹在大 prompt 中间，肉眼易漏；老板看到的是被截断的尾部 + reminder） | context_files 保留在 dynamic 头部，prompt 中段 | 高 |
| **H-B. AGENTS.md 注入的是旧 session**（prompt 在 session 启动时组装一次并缓存，AGENTS.md 是后来才写的） | PromptHandler dev mtime 缓存 / prod once 缓存 | 中 |
| **H-C. 老板贴的 prompt 不是 leader session 的**（可能是 squad 群聊 session，其 workspaceDir=squad 根目录，无 AGENTS.md → context_files 返空 → 但那样 dynamicChars 又不够触发截断…矛盾） | squad router workspaceDir=squadRootDir（squad-service L195） | 低（与截断标记矛盾） |
| **H-D. memory_session 才是被砍的，但老板把「缺 memory_session」误读成「缺 Project Context」** | 验算 8.6 | 中 |

> **建议 PRD 前用 `GET /session/:id/debug/system-prompt`（session-debug.ts）抓 leader session 的完整 system prompt，grep `Project Context` 一锤定音——这是唯一能区分 H-A/H-B 的手段。**

### 8.9 追加修复建议（截断维度）

| 问题 | 修法 |
|---|---|
| **floor=20000 太小**：k3 contextWindow=300000，6%=18000 被 floor 抬到 20000，但 AGENTS.md(20000)+memory_session 就撑爆 → memory_session 永远被砍 | 调 manifest：budgetFraction 提到 0.10-0.15，或 floor 提到 40000+（让 AGENTS.md + memory 共存） |
| **截断粒度太粗**：整段丢弃（break）而非部分截断 → 超 1 char 就丢整段 memory_session | 改 budget_truncate：最后一个放不下的 fragment 做「部分保留」（截到剩余 budget），而非整段 break |
| **AGENTS.md 20000 截断后仍占满 budget**：等于 AGENTS.md 独占整个 dynamic 预算，其他 dynamic 片段（memory_session）必被挤掉 | ① 降 MAX_FILE_CHARS（20000→8000）；② 或给 context_files 单独预算上限 |
| **truncate_note 有误导性**：只标「被截断」，不标「谁被截断」→ 排查困难 | note 里列出被丢弃的 fragment id 列表（如 `…[truncated: memory_session]`） |

---

## 7. 附：关键文件清单

| 文件 | 角色 |
|---|---|
| `app/server/src/prompts/handlers/context-files-handler.ts` | AGENTS.md/CLAUDE.md 读取器（readFirst + 20000 char 截断） |
| `app/plugins/builtins/rocky_context/prompt/context_files.ts` | context_files mapper（cwd 解析 + 委托 handler + 包 fragment） |
| `app/server/src/handlers/session-config.ts` | SessionConfig 装配（workdir = session.workspaceDir，L235/L317） |
| `app/server/src/services/squad-service.ts` L155 | leader workspaceDir = workspaces/{leaderMemberId} |
| `app/server/src/services/member-service.ts` L214/L231 | mate workspaceDir = workspaces/{memberId} |
| `app/server/src/handlers/academy-student.ts` L229 | academy 学员 workspaceDir = versions/{label}/ws/ |
| `app/plugins/scopes/default.yaml` L88-100 | system_prompt_mapper impls 列表（含 context_files） |
| `app/plugins/scopes/studio-leader.parent.main.yaml` / `studio-mate.parent.main.yaml` | leader/mate scope（extends default，继承 impls） |
| `app/plugins/scopes/academy-student.parent.main.yaml` L19 | academy 学员 scope（显式含 context_files） |
| `app/plugins/builtins/rocky_context/prompt/skills.ts` | skills mapper（L0 无来源标注，deriveGroup 三分组） |
| `app/server/src/skills/resolver.ts` | skills 4 层 resolver（builtin/app/workspace/group） |
| `app/server/src/agent/system-prompt-builder.ts` | buildSystemPrompt（mapper/reducer 链 + "\n\n".join） |
| `app/server/src/handlers/session-debug.ts` | debug 端点（GET /session/:id/debug/system-prompt，验收用） |
