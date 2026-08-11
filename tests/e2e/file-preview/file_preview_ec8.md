# ET case: chat 链接点文件 → 预览区开 tab（弹层退役）

> case_id: file_preview_ec8
> 来源: PRD §6 EC-8（UC-2 覆盖）+ test-plan §4 EC-8
> 前置: v0.0.320 弹层退役已编码完成（Task 2 D12/D13），dev 环境已启动

## 前置条件
- dev app 已启动，进入有 workspace 的 chat 页（playground 或 studio 单聊）
- 会话中有一条含文件链接的聊天消息（如 agent 回复 `[config](config.json)` 或 `[guide](docs/guide.md)`）
- workspace 目录内有链接指向的文件（如 `config.json`、`docs/guide.md`）
- 若无现成链接消息：可发送一条包含 markdown 文件链接的消息（或由 agent 生成）

## 操作目标

1. 聊天消息中找到文件链接（markdown 格式 `[文本](相对路径)`，如 `[config](config.json)`）
2. 点该链接 → 断言：
   - **不再弹出弹层 modal**（component-chat-link-viewer 已退役删除）
   - 预览区新建 tab「config.json」（view 模式显示内容）
3. 再点同一文件链接 → 断言激活已有 tab（不重复新建）
4. 点另一个文件链接（如 `[guide](docs/guide.md)`）→ 预览区新建第二个 tab「guide.md」
5. 截图留证：链接消息 + 点链接后预览区开 tab（无弹层）+ 重复点激活已有 tab + 第二个文件新 tab

## 判定
- pass: chat 链接点文件 → 预览区开 tab（无弹层），重复点激活已有 tab，多链接多 tab 正常
- small: 开 tab 正常但有视觉/交互小瑕疵
- blocking: 点链接仍弹旧弹层 / 不开 tab / 重复点重复新建 tab

## 备注
- chat 链接分发走 openLocalPath 五路分流（D12）：`onLocalViewer` 语义改 → `openLocalPath(target, { onEditor: preview.openTab, ... })`
- 弹层退役：`component-ws-file-editor.tsx` + `component-chat-link-viewer.tsx` 已删除（D13）；`component-modal-md-editor` 保留（academy 场景仍用）
- 无 PreviewAreaProvider（academy/studio 部分场景）→ 降级弹层（兼容代码，非死代码）——本 case 在 chat-page（有 Provider）验证主路径
- 同 path 已存在 → 激活该 tab；不存在 → 新建并激活（D4 openTab 语义）
