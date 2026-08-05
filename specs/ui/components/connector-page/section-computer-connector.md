# section-computer-connector（电脑连接器卡片 — 权限引导卡片）

> 层级: section（单卡片 section）
> 文件: app/web/src/components/connector-page/section-computer-connector.tsx

## 职责
电脑「连接器」tab 的交互单元：呈现 macOS 系统权限态（辅助功能 + 屏幕录制）、引导用户授权、并用 Electron 主进程 `desktopCapturer` 真截一张图证明权限主体成立。
**架构**：权限主体 = Rocky Electron 本体（非 spawn 子进程——裸 spawn 拿不到 TCC 权限）。前端经 `window.rockyComputer`（preload contextBridge 暴露）→ `ipcRenderer.invoke` → 主进程原生能力，共享 Rocky 的 TCC 身份。**不走后端 HTTP**。
边界：本卡片仅做权限查询/引导 + `desktopCapturer` 截图验证（证明权限主体成立）。agent 的实际桌面控制（截图/AX 树/键鼠）走单 `computer` tool → `ComputerNativePort`，**不经本卡片**（→ `specs/tech/agent/tools/[P1]computer_use_tool.md`）。

## 交互
- 权限状态两行：辅助功能 / 屏幕录制，各显 ✅已授权 / ❌未授权。
- 「授权辅助功能」按钮 → `requestAccessibility` → 重拉权限。
- 「打开屏幕录制设置」按钮 → `openScreenRecordingSettings`（屏幕录制无法程序弹窗）。
- 「测试截图」按钮 → `testScreenshot`：成功把 dataUrl 渲染成缩略图（证明真截到）；失败显示 reason。
- 「重新检测」按钮 → 重拉权限。
- spike 阶段 3 个动作按钮**常驻可点**（非「仅 missing 显示」），最大化验证灵活性——与 design.md §5.1「去授权仅 missing」的生产 UX 差异是 spike 有意取舍。

## 视觉基线
- 权限行色点/文字：granted=绿（text-sage）、missing=红（text-danger），用 design token。
- **布局稳定性**：截图缩略图/错误块追加在卡片底部，出现不位移上方元素（append 非插入）。
