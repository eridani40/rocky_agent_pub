# v0.0.320 tech change log — 文件预览区（三栏布局 + 多 tab 预览 + 编辑 + 冲突检测）

> 对应需求：`specs/prd/version_logs/v0.0.320-file-preview.md`（已验收通过，老板授权全自动推进）。
> 权威契约：`specs/tech/version_logs/v0.0.320/change_plan.md`（method 级 47 行表，frozen）。
> API 契约：`specs/api/version_logs/v0.0.320/change_log.md`（3 处后端变更）。

## 变更摘要

### 需求与动机

当前文件查看/编辑依赖弹层（`component-modal-md-editor`），一次只能看一个文件、多文件对比/切换体验差；文件树打开与聊天链接打开是两套挂载、交互割裂。老板拍板：新增**文件预览区**（独立中间栏，三栏布局 chat | 预览 | 工作区），chat 链接 + 工作区点文件都进预览区开 tab，弹层退役（chat 场景），并扩展编程语言文件支持 + 文件搜索 + 编辑冲突检测。

### 方案（15 架构裁决，详见 change_plan「设计决策 D1-D15」）

1. **布局引擎 4 槽扩展（D1）**：`layout-width-engine.ts` 加 `preview?` 可选槽——preview=null 旧 3 槽路径一字不动（旧 UT 全绿回归保护），preview 非 null 走 4 槽解析（left | chat | preview | right）。常量新增 `CHAT_WIDTH_MIN=320` / `PV_WIDTH_MIN=240` / `PV_WIDTH_MAX=1600` / `PV_WIDTH_DEFAULT=360`；`WS_WIDTH_MAX` 560→1600（近全屏）。
2. **布局 hook 扩展（D2）**：`use-three-col-layout.ts` 复刻 ws-panel 4 可选 props 模式（reportPreviewPanel/previewRenderWidth/previewDragMaxWidth/setPreviewDragging），`dragDynMax4` 唯一动态上限公式。
3. **预览区容器 + Provider（D3）**：`section-preview-area.tsx` 独立中间栏 + `preview-area-context.ts`（PreviewAreaContext + usePreviewArea，无 Provider 返 null）；localStorage per session `pv-width-<sid>` / `pv-collapsed-<sid>`；**单分隔条 `.pv-resize-left`**（[老板第三批] 删 `pv-resize-right` 修复拖拽 bug，原 D3 双分隔条 → 单条）复用 `component-col-resize-handle`（加 posSide prop 支持贴左缘+正比）。
4. **tab 状态机（D4）**：`use-preview-tabs.ts`——`PreviewTab`（id=`${source}:${path}`/path/fileName/subtitle/source/format/version/mode/dirty/content/draft/loadState）；open/close/activate/save/dirty 守卫（三选 modal）/冲突处理（409 → 取消=reload / 覆盖=force）。
5. **TabBar 横滑（D5）**：`component-preview-tab-bar.tsx`——横滑容器 + 左右 chevron（有剩余显示，opacity 显隐不位移）+ × 关闭 + dirty ●。
6. **viewer/editor（D6）**：`component-preview-viewer.tsx`（view 分流 md→PrimitiveMarkdownView / 其余→pre；edit 按钮）+ `component-preview-editor.tsx`（textarea + 保存/取消 + 错误保留重试）。**非弹层内嵌渲染**（弹层退役）。
7. **workspace 文件树改造（D7）**：文件夹 item 点击 → toggle 展开/收起（与 twisty 同语义防双发）；「打开文件夹」hover 按钮 stopPropagation 保留；文件 item → openLocalPath 五路分流不变，消费端 onEditor → preview.openTab（有 Provider）/ 降级弹层（无 Provider，academy/studio 兼容）。
8. **搜索框（D8）**：`component-ws-search-box.tsx`——前端过滤已加载树 + 后端补全量（防抖 300ms）；结果项点击文件→开 tab / 文件夹→展开收起；空输入恢复原树。
9. **后端 file version + save 冲突（D9）**：`session-workspace-file.ts`——`computeFileVersion`（`${mtimeMs}:${size}`）；read 响应加 version（binary 分支不加）；save 加 expectedVersion/force，不匹配且非 force → 409 `{error:'conflict', currentVersion}`；成功返 `{ok:true, version}`。
10. **后端搜索端点（D10）**：`session-workspace-search.ts` 新文件——递归全量搜索（ignore node_modules/.git，200 上限 + truncated）；路由 alternation 加 search。
11. **file-format 'code' 分类（D11）**：FileFormat + FileFormatCategory 加 'code'；EXT_TO_FORMAT 并入编程语言后缀（py/js/ts/java/go/rs/c/cpp/... 全映射 'code'）；getCategory('code') = plain 行为（pre 渲染无格式按钮）。**component-modal-md-editor 零改动自动支持**（getCategory 分流天然覆盖）。
12. **chat 链接 Provider 迁移（D12）**：ChatLinkHandlerContext 保留改造，Provider value 注入预览区上下文；message-stream 删 ComponentChatLinkViewer 挂载。
13. **弹层退役（D13）**：删除 component-ws-file-editor.tsx + component-chat-link-viewer.tsx + 相关测试断言；component-modal-md-editor 保留（academy 场景）。
14. **前端 API 客户端（D14）**：workspace-api.ts——readWorkspaceFile 返 version?；saveWorkspaceFile body 加 expectedVersion/force + 返 version?；新增 searchWorkspaceFiles。
15. **i18n（D15）**：`workspace.preview.*` 命名空间 19 key 双语。

