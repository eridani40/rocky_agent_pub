# v0.0.325 变更计划书 — html 预览态「浏览器打开」按钮

> **method 级 review 合同**。架构期冻结：coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> PRD 权威：`specs/prd/version_logs/v0.0.325-html-open-in-browser.md`

## 架构判断（已核实源码）

| 判断项 | 结论 | 核实依据 |
|--------|------|----------|
| html 当前渲染态 | `.html`/`.htm` → FileFormat `'code'` → `<pre>` 朴素渲染源码（不引入 iframe/webview） | PRD §4.1；`preview-tabs-types.ts` PreviewTab.format: FileFormat |
| 打开方式按 source 分流 | workspace 源 → `openWorkspaceItem(sessionId,{path,kind:'file'})`；absolute 源 → `window.rockyShell.openPath(path)` | `workspace-api.ts` L38 `openWorkspaceItem(sessionId, body:{path,kind}, base?)`；`preload.ts` L53 `openPath: (path)=>ipcRenderer.invoke('shell:openPath',{path})` |
| PreviewTab 有 source/path 字段 | `source: 'workspace'\|'absolute'`、`path: string`、`fileName: string`、`format: FileFormat` 全在 PreviewTab 上 | `preview-tabs-types.ts` L13-28 |
| 显示条件 | `mode==='view' && format==='code' && /\.(html?|htm)$/i.test(fileName)` —— code 含 .py/.js 必须额外校验扩展名 | PRD §5；`file-format.ts` FileFormat 含 'code' |
| 按钮位置 | 只读态胶囊容器内，编辑按钮之后第 2 位 | `component-preview-floating-actions.tsx` L65-75 只读态当前只有 1 个编辑按钮 |
| GlobeIcon 新增 | 沿用 preview-icons.tsx `base()` + IconProps 模式，feather globe SVG path | `preview-icons.tsx` L14 `base(size)` + L10 `IconProps` |
| 失败处理 | best-effort `console.warn` 不弹 error（与 open-local-path.ts `openSystemWorkspace`/`openSystemAbsolute` 风格一致） | `open-local-path.ts` L66-75 |
| section-preview-area 组装位置 | L194-205 `<ComponentPreviewFloatingActions>` 调用处，已有 `activeTab` + `sessionId` + `getCategory` | `section-preview-area.tsx` L194-205 |

## 设计决策（D 编号）

### D1: GlobeIcon 组件 — preview-icons.tsx（修改）

**文件**：`app/web/src/components/chat-page/preview-icons.tsx`（修改）

**变更**：
- 新增 `GlobeIcon` 组件（feather globe 地球仪），复用 `base()` + `IconProps` 模式
- SVG path（feather globe）：
  ```tsx
  <circle cx="12" cy="12" r="10" />
  <line x1="2" y1="12" x2="22" y2="12" />
  <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
  ```
- JSDoc：`/** globe —— 悬浮按钮「浏览器」（feather globe 地球仪） */`

**约束**：MUST strokeWidth=2, strokeLinecap='round'（base() 统一）；MUST size 默认 16；MUST 与族图标风格一致。

### D2: 胶囊容器加浏览器按钮 — component-preview-floating-actions.tsx（修改）

**文件**：`app/web/src/components/chat-page/component-preview-floating-actions.tsx`（修改）

**变更**：
- import 新增 `GlobeIcon`（L21 import 列表加）
- `FloatingActionsProps` 新增 2 个 prop：
  - `isHtml: boolean` —— 是否为 html 文件（控制浏览器按钮显隐）
  - `onOpenInBrowser: () => void` —— 点击浏览器按钮回调
- 只读态渲染（L65-75 `mode === 'view'` 分支）：编辑按钮之后、`isHtml &&` 条件下渲染浏览器按钮：
  ```tsx
  {isHtml && (
    <button
      type="button"
      data-testid="pv-float-browser"
      onClick={onOpenInBrowser}
      aria-label={t('workspace.preview.openInBrowser')}
      title={t('workspace.preview.openInBrowser')}
      className={ICON_BTN}
    >
      <GlobeIcon size={16} />
    </button>
  )}
  ```
- 按钮样式：`ICON_BTN`（与编辑按钮完全同款 `h-8 w-8 rounded-lg text-muted hover:bg-bg-warm hover:text-fg`）

**约束**：MUST 只读态才渲染（mode==='view' 分支内）；MUST isHtml 条件控制显隐；MUST 编辑态不显示浏览器按钮；MUST NOT 改编辑态按钮（保存/撤销/格式化/校验）；MUST NOT 改容器样式；MUST 按钮在编辑之后第 2 位。

### D3: 组装回调 + 文件源分流 — section-preview-area.tsx（修改）

**文件**：`app/web/src/components/chat-page/section-preview-area.tsx`（修改）

