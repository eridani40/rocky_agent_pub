# v0.0.22 PRD 变更日志

## 概述

本版本 = **prompts refine**（纯后端 infra 版本，**无 UI 变更**）。对 system prompt 与 compact prompt 的**内容**做优化 + 把 prompt 正文**文件化**（从代码常量抽到磁盘文件 + handler 基类读文件构建各 section），目标是更好的 agent 行为 / 诚实性 / 工具纪律 + 可维护性。

一句话：**system prompt 的 identity/rules/tool_guidance 内容更充实（参考 CC/Hermes）+ compact 的 user message 走结构化 9 板块 + `<analysis>`/`<summary>` 双 block + NO_TOOLS 双保险 + prompt 正文文件化（`app/server/src/prompts/` + handler base class）。**

权威输入：
- 调研：`specs/research/v0.0.22-system-prompt-and-compact.md`（CC 标杆 + Hermes/OpenClaw 旁证 + 优化建议 §4）
- user_query：`states/user_query.md` v0.0.22（AFK 全自动授权；代决项见下）

spec 权威源（本版本**不引入新概念，仅改 prompt 内容 + 加文件读取层**）：
- tech：`specs/tech/agent/context/[P0]system_prompt.md`（mapper/reducer/builder，6 mapper→3 reducer→`"\n\n".join`）
- tech：`specs/tech/agent/context/[P0]context_compact_detail.md`（compact forked agent、user message 形式、9 板块已约定 §3.3、双 block §3.1、NO_TOOLS §3.2、增量 merge §4 future）
- **新引入技术概念**（prompts 文件化、handler base class）属架构层，由 architect 落 `specs/tech/`，PRD 仅引用「prompt 内容将文件化、handler 模式构建」的高层描述，不发明技术细节。

---

## 1. 版本定位

### 1.1 范围

**IN（v0.0.22 三方向）**：

| # | 方向 | 范围 |
|---|------|------|
| D1 | **system prompt 内容优化** | 重写 `identity` / `rules` mapper 贡献的 prompt 正文（参考 CC intro+Hermes DEFAULT_AGENT_IDENTITY 的写法骨架）；`rules` 拆 3 section（Operating Rules / Doing Tasks / Tool Use，对齐 CC `# System`/`# Doing tasks`/`# Using your tools` 三分）；`tool_guidance` 补 CC 红线（dedicated tool 优先）+ 并行调用纪律（Hermes PARALLEL_TOOL_CALL_GUIDANCE）。 |
| D2 | **compact prompt 优化** | compact 的 user message 重写：对齐 spec §3 已约定的 **9 板块**（§3.3 通用化表，去 coding-specific）+ `<analysis>`/`<summary>` 双 block（§3.1，analysis strip 不落库）+ **NO_TOOLS 双保险**（§3.2，补 trailer——当前实现只有 preamble 一行）。 |
| D3 | **prompt 文件化** | 把 system prompt 与 compact prompt 的**正文**抽到磁盘文件（`app/server/src/prompts/` + handler base class 派生子类读文件构建各 section），保留 builder 层的条件拼装能力（按 `config.tools` 等）。 |

**OUT（本版本明确排除，标 future）**：

| 排除项 | 理由 / 出处 |
|--------|------------|
| compact 增量 merge（老 summary + 新段一起喂 forked）完整实现 | spec §4 future；当前 v0.0.13 全量重写，prompt 里可加「merge 老 summary」指引铺路但本期不强落地 |
| compact 的 from / up_to direction 变体 | CC 三变体；我们用 forked agent 继承父 system prompt 已解决 cache（spec §4） |
| CC 的 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 字符串 | 我们 tier_sort reducer 已实现 stable→context→volatile 排序（spec §9 边界 2），等价但更结构化 |
| `<analysis>` strip 的 regex 改造 | spec §6.5.1 已有 `extractTag`；如实现已满足则不改，coder 阶段对齐 CC `formatCompactSummary` |
| `getCompactUserSummaryMessage` 续作 wrapper | CC compact 后新 session 第一条 user msg；我们当前只插 `compact_notice` system message（spec §6.5），未来支持 session resume 再加 |
| systemPromptSection memoization（CC `/clear` `/compact` invalidation） | spec §6 缓存「留给实现」，本期不强加 mtime key；如实现简单可顺手 |
| timestamp 进 system prompt | spec §4 已移出走 reminder（日期精度）；保持 |
| UI 任何改动 | 纯后端 infra 版本 |