### 范式归属（老板铁律：逐控件过范式）

| 控件/操作 | 范式 |
|-----------|------|
| 预览区 tab 打开/切换/关闭 | 即时操作（无 SaveBar） |
| 编辑保存 | 即时操作（按钮直接落盘，无 autosave） |
| dirty 守卫（切/关 tab） | L3 确认 modal（保存并切换/放弃/取消） |
| 冲突检测（409） | L3 确认 modal（取消=重载/覆盖=force） |
| 预览区显隐 + 宽度 | 即时操作（chevron 窄栏）+ 拖拽手柄 |
| 搜索框 | 直接输入 + 防抖（无提交语义） |
| 文件夹点击/「打开文件夹」 | 即时操作（toggle / 系统打开） |

**结论**：预览区所有控件走「即时操作 / 确认 modal / 拖拽手柄」三类范式，**不引入 SaveBar**（预览区不是配置面板；dirty 守卫已有 modal 确认闭环）。

## 关键文件变更

### 前端（新组件族 + 改造）

| 文件 | 类型 | 说明 |
|------|------|------|
| `app/web/src/lib/layout-width-engine.ts` | 修改 | 4 槽扩展（preview? 可选，旧路径零改动） |
| `app/web/src/components/chat-page/use-three-col-layout.ts` | 修改 | preview 槽位接线 |
| `app/web/src/components/chat-page/section-preview-area.tsx` | 新增 | 预览区容器（~150 行） |
| `app/web/src/components/chat-page/preview-area-context.ts` | 新增 | Context + usePreviewArea（~30 行） |
| `app/web/src/components/chat-page/use-preview-tabs.ts` | 新增 | tab 状态机（~140 行） |
| `app/web/src/components/chat-page/component-preview-tab-bar.tsx` | 新增 | tab 横滑（~80 行） |
| `app/web/src/components/chat-page/component-preview-viewer.tsx` | 新增 | 内嵌 view（~60 行） |
| `app/web/src/components/chat-page/component-preview-editor.tsx` | 新增 | 内嵌 edit（~60 行） |
| `app/web/src/components/chat-page/component-preview-dirty-modal.tsx` | 新增 | dirty 确认 modal（~40 行） |
| `app/web/src/components/chat-page/component-preview-conflict-modal.tsx` | 新增 | 冲突 modal（~40 行） |
| `app/web/src/components/chat-page/section-workspace-panel.tsx` | 修改 | handleOpen → 预览区；删弹层挂载；搜索接线 |
| `app/web/src/components/chat-page/component-ws-tree-item.tsx` | 修改 | 文件夹点击 toggle |
| `app/web/src/components/chat-page/component-ws-search-box.tsx` | 新增 | 搜索框（~90 行） |
| `app/web/src/components/chat-page/component-message-stream.tsx` | 修改 | Provider 注入预览区；删 viewer 挂载 |
| `app/web/src/components/chat-page/chat-link-handler-context.ts` | 修改 | Context 语义改造 |
| `app/web/src/components/chat-page/component-ws-file-editor.tsx` | 删除 | 退役（-143 行） |
| `app/web/src/components/chat-page/component-chat-link-viewer.tsx` | 删除 | 退役（-223 行） |
| `app/web/src/lib/file-format.ts` | 修改 | 'code' 分类 |
| `app/web/src/lib/chat-api/workspace-api.ts` | 修改 | version + search 客户端 |
| `app/web/src/components/chat-page/page-chat.tsx` | 修改 | 预览区挂载 |
| `app/web/src/components/studio-page/component-studio-chat-router.tsx` | 修改 | 预览区挂载 |
| `app/web/src/i18n/locales/{zh-CN,en}/chat.json` | 修改 | workspace.preview.* 19 key |

