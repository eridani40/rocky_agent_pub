---
name: academy-train-skill
description: Academy 训练式优化方法论。何时加载——你是 academy-coach，接到 optimizeStyle='training' 多轮训练任务（mode='multi'，教室已备 dataset + grader），需要基于每轮评估结果反思学生表现 → 修订 AGENTS.md / skill → 进入下一轮。流程：读 turn.gradeResults → 分类正/负/中性 case → 反思共通模式 → 修订（加常见错误避免 / 反例）→ 拒绝记忆（防重复提议已被否决方向）→ 自评 + 下一轮方向预判。reasoning 必填，引用评估器 reasoning 字段做反思原料。evolvable=false（方法论不参与自我进化，防递归）。权威依据 specs/tech/academy/[P0]academy_skills.md §4 + refs/skillopt 反思+拒绝记忆范式。
allowed-tools:
  - read
  - write
  - edit
  - skill
evolvable: false
---

# Academy Train Skill — 训练式优化方法论

> 本技能是 academy-coach 做**训练式优化**的方法论指南（L1，按需加载）。coach 在 task.optimizeStyle='training' 时按本流程基于评估结果迭代学生能力。

## 1. 何时用本技能

- 你是 academy-coach，task.mode='multi' 且 optimizeStyle='training'。
- **训练式 = 基于评估结果反思迭代**，与「学习式」（从外部知识蒸馏）正交。
- 前置：教室已备 dataset + grader（multi 模式硬要求，见 design.md §5）。
- 不适用：optimizeStyle='learning'——走 learn-skill；训练外要求（评估器迭代/数据集补 case）是 head 的活，不进训练任务。

## 2. 核心流程（6 步，每轮 runTurn 后执行）

```
1. 读评估结果   → turn.gradeResults + turn.sampleResults（每 case 分数 + reasoning）
2. 分类 case    → positive / negative / neutral（按阈值）
3. 反思共通模式 → negative 找漏掉的维度，positive 找抓住的关键
4. 修订         → AGENTS.md 加「常见错误避免」/ skill 加反例
5. 拒绝记忆     → 读历史 turn.reflection，避免重复提议
6. 自评 + 预判  → 这一轮改了什么 + 下一轮方向
```

## 3. 读评估结果（reasoning 必填原则）

每轮 revise 完成后，调 `manage-task` 工具 `turn_result` action 拿回：

```
turn.gradeResults = [
  {
    caseId: "...",
    score: 0.65,              // 0–1
    reasoning: "...",          // 评估器给出的具体理由（必填，judge-skill 保证）
    graderType: "llm-judge" | "em"
  },
  ...
]
```

**reasoning 是反思原料**——不要只看分数。reasoning 告诉你「学生漏了什么维度」「哪一步走偏了」，是迭代的关键信号。

**reasoning 缺失或太抽象**（如「不够好」）：视为评估器质量问题，**不反思**，向 head 报告（让 head 迭代 grader，design.md §6 训练外要求）。

## 4. 分类规则（正/负/中性）

| 类别 | 阈值 | 价值 |
|---|---|---|
| **positive case** | score ≥ 0.8 | 学生做得好的——反思抓住的关键 |
| **negative case** | score < 0.5 | 学生做错的——反思漏掉的维度 |
| **neutral case** | 0.5 ≤ score < 0.8 | 边界——参考用，不强反思 |

**阈值可调**：若 case 量少（< 5 条），适当放宽 negative 阈值到 < 0.7 以多挖改进点。

**分类产物**（写入 turn.reflection）：

```
positive_cases: [
  { caseId, score, why_good: "（从 reasoning 提炼学生做对了什么）" }
],
negative_cases: [
  { caseId, score, why_bad: "（从 reasoning 提炼学生漏了什么）", pattern: "（共通模式归类）" }
],
neutral_cases: [...]
```

## 5. 反思共通模式（关键步骤）

**borrow from refs/skillopt `analyst_error.md` + `analyst_success.md`**：

### 5.1 negative case 共通模式

跨多个 negative case 找**重复出现的模式**：

| 模式信号 | 举例 |
|---|---|
| 都漏了同一维度 | 5 个 negative 都没考虑「目标读者」 |
| 都犯了同一错误 | 3 个 negative 都在开头堆砌形容词 |
| 都缺同一要素 | 4 个 negative 都没有明确观点 |
| 工具/流程缺陷 | 多次没调 web_search 验证事实 |

**反思产物**：`negative_patterns: ["学生普遍漏 X 维度", "学生普遍在 Y 环节犯错"]`。

### 5.2 positive case 共通模式

同样找 positive 重复模式，提炼「学生做对的关键」：

| 模式信号 | 举例 |
|---|---|
| 都抓住了同一关键 | 3 个 positive 都用了具体例子 |
| 都遵循了同一流程 | 2 个 positive 都先问目标再写 |

**反思产物**：`positive_patterns: ["学生普遍在 X 上做得好"]`。

**为什么找 positive**：不只是鼓励——找出学生**已经稳定掌握**的能力，避免下一轮**改坏**它（acceptGate 只看总分，单维退化会被总分掩盖）。

### 5.3 反思的「为什么」

每个共通模式问 **3 个 why**（borrow from Five Whys）：

