---
type: interface
title: System Prompt 构建（mapper / reducer）
priority: P0
status: active
updated: 2026-08-15
since: v0.0.8
---

# System Prompt 构建（mapper / reducer）

> 主文档：`[P0]context_engine.md`。扩展点机制见 `../../plugin_system/[P0]extension_point_interface.md`。整合索引（8 EP = 6 ordered + 2 exclusive compact；35 impl）见 `[P0]extension point and implementations.md`。调研依据见 `../../../research/v0.0.5-system-prompt-builder.md`。

## 1. 概述

`SessionConfig.systemPrompt`（最终喂 LLM 的 system string）由 **map → reduce → build 三阶段**构建：

```
   system_prompt_mapper (ordered)        system_prompt_reducer (ordered)                 builder（固定）
   [mapper₁ → mapper₂ → …]  ──concat──→  [tier_sort → dedup → budget_truncate …]  ──→  "\n\n".join  ──→ systemPrompt: string
   各 mapper 贡献 PromptFragment[]         链式处理 fragment 序列                          无脑拼接，非扩展点
```

- **mapper 链**（ordered 扩展点）：每个 mapper 贡献 0-N 个 `PromptFragment`，concat 成完整序列。
- **reducer 链**（ordered 扩展点）：链式处理 fragment 序列（排序 / 去重 / token 裁剪），输出仍是 fragment 序列（不是 string）。
- **builder**（固定，非扩展点）：无脑 `"\n\n".join` 拼接 reducer 输出 → string；不做排序/去重/裁剪（那些归 reducer）。

**scope 解析（v0.0.204 实接）**：mapper/reducer 链按 **scopeId** 取 impl 列表（`buildSystemPrompt(pluginManager, config, scopeId='default')`，scopeId = SessionKind canonicalId 纯拼接；per-EP 沿 scope yaml `extends` 链回退，root = default）。scope 级 system_prompt 覆写（如 playground 去 squad mapper）靠本参数生效——此前 buildSystemPrompt 单参恒走 default scope，所有 scope yaml 的 mapper/reducer 覆写静默无效（v0.0.204 C2 修复）。**async**：`buildSystemPrompt` 是 async 函数——mapper 链可能含 async impl（读 store），同步迭代 Promise 会抛 TypeError 被单 mapper 降级 catch 吞掉、输出静默丢失，故整条 mapper 链 `await m.map(ctx)`。

---

## 2. PromptFragment

```typescript
type PromptTier = "stable" | "context" | "volatile";

interface PromptFragment {
  id: string;            // 唯一标识，合并去重依据
  tier: PromptTier;      // 决定 cache 稳定性 + 合并排序（stable→context→volatile）
  content: string;       // 片段正文
}
```

> **tier 内排序用 mapper ext impl 的 effective order**（不另设 fragment.order）——一个 mapper 产多片段时，这些片段继承该 mapper 的 effective order。[v0.0.18] 删 `ExtImpl.priority` 后统一为 effective order（per-point 连续 1..n，无 record 时按 manifest 登记序末尾补位）；不另设 fragment 级排序字段（三层排序概念嫌多，砍掉 fragment 级）。

---

## 3. 两个扩展点

```typescript
const SystemPromptMapperPoint = {
  id: "system_prompt_mapper",
  group: "context",
  cardinality: "ordered",   // [v0.0.18] ext impl 按 effective order 升序串联；[v0.0.13] v0.0.5 hold 解除，6 impl 归 rocky_context
};

const SystemPromptReducerPoint = {
  id: "system_prompt_reducer",
  group: "context",
  cardinality: "ordered",   // [v0.0.13] v0.0.5 hold 解除，3 impl 归 rocky_context
};
```

> **[v0.0.13]** mapper/reducer 双 EP 由 `ContextEngine` 经 `PluginManager.getExtensionImpls(point, scopeId)` 驱动跑链（map→concat fragments；reduce→链式 `PromptFragment[] → PromptFragment[]`；builder 固定 `"\n\n".join`），见 `[P0]context_engine.md` §3.5。9 个内置 impl（6 mapper + 3 reducer）归 `rocky_context` plugin（见 `[P0]extension point and implementations.md` §3.4/§3.5）。**[v0.0.204]** 跑链按 scopeId 解析（§1 scope 解析）；`buildSystemPrompt` async 化（mapper 链可能含 async impl，§1）。