### 后端（仅 3 处，PRD §3.3 MANDATORY）

| 文件 | 类型 | 说明 |
|------|------|------|
| `app/server/src/handlers/session-workspace-file.ts` | 修改 | computeFileVersion + read version + save 409 |
| `app/server/src/handlers/session-workspace-search.ts` | 新增 | handleWorkspaceSearch（~90 行） |
| `app/server/src/routes/router-helpers.ts` | 修改 | alternation 加 search |
| `app/server/src/routes/session-routes.ts` | 修改 | workspace_search 分发 |

## 验证方式

| Task | 验证 |
|------|------|
| Task 1（后端 3 处） | UT（bun run test）+ AT（file version / save 409 / search 全量） |
| Task 2（前端布局 + 预览区核心） | UT（layout-engine 4 槽 + 组件）+ ET（EC-1/2/8/10/11/12） |
| Task 3（前端改造 + 清理） | UT（file-format code + ws-panel 改造）+ ET（EC-3/4/5/6/7/9） |

## 风险与边界

1. **layout-engine 4 槽回归** → preview=null 旧路径零改动 + 旧 UT 全绿门禁（回归保护）。
2. **academy/studio 降级** → 无 Provider → 保留弹层路径（component-modal-md-editor 不删，非死代码）。
3. **删除组件残留** → grep 全量门禁（import/测试断言）。
4. **搜索性能** → ignore node_modules/.git + 200 上限 + truncated。
5. **冲突竞态** → force/无 expectedVersion = last-write-wins 兜底（PRD §5.3）；旧后端缺 version → 前端跳过冲突检测降级。
6. **absolute IPC 源** → v1 不做冲突检测（IPC 层零改，last-write-wins）。

## 偏离记录

### Task 2 偏离（coder，leader 已确认）

1. **workspace-api.ts D14 前置子集**（Task 3 文件清单但 Task 2 依赖）：readWorkspaceFile 返 version? + saveWorkspaceFile 收 expectedVersion/force 返 version?（不含 searchWorkspaceFiles——留 Task 3）。
2. **session-api.ts req helper 加 err.body**：409 时附加响应体（前端读 currentVersion 必需；change_plan D14 明示"前端 catch err.status 读 body"）。
3. **i18n workspace.preview.\* 前置**（Task 3 文件清单但 Task 2 组件强依赖 32 key）：zh-CN + en 各 +32 行。
4. **preview-tabs-types.ts 独立文件**（控 use-preview-tabs 行数 ≤300）。
5. **loadTab 读成功后 dirty 清零**（reload=放弃本地修改语义，change_plan 未明示但必要）。

### Task 3 偏离（coder，leader 已确认）

1. **Provider 上移**：原 D3 将 PreviewAreaContext.Provider 挂 SectionPreviewArea 容器内，但 D7/D12 消费方（SectionWorkspacePanel / ComponentMessageStream）是容器**兄弟节点**——React Context 只能向下传，兄弟节点 usePreviewArea() 永远返 null。`preview-area-provider.tsx` 把 usePreviewTabs + Provider 提升到 page-chat / studio-chat-router 顶层包整行（透明容器不渲染 DOM）。
2. **fallback 降级弹层**：`component-ws-file-editor-fallback.tsx`（141 行）为无 Provider 场景（academy section-version-chat）降级路径，1:1 复用原 ws-file-editor 逻辑（readWorkspaceFile + ComponentModalMdEditor + last-write-wins + flash toast），仅改名——避免死代码 + 保留 academy 降级。
3. **无 Provider chat 链接降级系统打开**：message-stream onLocalViewer 无 Provider → workspace 源 openWorkspaceItem(kind='file') / absolute 源 rockyShell.openPath（对齐无 onLocalViewer 消费方行为）。

### M-1 修复（Task 3 review）

- **PreviewAreaProvider sessionId 与渲染面板对齐**：Provider 的 sessionId 用 `activeSessionId`（与 SectionPreviewArea/SectionWorkspacePanel 渲染面板对齐）——subagent 激活时（viewedSessionId=sub）右栏仍是 parent workspace 树，若 Provider 用 viewedSessionId 会读错 workspace（readWorkspaceFile(subagent) → 404 error pill）。

### ET-fix 4 项（e2e-test-executor 实测，coder 修复）

