# v0.0.112 长期记忆增强 — PRD 变更日志

> 引入版本 v0.0.112 · 2026-07-10
> 一句话：让长期记忆对齐 skill 的渐进披露（progressive disclosure）——系统提示只注入 name+description，正文按需读；补齐 evolvable 治理、300 词硬限制、manage 工具路由提示词、scope 统一命名。
> overall 快照：`specs/prd/overall/09-memory.md`。概念权威源：`specs/tech/agent/memory/` + `specs/tech/agent/skills/`。
> 本质：**memory 复刻 skill 已落地的 L0/L1 + evolvable + 纯读/管理分离模型**，非从零发明。

## 1. 背景与现状（先对齐，再改）

**memory 现状（要改的痛点）**：
- 注入 = **整文件注入**（`memory_injection.md §3` whole-file，`index.md ④ 原则 4`）。两 scope：memory_user（stable, priority 450）+ memory_session（context, priority 350），每条**正文全量**进 system prompt → 条数一多撑爆上下文。
- `memory_manage` 已有 write/archive/list/read；`read` 返完整正文，**无 search**。
- 容量 = soft-warn（user ~2000 / session ~1500 字符），**非硬限制**。
- memory entry 结构：name/description/type/body（+why/howToApply/archived），**无 evolvable 字段**。

**skill 现状（要对齐的样板）**：
- `skill`（纯读）：read(name)→SkillContent。L0 仅 name+description 注入；L1 工具读正文；L2 Read references。
- `skill_manage`（管理，与纯读分离）：create/patch/disable/enable/list/read。`evolvable` 治理（false 时仅 agent 路径 patch/disable/enable 拒绝；UI 永远可改）。默认值按来源（agent create=true，用户/下载/内置=false）。
- scope 底层 app（`<dataDir>/skills/`）/ workspace（`<workspaceDir>/.rocky/skills/`，项目级）。create 已默认 global（`parseNameScope` 非 workspace 即 app）。

## 2. 本版本 5 条需求（产品化表达）

### 需求 1：memory 纯读工具 + 注入翻转（核心）
- 新增独立 `memory` 纯读工具：`read({scope?,name})→完整正文` / `search({keyword,scope?})→命中条目 name+description 列表（不含正文）`。search 匹配所有字段（name/description/type/正文）。
- 注入侧 memory_user/memory_session 两 mapper **只注入 name+description（L0）**，正文按需经 `memory` 工具读。
- read 语义与 `memory_manage.read` 共享同一实现；`memory_manage` 保留写侧（write/archive/list）。
- 详见 overall §9.2.1 + §9.2.2。

### 需求 2：evolvable 治理（memory 引入同款）
- memory 引入 `evolvable`（默认按来源：agent 总结生成=true，用户手写/内置=false）。
- 只挡 agent 自动进化路径（memory_manage 对 evolvable=false 记忆的进化性写拒绝）；UI 用户永远全字段可编辑，无 lock、不置灰、不防呆。
- 详见 overall §9.2.3。

### 需求 3：正文 300 词硬限制
- 单条正文限制 300 词/字，write/patch 创建/更新时超限 hard error 拒绝（非软告警）。
- 计数口径：剔除标点空白 → CJK 逐字计 1 + 非 CJK 按空白分词每词计 1，总数 >300 拒绝。
- 存量豁免（只卡新写入/更新）。详见 overall §9.2.4。

### 需求 4：skill_manage / memory_manage 路由提示词
- 两步决策路由规则写进两工具 description + consolidation fork prompt（`post-compact-consolidation`）。
- 第一步 skill(怎么做) vs memory(记住什么) vs 都不写(项目代码→specs)；第二步 global vs session。
- 详见 overall §9.2.5。

