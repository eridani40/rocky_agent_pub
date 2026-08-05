# playground-multi-turn — Playground 多轮对话上下文保持

> 纯自然语言 case。executor 照 case + app-guide 操作，每步留证，自由心证。

## Use Case
作为用户，我想验证在同一会话多轮对话中，LLM 能记住前面说过的上下文——上下文管理基础冒烟。

## 前置条件
- env.sh 已起好环境。
- LLM provider 可用（minimax 优先）。

## 操作目标（编号步骤）

1. **进入 Playground**：照 `specs/ui/overall/00-app-guide.md` §3.1，点 Playground 入口。
2. **建/选会话**：新建一个会话（避免历史消息干扰）。
3. **第 1 轮 — 植入上下文**：发一条消息告诉 LLM 一个事实，如「我叫 Alice，我住在北京」。等待回复确认 LLM 收到。
4. **第 2 轮 — 问相关信息**：在同一会话发「我叫什么名字？」。等待回复。
5. **第 3 轮 — 问另一相关信息**：发「我住在哪里？」。等待回复。
6. **验收上下文保持**：第 2 轮回复应包含「Alice」，第 3 轮回复应包含「北京」。

## 验收口径
- **pass**：3 轮都能收到回复，且第 2/3 轮回复正确引用了第 1 轮植入的上下文。
- **small**：主链路走通但 LLM 回复略有跑题或上下文部分丢失（不影响链路通）。
- **blocking**：LLM 完全不记上下文（答「不知道」）/ 多轮发送失败 / 关键 UI 缺失。

## 依赖
- specs/ui/overall/00-app-guide.md §3.1
- specs/ui/components/ 对应板块组件 spec
