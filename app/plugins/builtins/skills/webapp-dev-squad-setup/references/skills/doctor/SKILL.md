---
name: doctor
description: 项目代码体检（Code Doctor）。系统性审计当前代码：①明显 bug/问题 ②与 spec/需求不符 ③冗余/落后方案 + 项目硬规则门禁（文件≤300行、状态/过程一致性）。按 subsystem 并行审计，产出结构化 findings 到 doctor/{日期}/。可重复运行、持续迭代。
---

# Doctor — 项目代码体检

## Purpose

对「当前代码」做一次系统性体检，产出**结构化、可追溯、可迭代**的问题清单。审计是**只读**的——只找问题、不改代码（修复另开版本/worktree）。

与 `code-reviewer`（单次 diff 审查）和 `verify-*`（功能验证）的区别：Doctor 是**全量、跨版本、面向 spec 对齐与架构卫生**的体检，不只看本次改动。

## When to Use

- 用户要求「检查/整理代码、找问题、体检、审计」
- 大版本合并前 / 发布前的健康检查
- 长期迭代后怀疑累积了技术债、冗余、spec 漂移
- 周期性（如每 N 个版本）运行，对比历次 `doctor/` 记录趋势

## 审计三维度（核心）

| 维度 | 问什么 | 典型信号 |
|---|---|---|
| **① Bug / 问题** | 真实正确性缺陷、错误处理缺失、并发/竞态、边界、资源泄漏、类型谎言、吞异常 | `catch {}` 空捕获、`as any`、未 await 的 Promise、event handler 泄漏、retry 无上限 |
| **② Spec/需求不符** | 代码与 `specs/`（prd/tech/api/ui）+ `reqs/` 的**权威定义**矛盾或缺失；spec 声称的能力代码没实现，或代码做了 spec 没说的事 | 接口语义/字段名漂移、状态机缺态、用户路径断链、UI 与组件 spec 不符 |
| **③ 冗余/落后** | 死代码、重复实现、被取代的旧方案、半成品、`TODO/FIXME/HACK`、dist 误入库、注释掉的代码块 | 两套同义函数、`deprecated`/`legacy`/`old` 命名、v2 旁边留着 v1、build 产物在 src |

## 项目硬规则门禁（MANDATORY — 本项目专属）

Doctor 必须额外核对 AGENTS.md / 项目约定里的硬规则：

1. **单文件 ≤ 300 行**（生产代码）。`wc -l` 找超限文件，测试文件标注但降权。
2. **状态/过程一致性**：每个已提交版本（git log 出现 `vX.Y.Z`）应有对应 `states/vX.Y.Z/` 且含非空 `task.json` + `task-board.md`。缺失/空目录 = 过程缺口。
3. **Bug 状态机闭合**：`bugs/BUG-xxx-[open].md` 应有追踪与决策；`[fixed]` 未转 `[closed]` = 悬空。
4. **spec ↔ code 一致**：功能完成后 specs/overall 是否同步（AGENTS.md 原则 12）。
5. **`.rocky/` 写保护**：除 `commands/` `agents/` `skills/` 外不应有改动残留。
6. **合并门禁**：声称已合并的版本是否真跑过 API/E2E（verify/ 产出是否存在）。

## 方法论（MANDATORY）

1. **先读 spec，再读代码**（AGENTS.md 原则 11）。每个 subsystem 的审计必须先建立「权威定义」基线：
   - `specs/prd/overall/*` + `specs/prd/version_logs/vX/`（产品意图）
   - `specs/tech/**`（架构权威，尤其 `specs/tech/agent/**`、`convention.md`、`progress.md`）
   - `specs/api/overall/*`（接口契约）
   - `specs/ui/overall/*` + `specs/ui/components/**`（UI 契约）
   - `reqs/vX/`（原始用户需求/设计稿）
2. **代码是 spec 的实现**——发现 spec 与代码不符时，**当场判断哪边对**并标注（多数情况 spec 是权威，除非 spec 已过时则反过来记 spec 漂移）。
3. **证据先行**：每条 finding 必须给 `文件:行号` 证据 + spec 引用，禁止「印象式」断言。
4. **不修代码**：只产 finding + 建议。

## 严重度分级

| 级别 | 定义 | 例 |
|---|---|---|
| **Critical** | 阻断功能 / 数据损坏 / 安全 / 崩溃 | 真 LLM 崩 React、消息丢失、竞态写坏状态 |
| **Major** | 与 spec 显著不符 / 架构硬规则违反 / 高概率误用 | 文件 >400 行、状态机缺态、接口语义漂移、空 catch 吞关键错误 |
| **Minor** | 代码味道 / 可维护性 / 小冗余 | 未用导出、命名歧义、重复小工具、TODO 无追踪 |
| **Info** | 提示性 / 过程缺口 / 已知项 | 版本无 state 目录、known-issue 已记、设计稿差异 |

