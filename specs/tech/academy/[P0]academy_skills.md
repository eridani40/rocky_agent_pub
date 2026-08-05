---
type: spec
title: Academy Skills — learn-skill / train-skill / judge-skill 3 个优化 skill 形态
priority: P0
status: active
updated: 2026-07-29
since: v0.0.210
---

# Academy Skills — 3 个优化 skill 形态

> 定位：academy 优化能力的 skill 资产。每个学生版本通过 workspace `.rocky/skills/` 加载；初始版本由训练引擎在 fork 时通过 coach 写入。3 个 academy skill 提供**方法论指导**（非具体业务能力）。
> 原则：复用现有 skill 机制（`specs/tech/agent/skills/`）— SKILL.md + progressive disclosure L0/L1/L2 + workspace/app/group 四层扫描。

## 1. 3 skill 全览

| skill | name | 用途 | 何时由 coach 写入 candidate workspace |
|---|---|---|---|
| **学习式优化 skill** | `learn-skill` | 教练 coach 如何**学习**优化学生：上网收集专家方法→提炼成新 prompt/skill 内容 | mode='simple' + optimizeStyle='learning'；mode='multi' + optimizeStyle='learning' |
| **训练式优化 skill** | `train-skill` | 教练 coach 如何**训练**优化学生：基于评估结果反思→整理正负例→修订 prompt/skill | mode='multi' + optimizeStyle='training' |
| **评估器编写参考 skill** | `judge-skill` | 教 head 用户如何**写好评估器**：prompt 模板结构 + 常见陷阱 + rubric 示例 | head 编辑评估器时（不在 candidate workspace，是 head workspace） |

## 2. SKILL.md schema（与现有 skill 一致）

```yaml
---
name: learn-skill
description: 学习式优化学生 agent 的方法论：上网收集专家方法→提炼→修订 prompt/skill
allowed-tools:
  - web_search
  - web_fetch
  - read
  - write
  - edit
  - skill
evolvable: false            # 方法论 skill 不参与自我进化（防递归）
---

# Learn Skill — 学习式优化方法论

## 何时用
当 coach 接到 optimizeStyle='learning' 的训练任务，且需要...

## 流程（参考 refs/skillopt + easy-skill-trainer）
1. 拆解 directive：识别优化目标（"学《旧猫咪》这本书" → 找书/找章节/找典型观点）
2. 上网收集：web_search 找权威源（书籍/论文/专家博客）→ web_fetch 抓全文
3. 提炼：从 N 个源提取共通模式 / 正负例 / 评估维度
4. 整理：写进 candidate workspace 的 AGENTS.md（或新增 skill）
5. 自我修订：参考 refs/skillopt/prompts/slow_update.md 自评→保留/修订/新增

## 注意事项
- 不要堆砌长 prompt（学生在 context window 内运行）；提炼到 500-1500 字
- 必须用具体案例（"这种情况正例是 X，负例是 Y"），不抽象
- 修订而非覆盖：保留 base 版本有效内容，增量改进

## 参考实现
- refs/skillopt/prompts/{analyst_success,analyst_success,slow_update}.md
- refs/easy-skill-trainer/docs/iteration-engine-guide.md
```

## 3. learn-skill（学习式优化）

### 3.1 流程

```
directive 解析 → 知识源识别（书籍/论文/案例）
  ↓
web_search 多 query 并发（不同关键词/角度）
  ↓
web_fetch 抓 Top-K 源（K ≤ 5；避免 context 爆）
  ↓
提炼阶段：
  - 共通模式（多个源都提到的 → 高置信）
  - 正例（A 源说"这样做对"）
  - 负例（B 源说"这样做错"）
  - 评估维度（如何判断好坏）
  ↓
整理：
  - 写进 candidate.AGENTS.md（系统提示词 — 身份 + 方法论 + 案例库）
  - 或新增/修订 candidate/.rocky/skills/<name>/SKILL.md（具体能力包）
  ↓
coach 自评（slow_update 模式）：
  - 这一版相比 base 改进了什么？
  - 哪些地方可能 over-fit？
  - 下轮该探索什么方向？
  ↓
coach 调 propose → status='awaiting_confirm'
```

### 3.2 资源约束

- 单次学习不超过 5 个 web_fetch（context 限制）。
- AGENTS.md 提炼后 ≤ 1500 字（学生 context window 内运行）。
- 新增 skill 必须 `description` 清晰（学生 L0 catalog 用）。

## 4. train-skill（训练式优化）

### 4.1 流程

