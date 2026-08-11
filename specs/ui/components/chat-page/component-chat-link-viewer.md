# component-chat-link-viewer（chat 链接 viewer 挂载层 — **已退役 v0.0.320**）

> 状态: **DEPRECATED / 已删除**（v0.0.320 D13 弹层退役）
> 代码: `app/web/src/components/chat-page/component-chat-link-viewer.tsx`（v0.0.320 已删除，-223 行）
> 替代: 预览区 tab（`section-preview-area.md`）——chat 链接 12 格式本地文件 → `openLocalPath` → `preview.openTab`（有 Provider）/ 系统打开（无 Provider 降级）
> 历史: v0.0.253 引入（强制只读）→ v0.0.280 覆盖（可编辑 + image/.url/absolute 分流）→ v0.0.320 退役

## 退役原因（v0.0.320）

预览区（三栏布局中间栏）取代 chat 场景弹层：chat markdown 链接点击与 workspace 文件树点文件统一进预览区开 tab（多 tab 横滑 + 内嵌查看/编辑 + dirty 守卫 + 409 冲突检测）。弹层一次只能看一个文件、多文件对比/切换体验差；文件树打开与聊天链接打开是两套挂载、交互割裂——老板拍板弹层退役（chat 场景）。

## 迁移后行为（现状）

- **chat 链接 12 格式本地文件**（`[文本](target)` 点击）→ `openLocalPath` 共享分发（v0.0.280 lib）→ `onEditor` 回调 → **有 Provider**（playground / studio 单聊·群聊）→ `preview.openTab`（预览区开 tab，含编辑/保存/冲突检测）；**无 Provider**（academy 版本会话等）→ 系统打开降级（`openWorkspaceItem` / `openPath`）。
- **image 6 格式** → `component-ws-image-viewer` 弹层保留（v0.0.269 语义，图片不进预览区）。
- **`.url` 远程链接** → 浏览器打开（嗅探失败降级 txt editor，`component-ws-file-editor-fallback`）。
- **Context 保留**：`ChatLinkHandlerProvider` / `useChatLinkHandler` 迁移至 `chat-link-handler-context.ts`（纯 TS 独立文件，createElement 断循环依赖）；value 注入 `onLocalViewer` + `sessionId`；无 Provider 返 null → 链接走默认 web/local 系统打开。

## 消费方更新（v0.0.320）

| 原消费方 | 现状 |
|----------|------|
| `component-message-stream.tsx` | 删 ComponentChatLinkViewer 挂载；`ChatLinkHandlerProvider` 包裹 + `onLocalViewer` → openLocalPath → preview.openTab（有 Provider）/ 系统打开（无 Provider） |
| `section-workspace-panel.tsx` | onEditor → preview.openTab（有 Provider）/ fallback 弹层（无 Provider） |

## 相关 spec 指针

- 预览区全貌：`specs/ui/components/chat-page/section-preview-area.md`
- workspace 文件点击分流：`specs/ui/components/chat-page/component-workspace-panel.md §4.4`
- 共享分发 lib：`specs/tech/app/frontend/index.md`（v0.0.280 openLocalPath 概念行）
- 技术权威：`specs/tech/version_logs/v0.0.320/change_plan.md`（D12/D13）+ `change_log.md`
