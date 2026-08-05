# Long Term Memory 调研与设计 Overview

> **状态**：调研完成 v0.1｜**待与用户讨论 spec 设计方向**（本文件不直接定 spec）
> **配套详细笔记**：`specs/research/long_term_memory_{claude_code,hermes,openclaw}.md`
> **规则**：核心观点（§0 TL;DR）置顶，针对每个关注问题用几句话说清楚

---

## 0. TL;DR 核心观点（最重要 — 先读这里）

### Q1. 结构化 memory 是什么形式？
三家都走 **「markdown 文件 + frontmatter 分类 + 索引分层 + 容量上限」**，区别在分层粒度：
- **Claude Code**：`MEMORY.md` 索引（**≤200 行 / 25KB 硬上限**）+ 主题 `.md` 文件；frontmatter `name/description/metadata.type=user|feedback|project|reference` + `Why/How to apply`；progressive disclosure（索引常驻、主题按需读）。**纯文件、无 DB。**
- **Hermes**：2-file core（`MEMORY.md`≤2200 字符 + `USER.md`≤1375 字符）**硬上限逼信息密度**，冻结快照注入（带容量 %），`§` 分隔；叠加 SQLite+FTS5 全文检索 + 8 选 1 external provider。
- **OpenClaw**：8 个职责 MD 文件（`SOUL/IDENTITY/AGENTS/USER/TOOLS/MEMORY/HEARTBEAT/BOOT` + `memory/YYYY-MM-DD.md` 日志 + `DREAMS.md`），「markdown is memory」零隐藏状态；记忆引擎插件化。
- **→ 结论**：结构化 memory = `markdown + frontmatter 分类 + 索引 + 容量上限`。**容量上限本身就是质量过滤器**（满了被迫合并去重）。对 rocky_agent：1～3 个 scope 文件 + frontmatter type 分类 + MEMORY.md 索引 + 硬容量上限。

### Q2. skill / memory manage 如何实现？
两条路线：
- **极简派（Claude Code / OpenClaw）**：**无专门工具**。memory 就是 markdown，agent 用标准 Edit/Write 直接写；skill 用文件系统 + `/agents` + hooks 管理。「操作 memory 的能力」本身被封装成一个 skill（社区 dream-skill 即是用户自建的 memory-manage skill）。
- **工具派（Hermes）**：有专门 `skill_manage` 工具（`create/patch/edit/delete`，**patch 定向修补优先**省 token）+ memory/skill nudge 影子 agent 写入 + `write_approval` 审批门闸 + **Curator 状态机**（active→stale 30d→archived 90d，永不自动删 + tar 快照 + 可回滚 + 可 pin）。
- **→ 结论**：对 rocky_agent 取折中——**memory 仍是 markdown（复用现有）**，但提供 `memory-manage` / `skill-manage` 作为封装工具（patch 优先 + write_approval 门闸），由 orchestrator 调度，避免 agent 用更差版本覆盖手写定制。

### Q3. auto dreaming / consolidation 如何工作、何时触发？
本质都是 **「后台/空闲 fork 影子 agent，做 merge / prune / 去重 / 矛盾解决 / 索引重建」**，触发分两类：
- **事件计数**：Hermes 每 10 用户轮（memory nudge）/ 每 10 工具循环（skill nudge）；Claude Code ≥5 sessions。
- **时间门控**：Claude Code ≥24h（与 5 sessions **双重门控**）；Hermes Curator 空闲 ≥2h + 间隔 ≥7 天；OpenClaw cron（默认 `0 3 * * *`）。
- Claude Code Auto-Dream 四阶段（Orient→Gather **narrowly grep 不读全 transcript**→Consolidate **日期绝对化 + 删除式矛盾解决**→Prune&Index 重建 ≤200 行），**沙箱化只能写 memory**。OpenClaw 三 phase（light/deep/REM）+ 6 信号加权 + 三阈值门。Hermes 还有 **GEPA 离线进化**（读执行轨迹→候选变体→约束门闸→**出 PR 不直接 commit**）。
- **→ 结论**：对 rocky_agent 用 **双重门控（每 N 个版本 + 距上次 ≥7 天）**，fork 影子 agent，**沙箱化（只写 memory / specs overall，不改当前版本 task.json 与源码）**，产物**出提案而非直接改**（合并权在人）。