### 需求 5：scope 统一命名 global/session + 默认 global
- 对外统一 global/session（仅改名不改底层粒度）；create/write 默认 global。
- 映射：global↔skill.app / memory.user；session↔skill.workspace(项目级) / memory.session(会话级)。
- ⚠️ skill 的 session 底层是项目级 workspace（非单会话私有），spec 必须注明。详见 overall §9.2.6。

## 3. 关键用户路径（测试最低覆盖 — 见 overall §9.3）

| ID | 链路 | 断言 |
|----|------|------|
| 路径 A | agent `memory.read(name)` | 返完整正文 |
| 路径 B | agent `memory.search(keyword)` | 返 name+desc 列表，不含正文 |
| 路径 C | 存 memory → 新 session → 查 system prompt | 只含 name+description，不含正文 |
| 路径 D | 会话含方法+结论 → 自动总结 | 方法落 skill、结论落 memory |
| 路径 E | 写超 300 词 memory | 被拒（hard error + 计数），未落盘 |
| 路径 F | UI 编辑 evolvable=false 内置项正文 | 保存成功、无字段置灰 |
| 路径 G | agent 写 memory 不指定 scope | 落 global(user) |

## 4. spec 影响面（架构阶段细化 — PRD 不擅改 tech spec）

| spec | 变更点 |
|------|--------|
| `memory/[P0]memory_injection.md §3` | 注入方式：整文件 → **仅 name+description（L0）**，正文按需 |
| `memory/index.md ④ 原则 4` | 「whole-file 整体注入，不检索」需翻转/修订为 L0 注入 + 按需读 |
| 新增 `memory/[P?]memory_tool.md` | 新 `memory` 纯读工具（read/search）契约，对齐 `skill_tool.md` |
| `memory/[P0]memory_manage_tool.md` | 写侧保留；read 共享给新 `memory` 工具；§5 容量约束改 300 词硬限；提示词加路由规则；scope 统一命名 + 默认 global |
| `memory/[P0]memory_definition.md` | 引入 `evolvable`（默认按来源）+ 300 词硬限制 + scope 统一命名 + 默认 global |
| `memory/[P0]consolidation_tier1.md §6` | fork-2 prompt 模板：写进两步路由规则（本为待定项，本版本落地） |
| `skills/[P0]skill_definition.md` + `skill_architecture.md` | scope 对外统一命名 global/session（底层不变，注明 session=项目级） |
| `skills/[P0]skill_manage_tool.md` | 提示词加路由规则；scope 必填→默认 global + 统一命名（对齐 code） |
| `specs/api/overall/14-self-evolution-tool-ref.md` | 新 `memory` 工具 tool schema；scope 入参统一 global/session；list 透出 evolvable |
| `specs/api/overall/15-memory-ui.md` | entry schema 加 evolvable；scope 命名统一 |
| `specs/ui/components/chat-page/section-memory-panel.md` + `component-memory-entry-card.md` | 内置项全字段可编辑（去置灰）；透出 evolvable |
| `specs/ui/components/app-dev-config-page/section-user-memory.md` | 同上 |

## 5. spec / req 不一致 & spec 过时点（交 orchestrator/architect）

1. **注入原则直接矛盾（核心）**：`memory_injection.md §3` +`index.md ④ 核心设计原则 4` 明写「whole-file 整体注入，不检索」，是当前**冻结的核心不变量**；需求 1 要翻转成 L0 注入。这是设计原则级变更，架构必须显式修订原则 4（不能只改 §3 而留原则 4 自相矛盾）。`memory_injection.md §5`（budget_truncate 只裁 context 不裁 stable 以「保证长期记忆完整」）在正文不再注入后语义弱化，需一并复核。

2. **evolvable 在 memory 完全缺失**：`memory_definition.md §3` entry schema 无 evolvable；`memory_manage_tool.md` write/archive 当前**完全不审批、无治理**。需求 2 要引入 evolvable + agent 路径 gating——需架构定义：memory_manage 哪些 action 受 evolvable 约束（更新既有 evolvable=false 条目 / archive 是否拒绝），以及 source 如何判定（UI POST→false / 工具 write→true，对齐 skill）。**新概念（memory.evolvable）必须先落 tech spec 再进实现。**

