# v0.0.51 技术变更日志 — long term memory spec 完善 + 实现

> **v1+v2（2026-07-02/03）：纯 spec 完善。** 实现依赖 v0.0.48 tool_list 机制 merge 后再进行。
> **实现完成（2026-07-03）：7 task 全落地 + UT 4106 passed + AT 6 case PASS**（见末尾「§实现完成」段）。
>
> 权威输入：用户确认的设计决策（memory_manage / skill_manage / consolidation_tier1 / post-compact handler ext point）。

---

## 0. 设计决策摘要

本版本将 long term memory 机制从前瞻设计推进到可实现状态，核心决策：

1. **memory_manage 工具**：已有设计基本不变（write/archive/list/read，不审批）
2. **skill_manage 工具（新建）**：create/patch/disable/enable/list/read，不可 delete（用 disable 替代），patch/disable/enable 受 mutable 强制
3. **mutable 字段强制**：从「仅记录不强制」改为「强制执行」（false 拒绝 patch/disable/enable；mutable 本身不可被 agent 修改）
4. **L0 catalog 协议变更**：每条 enabled skill 从 name+description 改为 name+description+mutable；disabled skill 不进 L0 catalog
5. **consolidation tier 1 重写**：fork-2 直接调工具落盘（不产出 ops）；memory+skill 在一个 forked agent 里；通过 post-compact ext point 触发；allowed tools = [skill_manage, memory_manage]
6. **post-compact handler ext point（新增）**：`context_post_compact` ordered EP，compact 成功完成后触发；默认 impl = `memory_skill_consolidation`
7. **memory 注入**：从 no-op 占位升级为实际 impl（memory_user=stable, memory_session=context）
8. **被动工具注册**：memory_manage + skill_manage 注册给 playground-rocky / studio-leader / studio-mate（依赖 v0.0.48 tool_list merge）

---

## 1. 改动总览

| # | 子系统 | 改动核心 | 权威 spec |
|---|---|---|---|
| **A** | skills | 新建 `skill_manage_tool.md`：create/patch/disable/enable/list/read 工具接口 | `[P0]skill_manage_tool.md`（新增） |
| **B** | skills | `skill_definition.md`：mutable 字段从「仅记录」改为「强制执行」；L0 catalog 带 mutable；disabled 不进 L0 | `[P0]skill_definition.md §2/§6/§8` |
| **C** | skills | `skill_tool.md`：明确只读 enabled skill；skill_manage.read 可读 disabled；§6 从 roadmap 改为「已设计」 | `[P0]skill_tool.md §1/§6/§7` |
| **D** | skills | `index.md`：①/②/④/⑤ 全面更新（skill_manage 已设计 + 3 条新原则 + 导航） | `skills/index.md` |
| **E** | memory | `consolidation_tier1.md`：重写 fork-2 契约（移除 ops 接口，直接调工具；post-compact ext point 触发；单 fork 做 memory+skill） | `[P0]consolidation_tier1.md §2/§3/§4/§5/§6` |
| **F** | memory | `memory_injection.md`：从 no-op 占位升级为实际 impl | `[P0]memory_injection.md §2` |
| **G** | memory | `memory_manage_tool.md`：§4 时机引用 skill_manage（不再 roadmap） | `[P0]memory_manage_tool.md §4` |
| **H** | memory | `index.md`：实现状态 + 导航更新 | `memory/index.md` |
| **I** | context | `context_compact_detail.md`：新增 §2d post-compact handler ext point | `[P0]context_compact_detail.md §2d` |
| **J** | context | `extension point and implementations.md`：EP 8→9 / impl 37→40 / memory mapper impl / manifest / 出处索引 | `[P0]extension point and implementations.md` |
| **K** | context | `index.md`：核心概念 + 边界 + 导航更新 | `context/index.md` |

---

## 2. 改动文件清单（A/M，按子系统）

### 2.1 skills 子系统

