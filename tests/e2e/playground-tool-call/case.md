# playground-tool-call — Playground 触发工具调用并看结果

> 纯自然语言 case。executor 照 case + app-guide 操作，每步留证，自由心证。

## Use Case
作为开发者，我想验证 Playground 里 LLM 能根据消息触发工具调用、工具执行、并把结果回到对话——agent loop 全链路冒烟。

## 前置条件
- env.sh 已起好环境。
- app 内已配置至少一个带工具的 plugin/skill（executor 在环境中观察当前可用工具，不预定义工具名）。
- LLM provider 可用（minimax 优先）。

## 操作目标（编号步骤）

1. **进入 Playground**：照 `specs/ui/overall/00-app-guide.md` §3.1，从 nav-rail 点 Playground，落到 chat 页。
2. **建/选会话**：列表选一个已有会话或新建。
3. **发一条能诱导工具调用的消息**：输入诱导性内容（如「现在几点」「帮我算 25 * 18」或类似——具体依环境可用工具选一条诱导性强的），点发送。
4. **观察工具调用卡出现**：等待并观察对话区出现工具调用相关 UI 元素（工具名 / 调用状态 / 结果区域）。
5. **等待工具结果回到对话**：等 LLM 拿到工具结果后给出后续回复（对话区出现新 assistant 消息）。
6. **验收全链路贯通**：用户消息 → 工具调用卡 → 工具结果 → LLM 后续回复，四段都出现。

## 验收口径
- **pass**：全链路四段都出现，工具调用卡 + 结果合理，LLM 后续回复引用了工具结果。
- **small**：主链路走通但某段有小瑕疵（如调用卡视觉小问题、LLM 回复稍微偏题）。
- **blocking**：LLM 未触发任何工具调用（尽管消息明显诱导）/ 工具调用报错 / 结果回不到对话 / 关键 UI 元素缺失。

## 依赖
- specs/ui/overall/00-app-guide.md §3.1
- specs/ui/components/ 对应板块组件 spec
- 环境内可用的 plugin/skill 配置（executor 现场观察，不预定义）