```
模式：学生普遍漏「目标读者」维度
why 1: 为什么？→ AGENTS.md 没明确要求识别读者
why 2: 为什么没要求？→ base 版假设学生默认会做
why 3: 为什么默认会做不靠谱？→ 评估显示 80% case 漏掉
→ 修订方向：AGENTS.md 加「写之前先显式列出目标读者」
```

## 6. 修订（AGENTS.md / skill）

### 6.1 AGENTS.md 加「常见错误避免」section

适用：跨能力的方法性纠正（如「漏读者」「堆砌形容词」）。

```markdown
# Common Pitfalls (Avoid)
- 漏目标读者：写之前先显式列出目标读者
- 开头堆砌形容词：开头优先用具体动作 / 对象
- 不验证事实：涉及事实性主张调 web_search
```

**段落约束**：≤ 200 字 / 段，4–8 条 pitfall 上限（太多学生记不住）。

### 6.2 修订已有 skill（加反例）

适用：能力级的具体反例（如「商品文案不要夸张」）。

edit 对应 SKILL.md，在已有「Case Library」或「Negative Examples」段落补反例：

```markdown
## Negative Examples（避免）
- 反例 X：写「史上最好」会被广告法拦截（case Y 失败）
- 反例 Y：...
```

**新增 skill**（次选）：发现新能力缺口（base 没有相关 skill）时考虑新增，但**优先修订已有**——避免 skill 数量膨胀。

## 7. 拒绝记忆（防重复提议，关键机制）

**borrow from refs/skillopt**：每轮反思前，**先读历史 turn.reflection**（训练引擎持久化的历史反思摘要）。

### 7.1 流程

```
1. 读历史 turn.reflection（manage-task 工具可读，或调 read turn 历史）
2. 提取已被拒 / 失败的修订方向：
   - 之前提过 X 修订但 acceptGate 拒了（总分下降）
   - 之前反思提到 Y 方向但实测无效
3. 当前反思若落在历史拒绝方向 → **不重复提议**，换方向
```

### 7.2 拒绝记忆产物

每轮 turn.reflection 里维护：

```
rejected_directions: [
  { direction: "加'多用形容词'到 AGENTS.md", reason: "v3 提过，总分下降 0.05", turn: 3 }
]
```

### 7.3 为什么重要

- 防止 oscillation（A 方向提了被拒 → 下轮又提 → 又被拒 → 死循环）。
- LLM 反思天然不记得自己之前干过什么——必须**显式读历史**。
- case 量少时 acceptGate 决策噪声大，更需拒绝记忆防止噪声驱动反复修订。

## 8. 自评 + 下一轮方向预判

修订完一版后，**强制自评**（borrow from refs/skillopt `slow_update.md`）：

```
1. 这一版相比上一临时基线改了什么？（写下来）
2. 预期效果：哪些 negative case 应该被修复？哪些 positive 不应退化？
3. 下一轮方向：
   - 若本方向有效 → 继续深挖（同模式的其他 case）
   - 若本方向无效（acceptGate 拒）→ 记入 rejected_directions，换方向
   - 若已无显著 negative → 建议用户 adopt 当前版本（调 `manage-task adopt` 旁路归档）
```

**早停建议**：连续 3 轮总分无提升（design.md §5.3 默认 earlyStop），task 自动进 paused+earlystop；coach 可向 head 建议采纳当前临时基线，或 head 调 `manage-classroom.update_task` 调整 directive 后 resume。

## 9. 反模式（必须避免）

- ❌ **只看分数不看 reasoning**：reasoning 是反思原料，分数只是分类信号。
- ❌ **逐 case 修订**：5 个 negative 改 5 处 → 学生无所适从 + context 爆。**找共通模式，一处修订覆盖多个 case**。
- ❌ **全盘重写 AGENTS.md**：丢失已稳定的 positive 能力。**增量加 section**。
- ❌ **不读历史 reflection**：重复提议被否决方向，浪费轮次。
- ❌ **越权改评估器/数据集**：那是 head 的活（design.md §6 训练外要求）。发现评估器问题 → 报告 head。
- ❌ **reasoning 编造**：没从 reasoning 提炼就拍脑袋编「学生漏了 X」——必须从 case 实际 reasoning 来。

## 10. 与训练链路对接

- 每轮反思完，coach 自主决定：继续 edit candidate + `manage-task revise` 推进下一轮，或 `manage-task adopt(versionId)` 旁路归档当前候选为新 formal。
- acceptGate 是纯函数（design.md §5.3）：新 candidate 评估分 > 当前临时基线分 → 替换；否则保留当前基线。
- maxTurns 到顶 → task 自动 paused+maxturns（硬终态，须 head `manage-classroom.update_task(maxTurns=N+x)` 调大再 resume）；早停 → paused+earlystop（可 resume）。

## 11. 参考（L2 深度钻取）

- `specs/tech/academy/[P0]academy_skills.md §4`（训练式形态权威）
- `specs/tech/academy/[P0]training_engine.md`（runTurn + acceptGate 纯函数）
- `refs/skillopt/prompts/{analyst_error,analyst_success,slow_update}.md`（反思/自评 prompt 骨架）
- `refs/skillopt`（拒绝记忆 + step_buffer + valid gate 范式）
- `app/plugins/skills/academy-judge-skill/SKILL.md`（评估器编写参考——理解 reasoning 字段如何产生）
