# Claude Code 长期记忆（Long Term Memory）体系深度调研

> 调研对象：Claude Code（Anthropic 官方 CLI）的 CLAUDE.md 多层 scope、结构化 memory 文件、自定义 skill、Auto-Memory、Auto-Dream、Session 总结、管理工具与 hooks。
> 版本基线：Auto-Memory / Auto-Dream 自 **Claude Code v2.1.59+** 默认开启。
> 来源：docs.claude.com 官方文档、claudefa.st、ogham-mcp.dev、decodethefuture.org、antoniocortes.com、grandamenium/dream-skill、buttondown.com/verified、Medium（@creativeaininja）、Piebald-AI 泄露系统提示词、dev.to、nicolasneera.com。

---

## 一、Memory 的形式

Claude Code 的记忆不是一个单一文件，而是**四层栈（four-layer stack）**协同：`CLAUDE.md`（你写的指令）+ Auto-Memory（Claude session 内自动写的笔记）+ Session Memory（单会话摘要）+ Auto-Dream（后台整合）。

### 1.1 CLAUDE.md 多层 scope（官方文档化，4 层）

| 层 | 文件路径 | 用途 | 共享范围 |
|---|---|---|---|
| 企业策略 | macOS `/Library/Application Support/ClaudeCode/CLAUDE.md`；Linux `/etc/claude-code/CLAUDE.md` | IT/DevOps 组织级指令 | 组织内所有用户 |
| 项目 | `./CLAUDE.md` 或 `./.claude/CLAUDE.md` | 团队共享项目指令 | 团队（随 git） |
| 用户 | `~/.claude/CLAUDE.md` | 跨所有项目个人偏好 | 仅自己（所有项目） |
| 项目本地（已弃用） | `./CLAUDE.local.md` | 个人项目偏好 | 仅自己（当前项目） |

- **启动时全量自动加载**，高层级优先、先加载，为更具体的记忆打基础。
- **递归向上查找**：从 cwd 向上到根（不含），沿途读所有 CLAUDE.md。
- **`@path/to/file` 导入语法**（相对/绝对路径，递归最大 5 跳，代码块内 `@` 不展开）。
- **`CLAUDE.local.md` 已弃用**，改用主目录导入。

### 1.2 结构化 memory 文件（`~/.claude/projects/<proj>/memory/`）

这是 **Auto-Memory 产物**（v2.1.59+ 内置维护）：
```
~/.claude/projects/<proj>/memory/
├── MEMORY.md                # 索引，启动加载前 200 行 / 25 KB
├── debugging.md             # 主题文件
├── api-conventions.md
├── build-and-test.md
├── deployment.md
└── activity-log-2026-05.md  # 每日日志
```
**`<proj>` 从 git repo 派生**——同一 repo 的所有 worktree **共享一个 memory 目录**。

**Frontmatter 字段**：`name` / `description` / `metadata.type`（`user|feedback|project|reference`）/ 正文 / `[[wikilink]]` / **Why**（为什么记住）/ **How to apply**（如何应用）。

> 说明：官方 memory.md 页面只文档化了扁平 CLAUDE.md 那套；带 frontmatter 的结构化目录是 **Auto-Memory + 社区/泄露提示词**驱动的约定。

### 1.3 MEMORY.md 索引机制
- **启动仅加载前 200 行 / 25 KB**（硬阈值）。
- 索引行是**单行指针**（≤150 字符），**不存内联内容**，细节移入主题文件。
- 主题文件**按需读取**（Read/Grep），启动不加载。
- **无语义/向量搜索**——纯线性索引 + 按需文件读取。

**关键设计**：渐进式披露（索引进上下文、细节留磁盘）；200 行硬阈值迫使分层 + 定期整合；git repo 派生 path（跨 worktree 一致但牺牲隔离）；机器本地无云同步（换 Cursor/Codex 看不到），换隐私 + 零向量库依赖。

---

## 二、自定义 Skill（SKILL.md）

### 2.1 SKILL.md 结构
```yaml
---
name: your-skill-name          # 必需，小写+数字+连字符，≤64 字符
description: Brief description ... when to use it   # 必需，≤1024 字符（触发器）
allowed-tools: Read, Grep, Glob   # 可选，激活时锁定工具集
---
正文 = 给 Claude 的指令 + 可选 references/scripts/templates 支持
```

### 2.2 发现机制（3 层）
个人 `~/.claude/skills/`（所有项目）｜项目 `.claude/skills/`（随 git）｜插件（随已装插件）。冲突时项目级优先。

### 2.3 触发机制
**模型驱动调用**（非斜杠命令）：Claude 根据 `description` + 上下文**自动决定**何时触发（关键词匹配）。也支持显式调用。