| 文件 | 操作 | 变更要点 |
|---|---|---|
| `specs/tech/agent/skills/[P0]skill_manage_tool.md` | 新增 | skill_manage 工具接口（create/patch/disable/enable/list/read）+ mutable 强制 + list 含 disabled + 被动工具注册范围 |
| `specs/tech/agent/skills/[P0]skill_definition.md` | 修改 | §2 mutable 注释改为「强制执行」；§6 重写（强制执行 + mutable 不可改 + disabled 不进 L0）；§8 移除「skill 管理界面改 mutable」 |
| `specs/tech/agent/skills/[P0]skill_tool.md` | 修改 | §1 明确只读 enabled + skill_manage 边界；§6 从 roadmap 改为「已设计」；§7 设计决策更新 |
| `specs/tech/agent/skills/index.md` | 修改 | ① 从「roadmap」改为「已设计」；② 边界更新；④ 新增 3 条原则（mutable 强制/不可 delete/list 含 disabled）；⑤ 导航新增 skill_manage_tool.md |
| `specs/tech/agent/skills/log.md` | 修改 | 追加 v0.0.51 变更日志条目 |

### 2.2 memory 子系统

| 文件 | 操作 | 变更要点 |
|---|---|---|
| `specs/tech/agent/memory/[P0]consolidation_tier1.md` | 修改 | §2 时机 B：单 fork 做 memory+skill，通过 post-compact ext point 触发；§3 移除 MemoryOp/SkillOp，直接调工具；toolsConstraint = [skill_manage, memory_manage]；§4 post-compact 触发 + 防递归；§5/§6 更新 |
| `specs/tech/agent/memory/[P0]memory_injection.md` | 修改 | §2 从 no-op 占位升级为实际 impl（memory_user/memory_session） |
| `specs/tech/agent/memory/[P0]memory_manage_tool.md` | 修改 | §4 时机引用 skill_manage（不再 roadmap） |
| `specs/tech/agent/memory/index.md` | 修改 | 实现状态从「前瞻设计，代码未落地」改为「spec 完善，待实现」；③ skills 关系更新；导航更新 |
| `specs/tech/agent/memory/log.md` | 修改 | 追加 v0.0.51 变更日志条目 |

### 2.3 context 子系统

| 文件 | 操作 | 变更要点 |
|---|---|---|
| `specs/tech/agent/context/[P0]context_compact_detail.md` | 修改 | 新增 §2d：post-compact handler ext point（`context_post_compact` ordered EP + PostCompactHandler/PostCompactCtx 契约 + memory_skill_consolidation 默认 impl + noop_post_compact 防递归 + 与 §2c 关系对比） |
| `specs/tech/agent/context/[P0]extension point and implementations.md` | 修改 | §1 概述更新（EP 8→9 / impl 37→40）；§2 EP 表新增 context_post_compact；§3 header 更新；§3.4 memory mapper 从 no-op 改为实际 impl；新增 §3.8 post-compact handler impls；§5 manifest 新增 2 条目；§6 出处索引新增条目 |
| `specs/tech/agent/context/index.md` | 修改 | ① EP/impl 计数更新 + post-compact 概念；② 边界更新；③ 对外协作点更新；⑤ 导航更新 |
| `specs/tech/agent/context/log.md` | 修改 | 追加 v0.0.51 变更日志条目 |

---

## 3. 关键设计决策详解

### 3.1 skill_manage 工具：不可 delete + list 含 disabled

**不可 delete**：用 disable 替代（设 enabled=false，skill 仍在磁盘可恢复）。self evolution 安全网——永不自动删资产。

**list 含 disabled**：agent 在判断是否要 create 新 skill 前，需要知道是否已有类似 skill（即使被 disabled）。如果 disabled skill 不可见，agent 可能创建撞车的重复 skill。disabled ≠ 不存在——只是不注入 L0 catalog，但 skill 资产仍在。

