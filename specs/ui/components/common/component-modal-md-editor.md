# component-modal-md-editor（通用文件 viewer/editor 弹层）

> 层级: component（common/，跨页共享）
> 文件: app/web/src/components/common/component-modal-md-editor.tsx
> 消费方：academy 版本内容编辑（`component-academy-modals.tsx` 挂载，不传 format → 缺省 'md' 行为不变）+ workspace 文件查看/编辑（`chat-page/component-ws-file-editor.tsx` 挂载，附带 format）+ chat 链接 viewer（只读，`chat-page/component-chat-link-viewer.tsx` 挂载，readOnly=true 强制——第三消费场景）

> **命名说明**：文件名「md-editor」是 v0.0.227 历史——v0.0.241 扩展为通用 file editor（覆盖 md + 11 种格式），命名泛化（md-editor → file-editor）留 follow-up。modal 不改名 = 向后兼容 academy 引用 + `mdEditor.*` i18n key + 既有 UT。

## 职责
跨页统一的文件查看/编辑弹层：modal shell + md-head（文件名 + mode-toggle + 关闭）+ md-body（view 模式按 format 分流：md 走 markdown 渲染 / 其余走 `<pre>` 朴素预览；edit 模式 textarea）+ md-foot（hint + 关闭 + [结构化格式]「格式化」「校验」按钮 + 保存）。
- academy 场景：版本内容编辑（AGENTS.md / SKILL.md / 记忆 .md），不传 format → 缺省 'md' → 走 markdown 渲染（v0.0.227 既有行为）。
- workspace 场景：点 `.md/.json/.yaml/.xml/.toml/.csv/.tsv/.jsonl/.txt/.ini/.env/.log` 文件拦截后内置查看/编辑（挂载层透传 format）。
- chat 链接场景（只读）：聊天消息 markdown 链接点击 12 格式本地文件 → 内置**只读**查看（`readOnly=true` 强制：无 mode-toggle/保存按钮；挂载层 `component-chat-link-viewer.tsx` 按路径来源分流取内容——workspace 相对走 HTTP readWorkspaceFile，绝对路径走 Electron `shell:readFileText` IPC；不写回）。

边界：只编辑文本型字段；不编辑 version.json（模型）或 tools 白名单（那些走专属 picker）；不管版本树（编辑后版本号不变，design §2.1）。落盘不耦合本组件——`onSave` 是纯回调，由挂载层接线（academy 落 academy API；workspace 落 `POST /workspace/file/save`）。

## Props
```ts
interface Props {
  open: boolean;
  fileName: string;    // mono 文件名，如 'AGENTS.md' / 'notes.md' / 'config.json'
  subtitle: string;    // 来源上下文，如 '小红书文案 · v2.0 · system prompt'（academy）/ 相对 workspaceDir 路径（workspace）
  initialValue: string;   // 原文（markdown 源码 / 配置文本）；open 变化时组件重置 draft + 切回 view
  versionLabel: string;   // 默认 hint 模板的 {{label}} 占位值，如 'v2.0'（academy）/ basename（workspace）
  hint?: string;          // 覆盖默认 hint 文案；不传走默认模板「直接编辑 · 保存后版本号不变（{{versionLabel}} 仍是 {{versionLabel}}）」
  format?: FileFormat;    // [v0.0.241 新增] 文件格式（缺省 'md'）：决定 view 分流 + edit 是否显示「格式化」「校验」按钮。academy 不传 → 'md' 行为不变
  readOnly?: boolean;     // 只读（process 版本 / chat 链接 viewer）→ 隐藏 mode-toggle 与「保存」按钮，仅 view + 关闭
  filePath?: string;      // 文件完整路径（derive baseDir 供 PrimitiveMarkdownView resolve 相对图片；academy 等无文件场景不传 → 相对图片降级 alt）
  sessionId?: string;     // 会话 ID（相对图片走 readWorkspaceFileBinary HTTP；无 sessionId 时相对图降级 alt）
  onSave?: (newValue: string) => Promise<void> | void;  // 落盘纯回调；throw 则组件显 saveError、textarea 内容保留供重试
  onClose: () => void;
}
```

> `mode`（view / edit）是组件**内部 state**（缺省 `'view'`，md-head 二段开关切换），不暴露为 prop。`readOnly=true` 时隐藏切换入口、强制停留 view。
> `format`（v0.0.241）派生出 `category: 'md' | 'structured' | 'plain'`（见 `lib/file-format.ts`），驱动 view 分流与 edit 格式按钮显隐——一次派生，避免多次调用 getCategory。

