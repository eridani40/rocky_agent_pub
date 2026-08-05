# OpenClaw 长期记忆与 Skill 体系调研笔记

> **调研对象**：OpenClaw（formerly Clawdbot / Moltbot）—— 开源、自托管、聊天原生的 AI agent 平台，围绕 Soul / Memory / Skills / workspace identity 架构。
> **来源**：OpenClaw 官方文档（concepts/memory、agent-workspace、active-memory、dreaming、tools/skills）+ 6 个关键参考实现 GitHub README + MyClaw.ai / ClawHub。
> **说明**：基于截至 2026 年中公开文档，生态演进快。

---

## 一、OpenClaw 是什么 + 整体记忆/身份架构

### 1.1 OpenClaw 是什么
**OpenClaw**（曾用名 Clawdbot → Moltbot）是**开源、自托管、运行在用户自己设备上**的 AI agent 平台。slogan "The AI that actually does things"。本质是 **Gateway / Runtime**：把聊天应用（WhatsApp/Telegram/Discord/Slack/Email）作为 channel surface，背后接 agent runtime（TypeScript，lane-based 队列默认串行）。核心仓库在 GitHub；**MyClaw.ai** 是第三方托管云平台（一键部署 $19/月起）。

**与 Claude Code 的关系**：内部 LLM 引擎可接 Claude（也支持 Codex/Gemini）。社区称 **"non-technical version of Claude Code"**。**可互操作**：共享 SKILL.md 格式、共享 workspace 目录结构（`~/.openclaw/workspace/skills/` 与 `~/.claude/skills/` 一致）；多个记忆技能同时支持两端；`migrate-openclaw-to-cc-skill` 专门迁移。**转折事件**：2026-04-05 起 Anthropic 封禁 OpenClaw 用 Claude Pro/Max，催生"迁移到 Claude Code Channels"方案。

### 1.2 "8 个 MD 文件"体系（markdown is memory）
官方原话：*"The model only 'remembers' what gets saved to disk — there is no hidden state."*（模型只记得被保存到磁盘的内容，无隐藏状态。）

| 文件 | 角色 | 加载 | 持久化 |
|------|------|------|--------|
| **SOUL.md** | 人格/灵魂（"who I am"） | 每会话启动 | 磁盘，改了要告诉用户 |
| **IDENTITY.md** | 名片（名字/emoji/视觉调性） | 每会话启动 | bootstrap 仪式创建 |
| **AGENTS.md** | 操作规章（运行规则/优先级/记忆使用规范） | 每会话启动 | 磁盘 |
| **USER.md** | 用户画像 | 每会话启动 | 磁盘 |
| **TOOLS.md** | 工具使用惯例（**仅 guidance，不控制工具可用性**） | 每会话启动 | 磁盘 |
| **HEARTBEAT.md** | 心跳清单（要求短，避免 token 浪费） | heartbeat 运行时 | 磁盘 |
| **BOOT.md** | 启动 checklist（gateway 重启自动跑） | 重启时 | 磁盘 |
| **MEMORY.md** | 长期记忆（curated） | 每 DM 会话启动 | 磁盘（人类/agent 共同 curate） |
| **memory/YYYY-MM-DD.md** | 每日日志（working layer） | 今天+昨天自动加载 | 磁盘，被 `memory_search` 索引 |
| **DREAMS.md** | 梦境日记（dreaming sweep 阶段总结，供人类 review） | 不自动注入 | 磁盘 |

**scope 分层**：**workspace 级**（最高优先级，`~/.openclaw/workspace/`）vs **全局/agent 级**（`~/.openclaw/` 配置/凭证/会话转录/managed skills）。**两者严格分离**，后者不应进 git。多 agent/profile：`OPENCLAW_PROFILE` 给不同 agent 不同 workspace。**workspace = 安全边界 + 记忆载体**（推荐放私有 git 备份）。

**可借鉴**：用 7-8 个职责清晰的 MD 文件切分 system prompt（比巨型 prompt 易维护易 diff）；"workspace 即记忆 + 即安全边界"；workspace 与配置目录严格分层（前者进 git、后者不进）。

---

## 二、记忆-技能生态（关键参考实现）

OpenClaw 记忆是**插件化**（`plugins.slots.memory` slot）。默认 `memory-core`（SQLite + hybrid search），社区有高质量替代/增强。

