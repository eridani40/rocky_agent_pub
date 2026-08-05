# playground-session-switch — Playground 多会话上下文隔离

> 纯自然语言 case。executor 照 case + app-guide 操作，每步留证，自由心证。

## Use Case
作为用户，我想验证在多个会话之间切换时，各会话上下文互不串——会话隔离基础冒烟。

## 前置条件
- env.sh 已起好环境。
- LLM provider 可用（minimax 优先）。

## 操作目标（编号步骤）

1. **进入 Playground**：照 `specs/ui/overall/00-app-guide.md` §3.1，点 Playground 入口。
2. **建会话 A**：新建一个会话（可在 sidebar 看到会话列表），命名为「会话 A」或类似可识别名字。
3. **在会话 A 中植入上下文**：发「我喜欢蓝色的苹果」。等待 LLM 回复。
4. **建会话 B**：回 sidebar 新建第二个会话，命名为「会话 B」。
5. **在会话 B 中植入不同上下文**：发「我喜欢红色的香蕉」。等待 LLM 回复。
6. **切回会话 A**：点 sidebar 里的会话 A。
7. **在会话 A 中验证隔离**：发「我喜欢的颜色和水果分别是什么？」。等待回复。
8. **验收隔离**：第 7 步的回复应包含「蓝色 / 苹果」，不含「红色 / 香蕉」（即 A 的上下文未串到 B）。

## 验收口径
- **pass**：会话 A 的回复正确引用了 A 的上下文（蓝色/苹果），且未引用 B 的（红色/香蕉），切换无串扰。
- **small**：主链路走通但切换有轻微视觉/状态瑕疵（不影响隔离正确性）。
- **blocking**：会话上下文串扰（A 里看到 B 的内容）/ 切换失败 / 会话建不出来 / 关键 UI 缺失。

## 依赖
- specs/ui/overall/00-app-guide.md §3.1
- specs/ui/components/ 对应板块组件 spec