**与 skill 读工具的边界**：
- `skill` 工具 = 对话中按需加载（progressive disclosure L1），只读 enabled，不做 list
- `skill_manage` 工具 = 管理用，list 含 disabled，read 可读 disabled 全文

### 3.2 mutable 强制规则

- `mutable=false`（用户手写/下载）：patch/disable/enable 全部拒绝
- `mutable=true`（agent create / consolidation 产出）：允许
- **mutable 字段本身不可被 agent 修改**（不能 true→false，也不能 false→true）
- 创建时设定：`create` 自动 `mutable=true`；用户手写/下载 `mutable=false`

### 3.3 consolidation fork-2：直接调工具 vs 产出 ops

**旧设计**：fork-2 产出 MemoryOp[] / SkillOp[] 结构化 ops → 调 manage 工具落盘
**新设计**：fork-2 是一个有 tools 的 forked agent（allowed tools = [skill_manage, memory_manage]），在推理过程中直接调用工具写入

**理由**：简化契约——forked agent = 一个有 tools 的 agent，而非产出 ops 的无状态函数。LLM 直接判断该做什么操作（write/create/patch/archive/disable），更灵活更自然。

### 3.4 post-compact handler ext point

compact 成功完成后触发（在 setSummary + appendMessages + markSummaryDone 之后）：
- **EP**：`context_post_compact`（ordered，多 handler 链式）
- **默认 impl**：`memory_skill_consolidation`（启动整理 fork-2）
- **防递归**：forked scope 跳过此 handler（与 reject_should_compact 同模式）
- **CompactCtx 复用**：PostCompactCtx = CompactCtx（含 snapshot / config / store / scopeId）

---

## 4. 实现依赖

本版本 spec 变更不包含代码实现。实现依赖：

1. **v0.0.48 tool_list 机制 merge**：memory_manage + skill_manage 工具需注册给特定 agent（playground-rocky / studio-leader / studio-mate），依赖 per-agent 工具集机制
2. **post-compact EP 注册**：`ensureForkedScope` 需新增 forked scope 跳过 `context_post_compact` handler 的配置

> **[v2 修正]** 原列「forked agent 工具支持：当前 forked agent 只支持 NO_TOOLS，需扩展支持 [skill_manage, memory_manage] 工具集」是**误判**——forked agent **本就支持指定 allowed tools 参数**（不是只能 NO_TOOLS；compact fork-1 用 NO_TOOLS 是其调用方主动传 `toolsConstraint: []`，并非 forked agent 机制限制）。∴ `[skill_manage, memory_manage]` 直接可用，**该条不构成阻塞依赖**，已移除。`context_compact_detail.md §2d.4` / `extension point and implementations.md §3.8` 经核查**无此误判**（均正确描述为 allowed tools = [skill_manage, memory_manage]）。

---

## 5. 版本

> 变更历史见对应子系统的 `log.md`（本版本会在 `skills` / `memory` / `context` 三个 KB 的 log.md 追加一条）。

---

## v2 修订（2026-07-03 — 用户复审 5 条决策落地）

用户复审 v1 spec 后给 5 条决策，本次修订落地。**仍是纯 spec，不写代码。**

### v2.1 改动文件清单