### 2.1 memory-lancedb-pro（CortexReach）— LanceDB 生产级
- **存储分层 L0/L1/L2**（Abstract/Overview/Full，按需加载）。
- **Smart Extraction**：6 类 LLM 分类 + 两阶段去重（向量预筛 ≥0.7 + LLM 决策 `CREATE|MERGE|SKIP|SUPPORT|CONTEXTUALIZE|CONTRADICT`）。
- **混合检索**：`(vector×0.7)+(bm25×0.3)` via RRF → Cross-Encoder Rerank → 生命周期衰减 → 长度归一化 → Hard Min Score → MMR。
- **生命周期 = Weibull 衰减**：3 tier（Core β=0.8 floor=0.9 / Working β=1.0 / Peripheral β=1.3），`recency=exp(-λ×days^β)`，综合分 = Recency 40% + Frequency 30% + Intrinsic 30%。
- **多 scope 隔离**：`global/agent:/custom:/project:/user:`。
- **9 个 MCP 工具**：核心 `memory_recall/store/forget/update` + 管理 + **自治理** `self_improvement_log/extract_skill/review`。
- **4 套 deployment plan**（Full Power/Budget/Simple/Local-Ollama 零 API key）。
- **"Iron Rules"**：5 条硬规则写进 AGENTS.md + `/lesson`/`/remember` slash 模板。

**关键**：记忆衰减用数学模型（Weibull）而非启发式；LEARNINGS/ERRORS → skill 闭环（`LRN-`/`ERR-` entry 生命周期 `pending→resolved→promoted_to_skill`）。

### 2.2 ClawMem（yoloshii）— 端侧混合 RAG
本地优先，TypeScript on Bun，**同时支持 Claude Code/OpenClaw/Hermes 三端共享同一 SQLite vault**（`~/.cache/clawmem/index.sqlite`），实现跨 runtime 跨 session 持久共享。
- **检索 QMD 多信号混合**：BM25 + 向量 + RRF + 查询扩展 + cross-encoder rerank。
- **SAME 复合分**：recency decay + confidence + content-type half-life + co-activation。
- **意图分类（MAGMA 风格）**：WHY/WHEN/ENTITY/WHAT 四类，dual-path（正则 + LLM 精化）分派不同检索策略。
- **A-MEM 自演化**：每条文档自动 enrich（keywords/tags/context），新文档触发邻居元数据演化（版本号 + 推理记录）。
- **因果推断**：observer 从 transcript 提 9 类 observation，LLM 推断 cause→effect（≥0.6）。
- **content_type 半衰期表（教科书级）**：∞ 永不衰减（`decision/deductive/preference/hub/antipattern`）；60 天（`problem/milestone/note`）；30 天（`handoff`）；45 天（`conversation/progress`）；120 天（`project`）；90 天（`research`）。频繁访问半衰期延长 3 倍。
- **矛盾检测 + 自动降权**：新 decision 与旧矛盾，旧 confidence −0.25（矛盾）/−0.15（更新）。
- **三层注入架构（hooks 90% + MCP 10%）**：`context-surfacing`(UserPromptSubmit) 注入 vault-context；`postcompact-inject`(SessionStart) compaction 后重注入；**`precompact-extract`(PreCompact) compaction 前抢抽取**（`before_prompt_build` 同步路径，不和 compactor 竞态）；`decision-extractor`+`handoff-generator`+`feedback-loop`(Stop)。
- **prompt injection 防护**：5 层检测。

**关键**：content_type 半衰期表；compaction 前抢抽取解决压缩丢上下文；矛盾自动降权让过时记忆自然淡出；跨 runtime 共享 vault 是多 agent 协作基础设施。

### 2.3 claude-claw（andrehuang）— OpenClaw 模式的 Claude Code 插件
把 OpenClaw 最佳实践蒸馏成 Claude Code 插件（`claude plugin install`），无需 gateway。
- **两技能**：`/handoff`（保存结构化 task state：objective/progress/files/pending/blockers/resume，下会话 "pick up where I left off" 恢复）+ `/manager`（持久 task board，status/add/plan/review/context 五模式）。
- **Multi-Agent Safety 6 条**：scoped file ownership、no stash/branch switching、commit scope discipline、conflict avoidance。
- **Memory Architecture 6 条**：**三层记忆系统** — Global（所有会话，用户身份/跨项目知识）/ Project-local（单项目，task state/handoff/决策）/ Daily log（单天单项目，临时事件）+ cross-project 检索 + pre-compaction flush。

**关键**：三层 scope（Global/Project/Daily）比二元划分实用；Multi-Agent Safety 规则集对多 worktree 项目直接可抄；重型基础设施降维成 behavior rules。

