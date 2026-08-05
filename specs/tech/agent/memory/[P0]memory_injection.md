---
type: concept
title: Memory 注入 context（native 注入）
priority: P0
status: active
updated: 2026-08-02
since: v0.0.21
---

# Memory 注入 context（native 注入）

> 主文档：`index.md`（① 是什么）。memory 定义见 `[P0]memory_definition.md`。注入入口对齐 `../context/[P0]system_prompt.md`（`SystemPromptMapper` 扩展点）。

## 1. 概述

memory 通过 **native 注入**进入 context：系统组装 context 时自动把每条 memory 的 **L0（name + intro）** 作为 `PromptFragment` 注入 system prompt，agent 无感（不直接 Read memory 文件，对应 `memory_definition` §4 封装）。

**核心（v0.0.112 翻转）**：**L0 注入（name+intro）+ 正文按需读**——注入侧只带每条 memory 的 `name + intro`（对齐 skill catalog），正文经 `memory` 纯读工具按需读（L1，见 `[P0]memory_tool.md`）。翻转 v0.0.21~v0.0.111 的「whole-file 整体注入」不变量：条目再多也不撑爆上下文。

## 2. 注入入口（复用 system_prompt mapper 扩展点）

memory 注入 = 注册 `SystemPromptMapper` ext impl，**不造新机制**。

> **实现状态（三 mapper 协同）**：`memory_user` / `memory_group` / `memory_session` mapper（`app/plugins/builtins/rocky_context/prompt/memory.ts` + `memory-group.ts` re-export）。memory_user priority=450 tier=stable；**memory_group priority=400 tier=stable**（介于 user 与 session 之间——比 session 稳定，与 user 同 stable tier 保 cache 友好）；memory_session priority=350 tier=context。**L0 注入（name+intro）+ 正文按需读** + archived 跳过 + 空 entries/全 archived 不贡献 fragment。三 mapper 读源统一 dir store `listMetas`（metadata 级，只读 frontmatter 不读 body），各自读三源（global + session + group）后调共享纯函数 `selectMemoriesByQuota(globalEntries, sessionEntries, groupEntries, quotas: MemoryInjectQuotas)`（`app/server/src/memory/inject-quota.ts`）做全局分层排序截断，各自只输出本 scope 的切片（决策 A，见下）。

| scope | mapper impl | tier | priority | 读源 | 说明 |
|-------|-------------|------|----------|------|------|
| `global` | `memory_user` | **stable** | 450 | `<dataDir>/memory/`（`listMetas(globalMemoryDir(dataDir))` → name+intro+source+updatedAt） | 跨 session 稳定，cache 友好；全局一份 |
| `group` | `memory_group` | **stable** | 400 | `<groupWs>/.rocky/memory/`（`listMetas(wsMemoryDir(groupWs))`；groupWs 经 `resolveGroupWsDir(dataDir, {squadId, classroomId})` 解析，皆缺 → 空贡献不阻塞） | 团队（squad/classroom）内共享；per-group 隔离；比 session 稳定，与 user 同 stable tier |
| `session` | `memory_session` | **context** | 350 | `<workdir>/.rocky/memory/`（`listMetas(wsMemoryDir(ctx.config.workdir))`；workdir 缺 → 空贡献） | session 级；per-session 隔离；被裁条目靠 `memory.search` 兜底定位 |