| 文件 | 操作 | 变更要点 |
|---|---|---|
| `specs/tech/agent/skills/[P0]skill_definition.md` | 修改 | frontmatter `updated`→2026-07-03；§2 frontmatter 加 `mutableLocked` 字段（+ source/production_method 扩 system/builtin 枚举值）；§6 重写为「双维度治理模型」（维度 A mutable / 维度 B mutableLocked，正交分离 + 默认值表 + 创建时写入规则）；§8 恢复并细化「UI 改 mutable」（默认可改，mutableLocked=true 拒绝；走独立 HTTP 路径，不经 skill_manage 工具） |
| `specs/tech/agent/skills/[P0]skill_manage_tool.md` | 修改 | §4 mutable 强制补充（agent 工具完全无视 mutableLocked；UI 改 mutable 走另一路径）；§7 重构为「注册范围 + 并发写：原子串行化」（§7.1 注册所有 agent；§7.2 per-file 文件锁序列化） |
| `specs/tech/agent/skills/index.md` | 修改 | ① 加「治理双维度」核心概念行；② 边界补 UI 改 mutable 路径 + 文件锁；④ 新增原则 11/12（双维度治理 + 写操作原子串行化） |
| `specs/tech/agent/memory/[P0]consolidation_tier1.md` | 修改 | §3 补 fork-2 输入澄清（snapshot 已含本次工具调用记录；不额外注入历史 memory；跨周期去重交 P1）；§6 待定移除「fork-2 用什么 model」+ 加 resolve 注（复用 session 当前 model） |
| `specs/tech/agent/memory/[P0]memory_definition.md` | 修改 | §7 待定补 session_memory 归档/提升策略 P1 占位 |
| `specs/tech/agent/memory/[P0]memory_manage_tool.md` | 修改 | §7（新）+ §8（原 §7 重编号）：注册范围 + 并发写锁（与 skill_manage_tool §7 同构） |
| `specs/tech/agent/memory/index.md` | 修改 | ④ 新增第 6 条原则（写操作原子串行化） |
| `specs/tech/agent/skills/log.md` | 修改 | 追加 v0.0.51 v2 条目 |
| `specs/tech/agent/memory/log.md` | 修改 | 追加 v0.0.51 v2 条目 |
| `specs/tech/version_logs/v0.0.51.long_term_memory/change_log.md` | 修改 | §4 修正（移除 forked agent 工具支持误判依赖）；新增本「v2 修订」段 |

> **context KB 不变**：v2 修订不触及 `context_compact_detail.md` / `extension point and implementations.md`（post-compact EP 设计无需调整）；context/log.md 不追加 v2 条目。

### v2.2 6 项决策落点确认

| # | 决策 | 落点（文件 + 段落） |
|---|---|---|
| 1 | `mutable` 新增「UI 可改性」配置维度（双维度治理模型） | `skill_definition.md §6`（双维度治理 + 默认值表）+ `§8`（UI 改 mutable 细则）+ `skill_manage_tool.md §4`（agent 工具无视 mutableLocked + UI 走另一路径）+ `skills/index.md ①/④`（核心概念 + 新原则） |
| 2 | fork-2 model = 复用 session model | `consolidation_tier1.md §6 待定`（移除该项 + 加 resolve 注） |
| 3 | fork-2 输入澄清（防误解） | `consolidation_tier1.md §3`（输入澄清段：snapshot 已含本次工具调用记录；不注入历史 memory；跨周期去重交 P1） |
| 4 | 修正 change_log §4 实现依赖误判 | `change_log.md §4`（移除「forked agent 只支持 NO_TOOLS」误判项 + 加修正注；context_compact_detail §2d.4 / extension point §3.8 经核查无此误判） |
| 5 | 写权范围 + 并发写锁 | `memory_manage_tool.md §7`（§7.1 注册所有 agent + §7.2 per-file 文件锁）+ `skill_manage_tool.md §7`（同构）+ `memory/index.md ④`（原则 6） |
| 6 | session_memory 归档策略待定（P1） | `memory_definition.md §7 待定`（补一条 session 结束归档/提升策略 P1 设计） |

### v2.3 「UI 可改性」字段设计

**字段名**：`mutableLocked`（boolean）

**语义**（与 `mutable` 正交）：
- `mutable`（维度 A，已有）：agent / consolidation 能否改 skill 内容（patch/disable/enable）
- `mutableLocked`（维度 B，新增）：**UI 能否改 `mutable` 字段本身**

**默认值表**：