### mapper 契约

```typescript
interface SystemPromptMapper {
  /** 贡献 0-N 个片段；返回空数组表示本次不贡献 */
  map(ctx: PromptCtx): PromptFragment[] | Promise<PromptFragment[]>;
}

/** mapper/reducer 上下文；各 mapper 按需读（来源见 §4）：identity/rules 经 PromptHandler 读 prompts/content/*.md（见 `[P0]prompt_content_files.md`），tool_guidance 读 config.tools，context_files 读 cwd 文件，memory 读记忆源 */
interface PromptCtx {
  config: SessionConfig;   // 含 tools（tool_guidance）、cwd（context_files）等
}
```

### reducer 契约（链式，与 assemble reducer 同构）

```typescript
interface SystemPromptReducer {
  /** 链式：input = 上一 reducer 输出（首 reducer 输入 = mapper concat 的完整序列）；输出仍是 fragment 序列 */
  reduce(input: PromptFragment[], ctx: PromptCtx): PromptFragment[];
}
```

reducer 链结束仍是 `PromptFragment[]`（不是 string），由 builder（§5）拼接。

**内置 reducer**（ordered ext impl，链式 `PromptFragment[] → PromptFragment[]`）：

| implId | 默认 order（登记序） | 逻辑 |
|---|---|---|
| `tier_sort` | 1 | 按 tier 排序：stable→context→volatile（tier 间固定）；tier 内按所属 mapper effective order 升序 |
| `dedup` | 2 | 同 `fragment.id` 去重，effective order 小的赢（不拼接） |
| `budget_truncate` | 3 | token 预算裁剪：**只裁 context/volatile 动态段**（不裁 stable，裁了破坏 LLM 行为）；超阈值从动态段尾部裁；阈值 = clamp(contextWindow × budgetFraction, floor, ceiling)（默认 `budgetFraction=0.06`、`floor=40000`、`ceiling=500000` token，归本 reducer `ExtImpl.configSchema`，显式 JSON Schema 见 `extension point and implementations.md` §4.5），token 用 char×ratio 估算（见 context_usage_detail §4）；**截断可溯源**——触发截断时尾部标记 fragment 列出全部被丢弃的 dynamic fragment id（`…[dynamic context truncated by budget_truncate reducer; dropped: id1, id2]`），不得静默 |

---

## 4. 内置 mapper 清单

| implId | tier | 默认 order（登记序） | 内容 | 来源 |
|---|---|---|---|---|
| `identity` | stable | 1 | agent 身份/角色（5 要素：定位/能力/协作/风格/诚实性红线） | **`prompts/content/identity.md`**（经 `IdentityHandler` 读取，见 `[P0]prompt_content_files.md`） |
| `rules` | stable | 2 | 行为规则（3 section：Operating Rules / Doing Tasks / Tool Use） | **`prompts/content/rules.md`**（经 `RulesHandler` 读取） |
| `tool_guidance` | stable | 3 | 工具使用说明 | **`prompts/content/tool_guidance.md` 模板 + 运行时数据**（`{{tool_list}}` ← `config.tools` 各 definition `name + (intro ?? description)`，[v0.0.146] 优先 intro 短简介、无则 fallback description） |
| `skills` | stable | 4 | 技能说明（L0 每条带 `[scope=builtin|app|workspace|group]` 来源层标注） | **`prompts/content/skills.md` 模板 + 运行时数据**（`{{skills_list}}` ← `config.skills.entries`，经 `selectSkillsByQuota` 按物理层分层配额 20/30/50 + builtin 不计恒全量殿后 + catalog 序 workspace→group→app→builtin） |
| `agent_profile` | stable | 5 | 「定义你的 agent」section（a) AGENTS.md 路径+叠加 b) memory scope c) skills 层路径；统一 mapper 按 `config.kind` 分支渲染，详见 `[P1]agent_profile.md`） | **运行时计算**（kind/sessionContext/workdir/dataDir + 文件存在性检测） |
| `context_files` | context | 6 | AGENTS.md / 项目上下文（squad 两级：团队 + 个人差异叠加，各带来源标注） | **项目文件**（项目根 `AGENTS.md`/`CLAUDE.md` + squad 个人差异 `.rocky/agents/{名字}-{id}.md`，路径走 `config.cwd`；经 `ContextFilesHandler` 读取，见 `[P0]prompt_content_files.md` §4.1） |
| `memory_user` | stable | 7 | 用户级长期记忆（跨 session）—— 只注入 L0（name+intro）；经 `selectMemoriesByQuota` 按 scope 分层配额截断（global ≤50，层内 manual→agent + updatedAt 倒序） | **app_config record `user_memory/default`**（`UserMemoryService.list`；native 注入，见 `../memory/[P0]memory_injection.md`） |
| `memory_session` | context | 8 | session 级记忆 —— 只注入 L0（name+intro）；经同一 `selectMemoriesByQuota` 分层配额（session ≤20）；squad session 的 session 源与 group 同址时跳过（去重，见 `../memory/[P0]memory_injection.md` §2.3） | **`<session.workspaceDir>/.rocky/memory/` per-entry dir**（`listMetas`；native 注入，见 `../memory/[P0]memory_injection.md`） |
| `session_states` | stable | 12 | session states 静态段——env / 工作目录 / 团队盘路径三小节（迁自退役 reminder provider env/workspace/squad_workspace，逻辑平移；团队盘小节仅 squad session）；fragment priority 810（rules 之后、squad_role 之前），代码 `prompt/session_states.ts` | **运行时计算**（config env/cwd/dataDir/squadId） |

