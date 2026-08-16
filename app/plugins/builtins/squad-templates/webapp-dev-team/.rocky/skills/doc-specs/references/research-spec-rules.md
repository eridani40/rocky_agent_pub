# 调研报告文档规范

## 目录结构

```
${SPECS_DIR}/research/
└── ${SLUG}/            # 每个调研主题一个目录
    ├── overview.md            # 概述 + 策略枚举
    ├── implementation.md      # 核心流程 + Prompt
    ├── comparison.md          # 竞品对比 + 建议
    └── ...                    # 按需拆分更多文件
```

目录名用 kebab-case，与调研主题对应，如 `llm-provider/`、`message-types/`。
单文件仍用 kebab-case 命名，文件名应有语义（不用 part1/part2）。

## 报告模板

```markdown
# {Feature 名称} 调研报告

- **调研范围**: {一句话描述聚焦点}
- **调研对象**: refs/${PROJECT1}, refs/${PROJECT2}
- **调研日期**: YYYY-MM-DD

## 1. 概述

{该 feature 在竞品中的整体实现概况，2-3 段}

## 2. 策略枚举

### 2.1 策略名称 A

- **定义**: 是什么，解决什么问题
- **触发条件**: 在什么条件下启用（阈值、判断逻辑）
- **代码位置**: `refs/${PROJECT}/${FILE}:${LINE}`

### 2.2 策略名称 B

{同上格式}

## 3. 核心流程

### 3.1 {流程名称}

**入口**: `refs/${PROJECT}/${FILE}:${LINE}` — `functionName()`

**数据流**:
1. 输入: {描述输入数据结构}
2. 处理: {关键步骤}
3. 输出: {描述输出}

**调用链**:
\`\`\`
functionA() → functionB() → functionC()
  refs/${FILE}:${LINE}  refs/${FILE}:${LINE}  refs/${FILE}:${LINE}
\`\`\`

**关键算法**:
\`\`\`typescript
// 摘录自 refs/${PROJECT}/${FILE}:${START}-${END}
{关键代码片段，保留原始注释}
\`\`\`

## 4. Prompt 收录

### 4.1 {Prompt 用途}

- **来源**: `refs/${PROJECT}/${FILE}:${LINE}`
- **触发时机**: {什么时候调用}

\`\`\`
{完整 prompt 文本，不可省略}
\`\`\`

## 5. 竞品对比

| 维度 | {Project A} | {Project B} |
|------|-------------|-------------|
| 策略 | ... | ... |
| 触发条件 | ... | ... |
| 优势 | ... | ... |
| 劣势 | ... | ... |

## 6. easy-harness 实现建议

### 推荐方案

{推荐的方案及理由}

### 注意事项

- {坑和边界情况}

### 可复用的设计模式

- {从竞品中可以借鉴的模式}
```

## 质量检查清单

报告提交前必须逐项确认：

- [ ] 每个结论都有 `refs/` 代码引用（文件:行号）
- [ ] 策略枚举完整，每个策略有定义+触发条件
- [ ] 核心流程有完整的入口→出口追踪
- [ ] 涉及 LLM 的 prompt 完整收录，无省略
- [ ] 竞品对比用表格呈现
- [ ] 给出了 easy-harness 的具体实现建议
- [ ] 未超出指定的 feature 调研范围
- [ ] 单文件 ≤ 200 行

## 拆分规则

单文件超过 200 行时按语义拆分到同一目录下的多个文件：

```
${SPECS_DIR}/research/${SLUG}/
├── overview.md           — §1 概述 + §2 策略枚举
├── implementation.md     — §3 核心流程 + §4 Prompt
└── recommendations.md    — §5 竞品对比 + §6 建议
```

每个文件顶部标注：
```markdown
> 本文件是 ${FEATURE} 调研报告的一部分，完整报告见 ${SPECS_DIR}/research/${SLUG}/
```