### 2.4 autonomys/openclaw-skills — 去中心化永久记忆
把记忆上链（Autonomys Network），实现"永久"记忆和"可重生"agent。
- **auto-memory**：Autonomys Auto Drive API 永久存储。**Memory chains**：身份/知识/决策存为**链表**，每条 entry 通过 CID 指向前一条 → **未来全新 agent 实例只需一个 CID 重建"我是谁"**。本地 `automemory-state.json` 跟踪最新 head CID，**无需钱包/token/链上交易**（只需免费 API key）。
- **auto-respawn**：链上身份 + 记忆锚定。recovery phrase → 两地址（consensus + EVM）= agent 可验证链上身份；最新 memory chain head CID 写入智能合约 → **从任意机器仅凭 EVM 地址即可恢复 head CID**。

**关键**：memory chain（CID 链表）是跨实例/跨设备恢复 agent 身份的优雅方案；"从一个 ID 恢复整个 agent"是强灾难恢复模型。

### 2.5 migrate-openclaw-to-cc-skill（qingxuantang）— 记忆模型对应反推
把整个 OpenClaw agent 迁移到 Claude Code。**最大价值：反推 OpenClaw ↔ Claude Code 记忆模型精确对应**：

| OpenClaw 文件 | → Claude Code |
|---------------|---------------|
| `SOUL+AGENTS+IDENTITY+TOOLS.md` | 合并成单个 `CLAUDE.md` |
| `MEMORY.md`（持久事实/偏好/决策） | 解析成 **4 类 typed memory**：`user/feedback/project/reference` |
| `memory/*.md`（每日日志） | 归档到 `archive/` 手动 review |
| `skills/`（全局+workspace 级） | **直接复制**（格式完全相同） |
| `openclaw.json`（env） | 提取到 `settings.json` |

**关键**：技能格式两平台完全相同（SKILL.md）直接复制；多 MD 身份体系 ↔ 单 CLAUDE.md + 4 类 typed memory 是"多文件 vs 单文件"风格对齐；每步有自动化策略标签（AUTO/AUTO-FIRST/MANUAL/DO NOT）。

### 2.6 openclaw-master-skills（LeoYeAI）— master skills
MyClaw.ai 官方精选技能合集（387+ skills，每周更新，多语言）。**master skills = 经过验证、值得作为 agent 默认装备的高质量技能集合**（curated index）。含 `agentcreate`（AI 驱动 agent 创建器，**agent 可通过技能创建新独立 agent**）、`ai-model-router`、`turing-pyramid`、`elite-longterm-memory`（WAL protocol + 向量检索，跨 Cursor/Claude/ChatGPT/Copilot）。

**关键**：curated index + 每周更新保证质量；技能作为跨 agent 平台可移植单元。

---

## 三、技能形式与管理

### 3.1 定义
技能 = 一个目录 + 一个 `SKILL.md`（与 Claude Code 完全相同）。官方：*"Skills are markdown instruction files that teach the agent how and when to use tools."* YAML frontmatter（`name/description/trigger`）+ markdown 正文。

