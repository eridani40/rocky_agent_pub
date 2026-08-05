---
type: reference
title: 文档撰写指南 (Docs Guide)
priority: P0
updated: 2026-06-30
---

# 文档撰写指南 (Docs Guide)

> 本文件说明**如何写这个项目的文档**，是"文档的文档"。
> 格式约定（命名 / ID / 时间 / 货币）见 [`convention.md`](convention.md)，本文件不重复。

---

## 1. 文档分层

| 层级 | 形态 | 职责 | 例子 |
|------|------|------|------|
| Module（模块） | 一个目录 | 一个子系统的全部设计 | `agent/providers_and_models/` |
| Spec（规范） | 一个 `.md` 文件 | 一份接口契约 | `[P0]llm_protocol_interface.md` |
| Decision Record（决策记录） | spec 内的"设计决策"章节 | 记录"为什么这么定"，避免后人推翻又踩坑 | 见 §3.4 |

> 目录是模块边界，文件是契约边界。**一个文件只定义一组内聚的契约**，不要把多个正交概念塞进同一文件。

---

## 2. 一份 Spec 文件必备章节

每份接口 spec 至少包含以下章节（按需增减，但顺序固定）：

```markdown
# <接口名> (<English Name>)

## 1. 概述
一句话说清这份文件管什么、不管什么。

## 2. 接口定义
TypeScript 类型 + 字段说明表。

## 3. 设计决策
逐条记录关键决策 + 理由（见 §3.4）。

## 4. 示例
最小可读的 JSON 示例（精简，不省略关键字段）。

## 5. 边界
本接口与相邻模块的职责切分，引用归属规则（见 §4）。

## 6. 版本
version: 1.0
```

---

## 3. 写什么 vs 不写什么

### 3.1 写

- **契约**：接口签名、字段类型、取值约束、状态机
- **边界**：谁管什么、跟谁衔接
- **决策理由**：为什么这么定，尤其在有多种合理选择时
- **最小示例**：能让读者独立读懂的精简 JSON / TS

### 3.2 不写

- 实现细节（函数体、算法步骤）—— 那是代码的事
- 伪代码只在"表达接口契约/调用拼装"时用，**单段不超过 50 行**；一旦超出，说明你在写实现而非契约，应拆成多张示意图或交给代码
- agent 运行日志、调试输出
- 与本契约无关的跨模块实现

### 3.3 示例约束

- JSON 示例**不得用 `...` 省略关键字段**（可省略与当前点无关的数组元素，但被讨论的字段必须完整）
- ID 用 ULID 真实格式（见 `convention.md` §3）
- 时间用 ISO 8601 UTC

### 3.4 决策记录写法

每条决策三段式：**结论 → 理由 → 反例**。

```markdown
**auth header 归 provider，不归 protocol。**
理由：同一 protocol（OpenAI Chat Completions）在 OpenAI 直连用 Bearer、在 Bedrock 用 SigV4、在 Vertex 用 OAuth——protocol 相同而 auth 不同，故 auth 跟着 provider 走。
反例：若 auth 归 protocol，则 OpenAI 兼容端点跑在不同 provider 上要重复定义多个 protocol，失去复用价值。
```

### 3.5 逻辑说明优先用示意

说明流程、循环、状态流转、时序等"动态逻辑"时，**首选 ASCII 示意图，而非大段伪代码**。伪代码适合"静态契约"（类型/调用拼装），示意图适合"动态行为"。两者分工：

| 要表达的 | 优先用 | 例子 |
|---------|--------|------|
| 类型 / 字段 / 接口签名 | TypeScript 类型 + 表格 | §2、§4.3 |
| 一次调用的零件拼装 | 短伪代码（≤ 50 行） | §4.3 `call_llm` |
| 循环 / 阶段流转 / 时序 / 状态机 | ASCII 示意图 | 见 `[P0]agent_loop_eager_drain.md` §4、§7 |

**示意图写法要点**（参照 `agent/agent_interface_and_loop/[P0]agent_loop_eager_drain.md`）：