### 2.4 Skill 与 Memory 的关系
边界：Skill = 可复用能力包，Memory = 项目知识/事实。交集：Skill 可读写 memory 文件。dream-skill 本质 = 一个"操作 memory"的 skill。

**关键设计**：description 即路由（模型自主判断）；渐进式披露；插件分发。可借鉴：把"操作 memory 的能力"封装成 skill 而非写死 CLI。

---

## 三、Auto-Memory + Auto-Dream（重点）

### 3.1 Auto-Memory：session 内信号收集（"Auto Memory 是笔"）

**收集的信号**：① 用户纠正（最高价值，"no/not that/I meant"）；② 显式保存请求（"remember that/from now on"）；③ 重复主题（≥3 session）；④ 重要决策（"let's go with/switch to"）；⑤ 构建命令/测试约定/代码风格/调试见解。

**写到**：`~/.claude/projects/<proj>/memory/` 的 MEMORY.md + 主题文件。
**配置**：默认开（v2.1.59+）；`/memory` 切换；`"autoMemoryEnabled": false`；env `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`（覆盖所有设置，CI 用）。`autoMemoryDirectory` 只能从 policy/user scope 设，**禁止 project scope**（防克隆 repo 重定向写入）。

### 3.2 Auto-Dream：REM 睡眠式整合（"Auto Dream 是编辑"）

#### 四阶段流程（Piebald-AI 泄露提示词 + 多源交叉验证）

**Phase 1 — Orient（定向）**：完整读 MEMORY.md + 引用的主题文件 + 活动日志，构建当前状态思维导图。**不写任何东西。**

**Phase 2 — Gather Signal**：提示词明确 **"grep narrowly, don't read whole files"**。在 `~/.claude/projects/<proj>/transcripts/*.jsonl` 上针对性 grep（不读全 transcript）。
- 用户纠正：`actually|no,|wrong|incorrect|not right|stop doing|I meant|that's not`
- 偏好/配置：`I prefer|always use|never use|from now on|remember that|default to`
- 重要决策：`let's go with|I decided|we're using|the plan is|switch to|we agreed`
- 重复模式：`again|every time|keep forgetting|as usual`
- 每个匹配提取：事实 + 日期（mtime）+ 置信度 + 与现有 memory 的矛盾。

**Phase 3 — Consolidate（巩固）**：合并新信息到主题文件；三大清理 pass：
- **日期规范化**：相对→绝对（永不存 "yesterday"）。
- **矛盾解决**：Express→Fastify 迁移 → **删除**旧的 "API uses Express"（不是注释，是删除）+ `(Updated YYYY-MM-DD, previously: ...)`。
- **去重**：3 次注意到同一怪癖 → 整合为一条。
- 来源归属：`(from session YYYY-MM-DD)`。

**Phase 4 — Prune & Index**：重建 MEMORY.md ≤200 行 / 25 KB 纯指针索引；索引行 ≤150 字符；删死指针；>90 天无引用降级 archive.md；**无需改的文件保持不动（手术刀式，非全量重写）**。

#### dream sub-agent 系统提示词（泄露原文核心）
"You are performing a dream — a reflective process over your memory files. Synthesize what you've recently learned into durable, well-organized memory so future sessions can quickly locate it." 另有独立的轻量修剪提示词（456 tokens）。

核心"意见"：① 狭义 grep 不读全 transcript；② MEMORY.md 200 行限制；③ 从源头解决矛盾（删除旧事实）；④ 对 memory 结构化有明确意见。

#### 触发时机（双重门控）
自动触发**必须同时满足**：① 距上次 dream **≥24 小时**；② 自上次 dream 以来 **≥5 个新 session**。"两天内 1 个长 session 不触发（session 不够）；两小时内 10 个短 session 也不触发（时间不够）。" `minSessions: 5` 阈值。
- 手动：`/dream` 斜杠命令（绕过门控）；自然语言 "dream"/"consolidate my memory"。
- 社区 dream-skill：Stop hook + `.dream-pending` 标志 + CLAUDE.md 会话开始指令，自建触发链。
- **并发控制**：lock 文件防同项目并发 dream。

#### 安全沙箱
- **对项目代码只读**：dream 期间只能写 memory 文件，不能改源码/配置/测试。沙箱化到 memory 目录。
- 后台执行，可继续工作。**8-9 分钟处理 913 个 session**（多源确认）。

#### 版本与状态
- Auto-Memory：v2.1.59+（2026-02-26 默认全项目开）。
- Auto-Dream：2026-03 下旬进 `/memory` UI，flag-gated 滚动推出。
- `/memory` 看到 **"Auto-dream: on"**。

#### "Memory 2.0" = 四层栈整体品牌
CLAUDE.md + Auto-Memory + Session Memory + Auto-Dream 三件套（含从 ChatGPT/Gemini 迁移的 Memory Import）。核心隐喻："Auto Memory 是笔；Auto Dream 是编辑。"