### 1.2 关键决策记录（orchestrator 代决 — AFK 授权）

| 决策 | 选择 | 出处 |
|------|------|------|
| 架构基线 | 保留 mapper/reducer 双 EP（system_prompt_mapper / system_prompt_reducer）+ 新增 `app/server/src/prompts/` 文件读取层（handler base class 派生子类读不同文件构建各 section） | user_query v0.0.22 代决项 1 |
| identity 写法 | CC 模式（`You are X, <org>'s <product>.` + 安全边界一行）+ Hermes 风格基线（concise/direct/admit uncertainty/genuinely useful over verbose） | 调研 §4.1 |
| rules 拆分 | 3 section：Operating Rules（系统层）/ Doing Tasks（任务层，含反 stub-stop / 反 fabricate）/ Tool Use（工具层，含并行纪律） | 调研 §4.2，对齐 CC `# System`/`# Doing tasks`/`# Using your tools` |
| compact prompt 形式 | 维持 user message 形式（forked agent 继承父 system prompt，保 cache）；9 板块（spec §3.3 通用化）+ 双 block（§3.1）+ NO_TOOLS 双保险（§3.2，补 trailer） | spec §3 + 调研 §4.4 |
| 文件化范围 | identity/rules/tool_guidance 正文 + compact 模板正文（BASE_COMPACT_PROMPT 等价部分）；**不文件化** compact 的待压缩 transcript（运行时 serialize） | 调研 §4.5 |
| 文件化后 builder 条件拼装 | 保留（mapper 内仍可按 `config.tools` / model family 条件拼装）；占位符替换对齐 CC `${FILE_READ_TOOL_NAME}` 模式 | 调研 §4.5 |
| E2E 适用性 | 待测试计划阶段判定（路径 1-3 都涉及真 LLM，E2E 主要回归 + system-prompt debug 端点验注入） | user_query v0.0.22 代决项 3 |

---

## 2. 功能点清单

> 本节是「内容优化 + 文件化」的高层描述，**技术细节（文件布局、handler 类层级、读取时机、cache key）由 architect 落 `specs/tech/`**，PRD 不发明。

### 2.1 system prompt 内容优化（D1）

对齐 `specs/tech/agent/context/[P0]system_prompt.md` §4 内置 mapper 清单（mapper 链 + tier 不变，仅改 mapper 贡献的正文）。

**`identity` mapper**（tier=stable, order=1）—— 参考调研 §4.1 关键要素清单：

| 要素 | 内容方向（coder 落地具体措辞） |
|------|------------------------------|
| 定位 | `You are Rocky, ...`（who + by whom + 做什么） |
| 能力范围 | wide range of tasks：对话 / 工具使用 / 代码 / 分析 / 创意 |
| 协作方式 | through conversation and tool use |
| 风格基线 | concise / direct / admit uncertainty when appropriate / genuinely useful over verbose |
| 诚实性红线 | 一行（参考 CC `IMPORTANT: You must NEVER generate or guess URLs...`）—— 我们可写 `Do not fabricate tool outputs or facts; report uncertainty honestly.` |

**约束**：≤ 8 行（cache 友好，调研 §4.1）。

**`rules` mapper**（tier=stable, order=2）—— 拆 3 section（参考调研 §4.2，对齐 CC `# System`/`# Doing tasks`/`# Using your tools`）：

| section | 内容方向 |
|---------|---------|
| `# Operating Rules`（系统层） | 工具结果可能含外部数据/注入可疑时 flag；工具失败如实报告、不重试同一调用；系统会自动压缩历史（conversation 不受 context window 限制） |
| `# Doing Tasks`（任务层） | 反 stub-stop / 反 fabricate（Hermes TASK_COMPLETION_GUIDANCE 直译可用）；改文件前先读；失败诊断根因再换策略；不超范围改码 |
| `# Tool Use`（工具层） | 优先 dedicated tool（Bash/通用工具兜底）；并行调用纪律（独立调用并行、有依赖才串行，Hermes PARALLEL_TOOL_CALL_GUIDANCE 可直译） |