```typescript
// 三 mapper 协同分层配额（session ≤20 / group ≤30 / global ≤50 独立计数）：
//   三 mapper 各自读三源 → 调同一 selectMemoriesByQuota(global, session, group, quotas) → 同输入同输出
//   → 各自只输出本 scope 的切片为 fragment（tier 不变）
// formatL0(rows) → "# <header>\n- <name>: <intro>\n..."（不含 body/why/how）
//   + 末尾提示「Use the `memory` tool to read a memory's full body by name.」
const MemoryUserMapper: SystemPromptMapper = {
  map(ctx: PromptCtx): PromptFragment[] {
    const { global, session, group } = readMemorySources(ctx);
    if (global.length === 0 && session.length === 0 && group.length === 0) return [];
    const quotas = resolveMemoryQuotas(ctx);
    const { global: picked } = selectMemoriesByQuota(global, session, group, quotas);
    const content = formatL0(picked, '# Long-term User Memory');
    return content ? [{ id: "memory_user", tier: "stable", content, priority: 450 }] : [];
  }
};
const MemoryGroupMapper: SystemPromptMapper = {
  map(ctx: PromptCtx): PromptFragment[] {
    const { global, session, group } = readMemorySources(ctx);
    if (global.length === 0 && session.length === 0 && group.length === 0) return [];
    const quotas = resolveMemoryQuotas(ctx);
    const { group: picked } = selectMemoriesByQuota(global, session, group, quotas);
    const content = formatL0(picked, '# Group Memory');
    return content ? [{ id: "memory_group", tier: "stable", content, priority: 400 }] : [];
  }
};
const MemorySessionMapper: SystemPromptMapper = {
  map(ctx: PromptCtx): PromptFragment[] {
    const { global, session, group } = readMemorySources(ctx);
    if (global.length === 0 && session.length === 0 && group.length === 0) return [];
    const quotas = resolveMemoryQuotas(ctx);
    const { session: picked } = selectMemoriesByQuota(global, session, group, quotas);
    const content = formatL0(picked, '# Session Memory');
    return content ? [{ id: "memory_session", tier: "context", content, priority: 350 }] : [];
  }
};
// readMemorySources 三源统一 dir store listMetas：global=globalMemoryDir(dataDir) / session=wsMemoryDir(workdir) / group=wsMemoryDir(groupWs)
// 缺依赖（无 workdir / 无 squadId+classroomId）对应源 → [] 空贡献不阻塞其他源
```

### 2.1 三 mapper 协同共享配额（决策 A）

**问题**：memory 三 mapper（memory_user=stable 450 + memory_group=stable 400 + memory_session=context 350）各自贡献 fragment，但要求「最终注入条目数按 scope 分层独立配额（session ≤20 / group ≤30 / global ≤50）」——**各 scope 配额独立**（v0.0.238 起不再跨 scope 共享总量），单 mapper 各自截断无法保证同 scope 内一致排序。

**方案（决策 A）**：纯函数 `selectMemoriesByQuota(globalEntries, sessionEntries, groupEntries, quotas: MemoryInjectQuotas)`（`app/server/src/memory/inject-quota.ts`）。三 mapper **各自读三源**（统一 dir store `listMetas`——metadata 级只读 frontmatter 无 body 开销小），调用同一纯函数得同一划分 `{ global, session, group }`，各自只输出本 scope 的切片为本 tier 的 fragment。

**为何不破坏 tier 语义**：selection 是纯函数无共享可变态；三 mapper 仍各自贡献自己的 fragment、tier 不变（reducer/builder 无感知）。同一输入 → 同一输出 → 无分歧。层内 manual→agent + updatedAt 倒序 + 各 scope 独立 slice(0, quota) 全在纯函数内闭环。

### 2.2 注入配额（v0.0.238 起按 scope 分层 20/30/50）

**[v0.0.238] 配额从「三源共享总量 50」改为按 scope 分层独立配额**：

| scope | 配额（独立计数独立截断） |
|-------|------------------------|
| session | ≤ 20 |
| group | ≤ 30 |
| global | ≤ 50 |

各 scope **独立**计数、独立截断——互不影响（PRD §14.2.3 D6）。层内排序规则不变（见下），层间不再共享总量。

`selectMemoriesByQuota` 派生分组键（scope × source → 六类），按 **session→group→global + 每层内 user→agent** 顺序（用户拍板）：

| 顺序 | 分组键 | 派生条件 | 语义 |
|------|--------|---------|------|
| 1 | `session-manual` | scope='session' + source='user' | 会话级 + 用户手动 |
| 2 | `session-agent` | scope='session' + source='agent' | 会话级 + agent 自动 |
| 3 | `group-manual` | scope='group' + source='user' | 团队级 + 用户手动 |
| 4 | `group-agent` | scope='group' + source='agent' | 团队级 + agent 自动 |
| 5 | `global-manual` | scope='global' + source='user' | 全局级 + 用户手动 |
| 6 | `global-agent` | scope='global' + source='agent' | 全局级 + agent 自动 |

> **group 层夹中间**（比 global 贴当前团队场景，比 session 稳定）。禁止把 group 排到 global 之后。

