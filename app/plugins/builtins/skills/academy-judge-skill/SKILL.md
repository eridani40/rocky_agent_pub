---
name: academy-judge-skill
description: Academy 评估器（grader）编写参考。何时加载——你是 academy-head_teacher，要为教室配置或迭代评估器（read_grader / 增改 prompt / 选 em vs llm-judge）。覆盖：grader 类型选型（em 程序性 vs llm-as-judge 主观性）、promptTemplate 4 段结构（题目 / 学生输出 / 评估标准 / 输出 JSON schema）、4 条常见陷阱（不给满分 / reasoning 必填 / 具体维度 / 反例锚定）、rubric 多维加权示例、迭代工作流。**评估质量决定训练迭代信号质量**——模糊评估 → coach 反思失效。evolvable=false（方法论不参与自我进化）。权威依据 specs/tech/academy/[P0]academy_skills.md §5 + [P0]evaluation.md + refs/easy-skill-trainer grader 设计。
allowed-tools:
  - read
  - write
  - edit
evolvable: false
---

# Academy Judge Skill — 评估器编写参考

> 本技能是 academy-head_teacher **编写/迭代教室评估器**的方法论指南（L1，按需加载）。评估器是教室资产（挂在 classroom，非 student），决定训练迭代信号质量。

## 1. 何时用本技能

- 你是 academy-head_teacher，要为教室配置评估器（design.md §6 训练外要求）。
- 场景：首次创建评估器 / 迭代已有评估器（基于 coach 反馈「reasoning 太抽象」等）/ 选型（em vs llm-judge）。
- 不在 candidate workspace（学生不用）——在 head workspace 加载（builtin 层自动）。

## 2. 评估器类型选型（em vs llm-judge）

| 类型 | 何时用 | 优势 | 劣势 |
|---|---|---|---|
| **em（精确匹配）** | 题目有唯一正确答案（数学题、事实问答、固定 schema 输出） | 0 成本、0 噪声、确定性 | 无法处理主观性 / 部分正确 |
| **llm-judge** | 主观性、多正确答案、需语义判断（写作、对话、推理过程） | 灵活、可评多维 | 有噪声、需配 prompt + rubric |

**选型决策**：
- 题目答案**唯一且可枚举** → em（如「北京是中国的首都」对/错）
- 题目答案**多正确 / 需语义判断** → llm-judge（如「写一段吸引人的开头」）
- **混合**：一道题可拆 em 子部分（事实对错）+ llm-judge 子部分（表达质量），加权汇总

**默认建议**：训练学生能力（academy 主场景）多为主观性，**llm-judge 是主力**。

## 3. promptTemplate 结构（4 段，llm-judge 核心）

promptTemplate 是 llm-judge 的灵魂。**4 段缺一不可**：

```markdown
[1. 题目]（question）
{case.question}

[2. 学生输出]（student_output）
{sample.output}

[3. 评估标准]（grading_criteria）
（rubric——见 §5，必须具体可判断）

[4. 输出 JSON schema]
按以下 JSON 格式输出（严禁其他格式）：
{
  "score": <0–1 浮点>,
  "reasoning": "<具体理由，引用学生输出原文>",
  "dimensions": {
    "<维度 1>": <0–1>,
    "<维度 2>": <0–1>,
    ...
  }
}
```

**模板引擎**：`{case.question}` / `{sample.output}` 由训练引擎在评估时注入（spec `[P0]evaluation.md`）。

## 4. 4 条常见陷阱（必避）

### 4.1 不要给满分（鼓励严格）

**问题**：LLM 默认倾向给高分（「整体不错」 → 0.9）。所有 case 都 0.9 → 训练信号无效。

**对策**：promptTemplate 中**显式约束**：

```
评分严格性要求：
- 默认上限 0.7（除非学生输出真正卓越才往上）
- 0.8+ 必须在 reasoning 给出「卓越的具体表现」
- 1.0 几乎不给出（理论满分，实际罕见）
- 0.5 是「合格但有明显改进空间」
```

**反例**：rubric 里只写「好 / 一般 / 差」对应 1 / 0.5 / 0——LLM 倾向「好」。

### 4.2 reasoning 必填（不填则 reject）

**问题**：LLM 偷懒只给 `{"score": 0.7}`，没 reasoning → coach 无法反思（train-skill §3 靠 reasoning）。

**对策**：promptTemplate 强制 + 训练引擎校验：

```
输出契约：
- reasoning 必填，至少 50 字
- 必须引用学生输出原文片段作为证据
- 必须指出 1 个改进点（即使高分）
```

**引擎层校验**（spec `[P0]evaluation.md`）：reasoning 缺失 / < 20 字 → 该 case 评估失败（status='grader_error'），coach 看到「reasoning 缺失」错误信号。

### 4.3 用具体维度（不要「整体感觉」）

**问题**：rubric 只写「整体感觉」→ LLM 决策无锚定 → 分数噪声大。

**对策**：rubric 拆**具体可判断的维度**（3–6 个）：

| bad（抽象） | good（具体） |
|---|---|
| 整体质量 | 切题度 / 信息密度 / 结构清晰 / 语言准确 / 创意 |
| 写得好不好 | 观点明确 / 论据充分 / 逻辑连贯 / 用词精准 |

每维度独立打分，总分 = 加权平均（见 §5）。

### 4.4 反例锚定（给 LLM 参照点）

**问题**：LLM 没参照系，对「好」的标准漂移。

**对策**：rubric 附**反例锚定**：