**progressive disclosure**：Metadata（name+description，~100 words 始终加载）→ SKILL.md body（触发时）→ references/*.md（按需）。**trigger = description 关键词匹配**。

### 3.2 存储与发现（scope 优先级，高→低）
1. workspace skills（`~/.openclaw/workspace/skills/`，**最高优先级**，覆盖下层同名）
2. project agent skills
3. personal agent skills
4. managed skills（`~/.openclaw/skills/`，**不在 workspace 内**）
5. bundled skills（内置）
6. `skills.load.extraDirs`

### 3.3 与 Claude Code 异同
- **格式完全相同**（SKILL.md），可互复制（migrate 项目直接 `cp -r skills/`）。
- **安装位置不同**：OpenClaw `~/.openclaw/{workspace/,}skills/`；Claude Code `~/.claude/skills/`。
- **分发**：OpenClaw 有 **ClawHub**（`clawhub.ai`，13700+ 技能）+ ClawHub CLI；Claude Code 用 `claude plugin install --url`。
- **版本管理**：git tag `<skill>/v<semver>` 发布 ClawHub。
- **供应链风险（重要）**：ClawHub 有 **1184+ 恶意/投毒技能**（利用 SKILL.md setup block），安装前必须 vetting。

### 3.4 技能管理谁来做
- 人类：手写 / ClawHub / master-skills 安装。
- **agent 自写**：memory-lancedb-pro 的 `self_improvement_extract_skill` 从 LEARNINGS scaffold 新技能；`agentcreate` 让 agent 创建配置新独立 agent。**OpenClaw 明确支持 agent 自我扩展能力库**。

**可借鉴**：progressive disclosure 控 token；workspace > managed > bundled 优先级（项目覆盖个人覆盖默认）；agent 自写技能是真正"自我进化"闭环；**供应链安全是引入第三方技能库的红线**。

---

## 四、记忆管理

### 4.1 谁负责 CRUD（多主体协作）
- **agent 自己**（主要写入者）：`memory_search`/`memory_get` 读，隐式写 MD 文件存。**无独立 memory-manage 工具**——直接用文件工具写 `MEMORY.md`/`memory/YYYY-MM-DD.md`。
- **memory plugin**（检索引擎）：`memory-core`（默认 SQLite）或 `memory-lancedb(-pro)`/ClawMem，负责索引/检索/（部分）生命周期。
- **自动 flush**（compaction 前）：OpenClaw **默认开** "automatic memory flush"——compaction 前跑静默 turn 提醒 agent 存重要上下文（可配 `compaction.memoryFlush.model` 如 `ollama/qwen3:8b`）。
- **heartbeat/cron**：dreaming sweep 由 cron 自动跑。
- **人类**：直接编辑 MD（推荐私有 git）。

### 4.2 结构化程度（两极并存）
- **自由 markdown**（默认原生）：MEMORY.md + memory/*.md，纯文本无 schema，检索靠 embedding+BM25。
- **结构化字段**（插件层）：memory-lancedb-pro（L0/L1/L2 + smart metadata + 6 类）；ClawMem（gray-matter frontmatter：title/tags/domain/workstream/**content_type**/review_by）；**memory-wiki**（官方，把 durable memory 编译成 wiki vault：确定性页面结构 + 结构化 claims/evidence + 矛盾/新鲜度追踪 + dashboard + 编译 digest，提供 wiki_search/get/apply/lint，**不替换 memory plugin 而是其上 provenance-rich 知识层**）。

### 4.3 写入/检索/淘汰
- **写入**：显式（agent 调文件工具）/ 自动抽取（ClawMem `decision-extractor` Stop hook 9 类 observation；lancedb-pro Smart Extraction）/ pre-compaction flush（官方内置）。
- **检索**：`memory_search`（语义）+ `memory_get`（精确）；hybrid search（向量+关键词，可配 local/Ollama/Gemini 等 embedding）。**Active Memory 插件（官方重要）**：**plugin-owned 阻塞式记忆子 agent，在主回复之前跑一次**——给系统"bounded 机会在主回复前浮现相关记忆"（"most memory systems are capable but reactive"）。queryMode（message/recent/full）+ promptStyle（balanced/strict/contextual/recall-heavy/precision-heavy/preference-only）；弱连接返回 NONE。
- **淘汰**：手动 / dreaming sweep（deep phase 阈值门控 promotion）/ 插件生命周期（lancedb-pro Weibull + 3 tier；ClawMem 半衰期 + 矛盾降权 + pin/snooze + **recall tracking**（频繁浮现但很少引用 = noise 候选，自动建议 snooze））/ **action-sensitive memory**（某些记忆需记 "何时可安全行动"——approval boundary/expiry/source authority；"memory 可保存 approval context 但不强制策略"，硬操作用 approval settings/sandboxing）。

**可借鉴**：**Active Memory "回复前阻塞检索"**把检索从 reactive 变 proactive；**memory-wiki provenance layer**（claim+evidence+矛盾/新鲜度追踪）适合强可信度知识库；**recall tracking**（surfaced vs referenced 比率）判断记忆是否有用。

---

## 五、会话总结 / 反思 / 固化（"做梦"）

OpenClaw 在此有**最完整设计**（Dreaming 系统），是其标志性特性。

### 5.1 Handoff（会话间传递）
claude-claw `/handoff`（结构化 task state）；ClawMem `handoff-generator`(Stop hook，GGUF observer + regex fallback)；lancedb-pro session memory。

### 5.2 Daily Log（天级别）
`memory/YYYY-MM-DD.md`（今天+昨天自动加载）；slugged 变体也加载；claude-claw daily log pattern 自动追加 notable events。

### 5.3 Dreaming（核心：背景固化）
`memory-core` 提供 **Dreaming** —— 背景记忆固化系统，把短期信号升级为持久记忆。

**三 phase**（内部实现）：
| Phase | 职责 | 写 MEMORY.md |
|-------|------|-------------|
| **Light** | 排序+staging 近期短期材料，去重，记录 reinforcement | 否 |
| **Deep** | 打分 + 晋升持久候选到 MEMORY.md | **是** |
| **REM** | 反思主题、反复想法，提取模式 | 否 |