| 场景 | source | method | mutable | mutableLocked | 含义 |
|------|--------|--------|---------|---------------|------|
| 用户手写 | user | handwritten | false | **false** | 用户资产；agent 不可改；UI 可解锁让 consolidation 优化 |
| 第三方下载（UI install） | user | download | false | **false** | 同上 |
| agent create / 整理产出 | agent | consolidation | true | **false** | agent 资产；agent 可改；UI 可锁回防 agent 再改 |
| 系统内置 / 敏感固化 | system | builtin | false | **true** | 彻底固化；agent + UI 都不可改 mutable；只能手编辑 frontmatter |

**强制点**：
- agent 工具（`skill_manage`）路径：完全无视 `mutableLocked`；agent 永远不能改 `mutable`（无论 mutableLocked 真假）。强制规则在 `skill_manage_tool.md §4`。
- UI 路径：走独立 HTTP 端点（如 `PATCH /skill/:name/governance`，调 SkillsService）；改 mutable 前先看 `mutableLocked`，true 则拒绝并提示「此 skill 已锁定 mutable，需手编辑 frontmatter」。
- 默认策略：除系统内置（`source=system, method=builtin`）外，`mutableLocked=false`——用户对自己资产有完全 UI 控制权。

### v2.4 实现依赖（与 v1 一致 + 1 项移除）

实现依赖（v2 修正后）：

1. **v0.0.48 tool_list 机制 merge**：memory_manage + skill_manage 工具需注册给所有 agent（playground-rocky / studio-leader / studio-mate），依赖 per-agent 工具集机制
2. **post-compact EP 注册**：`ensureForkedScope` 需新增 forked scope 跳过 `context_post_compact` handler 的配置

> **[v2 移除]** 原 v1 列「forked agent 工具支持：当前只支持 NO_TOOLS」是误判（forked agent 本就支持 allowed tools 参数，compact fork-1 用 NO_TOOLS 是其 caller 主动传 `toolsConstraint: []`，非机制限制），已移除。

> **[v2 新增依赖项 — 并发写锁]** memory_manage + skill_manage 写操作用 per-file 文件锁（`proper-lockfile` 或等价 lib）原子串行化。这是实现侧细节（spec 只约束「必须串行化」+ per-file 粒度），不构成阻塞依赖。

---

## 实现完成（2026-07-03 — 7 task 全落地）

### A. 实现总览（task → 落点）

| # | 子系统 | 落点（绝对路径） | 说明 |
|---|---|---|---|
| 1 | memory | `app/server/src/memory/managed-store.ts` | memory 受管存储（write/archive/list/read + per-file 锁 + atomicWrite + soft-warn 容量） |
| 2 | memory | `app/server/src/tools/memory-manage.ts` | memory_manage 工具（4 action dispatch，§2 接口 / §3 action 落地） |
| 3 | memory | `app/plugins/builtins/rocky_context/prompt/memory.ts` | memory_user / memory_session system_prompt_mapper impl（whole-file 注入 + archived 跳过） |
| 4 | skills | `app/server/src/tools/skill-manage.ts` | skill_manage 工具（6 action：create/patch/disable/enable/list/read；mutable 强制 + per-file 锁 + payload 不含 mutable） |
| 5 | tools | `app/server/src/agent/tool-policy.ts` | TOOL_POLICY bound：playground-rocky/studio-leader/studio-mate 各加 `skill_manage`+`memory_manage`（subagent/studio-squad 不加） |
| 6 | skills | `app/server/src/skills/governance.ts` | governance service（PATCH `/skill/:name/governance` + `mutableLocked` 强制 + 外科式 frontmatter 替换） |
| 7 | context | `app/plugins/builtins/rocky_context/compact/post-compact-consolidation.ts` | `context_post_compact` EP + `memory_skill_consolidation` impl + `noop_post_compact`（forked scope 防递归） |
| 7+ | context | `app/plugins/builtins/rocky_context/prompt/skills.ts` | L0 catalog `[mutable=true|false]` 标记（与 task 7 同批落地） |

### B. 验证结果