1. **流向用箭头 + 缩进表达层次**，主干 `│ ▼ └─→`，分支 `├─`。读者扫一眼就知道"先做什么、再做什么、什么时候循环"。
2. **阶段用编号 + 小标题**（如 `① 前置处理`、`② LLM 请求`），让正文能用"见 §4 ②"精确指代。
3. **每一步写"做什么 + 关键副作用"，不写"怎么做"**：写 `contextEngine.ingest(newMessages) → 推进 ingestUpTo`，不写 ingest 内部如何存盘。
4. **准入/退出条件单列**，不要埋在箭头里：`（准入条件：ingestUpTo != llmUpTo）`、`退出判定：max_iterations？doom_loop？`。
5. **不变量用一句话点出**：如 "`llmUpTo` 始终 ≤ `ingestUpTo`"。
6. **变体另起小节，复用骨架**：同一循环的多个分支（正常 / 触发审批 / 处理审批结果）不重复画完整骨架，只画差异，其余 `...（略）`。

> 反例（绝对禁止）：把循环逻辑写成 80 行带 `for/while/if` 的伪代码。那是实现，不是契约——改用流向图，每个阶段一行，全部 50 行以内。


---

## 4. 边界归属规则（通用）

当一个概念横跨多个文件时，按"零件唯一归属"原则切分：**请求 / 对象的每个组成部分只归一个文件**，不重叠。

### 4.1 规则总表

| 零件 | 归属 | 判定依据 |
|------|------|---------|
| URL base | provider | 跟着接入点走 |
| URL path | protocol | 跟着接口走 |
| auth header | provider | protocol 相同而 auth 不同（OpenAI/Bedrock/Vertex） |
| content-type / accept header | protocol | 请求 schema 的一部分 |
| request body + 参数字段名 | protocol | 接口契约 |
| 多模态输入/输出**编码** | protocol | 怎么放进请求 |
| 多模态/能力**支持与否** | model | 这个模型能不能做 |
| timeout / retry / rate-limit / proxy | provider | 传输策略 |
| 参数字段**存在性** | protocol | 接口暴露哪些开关 |
| 参数**默认值/取值范围/上限** | model | 这个模型的约束 |
| 定价、context window、max output | model | 模型固有属性 |

### 4.2 拆分范式

当一个属性同时被两个文件"碰"到，套用以下范式之一：

- **字段 vs 数值**：字段名/存在性 → protocol；具体数值/范围 → model。
  - 例：`temperature` 字段归 protocol，sonnet-4.6 的默认 1.0、范围 0–1 归 model。
- **编码 vs 能力**：编码方式 → protocol；是否支持 → model。
  - 例：图片在 body 里的 block 格式归 protocol；该模型是否吃图归 model。
- **base vs path**：base → provider；path → protocol。
  - 例：`https://api.anthropic.com` 归 provider，`/v1/messages` 归 protocol。

### 4.3 调用拼装示意

归属规则最终服务于一次调用，每个零件来源唯一：

```typescript
call_llm(provider, protocol, model, request): Response {
  const url     = provider.baseUrl + protocol.path;   // base | path
  const headers = {
    ...provider.authHeader(),      // auth
    ...protocol.contentHeaders(),  // content-type
  };
  const body    = protocol.encode(request, model);    // body + 参数 + 多模态编码
  const policy  = provider.transportPolicy();         // timeout/retry
  return protocol.parse(http(url, headers, body, policy));
}
```

---

## 5. 交叉引用规范

- 引用同仓库文件：`见 [\[P0\]agent_message_interface.md](agent/message/[P0]agent_message_interface.md) §2`
- 引用本文件内章节：`见 §4.2`
- 引用 `convention.md`：`见 convention.md §3`（命名/ID/时间/货币等格式约定一律引用，不在本文件复述）

---

## 6. 模块自检清单

写完一份 spec，对照确认：

- [ ] 概述说清了"管什么 / 不管什么"
- [ ] 每个跨模块零件都有唯一归属（查 §4.1）
- [ ] 关键决策有"理由 + 反例"
- [ ] 伪代码单段 ≤ 50 行，超出已拆成示意图
- [ ] 动态逻辑（循环/时序/状态机）用 ASCII 示意图而非大段伪代码（见 §3.5）
- [ ] JSON 示例无 `...` 省略关键字段
- [ ] ID / 时间 / 货币符合 `convention.md`
- [ ] 标注 `version`

---

## 7. 版本

version: 1.0