```
参考反例：
- 0.3 分样例：[学生输出 X]——扣分点：未切题、堆砌形容词
- 0.7 分样例：[学生输出 Y]——扣分点：观点明确但论据不足
- 0.9 分样例：[学生输出 Z]——加分点：结构清晰、有创意、论据充分
```

LLM 见过具体样例后，评分一致性显著提升（few-shot 效应）。

## 5. rubric 示例（多维度加权）

完整示例（「写吸引人的开头」题目）：

```yaml
dimensions:
  - name: 切题度
    weight: 0.2
    criteria: 是否围绕题目核心，不跑题
  - name: 吸引力
    weight: 0.3
    criteria: 前 50 字是否抓住读者注意力（悬念/冲突/具体画面）
  - name: 信息密度
    weight: 0.2
    criteria: 是否避免空洞描写，每句推进信息
  - name: 语言准确
    weight: 0.15
    criteria: 用词精准，无语法/搭配错误
  - name: 创意
    weight: 0.15
    criteria: 是否避免套路化表达（如「在一个阳光明媚的早晨」）

scoring_guide:
  0.9+: 卓越——多维度突出，无显著短板
  0.7-0.9: 良好——核心维度达标，1-2 个改进点
  0.5-0.7: 合格——切题但平庸，多处可改进
  0.3-0.5: 不足——核心维度不达标
  < 0.3: 跑题/失败

anchors:
  - score: 0.3
    sample: "在一个阳光明媚的早晨，小鸟在歌唱..."
    note: 套路化开头 + 环境描写堆砌
  - score: 0.7
    sample: "马孔多那年下了第一场冰。..."
    note: 具体画面 + 悬念，但缺角色
  - score: 0.9
    sample: "（具体卓越样例）"
    note: 多维度突出
```

**总分计算**：`Σ(dim_score × weight)`，引擎层算（不靠 LLM 加总，避免算错）。

## 6. 迭代工作流（head 用）

评估器不是一次写好——基于 coach 反馈迭代：

```
1. 首次创建：按 §3 结构 + §5 rubric 写 promptTemplate
2. 教室跑一轮训练任务（coach 用 manage-task）
3. 看 coach 反馈：
   - coach 报「reasoning 太抽象」→ 加强 §4.2 / §4.4 反例
   - coach 报「分数都偏高无区分度」→ 加强 §4.1 严格性约束
   - coach 报「某维度评不准」→ 改 §5 rubric 该维度 criteria
4. 增改 dataset（如发现某类 case 缺失）
5. 重新跑训练任务验证
```

**关键反馈信号**（coach 通过 send_message 报给 head）：
- 多数 case reasoning < 50 字 → 评估器偷懒，加 §4.2 约束
- 多数 case score 集中在 0.7–0.9 → 区分度不足，加 §4.1 / §5 scoring_guide
- 不同 case score 高度相关（同方向变化）→ rubric 维度可能耦合，重新拆分

## 7. em grader 配置（程序性评估）

em 适用于答案唯一题目。配置简洁：

```yaml
graderType: em
expected: "北京"           # 严格匹配
# 或
expectedPattern: "^北京$"  # 正则匹配
# 或
expectedContains: ["北京"]  # 包含匹配（任一命中即对）
```

**em 不需要 promptTemplate**——直接字段比对。

**部分正确**：em 不支持部分正确（0/1 二元）。若需要部分正确 → 用 llm-judge。

## 8. 反模式（必须避免）

- ❌ **「整体感觉」rubric**：抽象无维度 → 评估噪声大。
- ❌ **无 reasoning 强制**：LLM 偷懒只输出分数 → coach 无法反思。
- ❌ **满分倾向**：所有 case 0.9+ → 训练信号无效。
- ❌ **无反例锚定**：LLM 评分漂移 → 跨 case 不可比。
- ❌ **维度过多**（> 6 个）：LLM 注意力分散，每维度评估质量下降。
- ❌ **维度耦合**（「内容质量」+ 「信息密度」高度相关）：合并或拆清。
- ❌ **学生能猜题**：rubric 太透明 → 学生按 rubric 刷分而非真改善能力。**rubric 评能力，不教能力**——维度名指向能力，不指向答案模板。

## 9. 与训练链路对接

- 教室评估器配置在 classroom.graders（spec `[P0]data_model.md`）。
- 训练任务发起时，coach 用 `manage-task read_grader` action 读 promptTemplate 进上下文（理解评估维度）。
- 评估时每 case 独立调 LLM（pLimit 5 并发，spec `[P0]evaluation.md`）——**禁止一个 LLM 给多 case 打分**（噪声 + 不可比）。
- coach 拿到 gradeResults 后按 train-skill 反思。

**评估器迭代是训练外要求**（design.md §6）——head 独立完成，不进 training-task directive；coach 发现评估器问题 → send_message 报 head。

## 10. 参考（L2 深度钻取）

- `specs/tech/academy/[P0]academy_skills.md §5`（评估器编写要点权威）
- `specs/tech/academy/[P0]evaluation.md`（dataset/grader 体系 + fan-out 直调实现）
- `refs/easy-skill-trainer/packages/server/src/runtime/grader/{types,llm-judge-grader}.ts`（grader 接口 + LLM 模板）
- `refs/skillopt/evaluation/gate.py`（acceptGate 纯函数：cand > current → accept）
- `app/plugins/skills/academy-train-skill/SKILL.md`（coach 如何消费 gradeResults）