**关键设计**：笔/编辑分离（实时廉价收集 vs 离线昂贵整合）；双重门控；狭义 grep 控成本；沙箱化；删除式矛盾解决 + 绝对日期；REM 睡眠隐喻工程化。

---

## 四、Session 总结机制

- **Session Memory（独立于 Auto-Memory）**：自动生成 `summary.md`（`~/.claude/projects/<proj>/<session>/session-memory/`），后台 ~每 5K tokens 更新。用途：**单 session 内跨 `/compact`** 上下文续接。与 Auto-Dream 区别：session memory 是单 session 短期回忆，Auto-Dream 是跨 session 长期整合。
- **session 结束提炼**：不是一次性——分散到 session 内（Auto-Memory 持续写）+ session 间（Auto-Dream 定期整合）。
- **压缩策略**：session memory 增量摘要（时间维度）+ auto-dream 主题归并（主题维度），双索引互补。**不在 session 结束时做重活**（会阻塞用户离开），重活推迟到后台 dream。

---

## 五、管理工具

- **谁写 memory**：Auto-Memory = Claude 自己用 Edit/Write；Auto-Dream = 专门 dream sub-agent（沙箱化到 memory）；用户 = `#` 快捷键 / `/memory` / 直接编辑。子代理可维护**自己的 auto memory**（多 agent 编排边界）。
- **无专门 memory-manage / skill-manage 命令**。管理通过：斜杠命令（`/memory`、`/agents`、`/hooks`）+ 文件系统直接编辑 + skill 自身成为管理工具（dream-skill）。
- **Hooks 参与 memory 自动化**：hook = 任意 shell（写磁盘任何文件）。最接近的机制：SessionStart（`additionalContext` 注入）、UserPromptSubmit、**Stop/SubagentStop**（dream-skill 用 Stop hook 触发 `should-dream.sh` 检查 24h+5session → `touch .dream-pending` → 下次 session CLAUDE.md 检测标志后台 spawn `/dream`）。
- **快照机制**：启动捕获 hooks/memory 快照，session 内用快照，外部改要 `/hooks` 审查才生效——防 session 中途配置被篡改。

dream-skill hook 装配（写入 `~/.claude/settings.json`）：
```json
{"hooks":{"Stop":[{"matcher":"","hooks":[{"type":"command","command":"bash $HOME/.claude/skills/dream/should-dream.sh && touch $HOME/.claude/.dream-pending || true"}]}]}}
```

**关键设计**：不造专门工具，复用文件系统 + 标准工具（memory 就是 markdown，零特殊 API）；hook = 任意 shell 涌现用户自建自动化；启动快照 + 审查菜单 = 安全热更新边界。

---

## 六、对 rocky_agent 的启示

1. **引入"笔/编辑分离"双层架构**：现有依赖 MEMORY.md + CLAUDE.md，**缺定期的"编辑"层**。建议新增 **memory-consolidator agent**（类比 dream sub-agent），版本验收后或定期（每 3 版本）跑：读 task-board Check 记录 + bugs/ + MEMORY.md，做矛盾解决（closed bug 教训 vs open known-issue）、绝对日期化、去重、索引修剪回固定行数。
2. **给 memory 条目加结构化 frontmatter**：现有条目只有标题+链接。升级为 `metadata.type`（user/feedback/project/reference）+ 强制 **Why + How to apply**。让 memory 从"被动归档"变"可执行防回归规则"。
3. **借鉴双重门控 + 沙箱化设计"离线巩固"节奏**：每完成 N 版本 + 距上次巩固 ≥7 天 才触发，沙箱化（只写 memory/specs overall，不改当前 task.json 或源码）。
4. **用 Stop hook + 标志文件实现"跨 session 延迟任务"**：dream-skill 链路（Stop hook 检测条件 → touch 标志 → 下次 session 指令检测 → 后台 spawn 子代理）是无守护进程的优雅延迟任务模式，可复用于"版本合并后自动跑 doc-modifier"。
5. **"memory 就是 markdown，无专门 API"极简哲学**：把 states/ 版本状态、specs/ 设计记忆、memory/ 跨版本教训统一进"markdown + 索引 + 按需读"模型，不引入 DB，保持轻量可审计。

---

**Sources**: docs.claude.com(memory/skills/hooks/sub-agents/settings) · claudefa.st/auto-dream · ogham-mcp.dev/claude-auto-memory · decodethefuture.org · antoniocortes.com(2026/03/30) · github.com/grandamenium/dream-skill · buttondown.com/verified(Memory 2.0) · medium/@creativeaininja · Piebald-AI dream prompts · nicolasneera.com · dev.to/akari_iku