## Finding 输出格式（每条）

```markdown
### D-{NN} [{Severity}] {Category} — {一句话标题}
- **位置**: `app/.../foo.ts:123-145`
- **维度**: ①bug / ②spec / ③冗余 / 门禁
- **Spec/需求**: `specs/tech/agent/session.md §3` / `reqs/v0.0.12/req.md`
- **现象**: 代码实际做了什么
- **问题**: 为什么是问题（对照权威定义）
- **建议**: 怎么改（方向即可，不写代码）
```

## 产出目录（doctor/{日期}/）

```
doctor/
└── {YYYY-MM-DD}/              # 每次 run 一个日期目录（同日多次 run 加 -2/-3）
│   ├── 00-summary.md          # Orchestrator 汇总：全局健康度评分 + Top issues + 趋势
│   ├── 01-agent-core.md       # 各 subsystem 的 findings（agent 自填）
│   ├── 02-llm.md
│   ├── 03-tools-plugins.md
│   ├── 04-server-infra.md
│   ├── 05-web-frontend.md
│   ├── 06-cross-cutting.md    # 过程/状态/文件大小/死代码 全局扫描
│   └── findings.json          # 结构化（可选，便于跨次对比）
```

**00-summary.md 必含**：
- 健康度（绿/黄/红）+ 一句话结论
- Critical/Major 清单（按 subsystem）
- 与上次 `doctor/` run 的 diff（哪些旧问题已解决、哪些新增）——若无历史则记「首次 run」
- 门禁清单逐项 ✅/❌

## 审计流（Orchestrator 视角）

1. **建基线**：Orchestrator 读最新 `states/` + `git log` + 各 overall spec 结构，确认 subsystem 切分。
2. **并行委派**：按 subsystem 派 audit subagent，每个 agent 收到：(a) 该 subsystem 的 spec 路径，(b) 代码路径，(c) 本 skill 的输出格式，(d) 产出写入 `doctor/{日期}/{NN}-{subsystem}.md`。
3. **交叉审计**（可选）：换一个 agent 复核 Critical/Major（adversarial verify），剔除误报。
4. **汇总**：Orchestrator 读各 subsystem 产出 → 写 `00-summary.md`，给健康度 + Top issues + 门禁表。
5. **迭代**：把本次发现的高频问题模式回写进本 SKILL 的「典型信号」表，让下一次更敏锐。

## 审计准则（防误判 — 首轮 run 踩过的坑）

1. **区分「定义层」与「实现层」再归因**。框架内部表示（canonical message、内部 role/字段）往往是 by design 的合法设计，**不是 bug**；bug 通常在「转换/适配层」（protocol encode、wire 映射、finalize 收尾）。归因前先问：这是定义层的合法内部表示，还是实现层漏了转换？例：`role:"tool"` 是 message 定义层的合法 canonical 表示，bug 在 protocol encode 漏了 role 映射——**不要把定义层当成问题的一部分**。

2. **finalize / 收尾类逻辑，查「是否破坏已发生内容」而非具体症状**。abort/error/中断的收尾（重组 partial、补缺、重放）极易「好心办坏事」：用不完整的重组结果覆盖已落库的完整数据。审计这类逻辑时，盯住不变量「**收尾不得修改/覆盖任何已 emit/已 store 的内容（不限 block 类型）**」，而不是只看「tool_call 丢没丢」这类具体症状。配套查：底层 put/append 是 upsert 还是 insert-if-absent？收尾是否复用了通用 upsert 入口？

3. **Critical/Major 的 spec 引用，orchestrator 亲自核对原文**。subagent 转述 spec 容易失真（首轮 `role:"tool"` 与 abort 收尾两例，都是亲自读 spec 原文后才纠正定位）。Critical/Major 必须由 orchestrator 核对 spec 原文行号，不靠转述；转述与原文不符时，以原文为准并反过来记 spec 漂移。

## 注意

- **量力而行**：审计是抽样 + 聚焦高风险区，不追求 100% 行覆盖。每 subsystem 报 Top N（默认 N=15）即可，宁准勿滥。
- **区分 spec 漂移 vs 代码错**：spec 过时 → 记「spec 需更新」（Info/Major）；代码错 → 记代码 finding。
- **不重复 code-reviewer**：本次 diff 的问题交给 code-reviewer；Doctor 看「全局当前态」。
- **known-issue 不重报**：已在 `bugs/BUG-*-[open].md` 或 `doctor/` 历史记录的，标「已知」引用即可，除非有新证据。
