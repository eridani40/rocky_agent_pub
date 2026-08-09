# playground-input-draft — 会话输入草稿缓存（切走切回恢复 + 发送清除）

> v0.0.267 关键用户路径 case。纯自然语言，零断言零录制零 testid 预定义；executor 读 case.md + app-guide 按 snapshot 文案/位置自选定位方式。
> PRD 源：`specs/prd/version_logs/v0.0.267.input_draft_cache/prd.md` 关键用户路径 UC-1~8。

## Use Case
作为 Rocky 的个人用户，我在 Playground 会话 A 里输入了**一半内容**（含一个 mention pill），还没发送就切到会话 B——切回 A 时草稿应该**完整恢复**（文本 + mention pill 保真，继续编辑不受影响）；把草稿发出去后，再切走切回 A，输入区应**为空**（草稿已清除，不残留已发送内容）。

## 前置条件
- env.sh 已起好环境（headless 或 electron 模式）。
- LLM provider 可用（minimax 优先；429 则按 skipped 口径汇报，不算 fail）。
- 已有或可新建 **2 个会话**（下文称 A / B）。

## 操作目标（编号步骤）

1. **进入 Playground**：照 `specs/ui/overall/00-app-guide.md` §3.1——从 nav-rail 点 Playground 入口，落到 chat 页。
2. **建/选会话 A**：session 列表为空则新建一个（A）；已有则选第一个作为 A。
3. **在 A 输入未发送草稿（含 mention）**：在输入区输入一段纯文本（如「帮我看看」）+ 一个 mention pill——输入 `@` 触发 mention 选择，选一个可 @ 目标（文件 / 成员 / 会话等，取环境里可用的）。**不要发送**。
4. **切到会话 B**：回 sidebar 新建/选择第二个会话 B（此时 A 的草稿未发送）。
5. **切回会话 A**：点 sidebar 里的会话 A。
6. **验收草稿恢复（UC-1~3）**：输入区应显示与第 3 步**原样**的内容——纯文本完整 + mention pill 保真（pill 仍是可辨识的 mention 标签，不是退化成纯文本 `@xxx`）。
7. **发送草稿**：点发送，等待 LLM 回复（草稿内容进入对话）。
8. **验收发送后清除（UC-4）**：切到会话 B → 再切回会话 A → 输入区应为**空**（已发送内容不残留）。

## 验收口径（executor 自由心证）
- **pass**：切回 A 后草稿**完整恢复**（纯文本 + mention pill 保真）；发送后再切走切回，输入区为空（草稿清除）。
- **small**：草稿恢复/清除主链路通，但有轻微视觉/状态瑕疵（如 pill 样式微差、恢复瞬间闪烁，不影响内容完整性）。
- **blocking**：草稿丢失（切回 A 输入区为空）/ mention pill 退化或丢失 / 发送后草稿仍残留（切回 A 又看到已发送内容）/ 输入区无法编辑。

## 依赖
- specs/ui/overall/00-app-guide.md §3.1（Playground 路径 + 「聊天输入草稿缓存（v0.0.267）」段）
- specs/ui/components/chat-page/chat-composer.md（输入区契约 / 输入草稿缓存节）