- **组内排序**：`updatedAt` 倒序（ISO 字典序=时间序；`''` 排末）+ tiebreak `name` 升序（与 skill 同构保确定）。
- **[v0.0.238] 各 scope 独立 slice(0, quota[scope])**：跨组连续拼接种类同 scope 内的 manual→agent 两组后取前 quota；不再有跨 scope 总量截断（原 `slice(0, maxN)`）。`quota` 缺失（maxMemoryInject=0 等无效）→ 三段均 `[]`；quota 大于总数 → 全要。
- **输出按 scope 拆分**：保持 selection 顺序（不重排）；各 scope 子序列保留原序。
- **配额源**（v0.0.238）：app_config `session` group，**旧 `maxMemoryInject` 语义转为 global 层配额**（缺省 50）；新增 `maxMemoryInjectGroup`（缺省 30）/ `maxMemoryInjectSession`（缺省 20）。`resolveMemoryQuotas(ctx)` 读三 key 返 `MemoryInjectQuotas`。属「可选覆盖调参组」见 `../../config/[P0]app_config.md §3.14/§3.15`。截断在 mapper/纯函数内闭环，不新增 PromptCtx 字段、不新增 reducer。
- **向后兼容**：`groupEntries=[]` 时该层退化为不贡献（group-manual/group-agent 空组跳过）。
- **注入侧按 biz 对齐可用层（v0.0.238）**：playground 无 group 层（无 squadId → group 源空）；studio 无 session 层（workdir 与 groupWs 同址 → session 源经 §2.3 同址去重为空）；academy 三层都可见（但 academy group 物理解析仍 squad-only，无 squadId 时 group 源空——见 `agent_profile §4`）。无需注入侧额外代码（同址去重已保证），biz 可用表是写侧词汇约定（见 `biz-scope-rules.ts` + `memory_manage_tool §5.2`）。

> **注入链路依赖**：
> - `ctx.config.dataDir`（global 源 + group ws 解析）+ `ctx.config.workdir`（session 源）+ `ctx.config.squadId` / `ctx.config.sessionContext?.classroomId`（group 源，经 `resolveGroupWsDir`）。
> - 缺 workdir（session 源）/ 缺 squadId+classroomId（group 源）→ 对应源 `[]`，mapper 空贡献不阻塞其他源。
> - `appConfig` 仅用于配额 `maxMemoryInject`（读源不再走 app_config）。
> - `system_prompt.md` §4 memory mapper 段应引 `memory_user`(stable)/`memory_group`(stable)/`memory_session`(context) 三 mapper。

### 2.3 squad 场景 session 源与 group 源同址去重（v0.0.232）

squad session 的 `session.workspaceDir = squads/{sid}/`（团队 workspace 简化，见 `../../squad/[P1]squad_workspace.md`）——session 源（`wsMemoryDir(workdir)`）与 group 源（`wsMemoryDir(groupWs)`）**物理同址**。若两源都读，memory_session 与 memory_group 两 fragment 会注入同一批条目（重复注入）。

**规则**：`readMemorySources` 在 `workdir === groupWs`（路径字符串相等）时**跳过 session 源**（session=[]）——同址目录只经 group 源读一次，由 memory_group fragment 单份注入；memory_session mapper 因此空贡献（不产 fragment）。语义 = D5「memory 只留团队级」：squad 场景 session scope 与 group scope 同址，团队共享记忆为唯一事实源。

**写侧/查询侧不改**（自然同址，物理本就是一个目录）：memory 工具 `resolveScopeDir` 的 session/group 两分支解析到同一目录，写任一 scope 落同一文件；`query.ts` 跨 scope search 池只合并 session+global（本就不含 group，无重复池化）；memory HTTP API（`handlers/memory.ts`）跟随 session.workspaceDir，squad session 的 scope=session 查询即得团队记忆。「定义你的 agent」b) 条对 squad 渲染为「session（squad 场景与 group 同址·团队级）/ group / global」（见 `../context/[P1]agent_profile.md` §4）。存量 session（旧 `workspaces/{memberId}` workspaceDir）不同址，行为不变（无迁移）。

## 3. L0 注入（name+intro）+ 按需读正文（v0.0.112 翻转）

- 每个 scope 的所有 active entry 的 `name + intro` 合并 → 1 个 L0 `PromptFragment`（对齐 skill catalog 的 `- name: intro` 列表 + 末尾「Use the `memory` tool to read a memory's full body by name.」引导）。**不注入 body/why/howToApply**。
- 正文经 `memory` 纯读工具按需读（L1，`memory_tool.md`）；关键词定位经 `memory.search`。
- 理由：
  - **不撑爆上下文**（条目增长 ≠ token 爆炸；progressive disclosure，对齐 skill L0/L1）。
  - **cache 友好**（user_memory L0 是 stable tier，不常变，prefix cache 命中）。
  - **翻转前**（v0.0.21~v0.0.111）：whole-file 整文件注入正文——条数一多撑爆上下文，本版本核心痛点。

