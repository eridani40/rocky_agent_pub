# 05 连接器页

> 组件 spec：`specs/ui/components/connector-page/`
> 技术契约（browser 连接器）：`specs/tech/config/[P1]connectors.md`（双状态机 + 持久化 + BrowserConnectorManager）
> 技术契约（computer — **非连接器**，主进程注入 ComputerNativePort）：`specs/tech/agent/platform/[P1]computer_native_capability.md`；本 tab 仅是权限引导卡片（走 Electron IPC，无 toggle/连接态机）
> 无设计稿——视觉基线对齐现有 config 页（app-dev-config-page / skill-page）风格，不要求像素级。

## 1. 入口

- nav-rail 底部独立入口「连接器」（位置：SKILLS 之后），hover tooltip「连接器」
- 点 → 主区渲染 `<PageConnector />`
- PageConnector 内 tab 栏双 tab（「浏览器」|「computer」），主区按 active tab 渲染对应 section

## 2. 页面结构

```
page-connector (main, flex-1 overflow-y-auto)
├── 页头：标题「连接器」+ mono 副标题（管理 agent 对外部资源的连接）
├── config-body 容器 (max-width 880px)
│   ├── tab 栏：「浏览器」（默认选中）/「computer」
│   ├── browser section (active tab=浏览器 时渲染)
│   │   └── browser-connector-card（详 section-browser-connector.md）
│   └── computer section (active tab=computer 时渲染)
│       └── computer-connector-card
│           ├── 名称「电脑」+ 描述（让 agent 看屏幕截图并操作你的 Mac）
│           ├── 「重新检测」按钮（重拉权限态）
│           ├── [非 Electron 环境] 降级块「仅桌面 App 可用」（仅 window.rockyComputer 缺失时渲染）
│           ├── 权限面板（两行）
│           │   ├── 辅助功能行：✓绿 granted / ✗红 denied + 未授权时「授权辅助功能」按钮
│           │   └── 屏幕录制行：✓绿 granted / ✗红（附原始状态）+ 未授权时「打开屏幕录制设置」按钮
│           ├── 「测试截图」按钮
│           ├── 截图缩略图（img，截图成功后渲染，证明真截到）
│           └── 截图失败原因（截图失败时渲染）
```

## 3. 关键交互

### 3.1 browser tab（详 `section-browser-connector.md`）

| UI 组合态 | toggle | status |
|---|---|---|
| switch=off, connection=disconnected | off | 「未启用」(灰) |
| switch=on, connection=disconnected | on | 「已启用（未连接）」(灰) |
| switch=on, connection=connecting | on 禁用 | 「连接中…」(黄+spinner) |
| switch=on, connection=connected | on | 「已连接」(绿) |
| switch=on, connection=error | on | 「连接失败」(红) |

### 3.2 computer tab（权限查询 + 引导 + 截图验证）

> **架构**：Rocky Electron 本体作权限主体——前端经 `window.rockyComputer`（preload contextBridge）→ 主进程原生能力（`desktopCapturer` / `systemPreferences`），共享 Rocky TCC 身份。**本 tab 走 Electron IPC，不走后端 HTTP**（无 toggle/connection 状态机）。

computer 卡片 = 自管 IPC 态的**权限验证卡片**（非受控连接器）：

| 环境 | 渲染 |
|---|---|
| 非 Electron（dev web 浏览器，`window.rockyComputer` 缺失） | 仅「仅桌面 App 可用」降级块 |
| Electron 桌面 app | 权限面板（两行）+ 测试截图按钮 |

**动态监测**：① 挂载即拉一次；② `window focus` 事件重拉（用户从系统设置授权完回到 Rocky 自动刷新）；③ 手动「重新检测」按钮。

**IPC 契约**（`window.rockyComputer`，非 HTTP）：
- `getPermissions()` → `{ platform, supported, accessibility:boolean, screenRecording:'granted'|'denied'|'restricted'|'not-determined'|'unknown' }`
- `requestAccessibility()` → boolean（`systemPreferences.isTrustedAccessibilityClient(true)` 弹辅助功能授权引导窗）
- `openScreenRecordingSettings()` → `{ ok, reason? }`（深链 `x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`；屏幕录制不能程序弹窗只能引导）
- `testScreenshot()` → `{ ok:true, dataUrl, width, height } | { ok:false, reason }`（`desktopCapturer.getSources({types:['screen']})` 取 thumbnail 转 dataURL）

**权限请求时机（不变量）**：**应用启动 / 自动刷新绝不主动触发任何 TCC 权限请求 / 系统弹窗**。自动路径（挂载拉取、`window focus` 重拉、主进程启动自检 `runComputerSelfCheck`）只调**非侵入查询** `getPermissions`（纯查询不弹窗）。会触发系统请求/弹窗的操作——`requestAccessibility()`、`testScreenshot()`（首次触发屏幕录制系统请求）——**仅由用户主动点对应按钮触发**。

**去授权引导**：
- 辅助功能 → 「授权辅助功能」按钮 → `requestAccessibility()` 弹引导窗
- 屏幕录制 → 「打开屏幕录制设置」按钮 → `openScreenRecordingSettings()` 深链系统设置（屏幕录制无法程序弹窗）

**测试截图**：「测试截图」按钮 → `testScreenshot()`；成功渲染缩略图（证明 Rocky 作权限主体真截到），失败显 reason。macOS 屏幕录制首次授权后可能需重启 app 才生效（进程内缓存）。

**布局稳定性**：3 动作按钮常驻可点；截图缩略图/错误块 append 在卡片底部，出现不位移上方元素。

### 3.3 tab 切换

- 默认选中「浏览器」tab（`aria-selected="true"`）
- 点「computer」tab → 主区渲染 computer section（卸载 browser section）
- tab 切换不持久化（刷新回浏览器默认）

## 4. 边界

| 零件 | 归属 |
|---|---|
| 连接器页结构 + tab 切换 + computer 权限验证卡片契约（IPC） | 本文 ✅ |
| 组件设计（page / card / toggle / status / guide / tab 栏 / 权限面板） | `specs/ui/components/connector-page/` |
| computer IPC 契约（主进程 handler + preload 暴露 + Window 类型） | `app/electron/src/computer-permissions-ipc.ts` + `app/electron/src/preload.ts` + `app/web/src/types/rocky-computer.d.ts` |
| browser 状态机 + 持久化 + BrowserConnectorManager | `specs/tech/config/[P1]connectors.md` |
| computer 原生能力（tool→ComputerNativePort，非连接器） | `specs/tech/agent/platform/[P1]computer_native_capability.md` |
| nav-rail「连接器」项 | `specs/ui/components/framework/nav-rail.md` |
| HTTP facade（GET `/config/connectors` / PUT `/config/connectors/:id`） | `specs/api/overall/03-config-center.md` |