**约束**：≤ 20 行（调研 §4.2）。**tool_guidance mapper** 本身保持「从 `config.tools` 读 description」的纯数据贡献（spec §4），CC 红线/并行 steer 放 `# Tool Use` section。

### 2.2 compact prompt 优化（D2）

对齐 `specs/tech/agent/context/[P0]context_compact_detail.md` §3。**形式不变**（user message、继承父 system prompt、NO_TOOLS），**内容重写**：

| 组件 | 当前实现（spec §0 注） | 优化后（对齐 CC + spec §3） |
|------|----------------------|--------------------------|
| NO_TOOLS preamble | 一行 | CC 完整 preamble（CRITICAL: TEXT ONLY + 4 条 bullet） |
| 主体指令 | 一行「请把以下对话压缩为 summary」 | 9 板块要求（spec §3.3 通用化表，去 coding-specific）+ analysis/summary 双 block 输出约束（§3.1） |
| NO_TOOLS trailer | **缺** | **补**（REMINDER: Do NOT call any tools，放最末，双保险，调研 §4.6） |
| `<analysis>` 处理 | 未要求 | scratchpad，compact strip 不落库（CC `formatCompactSummary` 等价，spec §3.1） |
| 待压缩内容 | `JSON.stringify(snap.messages)` | 维持（运行时 serialize，**不文件化**） |

**9 板块**（spec §3.3 通用化，去 coding-specific）：会话目标与意图 / 关键事实与决策 / 已完成的工作 / 错误与修正 / 问题与进展 / 用户消息要点（非 tool result）/ 待办 / 当前状态 / 续作上下文。

> spec §3 完整 9 板块 + §4 增量 merge + from/up_to 变体在 spec 层是 future；本版本**仅落 §3.1 双 block + §3.2 NO_TOOLS 双保险 + §3.3 9 板块**，§4 增量 merge 仍 future（但 prompt 里可加「merge 老 summary」指引为后续铺路，由 coder 决定是否纳入）。

### 2.3 prompt 文件化（D3）

**目标**：prompt 正文从代码常量抽到磁盘文件 + handler base class 派生子类读不同文件构建各 section（可维护性，方便后续迭代）。

**高层描述**（技术细节由 architect 落 tech spec）：
- **位置**：`app/server/src/prompts/`（与 server 代码同仓）
- **范围**：system prompt 的 identity/rules 正文（+ 可选 tool_guidance 模板）+ compact 的模板正文（NO_TOOLS preamble/trailer + 9 板块指令骨架 + 双 block 输出约束）；**不文件化** compact 的待压缩 transcript 段
- **handler 模式**：base class 提供读文件 + 占位符替换 + 条件拼装的通用骨架；子类（如 `IdentityPromptHandler` / `RulesPromptHandler` / `CompactPromptHandler`）读各自文件构建 section
- **保留 builder 层条件拼装**（调研 §4.5）：mapper 内仍可按 `config.tools`、model family 等条件拼装（参考 Hermes model-family guidance、CC enabledTools 分支）；占位符替换对齐 CC `${FILE_READ_TOOL_NAME}` 模式
- **读取时机 / cache**：spec §6「mapper 结果不变时实现可复用」；文件内容 stable tier（极少变），实现可加 mtime/version 作 cache invalidation key（dev 改文件立即生效、prod 不变，调研 §4.5，coder 阶段决定是否落地）

---

## 3. 关键用户路径（MANDATORY — 测试最低覆盖）

本版本虽是后端 infra，但 prompt 影响以下核心路径。每条至少 1 个 API case；E2E 适用性在测试计划阶段判定（部分路径走真 LLM 不可控，E2E 主要做行为回归 + 用 debug 端点验注入）。

