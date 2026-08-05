---
type: reference
title: 全局约定 (Convention)
priority: P0
updated: 2026-06-30
---

# 全局约定 (Convention)

## 1. 语言与格式

- 所有接口定义使用 **TypeScript**
- 数据序列化使用 **JSON**
- 文档语言：中文

## 2. 命名规范

| 类别 | 风格 | 示例 |
|------|------|------|
| 接口 / 类型 | PascalCase | `Message`, `ContentBlock`, `ToolCallBlock` |
| 字段 / 变量 | camelCase | `toolCallId`, `isError`, `createdAt` |
| 常量 / 枚举值 | snake_case（字符串字面量） | `"tool_call"`, `"tool_result"` |
| 文件名 | snake_case.md | `[P0]agent_message_interface.md` |

> **注意**：type 字符串字面量用 snake_case（与 OpenAI/Anthropic API 一致），TS 字段名用 camelCase。

## 3. ID 体系

- 所有 ID 统一使用 **ULID**（Universally Unique Lexicographically Sortable Identifier）
- 示例：`01KVCA58G80Y54TTF2S8ZPFR5M`
- 优点：时间有序、全大写、26 字符、无需中心化分配
- 框架自动生成的 ID 均使用 ULID
- LLM 返回的 ID（如 tool_call_id）保留原值，不强制转换

## 4. 时间格式

- 所有时间字段使用 **ISO 8601 UTC**
- 示例：`2026-06-18T02:07:31.601Z`

## 5. 货币

- 货币类型：

```typescript
type Currency = "USD" | "CNY";
```

- `cost` 字段类型为 `number`，保留足够精度（不四舍五入）
- `cost` 的币种由配套 `currency` 字段（`Currency`）声明，不假定固定币种
- `currency` 来源：跟随 `model.pricing.currency`（见 `agent/providers_and_models/[P0]llm_model_interface.md`）
- 需要统一币种汇总时，由上层按汇率折算，不在字段层强制

## 6. 可选字段

- 使用 TypeScript `?` 标记可选字段
- 可选字段缺失时默认值为 `undefined`，不使用 `null`

## 7. 版本化

- 不修改已有版本，新版本创建新文件或新目录
- 文件内标注版本号：`version: 1.0`