```
读 turn.gradeResults + turn.sampleResults
  ↓
分类：
  - positive case（score >= threshold）：学生做得好的
  - negative case（score < threshold）：学生做错的
  - neutral case：边界情况
  ↓
反思（关键步骤）：
  - negative case 共通模式？（如"都漏了 X 维度"）
  - positive case 共通模式？（如"都抓住了 Y 关键"）
  - 评估器 reasoning 提取关键反馈
  ↓
修订：
  - 在 candidate.AGENTS.md 增加"常见错误避免"section
  - 或修订已有 skill 的 SKILL.md（增加反例）
  ↓
coach 自评 + 下一轮方向预判（feed 拒绝记忆 — 防重复提议）
  ↓
继续 revise 或 propose
```

### 4.2 拒绝记忆（borrow from skillopt）

- coach 在反思时读历史 turn.reflection（含 rejected edits 摘要）。
- 避免重复提议同一修订方向（防止 oscillation）。

## 5. judge-skill（评估器编写参考）

### 5.1 用途

- head 编辑/迭代评估器时参考。
- 不在 candidate workspace（学生不用）；在 head 的 workspace `.rocky/skills/judge-skill/`。

### 5.2 内容要点

- promptTemplate 结构（题目/学生输出/标准/输出 JSON 格式）。
- 常见陷阱：
  - 不要让 judge 给满分（鼓励严格 — 默认 0.7 上限）。
  - reasoning 必填（不填则 reject）。
  - 用具体维度（不要"整体感觉"）。
- rubric 示例（多维度加权）。
- em grader 使用场景（何时用精确匹配 vs llm-judge）。

## 6. builtin 注册（`app/plugins/builtins/skills/`）

```
app/plugins/builtins/skills/
├── academy-learn-skill/        # 学习式优化方法论（academy-* 前缀，builtin 扫描根）
│   └── SKILL.md
├── academy-train-skill/        # 训练式优化方法论
│   └── SKILL.md
└── academy-judge-skill/        # 评估器编写参考（head 编辑评估器时加载）
    └── SKILL.md
```

> **builtin 扫描根**：3 个 academy skill 落 `app/plugins/builtins/skills/`（`builtinSkillRoot()` 扫描根，dev/打包一致可见）。coach（skillSource=global-enabled）自动加载 builtin 层，可 `skill academy-train-skill` 调起。build-plugins `copyResources` 由 `BUILTINS_SRC/skills` 统一覆盖 academy-* 子目录（无特殊 workaround）。

- 通过 build-plugins `copyResources` 拷贝到 packaged dist（与 session-types/scopes/其他 builtin skills 同待遇）。
- skill 加载走现有四层扫描（builtin/app/workspace/group），builtin 层 = 默认全集。
- enabled 默认 true（coach/head session 自动加载；student workspace 由训练链路选择写入）。

## 7. 与训练链路的关系

- **初始 student workspace（0.0 版本）**：不带任何 academy skill（全空）。
- **fork 过程版本时**：candidate workspace 由 coach 编辑（coach 直接改 AGENTS.md/.rocky/skills/）；coach 自身靠 builtin 层加载的 `academy-train-skill`/`learn-skill` 获得方法论指导（不需写入 candidate）。
- **judge-skill**：head 编辑/迭代评估器时参考（head session builtin 自动加载）。

## 8. academy skill 与业务 skill 区分

- **academy skill（本文 3 个）**：方法论指导，跨学生/版本通用，由 coach/head 消费。
- **业务 skill（学生版本自己的）**：具体领域能力（如"如何写商品文案"），由训练链路（学习式/训练式）产出写入 candidate workspace，是**学生版本专属**资产。

> 训练产出 = AGENTS.md（系统提示）+ 业务 skill（若有）；academy skill 是**过程工具**，不进 accept 后的正式版本。

## 9. 边界

| 管 | 不管 |
|---|---|
| 3 academy skill 形态 + 内容要点 + 注册位置 | 本文 ✅ |
| **学生版本工作区 skill 的读写通道**（`.rocky/skills/` 文件树 + 单文件读/写端点） | 本 KB：`[P0]data_model.md §3.1/§6.1` + `specs/api/overall/18-academy.md §1.8/§1.11`（**复用** `../agent/skills/` 的 buildFileTree / parseSkillDir / file-io 原语，不重造） |
| SKILL.md schema（frontmatter / progressive disclosure） | `../agent/skills/`（复用） |
| skill 加载四层扫描 | `../agent/skills/` |
| 具体业务 skill 内容 | 训练链路动态产出（非 spec） |