### Q4. session 总结机制？
- **Claude Code**：Session Memory（`summary.md`，~每 5K tokens 增量，跨 `/compact` 续接）+ Auto-Memory 实时写 + Auto-Dream 跨 session 整合。**时间维度 + 主题维度双索引。**
- **Hermes**：core 冻结快照（启动读 1 次，本 session 看不到新写，保 prefix cache）+ FTS5 全文 + external provider 每轮 prefetch/sync/session 结束 extract。
- **OpenClaw**：daily log（今天+昨天自动加载）+ **handoff**（结构化 task state：objective/progress/files/blockers/resume）+ **pre-compaction flush**（压缩前抢救上下文，防丢）。
- **→ 结论**：对 rocky_agent 每个 session 结束写 **session summary + handoff**（现有 task-board Check 记录的升级版），加 **pre-compaction flush** 防压缩丢上下文。

### Q5. 已总结 skill/memory 的二次反思时机？
- **Claude Code**：Auto-Dream Phase3 定期（24h+5session）重审合并 + 删除式矛盾解决；>90 天无引用降级 archive。
- **Hermes**：memory nudge 每 10 轮重审 + 容量 ~80% **强制合并**；Curator 合并 umbrella 技能；GEPA 读轨迹离线进化；Holographic **矛盾检测 + 信任分**（helpful +0.05 / unhelpful −0.10）；**永不自动删，归档可恢复**。
- **OpenClaw**：dreaming deep phase 晋升；ClawMem **content_type 半衰期表**（decision∞ / handoff 30 天 / problem 60 天）+ **矛盾自动降权** + **recall tracking**（频繁浮现但从不被引用 = noise 候选）；reflect（默认 14 天）+ consolidate。
- **→ 结论**：二次反思 = 定期 consolidation + 容量压力强制演化 + **半衰期淘汰** + 矛盾检测降权。关键护栏：**永不自动删（只归档）+ 可回滚 + 可 pin + 验证门（改了要过测试/语义不漂移）**。对 rocky_agent：版本合并后/定期跑 sweep，content_type 半衰期（specs 决策∞ / bugs 版本后衰减 / states 临时），矛盾检测（新 specs vs 旧 overall）。

### Q6. 一个反复出现的核心设计原则
**「笔/编辑分离」**（Claude Code 原话：Auto-Memory 是笔、Auto-Dream 是编辑）：实时廉价收集（可能含噪）与离线昂贵整合（产出干净知识）解耦到不同时间尺度。+ **「给记忆设上限比加容量更有价值」**（Hermes）+ **「markdown is memory，零隐藏状态」**（OpenClaw）。三家共识：**自改进系统必须有安全网（永不自动删 + 可回滚 + 可 pin + 验证门 + 出 PR 不直接 commit）**，否则「自我表扬的退化」。

---

## 1. 三家横向对比

| 维度 | Claude Code | Hermes | OpenClaw |
|------|-------------|--------|----------|
| **memory 载体** | MEMORY.md 索引 + 主题文件 | 2-file core + SQLite/FTS5 + external provider | 8 个 MD 文件 + daily log + 插件引擎 |
| **容量策略** | 索引 ≤200 行/25KB | core 硬上限 3575 字符逼密度 | workspace 即记忆，无显式上限（靠 dreaming 整理） |
| **scope 分层** | 企业/项目/用户/本地 4 层 | core(全局) + session + external | workspace 级 vs ~/.openclaw 全局级 |
| **注入时机** | 启动全量 + 按需读主题 | 启动冻结快照（保 cache） | 启动注入身份/记忆文件 |
| **manage 工具** | 无（agent 直接写文件） | `skill_manage` + nudge + Curator | 无独立工具 + Active Memory 阻塞检索子 agent |
| **consolidation** | Auto-Dream（24h+5session 双门控） | Nudge（每 10 轮/循环）+ Curator（空闲）+ GEPA | Dreaming（cron，3 phase + 6 信号） |
| **审批/安全** | 沙箱只写 memory | write_approval 门闸 + 永不删 + 可回滚/pin | dreaming opt-in + 可 rollback |
| **skill 进化** | 社区 dream-skill 范式 | skill_manage patch + Curator 状态机 | agent 自写 skill（self_improvement_extract_skill） |
| **验证环节** | 无显式 | **GEPA 约束门闸（测试 100% + <15KB + 语义不漂移）→ 出 PR** | QA shadow trial（report-only 未来） |

---

## 2. 对 rocky_agent 的启示（结合用户愿景）

用户愿景要素映射：