## 状态 / 交互
- **L3 modal 不变式（硬约束）**：走 `<Portal>` 挂 overlay-root + Portal 根节点显式 `pointer-events-auto` ——见 `_conventions.md §13`（漏第二条则整弹层按钮全不可点，仅 ESC 可关；已有防回归 UT 断 className）。
- **modal shell**：720px 宽（max 92vw）+ max-h 88vh + `rounded-xl` + shadow-lg + column flex overflow-hidden；背景遮罩 `rgba(10,10,10,.4)`，点击遮罩关闭。
- **md-head**（p-13/18 + bottom border）：icon 📝（17px）+ `md-file` mono 13.5px/600 fileName + `md-sub` 11px muted subtitle + 右 `mode-toggle`（二段「👁 查看 / ✏️ 编辑」sm，激活 `--color-accent` 黑底白字）+ ✕ 关闭按钮。
- **md-body**（flex-1 overflow-y-auto，min-h 280px）：
  - **view 模式**（默认）按 `category` 分流（v0.0.241）：
    - `category === 'md'` → `md-view` markdown 渲染（p-18/22 + 13.5px/1.75 行高；h1 17px/600 mb-8；ul pl-20；li m-3/0；code mono 12px + surface-2 bg + 4px radius + p-1/5）。academy 调用不传 format 走此分支（回归保护）。**`md` 走 `PrimitiveMarkdownView` 渲染内核，v0.0.286 起新增 block 级 `![alt](url)` 图片渲染**：`filePath` prop derive `baseDir` → 传给 `PrimitiveMarkdownView` → 相对路径图片 resolve 到 md 文件目录 → workspace 相对走 `readWorkspaceFileBinary` HTTP / 绝对走 `readFileBinary` IPC → base64 → data URL → `<img>`；网络图片 `http(s)://` 直渲。**`filePath` 不传**（academy 场景）→ 无 baseDir → 相对图片降级 alt 文本（网络/绝对路径不受影响）。
    - `category === 'structured' | 'plain'` → `<pre>` 朴素预览（p-18/22 + mono 13px/1.7 + `whitespace-pre-wrap break-words`；保留缩进/换行，**无**语法高亮 / 行号 / 折叠——PRD §2.2 极简风格）。
  - **edit 模式**：`md-edit` textarea 全宽全高（p-18/22 mono 13px/1.7）；所有 format 统一用 textarea（不引入 CodeMirror/Monaco）。
- **md-foot**（p-12/18 + top border）：
  - **格式按钮**（v0.0.241）：edit 模式 + `category === 'structured'` 时显示「格式化」「校验」两个 outline 按钮（BTN_SECONDARY，位「关闭」左侧）；`category !== 'structured'`（md/plain）用 **`visibility:hidden`** 渲染同尺寸占位（保布局稳定，禁 `display:none` + 条件渲染致相邻元素位移，CLAUDE.md 布局稳定性硬规则）；view 模式一律不渲染。
    - 「格式化」→ `formatText(format, draft)` → 成功 `setDraft(output)` + `setValidateResult({kind:'ok'})`；失败不动 draft（PRD §3.1 关键不变量：解析失败不可格式化，防洗空坏内容）+ `setValidateResult({kind:'error', msg})`。
    - 「校验」→ `validateText(format, draft)` → 成功 `setValidateResult({kind:'ok'})`；失败 `setValidateResult({kind:'error', msg})`（msg 含行号时走 i18n template `validateFailLine`，否则 `validateFail`）。**不阻塞保存**（last-write-wins 不变）。
  - **hint 区状态机**（v0.0.241，优先级链）：`saveError`（既有，落盘失败）→ `validateResult.kind==='error'`（校验错误 msg）→ `validateResult.kind==='ok'`（「✓ 格式正确」/「✓ Valid」正向反馈）→ `idle` 显既有 hint/versionLabel 模板。
  - `md-hint` 11.5px muted——默认文案「直接编辑 · 保存后版本号不变（{{versionLabel}} 仍是 {{versionLabel}}）」（academy 场景）；传 `hint` prop 则整体覆盖（workspace 场景传文件场景文案）。
  - 右按钮组：「关闭」outline 按钮（view/edit 都显示）；「保存」primary 按钮（**仅 edit 模式显示**，view 模式 `display:none`；点击 → `onSave(newValue)` → 成功后切回 view）。
  - **可见文案**（E2E）：fileName / subtitle / 「👁 查看」「✏️ 编辑」/ ✕ 关闭 tooltip / hint 文案（默认模板或 `hint` 覆盖值或 validateResult 状态文案）/ 「关闭」「保存」/ 「格式化」「校验」（仅 edit + structured）。

## 复用关系
- **跨页共享（common/）**：academy + workspace 双消费触发提升（design §8.2「跨 ≥2 页复用时提升 common/」预告，v0.0.227 落实；v0.0.241 扩 format Props 不会破坏 academy 调用——缺省 'md'）。academy 侧由 `section-student-detail` 四元组卡触发（如 System Prompt 卡「查看 / 编辑」）；workspace 侧由 `section-workspace-panel.handleOpen` 点 md/json/yaml 等 12 格式文件触发（挂载层 `component-ws-file-editor.tsx`，v0.0.241 改名自 `component-ws-md-editor.tsx`）；chat 链接侧由 `component-message-stream` 内链接点击触发（挂载层 `component-chat-link-viewer.tsx`，readOnly=true 强制只读，详见 `../chat-page/component-chat-link-viewer.md`）。
- ver-hero 不再持编辑入口（槽位留给过程版「进入观察」）。
- 不复用 studio-page 的 charter-editor（那有 4 字段 + history，语义不同）。
- **已知技术债**：组件反向引用 `../academy-page/academy-styles`（BTN_PRIMARY / BTN_SECONDARY / ICON_BTN tokens）——common 依赖 academy 样式是层级倒置，follow-up 可把 BTN tokens 提到 common 样式层；命名泛化（md-editor → file-editor）亦留 follow-up。

## 视觉基线
- 设计稿来源：`demo/09-version-edit.html`。
- 尺寸：modal 720px / max-h 88vh；head p-13/18；body min-h 280px；foot p-12/18。
- 字体：md-file mono 13.5px/600；md-sub 11px muted；md-view 13.5px/1.75；md-edit mono 13px/1.7；md-hint 11.5px muted。
- 边框：modal `rounded-xl` + shadow-lg；head bottom border；foot top border；mode-toggle border + `rounded-md` overflow-hidden。
- 配色：modal `bg-surface`；遮罩 `rgba(10,10,10,.4)`；mode-toggle 激活 `--color-accent` 黑底白字；非激活 muted；view h1 fg；code `surface-2`；btn-primary `--color-accent`。
