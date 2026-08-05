# playground-send-message — Playground 发消息收到回复

> 这是 **case.md 样例模板**（后续版本 PRD「关键用户路径」照此写 case——PRD 路径 = E2E case 源，用户裁决）。
> 纯自然语言，零断言零录制；executor 读 case.md + app-guide 按 snapshot 文案/位置自选定位方式。

## Use Case
作为 Rocky 的个人用户，我想在 Playground 里发一条简单消息，验证能收到 LLM 的纯文本回复——主链路贯通的最小冒烟。

## 前置条件
- env.sh 已起好环境（headless 或 electron 模式）。
- LLM provider 可用（minimax 优先；executor 看 app 内可用 provider 选）。

## 操作目标（编号步骤）

1. **进入 Playground**：照 `specs/ui/overall/00-app-guide.md` §3.1——从 nav-rail 点 Playground 入口，落到 chat 页。
2. **建会话或选已有会话**：若 session 列表为空则新建一个；若已有则选第一个。
3. **发一条简单消息**：在输入区输入「你好」（或类似的简单问候），点发送。
4. **等待并验收 LLM 回复**：观察对话区出现一条 assistant 回复（非空、不是错误提示）。
5. **（可选）再发一条确认多轮**：发第二条简单消息（如「1+1 等于几」），验收到回复。

## 验收口径（executor 自由心证）
- **pass**：发出消息后能收到合理的 LLM 回复，对话区显示完整；主链路贯通。
- **small**：能收到回复但有视觉/文案小瑕疵（不影响主路径）。
- **blocking**：发不出去 / 发出后一直 thinking / 回复报错 / 关键元素找不到。

## 依赖
- specs/ui/overall/00-app-guide.md §3.1（Playground 路径）
- specs/ui/components/ 对应板块组件 spec（含可见文案，executor 按文案/位置自选定位方式）