> **数据依赖行为变化（架构注记）**：翻转后既有用户 memory 正文**不再自动进 prompt**——依赖注入正文的 agent 行为改为靠 `memory` 工具主动读（L1）。consolidation fork-2 输入是完整对话 snapshot（本就不含历史 memory 正文，见 `consolidation_tier1.md §3`），不受本翻转影响。

## 4. 注入时机

- **system_prompt 组装时**（assemble 之前）：memory mapper 与其他 mapper（identity / rules / tool_guidance / skills / context_files）一起贡献 fragment，经 reducer（tier_sort / dedup / budget_truncate）处理后进 system prompt。
- memory 文件变更后，**下次 assemble 生效**（不实时刷新当前 session 已组装的 prompt——保 cache，与冻结快照哲学一致）。

## 5. 与 budget_truncate 的关系

system_prompt 的 `budget_truncate` reducer **只裁 context/volatile 段**（不裁 stable，见 `system_prompt.md` §3）：
- `memory_user` + `memory_group`（stable）**不被裁**。
- `memory_session`（context）超预算时可能被裁尾部 —— 可接受（session 级本就动态）。**被裁条目不在当前 L0**，agent 靠 `memory.search` 兜底定位（见 `memory_tool.md §4`）。

> **[v0.0.112] 语义弱化注记**：翻转 L0 后注入内容只有 name+intro（体量极小），`budget_truncate` 实际很少触发裁 session_memory；「保证长期记忆完整」的原表述（针对整文件注入的 stable 段）随正文不再注入而弱化——现在完整正文本就不在 prompt 里（按需读），truncate 语义从「保正文完整」退化为「保 L0 索引完整」。behavior（stable 不裁 / context 可裁尾）不变。

## 6. 检索现状 + 未来（相关性召回 P1）

- **现状（v0.0.112）**：注入只带 L0（name+intro），关键词定位已由 `memory` 工具的 `search`（全字段大小写不敏感子串匹配，见 `memory_tool.md §3`）承接——被 `budget_truncate` 裁掉的 session 记忆 / L0 索引不到的正文都能 search 兜底。
- **未来（P1，暂不实现）**：`search` 目前无排序 / 无相关度打分（决策 D）；memory 体量再增长时保留引入**相关性/向量召回**的可能（按 embedding 召回子集）。当前先靠 L0 按需读 + 字符硬限 + 整理控制体量。

## 7. 设计决策

- **native 注入**：系统自动，agent 无感，对应 memory 封装（不当文件用）。
- **复用 system_prompt mapper**：不造新注入机制，memory 只是又一个 mapper ext impl。
- **[v0.0.112] L0 注入 + 按需读**：注入只带 name+intro，正文经 `memory` 工具读（L1）——条目增长不撑爆上下文，对齐 skill progressive disclosure。
- **global=stable / group=stable / session=context**：对齐 `PromptTier`，注入行为（cache / 裁剪）天然正确；group 与 global 同 stable tier（比 session 稳定，团队内多 session 期间维持）。
- **注入总量配额（六类分组 + 组内 updatedAt 倒序 + 跨类取前 N）**：条目持续增长会让 stable/context 段膨胀，挤占 prompt cache 命中率与有效预算（`budget_truncate` 只裁 context/volatile 不裁 stable，无自愈机制）。引入配额：跨三 scope 六类（session 手→session 自→**group 手→group 自**→global 手→global 自）按优先级连续取前 N（默认 50，`app_config.session.maxMemoryInject`）。**三 mapper 协同共享同一总量配额**（决策 A）：纯函数 `selectMemoriesByQuota(global, session, group, maxN)`（`memory/inject-quota.ts`），三 mapper 各自读三源后调同一函数得同输入同输出划分，各自只输出本 scope 切片为 fragment（tier 不变，reducer/builder 无感知）。截断在 mapper/纯函数内闭环，不新增 reducer。skill 侧同构（`selectSkillsByQuota`，见 `../context/[P0]system_prompt.md §4` skills mapper）。

## 8. 待定

- memory mapper 的 effective order（删 ExtImpl.priority 后改 effective order，与 skills / context_files 等的排序，见 `../context/[P0]extension point and implementations.md` §2）
- session_memory 超预算裁剪策略（尾部裁 vs 摘要）