> **scope 级 mapper（不在 default 链）**：上表是 default scope 的链。scope yaml 可对 `system_prompt_mapper` 点声明全量替换列表——如 `playground-rocky.parent.main` scope 去 squad_role/team_roster/memory_group/parent_task（替换为更简的 mapper 集合）；`studio-{squad,leader,mate}.parent.main` 等 scope 也声明自己的列表。这些覆写经 §1 的 scopeId 解析生效。

> **skills/memory mapper 注入配额（mapper 内闭环，不新增 reducer）**：截断在 mapper 内闭环——配额读 `app_config` group `session`，不新增 PromptCtx 字段、不新增 reducer。
> - **skills mapper**（分层配额）：`selectSkillsByQuota(rows, quotas)` 接 `SkillInjectQuotas` `{ session: 20; group: 30; global: 50 }`，物理层归组映射 = workspace→session / group→group / app→global / **builtin 不计配额恒全量殿后**；catalog 拼接序 = workspace → group → app → builtin（近者优先）；层内 user→agent + updatedAt 倒序 + name 升序。app_config：`maxSkillInject`（旧 key 语义转为 global 层）/ `maxSkillInjectGroup` / `maxSkillInjectSession`（缺省 50/30/20）。builtin 由 `injectLayerOf(scope)` 映射到独立 inject layer（不经 origin 分组）。详见 `../skills/[P0]skill_definition.md §3`。
> - **memory_user + memory_session + memory_group mapper**（分层配额）：`selectMemoriesByQuota(...)` 接 `MemoryInjectQuotas` `{ session: 20; group: 30; global: 50 }`，各 scope 独立截断（层内 manual→agent + updatedAt 倒序 + name 升序）；跨 scope 不再共享总量。app_config：`maxMemoryInject`（旧 key 语义转为 global 层）/ `maxMemoryInjectGroup` / `maxMemoryInjectSession`（缺省 50/30/20）。详见 `../memory/[P0]memory_injection.md §2.2`。
> - **skill=stable tier，数量变破 prompt cache**（预期内，本机制目的就是控量；记一笔，不额外缓存）。

> **[v0.0.22] prompt 正文文件化**：`identity`/`rules`/`tool_guidance`/`skills` mapper 的「正文内容源」从代码内置常量改为「经 `PromptHandler` 读 `prompts/content/*.md`」（plugin 层 mapper 变薄，委托 handler 取 content → 包 PromptFragment；handler 仍是 server 核心模块，不引入新 EP、不改 manifest）。详见 `[P0]prompt_content_files.md`。`context_files` 仍读项目 cwd 文件（不经 content 目录，但代码结构抽到 `ContextFilesHandler`）。

> **timestamp / dynamic_context 不在 system prompt**——它们每 turn 变化、会破坏 prompt cache，改走 **system reminder**（运行时动态注入最后一条 user message，不进 system prompt）。见 `[P0]system_reminder.md`。