| 愿景要素 | 三家给的最佳实践 | rocky_agent 落地建议 |
|----------|------------------|----------------------|
| **1～3 个 scope 的 memory 文件** | Hermes 2-file core + Claude 多 scope | `project`（跨版本教训/决策）+ `user`（偏好/反馈）+ `session`（当前进行）三 scope；各自带容量上限 |
| **skill + 结构化 memory 作载体** | 三家共识：markdown + frontmatter | memory 文件 frontmatter `type=user\|feedback\|project\|reference` + `Why/How to apply`；skill 用 SKILL.md progressive disclosure |
| **skill-manage / memory-manage 工具** | Hermes `skill_manage`(patch 优先) | 封装为 orchestrator 调度的工具/agent：patch 优先 + write_approval 门闸 + Curator 状态机 |
| **跟随 session 总结** | OpenClaw handoff + Claude session memory | 每 session 结束写 summary + handoff；pre-compaction flush |
| **二次反思时机** | Hermes nudge(每10轮) + Claude(24h+5session) + OpenClaw(14天 reflect) | 版本合并后 + 定期（每 N 版/≥7 天）跑 consolidation sweep；矛盾检测 + 半衰期 |

**最该抄的 5 点**：① 笔/编辑分离（实时收集 + 离线整合）；② 硬容量上限逼密度；③ progressive disclosure（索引常驻/全文按需）；④ 永不自动删 + 可回滚 + 可 pin + 验证门（出 PR）；⑤ content_type 半衰期 + 矛盾自动降权。

**最该避免的**：① review fork 用不同 system prompt 破坏 prefix cache（Hermes #25322 bug）；② agent 自我表扬偏差（需 GEPA 式「读轨迹而非问 agent」）；③ 自改进直接 commit（必须出 PR/提案，合并权在人）。

---

## 3. 初步 spec 方向建议（待与用户讨论，非定稿）

基于调研，rocky_agent 的 long term memory spec 可考虑如下骨架（**仅提案，待确认**）：

1. **载体层**：在现有 `~/.claude/projects/.../memory/` 基础上，明确 **3 scope**——`project.md`（跨版本设计决策/教训）+ `user.md`（用户偏好/反馈）+ `session.md`（当前版本进行中的上下文）。每个带 frontmatter type + Why/How + 硬容量上限。MEMORY.md 作索引（≤200 行）。
2. **管理层**：`memory-manage` + `skill-manage` 作为 orchestrator 委派的能力（不引入新 CLI，复用 agent + 文件），patch 优先 + write_approval 门闸。
3. **整合层**：新增 `memory-consolidator` agent（类比 dream），**双重门控**（每 N 版 + ≥7 天），fork 影子 agent，沙箱化（只写 memory + specs overall），输出**提案（写 states/.../review/ 或 PR）**不直接改。
4. **演化层**：content_type 半衰期 + 矛盾检测（新 specs vs 旧 overall）+ Curator 状态机（active→stale→archived，永不自动删，归档可恢复）。
5. **验证层**：对已沉淀资产（specs/skills）的改动须过「测试 100% + 体量不超标 + 语义不漂移」门闸（GEPA 式），合并权在人。

> **开放问题（需用户拍板）**：
> - scope 数量：2（Hermes 式精简）还是 3（project/user/session）？
> - consolidation 触发：版本事件驱动（每版本合并后）还是时间驱动（定期 cron）还是混合？
> - 是否引入 external 检索层（SQLite/FTS5 或向量），还是坚持纯 markdown 索引？
> - 验证层是否现在就做，还是先做载体+管理+整合，验证层后续？

---

## 4. 来源（详见配套笔记）

- **Claude Code**：docs.claude.com(memory/skills/hooks/sub-agents) · claudefa.st/auto-dream · ogham-mcp.dev · decodethefuture.org · antoniocortes.com · github.com/grandamenium/dream-skill · Piebald-AI 泄露 dream 提示词 · buttondown.com(Memory 2.0)
- **Hermes**：hermes-agent.nousresearch.com/docs(curator/cron/memory-providers/personality) · 53AI/lzw.me/xmsumi 源码拆解 · GitHub Issues #13578/#22357/#25322 · medium/@xpf6677
- **OpenClaw**：docs.openclaw.ai(memory/active-memory/dreaming/skills) · github CortexReach/memory-lancedb-pro-skill · yoloshii/ClawMem · andrehuang/claude-claw · autonomys/openclaw-skills · qingxuantang/migrate-openclaw-to-cc-skill · ClawHub

---

version: 0.1（调研综合，待 spec 设计讨论）
