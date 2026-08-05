# playground-interrupt-queue-inject — 运行中 ESC 中断 + 排队内容注入输入区（保留 mention pill）

> 纯自然语言 case（v0.0.188 ET 范式）。executor 读 case.md + `specs/ui/overall/00-app-guide.md` 按
> snapshot 文案/位置自选定位方式；零断言零录制；留证 4 件套 + 自由心证 pass/small/blocking。
> 覆盖 PRD 路径 P-A（ESC 中断）+ P-B（排队注入保留 pill）+ P-E（@ popover 优先只关 popover 不中断）。

## Use Case
作为 Rocky 的个人用户，我想在 Playground 里 run 进行中按 ESC 中断当前 run——同时已排队的消息自动取消并
按「消息1\n消息2\n」拼到输入区开头（保留 mention pill），后接输入区原内容；以及验证 @ popover 打开时 ESC 只关
popover 不中断 run——中断体验的核心交互闭环。

## 前置条件
- env.sh 已起好环境（headless 或 electron 模式）。
- LLM provider 可用（minimax 优先；executor 看 app 内可用 provider 选）。
- **长生成窗口约束**：触发 run 的首条 prompt 须请求长生成（如「请详细写一篇 800 字以上的文章，分多个小节，
  每节展开」），否则 run 过快结束，来不及在 running 中 enqueue + ESC + 观察。

## 操作目标（编号步骤）

1. **进入 Playground**：照 `specs/ui/overall/00-app-guide.md` §3.1——从 nav-rail 点 Playground 入口，落到 chat 页。
2. **建会话或选已有会话**：若 session 列表为空则新建一个；若已有则选第一个。
3. **发一条长生成 prompt 起 run**：在输入区输入一条请求长生成的 prompt（如「请详细写一篇 800 字以上的文章
   介绍人工智能的发展历史，分多个小节，每节展开细节」），点发送（或按 Enter）。run 进入 running 态，
   对话区出现流式 assistant 回复（在生成中）。
4. **run 中发 2 条消息进排队区**：趁 run 还在 running（assistant 还在流式输出），在输入区连发两条短消息（如
   「排队消息1」「排队消息2」），每条点发送。排队区（enqueue-view）出现 2 项排队（标「队列中」/「移出队列」按钮）。
5. **触发 @ mention popover**：在输入区输入「@」字符，触发 mention popover 浮层（候选 file/skill/workitem/
   member 等列表弹出）。
6. **按 ESC 验证 P-E（只关 popover 不中断）**：按一次 ESC 键——验证**仅 popover 关闭**，run 仍在 running
   （对话区流式回复继续）、排队区 2 项排队仍在、输入区内容不动。**此步不应触发中断**。
7. **再按 ESC 触发中断动作（P-A + P-B）**：确认 popover 已关 + 焦点在输入区，再按一次 ESC——验证中断动作触发：
   - **排队项全部消失**：排队区 2 项排队被清空（逐条 cancel + SSE 移项）；
   - **输入区开头注入**：输入区开头出现「排队消息1\n排队消息2\n」+ 步骤 5 剩余的输入区原内容续后；
   - **run 转 interrupted**：对话区停止流式输出，run 进入 interrupted 态（红色中断钮消失或转回发送钮）。
8. **（可选）若排队内容含 mention**：如某条排队内容里嵌了 `<mention .../>`（例如「看 @helper.ts 这个文件」），
   验证注入后输入区里 mention 显示为 pill（@helper.ts 带 icon），不是字面 `<mention .../>` tag 文本。

## 验收口径（executor 自由心证）
- **pass**：步骤 6 ESC 只关 popover（run 不中断、排队仍在、输入区不动）；步骤 7 再 ESC 触发中断动作（排队清空 +
  输入区开头注入「排队消息1\n排队消息2\n」+ 原内容续后 + run interrupted）；mention（若有）显 pill 非字面 tag。
  主交互闭环完整。
- **small**：主路径走通但有瑕疵（如注入内容换行符显示微差、popover 关闭动画小卡顿、文案细微差异），不阻塞合并。
- **blocking**：① 步骤 6 ESC 误中断 run（popover 开时不该中断却中断了）；② 步骤 7 ESC 无反应（焦点在输入区 +
  running 却不触发中断）；③ 排队项未清空 / 输入区未注入 / run 未 interrupted；④ 注入内容 mention 显示成字面
  `<mention .../>` tag 文本（pill 丢失）；⑤ 关键元素找不到 / 操作报错。

## 兜底（用户裁决）
若 ET timing 不可靠（run 过快结束无法在 running 窗口内完成 enqueue + ESC + 观察）且归因到环境/timing 而非实现
bug → 转用户手测（不硬磕）。实现 bug（如焦点门控判定错、注入 pill 丢失）则退 coder 修。

## 依赖
- specs/ui/overall/00-app-guide.md §3.1（Playground 路径）
- specs/ui/components/chat-page/_overview.md §5.3（abort 中断链路）/ §4.11a（enqueue 排队区）
- specs/ui/components/chat-page/chat-composer.md（输入区契约：@ popover / ESC / mention）
- specs/prd/version_logs/v0.0.245.interrupt_exp/prd.md §3.1（焦点门控）/ §3.2（统一中断动作）/ §3.3（焦点管理）