1. **BLOCKING1 dirty modal 插值**：`component-preview-dirty-modal.tsx` 标题 + aria-label 改 `t(key, { name: fileName })`（原漏传参渲染字面量 `{{name}}`）。
2. **BLOCKING2 放弃清 draft**：`use-preview-tabs.ts` resolveDirty discard → draft 重置为 content（文件最新内容，防旧草稿残留写回）；saveTabContent 成功 → draft 同步为已保存内容。
3. **修复3 树文件守卫**：openTab 加 dirty 守卫（action='open' + pendingOpen 原始 target）——dirty 时点树文件/chat 链接开新 tab 走 保存并切换/放弃/取消 三选，确认后完整 openTab 语义（新建+load）。
4. **修复4 展开态收起按钮**：`component-preview-tab-bar.tsx` 加 onCollapse（chevron 右向，对齐 ws-tab-bar）；`section-preview-area.tsx` 接线 → collapsed rail + localStorage 写 true。

## 验收结果（2026-08-10）

- **AT 3/3 pass**（Task 1）：workspace_file_version_tc1（read 返 version）/ workspace_save_conflict_tc2（expectedVersion 匹配 200 + 不匹配 409 不写盘 + force 覆盖）/ workspace_search_tc3（搜索命中 + ignore node_modules/.git + 空 q 400）。证据 `states/v0.0.320/verify/api-test/`。
- **Review PASSED**：Task 1 `code-review-task1.md` + Task 2 `code-review-task2.md` + Task 3 `code-review-task3.md`（r2 复审）+ `code-review-etfix.md`。证据 `states/v0.0.320/verify/review/`。
- **ET 12 条 11 pass / 1 blocking 已修复**：blocking（dirty modal 插值）修复后补验 5/5 pass。证据 `tests/e2e/file-preview/` + `states/v0.0.320/verify/e2e/`。
- **全量 UT 10159/0 failed**（含 320 新增用例：layout-engine 4 槽 + use-preview-tabs + file-format code + workspace-api）。证据 `states/v0.0.320/verify/unit-test/`。

## 第三批及后续全部改动（老板试玩反馈，9 commits）

> 详见 `specs/ui/version_logs/v0.0.320-file-preview/change_log.md`（UI 增量权威）。纯前端零 API 变更。

### 改动总览

| # | commit | 说明 |
|---|--------|------|
| 1 | b1696c90a | 删顶栏文件名行 + 悬浮操作按钮 + 收起/展开箭头 + 拖拽 bug 修复（删 pv-resize-right） |
| 2 | 41bb36296 | 收起/展开箭头方向修正 |
| 3 | 98f596d2f | 悬浮按钮「撤销」文案（cancel→undo） |
| 4 | f7270d093 | 收起按钮竖条样式（VSCode 风格手柄） |
| 5 | 53516d1c5 | 收起态打开文件自动展开（collapsed 下移 hook 层） |
| 6 | 508a42192 | use-preview-tabs 超行抽离（→ use-preview-collapsed.ts） |
| 7 | 7d4d36bf8 | 视觉打磨：tab 分隔感 + 悬浮按钮方形圆角竖排 |
| 8 | b9f05385a | tab 区 Tab 键循环切换 |
| 9 | 4049fa672 | 悬浮按钮图标修正（feather stroke，新增 preview-icons.tsx） |

### 新增文件（4）

| 文件 | 行数 | 说明 |
|------|------|------|
| `component-preview-floating-actions.tsx` | 134 | 正文区悬浮操作按钮（编辑/保存/撤销/格式化/校验，group-hover 显隐） |
| `component-preview-collapse-toggle.tsx` | 80 | VSCode 风格竖条手柄（收起/展开两形态） |
| `preview-icons.tsx` | 75 | feather stroke 图标族（Pencil/Save/Undo/Align/CheckSquare） |
| `use-preview-collapsed.ts` | 44 | collapsed hook + per session localStorage + 自动展开 |

### 退役元素

- `pv-resize-right`（拖拽 bug，单分隔条 pv-resize-left only）
- viewer/editor 顶栏按钮行（悬浮按钮替代）
- 旧 chevron rail `.pv-rail`（竖条手柄替代）

### 验收

- **第三批复审 PASSED**（code-reviewer2）：悬浮按钮 + 收竖条手柄 + Tab 循环 + 图标族 + 自动展开全通过。
- **ET 复验 pass/small**：视觉综合复验（图标+tab 分隔+Tab 切换）pass。证据 `states/v0.0.320/verify/e2e/`。
