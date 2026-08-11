# component-skill-drop-zone

> 层级: component
> 文件: app/web/src/components/skill-page/component-skill-drop-zone.tsx

## 职责
Skill 安装区。支持两种输入：(1) 拖拽（dragover/drop，含文件夹 via `webkitGetAsEntry`）；(2) 点击 → 选择文件 / 选择文件夹两个按钮（hidden `<input type=file>` + `webkitdirectory`）。收集到 file/folder/zip 后，**上传到后端安装 API**（后端解压持久化 + 解析 SKILL.md frontmatter），**不在前端解压**（不照搬设计稿的 JSZip mock）。
边界：只管收集 + 上传触发；解压/解析/持久化在后端。上传中可显示 loading 态（可选，v0.0.21 最小实现可不显）。
## Props
- onInstall: (payload: { kind: 'files' | 'folder' | 'zip'; files: File[] }) => ...
- uploading?: boolean;   // 可选：上传中禁用 + 提示

## 状态 / 交互
- ：dragover 期间高亮（边框 accent + 浅底 + 4px accent-light 阴影圈）
- drop → preventDefault + 判断是文件夹（`webkitGetAsEntry.isDirectory`）还是文件 → `onInstall({kind, files})`；dragleave 重置 dragOver
- input 用完即清空 `e.target.value = ''`（允许重复选同名）

## 复用关系
- 被组合：`page-skill`（[v0.0.198] 起被包成**弹层条件渲染**——`{installExpanded && <div className="relative mb-[22px]"><DropZone/><×按钮/></div>}`；组件内部实现不变，外层加 relative div + 右上角 × 按钮收起；展开/收起用条件渲染而非 display:none，收起态彻底卸载包括内部 file input ref）
- 组合：无（图标内联 SVG `upload`/`file`/`folder`）

## 视觉基线
来源行段：`.drop-zone` :85-87、`.drop-icon` :88-89、`.drop-title/.drop-sub` :90-91、`.drop-actions` :92；`.btn-secondary` :58-59；DOM :425-438。
- **font**：标题 `.drop-title` 14px/600 `var(--fg)`；sub `.drop-sub` 11px `JetBrains Mono` `var(--muted)`；按钮 12px/600（`.btn` 通用）。
- **color**：默认底 `var(--surface-2)`；hover/dragOver 底 `var(--accent-surface)`；图标默认 `var(--bg-warm)` 底 + `var(--muted-2)` 字，hover/dragOver → `var(--accent-light)` 底 + `var(--accent)` 字。按钮文字 `var(--fg-3)` → hover `var(--accent)`。
- **双主题**：全 token，dash/border-strong/阴影圈 token 在 light/dark 都有定义（:16,:24），无需特判。

## 消费方
- `app/web/src/components/skill-page/page-skill.tsx`