3. **容量约束口径不一致**：`memory_definition.md §5` + `memory_manage_tool.md §5` 现为「文件总长 char 软告警（~2000/1500）」；需求 3 是「**单条正文** 300 **词** 硬拒」。两者维度不同（文件总 char vs 单条 word）。架构需决定 file-total soft-warn 去留（PRD 建议 OUT，只做 per-entry 300 词硬限）。`15-memory-ui.md §12` 明列「memory 容量上限硬拒」为 OUT——本版本对 per-entry 300 词是 IN，该 API spec OUT 条目需订正。

4. **scope 值域漂移**：memory 工具/API/UI 现用 `user`|`session`；skill 现用 `app`|`workspace`。需求 5 统一对外为 `global`|`session`。这是**契约级 enum 变更**——现有 AT/E2E case 用旧 scope 值需同步更新。`skill_manage_tool.md §2` 标 scope 必填（未引导默认 global），与代码 `parseNameScope` 已默认 global 不符——spec 落后，本版本订正。

5. **memory 有 L0 却仍加 search 的合理性（非矛盾，需 spec 说明）**：`skill_tool.md §1` 解释 skill「不做 list」因 L0 catalog 常驻 prompt。memory 本版本也把 L0（name+desc）注入 prompt，却仍加 `search`——理由：memory_session 是 **context tier（可被 budget_truncate 裁尾）**，被裁条目不在当前 L0，需 search 兜底定位；且 search 匹配正文（L0 只有 desc）。架构应在新 `memory_tool.md` 写清此差异，避免下游误认为「与 skill 不一致」。

## 6. 需要 architect 特别注意的设计难点

1. **注入机制翻转的兼容性**：翻转 whole-file→L0 是核心原则变更，牵动 (a) memory_user/memory_session 两 mapper 实现；(b) `index.md ④ 原则 4` 与 §5 budget_truncate 语义；(c) 已有真实用户 memory 数据在翻转后正文不再自动进 prompt——agent 行为依赖变化（须靠 `memory` 工具主动读）。需评估对现有 consolidation fork 输入（snapshot 不含历史 memory）与 agent 依赖注入正文的既有链路影响。

2. **memory.evolvable 的 gating 落点**：skill 的 evolvable gate 在 patch/disable/enable 三个 action。memory_manage 的等价「进化性写」是什么（更新既有条目？archive？）需架构明确定义 + 落 error code（对齐 skill `[invalid_input] non-evolvable`）。同时 UI 路径（`/memory/*` HTTP）不受 gate，与 skill governance 端点对称——需确认 memory UI 是否需要类似 `PATCH /memory/:scope/:name/governance` 或直接在 PATCH entry 里带 evolvable。

3. **scope 命名映射的边界层**：统一命名只在**接口/工具入参/UI 层**，底层存储路径（skill workspace 覆盖 app、memory user=app_config / session=per-session md）不变。架构须明确映射发生在工具/handler 边界（tool input `global`→内部 `user`/`app`），底层 service 签名是否保留旧 enum 或全量改名——影响改动面与测试面。注意 skill session=项目级 workspace（非单会话），命名统一后**用户/agent 可能误以为 skill session 是单会话私有**，description + spec 须显式消歧。

4. **300 词计数的单一实现**：CJK 逐字 + 非 CJK 分词的计数函数应单点实现（供 memory_manage.write/patch 复用），避免多处重复口径漂移。存量豁免 = 仅在「本次写入的新正文」上校验，不扫既有条目。

5. **路由提示词三处一致性**：memory_manage description、skill_manage description、consolidation fork prompt 三处路由规则须同源（建议单一文案常量），避免三处措辞漂移导致 agent 判断不一致。