| ID | 用户操作链路 | 预期结果 | 类型 |
|----|-------------|---------|------|
| **路径 1** | 创建会话 → 发消息 → 收到回复 | system prompt 生效：identity（定位/能力/协作/风格/诚实性红线 5 要素）+ rules（3 section）注入；agent 行为符合优化后规则（如不编造） | API（真 LLM）+ debug 端点验注入 |
| **路径 2** | 多轮对话 → 上下文超阈值 → 自动 compact → 继续 | compact 的 user message 走优化后的结构化模板（9 板块 + 双 block + NO_TOOLS 双保险）；compact 成功、summary 落库、续对话正常 | API（真 LLM 多轮超阈值） |
| **路径 3** | 手动触发 compact（`POST /session/:id/compact`）→ summary 产出 + compact_notice 留痕 | 复用 forked agent + 优化后 compact 模板；summary 含结构化板块；transcript 插 `compact_notice` system message（metadata.kind=compact_notice） | API |
| **路径 4（验证用）** | `GET /session/:id/debug/system-prompt`（如已存在）→ 返回组装后的 system prompt | 文件化的 identity/rules 内容被正确注入；可断言含优化后正文关键句 | API（黑盒） |

**路径数确认**：4 条（1-4），覆盖 system prompt 注入 + compact 自动/手动 + debug 验证。每条至少 1 个 API case；E2E 主要回归对话/compact 主链路（视觉门禁跳过——无 UI 改动无设计稿）。

> **debug 端点存在性**：路径 4 依赖 `GET /session/:id/debug/system-prompt` 是否已落地。architect 阶段确认；若不存在，本期是否新增由 architect 决定（属架构层，PRD 不发明）。如不存在且本期不加，路径 4 退化为 API 侧通过真 LLM 行为断言（弱覆盖）。

---

## 4. 非目标（NON-GOALS）

- compact 增量 merge（spec §4，future）
- compact from / up_to direction 变体（spec §4，future；forked agent 继承父 system 已解决 cache）
- `SYSTEM_PROMPT_DYNAMIC_BOUNDARY` 字符串（tier_sort reducer 已等价，spec §9）
- `<analysis>` strip regex 改造（如实现已满足则不动）
- `getCompactUserSummaryMessage` 续作 wrapper（session resume 才需要，future）
- systemPromptSection memoization（spec §6 缓存留给实现）
- timestamp 进 system prompt（spec §4 已移出走 reminder）
- 任何 UI 改动（纯后端 infra）
- 新增 mapper/reducer impl（mapper/reducer 链结构不变，仅改正文 + 加文件读取层）
- model family 特定 guidance（Hermes OPENAI_MODEL_EXECUTION_GUIDANCE 等）——本期不做，留 roadmap

---

## 5. 设计决策（已确认，对齐 spec）

### 5.1 为什么是「内容优化 + 文件化」而非重写架构

调研 §4.5 + §4.7 明示：三家竞品（CC/OpenClaw/Hermes）都**硬编码在代码常量**（不走纯外部文件），原因是需要 builder 层条件分支（CC ant/3P、enabledTools、feature flag；Hermes model family、valid_tool_names；OpenClaw promptMode/channel）。我们的 mapper/reducer/builder 架构（spec §1-§5）已是正确的扩展点模型，本版本不动架构，仅：① 优化 mapper 贡献的**正文**（identity/rules）+ compact 的**模板正文**；② 把正文抽到文件（保留 builder 条件拼装能力，handler 基类提供通用骨架）。

### 5.2 为什么 compact 维持 user message 形式（不转 system prompt）

spec §3.2 + 调研 §3.1 明示：CC 让压缩 prompt 走 user message，是为了**让 forked agent 共享父 session 的 system prompt cache**。我们 spec `[P0]context_compact_detail.md §3.2` 已对齐此决策（forked agent 继承父 system prompt，压缩指令作末尾 user message）。本版本维持，仅优化 user message 正文。

### 5.3 为什么 NO_TOOLS 要双保险（补 trailer）

调研 §3.1 + §4.6 CC 注释（`prompt.ts:12-18`）：forked agent 继承父 tool set（cache-key match 需要），Sonnet 4.6+ adaptive-thinking 模型**仍可能误调工具**，maxTurns:1 下 denied tool call = 无文本输出 = 浪费唯一 turn。当前实现只有 preamble 一行（spec §0），需补 trailer（放最末，双保险）。对齐 spec §3.2「NO_TOOLS 前缀/后缀」。

### 5.4 为什么 9 板块走「通用化」（去 coding-specific）

