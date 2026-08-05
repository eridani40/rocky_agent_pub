# playground-ws-md-editor — workspace 点 .md 用内置 viewer/editor 打开

> 纯自然语言 case（v0.0.188 范式）；PRD「关键用户路径」UC-227-OPEN / EDIT-SAVE / PERSIST / REG 的 E2E 主链路冒烟。
> executor 读 case.md + `specs/ui/overall/00-app-guide.md` §3.1，按 snapshot 文案/位置自选定位方式。

## Use Case
作为用户，我想在 chat 页 workspace 面板点一个 `.md` 文件，直接在 app 内弹出 markdown 查看/编辑器（而不是跳出 app 用外部编辑器），能查看、编辑、保存——和 academy 里点版本 AGENTS.md 是同一个体验。

## 前置条件
- env.sh 已起好环境（headless 或 electron）。
- 当前 session 的 workspace 里有可测的 `.md` 文件。若无：executor 可先在输入区发消息让 agent 建一个 `notes.md`（内容随便，几行 markdown 即可），或在文件树里找一个已存在的 `.md`（如 README）。
- workspace 面板可见（chat 页右侧第 3 栏；若收起则点展开 chevron）。

## 操作目标（编号步骤）

1. **进入 chat 页 + 选会话**：照 `00-app-guide.md` §3.1 从 nav-rail 进 Playground/chat 页，建或选一个会话。
2. **展开 workspace 面板**：确认右侧 workspace 文件树可见。
3. **准备/定位一个 .md 文件**：在文件树找一个 `.md`（如 `notes.md` / `README.md`）；没有则先让 agent 建一个。
4. **点 .md 文件 → 验证内置 editor 弹出**：点击后 app 内弹出一个 md editor modal（**不是**跳出 app 用外部编辑器打开），默认「👁 查看」模式，body 渲染该 markdown 内容（标题/列表/代码块等可见）。modal 头部显示文件名 + 相对路径副标题。
5. **切编辑 + 改内容 + 保存**：点「✏️ 编辑」→ body 切成 textarea → 改一段文本（如加一行「E2E 测试修改」）→ 点「保存」→ 验证出现「已保存」toast 反馈。
6. **关闭 + 重开验证持久化**：关闭 modal → 再次点同一个 .md → 验证查看模式显示刚才保存的新内容（非旧内容、非空）。
7. **回归（非 .md）**：点一个非 `.md` 文件（`.png` / `.json` / `.txt` 等）→ 验证**不弹**内置 editor（仍走原系统打开行为，不弹 modal）。

## 验收口径（executor 自由心证）
- **pass**：点 `.md` 弹内置 editor（非外部应用）→ 查看/编辑/保存全通 → toast 反馈 → 重开见新内容；非 `.md` 不弹 editor。主链路贯通。
- **small**：主链路通但有视觉/文案小瑕疵（如副标题格式、toast 位置微差），不影响功能。
- **blocking**：点 `.md` 不弹 editor / 弹了外部应用 / editor 弹了但内容不渲染 / 保存无反馈或报错 / 重开内容丢失（未持久化）/ 非 `.md` 文件误弹 editor / 关键元素找不到。

## 依赖
- `specs/ui/overall/00-app-guide.md` §3.1（chat/playground + workspace 面板）
- `specs/ui/components/chat-page/component-workspace-panel.md`（文件树点击）
- `specs/ui/components/academy-page/component-modal-md-editor.md`（editor 可见文案：👁 查看 / ✏️ 编辑 / 保存 / 关闭）