---

## 5. builder（固定，非扩展点）

reducer 链输出的 fragment 序列 → 无脑拼接：

```
build(fragments):
  "\n\n".join(fragments.map(f => f.content)) → systemPrompt: string
  → 注入 SessionConfig.systemPrompt
```

- **无脑**：只拼接，不做排序/去重/裁剪（那些都归 reducer 链 §3）。
- **非扩展点**：固定，不可替换。要换拼接策略，改 reducer 产出的顺序/内容，不换 builder。

---

## 6. 触发时机与 cache

- **由 `assemble()` 调用 system prompt builder 构建** `snapshot.system`：assemble 组装 snapshot 时跑 mapper 链 + 默认合并，产出 system string（见 `context_assemble_detail.md`）。**调用形态**：`await buildSystemPrompt(pluginManager, config, scopeId)`（v0.0.204 起 async + 透 scopeId——assemble 入参 scopeId 原样透传，session-debug 预览端点同样透 `scopeIdOf(kind)` 保证预览与真实链一致）。
- **缓存留给实现**：mapper 结果不变时实现可复用（stable tier 本身 cache 友好），spec 层只规定「assemble 负责构建」，不强制每次重算或必须缓存。
- **cache 友好**：stable 段（身份/规则/工具/技能）极少变 → prompt cache 命中；仅 volatile 段（记忆）变化才破缓存。
- **timestamp 不在本 spec 范围**：走 system reminder（见 `[P0]system_reminder.md`）。reminder 注入最后一条 user message，**本来就不破 system prompt cache**（system 字段独立）；user message 段每 turn 失效，时间精度日→分钟无额外 cache 损失。[v0.0.64] 起 time reminder 用分钟级 + 时区名，旧版「日期精度保 cache」标注是误置权衡（详见 system_reminder §5）。

---

## 7. token 预算 → 由 budget_truncate reducer 实现

token 预算裁剪不再是 system_prompt 自己 hold，而是 **`budget_truncate` reducer**（见 §3 内置 reducer）的职责：

- **只裁动态段**（context_files / memory），不裁 stable（身份/规则，裁了破坏 LLM 行为）。
- 阈值 = clamp(contextWindow × `budgetFraction`, `floor`, `ceiling`)（默认 `budgetFraction=0.06`（6%，参考 Hermes）、`floor=40000`、`ceiling=500000` token；char 用 ratio 转）。floor 40000 的口径：两级 AGENTS.md（团队 ≤20000 + 个人 ≤8000）+ memory_session L0 清单在 dynamic 段可共存，不被互相挤掉。
- 超阈值从动态段尾部裁。
- 阈值归 budget_truncate 的 `ExtImpl.configSchema`（谁用归谁）。**显式 JSON Schema 字段名**（type/default/min/max）见 `[P0]extension point and implementations.md` §4.5。

---

## 8. 与 SessionConfig.systemPrompt 的关系

构建结果（string）注入 `SessionConfig.systemPrompt`，供 `assemble()` 作为 snapshot.system（见 `context_engine.md` §2）。

---

## 9. 边界与坑（竞品调研提炼）

1. ~~timestamp 用日期精度（分钟级每 turn 破缓存）~~ **[v0.0.64] 已澄清为误置权衡**：timestamp 走 reminder 不进 system prompt，与 cache 正交（system 段独立）。旧版「日期精度保 cache」标注把「保 system prompt cache」当成 reminder 节流理由是错的——reminder 注入最后 user message 段每 turn 失效，cache 本来就 miss，时间精度日→分钟无额外损失。详见 `[P0]system_reminder.md §5`。
2. 同 id 去重 = effective order 小的赢（[v0.0.18] priority 已删），不拼接（避免 OpenClaw 式整串覆盖混乱）
3. token 只裁动态段（budget_truncate reducer，见 §3/§7）
4. 单 mapper 失败降级为「不贡献」，不中断整个构建

---

## 10. 版本

> 变更历史见 [`log.md`](log.md)（本 KB 位置轴）+ [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)（跨版本发布说明）。v0.0.22 prompt 正文文件化的 spec 影响详见 `[P0]prompt_content_files.md`。