CC 的 9 板块（Primary Intent / Key Concepts / **Files & Code** / Errors / Problem Solving / User messages / Pending / Current Work / Next Step）含 coding-specific 的「Files & Code Sections」。我们 spec §3.3 已通用化（「Files & Code」→「已完成的工作」），适配任意 agent 场景。本版本对齐 spec §3.3 通用化表。

### 5.5 文件化为什么保留 builder 条件拼装

调研 §4.5：纯文件读取不够，builder 层需要按 `config.tools`（tool_guidance 读 description）/ model family / feature flag 注入不同 section。文件化抽的是**正文**，handler base class 提供「读文件 + 占位符替换 + 条件拼装」通用骨架，子类按需 override。对齐 CC `systemPromptSection`（computed-once-cache）+ Hermes `_r` 间接层（test 可 patch）模式。

---

## 6. 验收口径

| 维度 | 口径 |
|------|------|
| system prompt 内容 | identity 含 5 要素（定位/能力/协作/风格/诚实性红线）≤ 8 行；rules 含 3 section（Operating Rules / Doing Tasks / Tool Use）≤ 20 行 |
| compact prompt 内容 | NO_TOOLS preamble + trailer 双保险；9 板块（通用化）要求；analysis/summary 双 block 输出约束；`<analysis>` strip 不落库 |
| 文件化 | identity/rules/compact 正文从 `app/server/src/prompts/` 文件读取（非代码常量）；handler base class + 子类；保留条件拼装 |
| 行为不回归 | 路径 1（发消息收回复）、路径 2（自动 compact）、路径 3（手动 compact）真 LLM 主链路 PASS；既有 agent 行为无回归（如工具调用、SSE、session 状态） |
| 注入验证 | 路径 4（debug 端点，如存在）断言优化后正文被注入 |
| 视觉保真 | **跳过**（无 UI 改动、无设计稿） |
| 双主题 | **跳过**（无 UI 改动） |

---

## 7. PRD ↔ spec 对齐核对（MANDATORY）

| 核对点 | PRD | spec | 一致 |
|--------|-----|------|------|
| mapper/reducer/builder 架构 | 不动（仅改正文 + 加文件读取层） | system_prompt §1-§5（6 mapper→3 reducer→`"\n\n".join`） | ✅ |
| identity mapper | tier=stable order=1，正文 5 要素 | system_prompt §4 内置 mapper 清单 | ✅ |
| rules mapper | tier=stable order=2，拆 3 section | system_prompt §4（rules 归一个 mapper，内部可多 section） | ✅ |
| tool_guidance mapper | 保持从 `config.tools` 读 description（纯数据贡献） | system_prompt §4 | ✅ |
| compact 形式 | user message、继承父 system prompt、NO_TOOLS | context_compact §3.2、§6.4 | ✅ |
| compact 9 板块 | 通用化表（去 coding-specific） | context_compact §3.3 | ✅ |
| compact 双 block | analysis（strip）/ summary（落库） | context_compact §3.1 | ✅ |
| compact NO_TOOLS | preamble + trailer 双保险 | context_compact §3.2（spec 已约定「前缀/后缀」，当前实现缺 trailer，本期补齐） | ✅ |
| compact 增量 merge | future（不做） | context_compact §4 future | ✅ |
| compact 消息留痕 | compact_notice system message（自动/手动共用，失败不插） | context_compact §6.5 | ✅ |
| 手动触发 | POST /session/:id/compact，复用 forked agent | context_compact §2b | ✅ |
| 触发算式 | 不变 | context_compact §1（remainingTokens = tokenLimit − total − maxOutput） | ✅ |
| timestamp | 不进 system prompt（走 reminder） | system_prompt §4、§9 | ✅ |
| 文件化 / handler | 新概念，PRD 仅高层描述，技术细节由 architect 落 tech spec | （待 architect 落 `specs/tech/`） | ⏳ 架构阶段补 |
| debug 端点 | 引用既有概念（如存在），不发明 | （architect 阶段确认存在性） | ⏳ 架构阶段确认 |

---

## 8. 版本

version: v0.0.22（prompts refine — system prompt 内容优化 + compact prompt 结构化 + prompt 文件化；纯后端 infra，无 UI）
