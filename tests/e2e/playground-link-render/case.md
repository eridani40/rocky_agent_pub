# playground-link-render — 聊天区 markdown 链接渲染 + 点击分发

> 纯自然语言 case（v0.0.188 范式）；executor 读 case.md + app-guide 按 snapshot 文案/位置自选定位方式。
> PRD 关键用户路径来源：`specs/prd/version_logs/v0.0.253.md` §4 UC-A/B/C（http→浏览器 / .md→内置只读 viewer / 图片→系统应用）。

## Use Case
作为 Rocky 个人用户，我希望在 Playground 里收到 agent 的 markdown 链接回复后，点链接能按类型正确打开——web 链接走系统浏览器、本地 .md 文件弹内置只读 viewer、本地图片走系统默认应用，而不是点击无反应或开成 Electron 窗口。

## 前置条件
- env.sh 已起好环境（headless 或 electron 模式）。
- LLM provider 可用（minimax 优先；executor 看 app 内可用 provider 选）。
- Playground 已建/选一个会话；**workspace 预置一个 `.md` 文件**（如 `notes.md`，env seed 或 executor 手动创建）：用于 UC-B 点 .md 链接 → 内置 viewer。

## 操作目标（编号步骤）

1. **进入 Playground 会话**：照 `specs/ui/overall/00-app-guide.md` §3.1——从 nav-rail 点 Playground 入口 → 选/建会话 → 落到 chat 区。
2. **引导 agent 输出 markdown 链接**：在输入区发类似消息：「给我几个有用的链接，包括网页 URL 和 workspace 里的 notes.md 文件，用 markdown 链接格式回复」。依赖新 rules.md bullet（v0.0.253），LLM 应输出 `[文本](路径)` 链接。
   - 若 LLM 未稳定输出链接：重试 1-2 次，或 executor 心证记 small（prompt bullet 效力），**非 blocking**。
3. **UC-A：点 http/https 链接** → 在 agent 回复气泡里找到一个 web URL 链接（`[文档](https://...)`），点击它。
   - **心证**：app 内不导航（地址栏无变化、无页面跳转）、不开新 Electron 窗口、不报错。**外部浏览器是否真打开**由人验收（外部应用 playwright 不可观测）。
4. **UC-B：点 .md 文件链接 → 内置只读 viewer** → 找一个指向 `notes.md`（或 workspace 内其它 .md 文件）的链接，点击它。
   - **验证**：app 内弹出 viewer modal（文件名头 + 内容区），内容区显示 .md 文件内容（markdown 渲染或 `<pre>` 文本）。
   - **验证只读**：modal 内**无 mode-toggle（👁 查看 / ✏️ 编辑 二段开关）**、**无「保存」按钮**、**无「格式化」「校验」按钮**（强制只读，区别于 workspace 面板打开文件的 edit 能力）。
   - **关闭**：点 ✕ 或 ESC 关 modal，回到 chat 区。
5. **UC-C：点图片链接（若 agent 输出 / workspace 有图片）** → 若 agent 给出图片链接（`[截图](./images/x.png)` 或绝对路径），点击它。
   - **心证**：不报错、app 不导航（外部系统图片应用是否真打开不可观测）。
   - 若本 case 无图片链接可用：跳过此步，记 small，**非 blocking**。

## 验收口径（executor 自由心证）
- **pass**：UC-B 主路径走通（点 .md 链接 → 内置只读 viewer modal 弹出 + 显示内容 + 无编辑/保存按钮）；UC-A 点 web 链接 app 内不导航不报错；UC-C 不报错（图片真打开由人验收）。
- **small**：链接渲染 + 点击路由通，但 LLM 未稳定输出链接（需重试或手动造链接）/ UC-C 无图片链接可测 / 视觉小瑕疵（不影响主路径）。
- **blocking**：
  - agent 回复里的链接**不渲染为可点击 `<a>`**（仍纯文本）
  - 点 .md 链接**不弹 viewer modal** / 弹出但有「保存/编辑」按钮（破坏只读不变量）
  - 点 web 链接**导致 app 内导航或新开 Electron 窗口**（兜底拦截失效）
  - 点击报错 / modal 内容空 / 关键 testid / 文案找不到

## 依赖
- `specs/ui/overall/00-app-guide.md` §3.1（Playground 路径）+ §3.1 workspace 面板（点文件分流）
- `specs/ui/components/chat-page/component-chat-link-viewer.md`（viewer 契约 + 可见文案）
- `specs/ui/components/common/component-modal-md-editor.md`（readOnly 模式：无 mode-toggle / 无保存按钮）
