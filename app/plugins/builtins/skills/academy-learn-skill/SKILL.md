---
name: academy-learn-skill
description: Academy 学习式优化方法论。何时加载——你是 academy-coach，接到 optimizeStyle='learning' 训练任务（mode='simple' 或 'multi'），且 directive 含「学习专家方法 / 找书籍 / 找论文 / 收集案例」类外部知识诉求。流程：拆 directive → web_search 多 query 并发 → web_fetch Top-K 源 → 提炼共通模式/正负例 → 整理进 AGENTS.md 或新增 skill → slow_update 自评（保留/修订/新增）。从人类专家方法蒸馏新能力注入学生，非凭空发明。evolvable=false（方法论不参与自我进化，防递归）。权威依据 specs/tech/academy/[P0]academy_skills.md §3 + refs/skillopt 提炼契约。
allowed-tools:
  - web_search
  - web_fetch
  - read
  - write
  - edit
  - skill
evolvable: false
---

# Academy Learn Skill — 学习式优化方法论

> 本技能是 academy-coach 做**学习式优化**的方法论指南（L1，按需加载）。coach 在 task.optimizeStyle='learning' 时按本流程从外部知识源蒸馏能力给学生版本。

## 1. 何时用本技能

- 你是 academy-coach，task.directive 形如「这次去学《旧猫咪》这本书」「重点优化开头」「找专家怎么做 X」。
- **学习式 = 从人类专家知识蒸馏**，与「训练式」（基于评估结果反思）正交。
- 不适用：directive 是「评估器迭代」「数据集补 case」——那是 head teacher 训练外要求，不进训练任务（design.md §6）。

## 2. 核心流程（5 步，按序执行）

```
1. 拆 directive    → 把模糊目标拆成可搜索的具体子问题
2. 多源收集       → web_search 多 query 并发 + web_fetch Top-K（K ≤ 5）
3. 提炼           → 共通模式 / 正例 / 负例 / 评估维度（四要素）
4. 整理落盘       → 写进 candidate.AGENTS.md 或新增/修订 skill
5. slow_update 自评 → 保留/修订/新增三态自检，避免 over-fit
```

## 3. 拆 directive（把模糊变具体）

directive 通常是 user 自然语言（「学《旧猫咪》」）。**先拆**：

| directive 类型 | 拆出的子问题（举例） |
|---|---|
| 学某本书/某理论 | 这本书核心论点是什么？典型方法有哪些？常见误读有哪些？谁在用？ |
| 优化某能力（「写好开头」） | 专家如何定义「好开头」？有哪些范式？反例是什么？评估维度有哪些？ |
| 学某领域实践 | 行业最佳实践是什么？经典案例有哪些？常见踩坑？工具/流程？ |

**输出**：3–5 个**可搜索**的具体子问题，每个对应一两条 web_search query。

**反例**（不拆直接搜）：directive「学《旧猫咪》」→ 直接 `web_search("旧猫咪")` → 拿到无效结果。**先拆再搜**。

## 4. 多源收集策略

### 4.1 web_search 多 query 并发

每个子问题至少 2 条 query（不同角度/关键词）：

```
子问题「如何定义好开头」：
  - query 1: "小说开头 写作技巧 专家"
  - query 2: "story opening best practices writer"
  - query 3: "creative writing opening examples"
```

**多角度**：中文 + 英文 + 领域术语；理论 + 实例；权威源（书籍/论文）+ 实战博客。

### 4.2 web_fetch Top-K（K ≤ 5 硬上限）

从搜索结果挑**至多 5 个**最权威/最相关的源抓全文：

- **优先级**：权威书籍/论文 > 专家博客/专栏 > 通用百科 > 其他
- **跳过**：内容农场、SEO 堆砌、明显不相关
- **context 约束**：每 fetch 一篇会占大量 token；超 5 篇学生 context 装不下，反而失焦

### 4.3 收集阶段产出

整理成**带出处的事实卡片**（后续提炼的原料）：

```
[源 A: 《写作课》第三章]
  论点：开头应建立「预期缺口」
  正例：《百年孤独》冰的开头
  负例：从天气描写开始

[源 B: writer.com/blog/openings]
  论点：前 100 字决定读者留存
  维度：悬念 / 角色 / 风格 / 信息密度
```

## 5. 提炼（四要素）

把事实卡片蒸馏为**学生可直接消费**的结构化知识（borrow from refs/skillopt `analyst_success.md` + `meta_skill.md`）：

| 要素 | 来源 | 价值 |
|---|---|---|
| **共通模式** | 多个源都提到的（≥2 源共识） | 高置信，必入正文 |
| **正例** | A 源说「这样做对」 | 给学生具体范本 |
| **负例** | B 源说「这样做错」 | 给学生红线避免 |
| **评估维度** | 源中提到的判断标准 | 学生自我检查 + judge 编写参考 |