**Deep phase 6 信号加权排名**（+ phase reinforcement）：Relevance 0.30 / Frequency 0.24 / Query diversity 0.15 / Recency 0.15 / Consolidation 0.10 / Conceptual richness 0.06。

**三道阈值门**：`minScore` + `minRecallCount` + `minUniqueQueries` 全通过才 promote。

**Dream Diary**（`DREAMS.md`）：每个 phase 攒够材料跑 best-effort 背景 subagent turn 追加日记条目，**是人类 review 的 surface**。还有 grounded historical backfill lane（重放历史 daily log），可 rollback（`openclaw memory rem-backfill --rollback`）。

**触发**：**opt-in（默认关）**；**scheduled**（启用后自动管理 cron，默认 `0 3 * * *`，跑完整 light→REM→deep sweep）；覆盖主 workspace + 所有配置 agent workspace（路径去重）；**依赖 heartbeat**（cron 存在但默认 heartbeat 没跑 → status `blocked`）。

**QA shadow trial（report-only）**：未来设想——候选记忆晋升前先跑对比 trial（baseline vs 用候选记忆），verdict（helpful/neutral/harmful）→ promote/defer/reject 建议。**当前仅 report-only，不改 deep-phase 引擎**。

**社区扩展**：openclaw-auto-dream（LeoYeAI）；ClawMem `reflect`（跨会话，默认 14 天）+ `consolidate`（归档重复低置信）+ quiet-window heavy maintenance lane（`CLAWMEM_HEAVY_LANE=true`，只在配置时间窗跑，gated by context_usage 查询率，**永不和交互会话抢 CPU/GPU**）。

**可借鉴**：**三 phase + 6 信号加权 + 三阈值门**是工业级 consolidation；**Dream Diary 作人类 review surface**（机器自动固化 + 可审计）；**query diversity 信号**（不只频率，看不同 query 是否都命中）防噪声被召回强化；**QA shadow trial**（先 trial 再 promote）是可信方向；**quiet-window heavy maintenance** 避免抢资源。

---

## 六、对 rocky_agent 的启示

1. **借鉴"8 个 MD 文件"身份分层，但不全盘照搬**：rocky_agent 已有 specs/(概念权威)+states/v{N}.{M}/(版本状态)+user_query.md。可考虑加 SOUL.md/AGENTS.md 风格的 orchestrator 行为宪法（区分人格/价值观 vs 操作规则）。但 rocky_agent 的工程化（task.json + task-board.md 双轨）比 OpenClaw 原生纯 MD 更结构化，应保留。
2. **content_type 半衰期表 + 矛盾自动降权直接抄**：当前 states/ 下版本目录全保留，随版本累积膨胀。可为不同类型状态（specs 决策 vs task-board 进度 vs bugs 临时）引入不同保留策略。ClawMem 的 `decision∞/handoff 30天/problem 60天` 极具参考价值。
3. **Dreaming 式背景固化值得长期投入**：rocky_agent 每版本结束靠 doc-modifier 同步（一次性人工触发）。可演进为**定期 cron 跑固化 sweep**：跨版本扫描 specs/+states/+bugs/，用 6 信号打分，高频复用决策**自动晋升 specs/overall**，过时移 archive。从"每版手动同步"到"系统化知识沉淀"。
4. **Active Memory "回复前阻塞检索"解上下文丢失痛点**：当前 CLAUDE.md 强调"先理解再动手"、"从 specs 理解项目"但依赖 agent 自觉。可在 orchestrator 委派 subagent 前**强制插阻塞式检索**（类似 Active Memory `before_prompt_build`），把相关 specs/research/过往决策自动注入 subagent 上下文，缓解"specs 不准确连锁误导"。
5. **memory chain（CID 链表）式跨实例恢复适合 worktree 多分支**：MEMORY.md 记录了 worktree-divergent-salvage 教训。可借鉴 memory chain——每 worktree/版本维护指向上一版本 state 的"记忆指针"，即便 divergent 也能通过指针链重建完整上下文，降低 salvage 复杂度。

---

**Sources**: docs.openclaw.ai(concepts/memory,agent-workspace,active-memory,dreaming;tools/skills) · github CortexReach/memory-lancedb-pro-skill · yoloshii/ClawMem · andrehuang/claude-claw · autonomys/openclaw-skills · qingxuantang/migrate-openclaw-to-cc-skill · LeoYeAI/openclaw-master-skills · clawhub.ai · openclaw.ai / myclaw.ai