| 层 | 范围 | 结果 |
|---|---|---|
| **UT**（白盒） | 全量 | **4106 passed**（含 memory-manage / skill-manage / governance / post-compact-consolidation / memory mapper 单测） |
| **AT**（黑盒真 LLM 真服务，禁 mock） | 6 case | **6/6 PASS** —— governance（200/403）+ memory_manage（write 新建/upsert + list metadata + read 全文）+ skill_manage（create + patch mutable=true 允许 + mutable=false 强制 REJECT） |
| **post_compact** | UT 15 | AT 不可行（compact 触发链路黑盒不可观测 + 需多轮对话撞 60% 阈值），UT 15 覆盖（runner wire + forked scope 防递归 + fire-and-forget 异常隔离） → **known_gap** |

### C. 代码 ↔ spec 一致性核对（CLAUDE.md 原则 12）

| 核对项 | spec 契约 | 代码实现 | 结论 |
|---|---|---|---|
| `memory-manage.ts` action 集合 | `[P0]memory_manage_tool.md §2/§3`：write/archive/list/read | dispatch 4 action（write upsert / archive 不删 / list metadata / read 全文） | ✅ 对齐 |
| `skill-manage.ts` action 集合 | `[P0]skill_manage_tool.md §2/§3`：create/patch/disable/enable/list/read，不可 delete | dispatch 6 action；无 delete 路径（disable 替代） | ✅ 对齐 |
| `skill-manage.ts` mutable 强制（§4） | `mutable=false` 拒绝 patch/disable/enable；payload 不含 mutable；agent 无视 mutableLocked | `getBool(file.data,'mutable',false)` → false 即 REJECT；executePatch payload 显式不写 mutable 字段（保留原值）；完全无视 mutableLocked | ✅ 对齐 |
| `governance.ts` PATCH 端点 | `06a-skill-governance.md §2` + `skill_definition.md §8`：PATCH `/skill/:name/governance` + service 层 `mutableLocked=true` → 403 + 外科式替换 | `handleSkillGovernance` → `governSkillMutable`；parseBody 校验 scope/mutable/workspace；step3 检查 `mutableLocked===true` 抛 403；`setMutableLine` 外科式替换 frontmatter；per-file 锁串行化 | ✅ 对齐 |
| `post-compact-consolidation.ts` EP + fork-2 | `context_compact_detail.md §2d` + `consolidation_tier1.md`：fire-and-forget + allowed tools=[skill_manage, memory_manage] + 防递归 | `CONSOLIDATION_ALLOWED_TOOLS=['skill_manage','memory_manage']`；`void this.startConsolidation(ctx).catch(()=>{})` 不 await；forked scope 选 `noop_post_compact` 防递归 | ✅ 对齐 |
| `memory.ts` mapper tier | `memory_injection.md §2`：memory_user=stable / memory_session=context | MemoryUserMapper priority=450 tier=stable；MemorySessionMapper priority=350 tier=context | ✅ 对齐 |
| `tool-policy.ts` bound | `[P0]skill_manage_tool.md §7.1` + 同 spec memory_manage §7.1：playground-rocky/leader/mate 注册 | 三角色 bound 各含 `'skill_manage','memory_manage'`；subagent/studio-squad 不含 | ✅ 对齐 |
| `skills.ts` L0 catalog 标记 | `skill_definition.md §2 末段` + `skill_manage_tool.md §5`：每条带 `[mutable=...]`；disabled 不进 L0 | entries 已被 session-config 层过滤为仅 enabled；mapper 拼 `- ${name} [mutable=${mutable?'true':'false'}]: ${description}` | ✅ 对齐 |

**结论：v0.0.51 实现 8/8 项与 spec 契约一致，未发现代码静默偏离 spec 的情况。**

### D. 版本

v0.0.51 long term memory 实现完成（7 task 全落地 + UT 4106 + AT 6/6 + post_compact UT 覆盖 known_gap）。