**提炼要求**：
- 必须用**具体例子**（「这种情况正例 X，负例 Y」），不抽象（bad: 「开头要吸引人」）
- **保留出处**：`（《写作课》§3）` 标注，便于追溯
- **删除冗余**：同一论点多个源 → 合并保留一个最强表述

## 6. 整理落盘（两个去向）

### 6.1 写进 candidate.AGENTS.md（首选）

适用：**身份级 / 跨能力**的方法论（如「这个学生的写作哲学」）。

AGENTS.md 结构（建议段落）：

```markdown
# Student Identity
（学生身份定义）

# Methodology
（核心方法论，从本次学习提炼的共通模式）

# Case Library
## Positive Examples
（正例 + 出处）
## Negative Examples（避免）
（负例 + 出处）

# Self-Check Dimensions
（评估维度，学生可自查）
```

**字数约束**：AGENTS.md ≤ 1500 字（学生在 context window 内运行，超长会失焦 + 挤占业务 token）。

### 6.2 新增 / 修订 skill（次选）

适用：**具体能力包**（如「如何写商品文案」「如何做竞品分析」）——独立成 skill 更易触发 + 维护。

- 新增：用 `skill` 工具 create（注意 `description` 必须清晰，是 L0 catalog 路由依据）
- 修订已有 skill：edit 其 SKILL.md，增加反例 / 维度章节

**判断**：身份级进 AGENTS.md，能力级进 skill。

## 7. slow_update 自评（保留 / 修订 / 新增）

整理完一版后，**强制做一次自评**（borrow from refs/skillopt `slow_update.md`）：

```
1. 相比 base 版本，本次学习改进了什么？（写下来，1–3 条）
2. 哪些地方可能 over-fit？
   - 是否只看了 A 派观点而忽略 B 派？
   - 是否把某专家个人偏好当成通用法则？
   - 是否引用了过时案例？
3. 下一轮（若用户继续训练）该探索什么方向？
```

**自评产物**写入 `turn.reflection`（训练引擎持久化），下一轮反思时可读。

**三态决策**：
- **保留**：base 已有的有效内容，不动
- **修订**：base 有但表述不准/缺例子，改
- **新增**：base 没有的，本次新加

**禁止全盘重写**——base 已积累的有效内容必须保留，增量改进。

## 8. 资源约束与反模式

### 8.1 硬约束

| 项 | 上限 | 理由 |
|---|---|---|
| web_fetch 次数 | 5 | context window 装不下 + 失焦 |
| AGENTS.md 字数 | 1500 | 学生运行时占 token |
| 新增 skill description | ≤ 200 字 | L0 catalog 可读 |

### 8.2 反模式（必须避免）

- ❌ **堆砌源**：抓 10 篇 web_fetch 全文 → 学生 context 爆 + 失焦。**先筛 Top-5**。
- ❌ **抽象口号**：「要创新 / 要专业 / 要吸引人」——没具体例子 = 无效。
- ❌ **覆盖式重写**：把 base AGENTS.md 全删重写——丢失已积累能力。**增量修订**。
- ❌ **不标出处**：把外部知识当自己想的——失去追溯能力，下次迭代没法验证。
- ❌ **学习 ≠ 训练**：学习式不依赖评估结果，不要去读 gradeResults（那是 train-skill 的事）。

## 9. 与训练链路对接

学习完一版后：
1. `manage-task` 工具调 `revise` action 推进一轮 → 引擎跑 sample+grade（若有 dataset/grader），acceptGate 判 improve/regress。
2. simple 模式：candidate 直接采纳（无 dataset/grader），improve 时晋升 baseline + fork 新 candidate。
3. multi 模式：进下一轮评估（若教室有 dataset + grader）；到顶/早停 → task status='paused'+pausedReason。
4. 任意时刻可调 `manage-task adopt(versionId)` 把某 process 版归档为新 formal（旁路，不改 task 状态；可重复）。

**学习式可在 multi 模式每轮都跑**（每轮 directive 可能不同），也可只在第一轮跑（建立 base 后续靠训练式迭代）——看 user 怎么发任务。

## 10. 参考（L2 深度钻取）

- `specs/tech/academy/[P0]academy_skills.md §3`（学习式形态权威）
- `refs/skillopt/prompts/{analyst_success,meta_skill,slow_update}.md`（提炼/自评 prompt 骨架）
- `refs/easy-skill-trainer/docs/iteration-engine-guide.md`（产品化迭代流程）
- `specs/tech/academy/[P0]training_engine.md`（runTurn + acceptGate）