**变更**：
- import 新增 `openWorkspaceItem` from `'../../lib/chat-api'`（workspace 源打开）
- import 新增 `GlobeIcon` 不需要（GlobeIcon 只在 floating-actions 内部用）
- `ComponentPreviewFloatingActions` 调用处（L194-205）新增 props：
  - `isHtml`：从 activeTab 判定 —— `activeTab.format === 'code' && /\.(html?|htm)$/i.test(activeTab.fileName)`
  - `onOpenInBrowser`：内联分流函数：
    ```tsx
    onOpenInBrowser={() => {
      if (activeTab.source === 'workspace') {
        void openWorkspaceItem(sessionId, { path: activeTab.path, kind: 'file' })
          .catch((e) => console.warn('openInBrowser(workspace) failed:', e));
      } else {
        void window.rockyShell?.openPath(activeTab.path)
          ?.catch?.((e) => console.warn('openInBrowser(absolute) failed:', e));
      }
    }}
    ```
    > 注：`window.rockyShell?.openPath` 返回 `Promise<void>`（preload L53）；dev 浏览器无 rockyShell → `?.` 短路 noop。openPath 返回值可能非 thenable（guard `?.`），但 preload 确认返回 `ipcRenderer.invoke(...)` = Promise，故 `void ...openPath(path).catch(...)` 安全。

**约束**：MUST workspace 源走 openWorkspaceItem（HTTP）；MUST absolute 源走 rockyShell.openPath（IPC）；MUST 失败 console.warn 不弹 error；MUST NOT 新增 IPC/API/后端改动；MUST NOT 改其他 props 接线。

### D4: i18n 双语 — zh-CN/chat.json + en/chat.json（修改）

**文件**：
- `app/web/src/i18n/locales/zh-CN/chat.json`（修改）
- `app/web/src/i18n/locales/en/chat.json`（修改）

**变更**：
- `workspace.preview` 块新增 key `openInBrowser`：
  - zh-CN：`"openInBrowser": "在浏览器打开"`
  - en：`"openInBrowser": "Open in Browser"`
- 插入位置：`workspace.preview` 块内（如 `format` 之后，按字母序或就近原则）

**约束**：MUST 双语；MUST key = `openInBrowser`；MUST 命名空间 `workspace.preview.*`。

## 文件级变更清单

| # | 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 预计影响行 |
|---|---------|---------|----------|------|---------|------|------|-----------|
| 1 | preview-icons | `app/web/src/components/chat-page/preview-icons.tsx` | `GlobeIcon` | 新增 | feather globe SVG 组件（circle+line+path） | MUST base() 模式；MUST strokeWidth=2 | D1 | +8 |
| 2 | floating-actions | `app/web/src/components/chat-page/component-preview-floating-actions.tsx` | `import` | 修改 | import 列表加 GlobeIcon | MUST | D2 | 1 |
| 3 | floating-actions | 同上 | `FloatingActionsProps` | 修改 | 加 `isHtml: boolean` + `onOpenInBrowser: () => void` | MUST | D2 | +2 |
| 4 | floating-actions | 同上 | `ComponentPreviewFloatingActions` 解构 | 修改 | 解构加 isHtml, onOpenInBrowser | MUST | D2 | 1 |
| 5 | floating-actions | 同上 | 只读态浏览器按钮 JSX | 新增 | 编辑后 `isHtml &&` 条件渲染 GlobeIcon 按钮 | MUST 第2位；MUST ICON_BTN 样式 | D2 | +12 |
| 6 | preview-area | `app/web/src/components/chat-page/section-preview-area.tsx` | `import` | 修改 | 加 openWorkspaceItem from chat-api | MUST | D3 | 1 |
| 7 | preview-area | 同上 | `ComponentPreviewFloatingActions` 调用 | 修改 | 加 isHtml 判定 + onOpenInBrowser 分流回调 | MUST workspace→HTTP / absolute→IPC | D3 | +10 |
| 8 | i18n | `app/web/src/i18n/locales/zh-CN/chat.json` | `workspace.preview.openInBrowser` | 新增 | "在浏览器打开" | MUST | D4 | 1 |
| 9 | i18n | `app/web/src/i18n/locales/en/chat.json` | `workspace.preview.openInBrowser` | 新增 | "Open in Browser" | MUST | D4 | 1 |

## 范式归属（逐控件）

| 控件/操作 | 范式 | 理由 |
|-----------|------|------|
| 浏览器按钮点击 | **即时操作** | 点击即执行（系统浏览器打开），无确认/无 undo |
| 浏览器按钮显隐 | **条件渲染**（isHtml prop） | 父级算好条件传 prop，组件纯渲染 |
| 打开失败 | **静默 console.warn** | best-effort，不弹 error（与 open-local-path.ts 风格一致） |

**结论**：不引入新范式，不引入确认 modal，不引入 SaveBar。

## 影响面评估

- **跨模块**：preview-icons（图标）/ floating-actions（按钮）/ section-preview-area（组装分流）/ i18n —— 全前端
- **破坏性变更**：`FloatingActionsProps` 新增 2 个必填 prop（isHtml, onOpenInBrowser）—— 唯一消费方是 section-preview-area，同版本同步改
- **零后端 / 零 IPC 新增 / 零 viewer 改动**
- **依赖顺序**：D1（GlobeIcon）独立；D2（floating-actions）依赖 D1；D3（section-preview-area）依赖 D2；D4（i18n）独立可并行
- **UT 覆盖面**：
  - `component-preview-floating-actions.test.tsx`（改）—— 加 isHtml=true 只读态渲染浏览器按钮断言 + isHtml=false 不渲染断言 + 点击触发 onOpenInBrowser 断言 + 编辑态不显示断言
  - `section-preview-area.test.tsx`（改/不强制）—— isHtml 判定逻辑可选断言（组件集成层，floating-actions 单测已覆盖按钮行为）
