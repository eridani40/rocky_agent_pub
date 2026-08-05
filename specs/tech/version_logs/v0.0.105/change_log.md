# v0.0.105 Computer Use — 跨版本发布说明（tech）

> 版本轴发布说明（详）。位置轴目录级变更见各 KB `log.md`（platform / tools / config）。
> method 级变更契约：`change_plan_v2.md`（pivot 架构）+ `change_plan_v2_batch2.md`（单 tool 11 action）。旧 `change_plan.md`（v1 spawn helper + connector）已被 v2 取代，仅存历史。

## 摘要

agent 首次获得**控制 macOS 桌面**的能力（看屏幕截图 + 读 AX 树 + 键鼠操作）。经历一次架构 pivot：

1. **原设计（v1，已废）**：`@app/server` spawn Swift helper 子进程（driver + IPC session）+ computer 作第 2 连接器（toggle + owner 锁）。
2. **pivot（真机 dogfood 2026-07-10）**：裸 spawn Swift helper **拿不到 macOS TCC 权限**（TCC 按进程签名身份判定，spawn 子进程不继承宿主授权，实测 4+ 次）。**改为「Rocky Electron 主进程注入 `ComputerNativePort`」**——原生能力在主进程内（`com.rocky.agent` = TCC 权限主体），server 直调注入的 port。memory `macos-tcc-spawn-no-perm-use-electron-host`。
3. **能力对齐 open-codex（波次 B）**：单 `computer` tool + 11 action，能力集 1:1 对齐 iFurySt open-codex。

## 一、平台层：ComputerNativePort + native addon（platform KB 新建）

- **新建 `[P1]computer_native_capability.md`**（删旧 `[P1]computer_driver.md`）。
- `ComputerNativePort`（纯 TS 接口，server 零 electron）：11 能力 checkPermissions / screenshot / getAppState / readAxTree / listApps / click / type / scroll / pressKey / drag / setValue / performSecondaryAction。方法 `ok=false 返 reason 不抛`（fail-closed）。`native-port.ts`（行为契约 + 权限态 + Error 类）+ `native-port-types.ts`（数据形状，拆出控体量，`export *` 保 import 面）。**截图结果字段 `mediaType`（非 mime）**。
- **主进程实现 = native addon**（`app/computer-native/` Swift dylib `RockyComputerCore` + N-API C++ 桥 + node-gyp）：ScreenCaptureKit 单窗口截图（`Screenshot.swift`）+ AXUIElement AX 树（`AccessibilitySnapshot.swift`，含 secondary actions 采集）+ CGEvent postToPid 键鼠（`InputSimulation.swift`，后台不抢前台、仅需 Accessibility）+ resolvePid/lastRecords 缓存（`Service.swift`）+ `@_cdecl` C ABI 桥（`CBridge.swift`）。`app/electron/src/computer-native-port.ts makeElectronComputerNativePort` 调 addon；checkPermissions 走 electron systemPreferences。
- **三态注入 precedence**（`bootstrap.ts`）：`resolveMockComputerNativePort(env,dataDir) ?? resolveLoopbackComputerNativePort(env) ?? getComputerNativePort()`。① AT mock（读 `computer-mock.json` fixture，零子进程/GUI）② dev loopback（127.0.0.1 + token 通道，`computer-loopback-server.ts` 泛路由 `/invoke`）③ packaged registry 直调（main.ts `setComputerNativePort(makeElectronComputerNativePort())`）。降级 undefined → tool 返「仅桌面 App 可用」不阻断启动。
- **两处 deps 组装点注入 ctx.config**（BUG-001 教训 `session-config-two-deps-assembly-points`）：`router.sessionDeps → session-config` + `bootstrap.setResolveConfig 闭包`。漏一处 agent-loop 运行时读不到 port。
- **坐标 = window-relative 三段式**（`coords.ts pixelToGlobalPoint`/`deriveScaleFactor`）：`windowPoint=pixel/scaleFactor` → `globalPoint=windowPoint+windowBounds.origin`。element_index 主（AX 零像素数学）/ coordinate 辅。
- **删旧代码**：`platform/computer/{ipc-client,macos,macos-session,helper-bundle,pick-driver,unsupported/linux/windows-driver,connector-manager,connector-bootstrap}.ts` + 旧 `swift-helper/`（spawn 方案全废，delete-dead-code）。

## 二、工具层：单 computer tool + 11 action（tools KB）

- **新建 `[P1]computer_use_tool.md`**：**单一 `computer` tool + `action` 参数**（11 action = 同一 tool 的不同 action），**非** 多独立 tool、**非** 连接器。对齐 open-codex 9 tool + 2 省 token 补充（screenshot 纯图 / read_ax_tree 纯树；get_app_state 图+树是主 action）。
- `run()` 四层 fail-closed：① action 校验（∈ 11 值集）② port undefined ③ ACTION_PERMS 按 action 权限门禁（screenshot→screenRecording；get_app_state→双；其余→accessibility）④ switch dispatch → handler → port method。
- 扁平 action-discriminated schema（`COMPUTER_INPUT_SCHEMA`）：`action` 必填 enum + snake_case 参数（`element_index`/`from_x..to_y`/`max_tree_nodes`/`max_tree_depth`/`secondary_action`/`click_count`/`mouse_button`）+ `additionalProperties:false`；action-specific 必需参数由 handler 校验。
- app-scoped（`app` 参数 → Swift resolvePid）；window-relative 三段式坐标（`session-state.ts` per-sessionId 缓存 windowBounds+scaleFactor；`target.ts resolveTarget/resolveDrag`）；`image-block.ts wrapScreenshot` 包 ImageBlock。
- `tool-policy.ts`：`TOOL_POLICY['playground-rocky'].bound` 加单 `'computer'`（1 条覆盖 11 action；subagent/leader/mate/squad 不加——控 OS 风险）。
- 测试：mock port（`mock-native-port.ts` 读 fixture）+ mock-llm directive（`@@cu:<json>@@` → 单 `computer` tool_call）；真操作走 dev dogfood，不进 run_all（守 `test-no-real-spawn-system-gui`）。

## 三、连接器回退 + ImageBlock 打通

- **`[P1]connectors.md` v1.3 → v1.4 回退**：computer 去连接器语义，删 §1 computer 行 / §3.1 permissions 字段 / §3.2.2 computer 迁移规则 / §5.2 ComputerConnectorManager；shared type `ConnectorId` 回 `'browser'`。共享类型抽取 `app/server/src/connector/types.ts` **保留**（browser-only，干净重构）。
- **ImageBlock 全链路（P0 前置）**：`message/types.ts ContentBlock` union 加 ImageBlock（v0.0.8 砍的补回）+ `protocol-encode.ts case 'image'` spec 形→wire 形翻译 + ToolResultBlock.content 承载 image。截图回灌 LLM 看屏幕的协议原语。

## 四、API + UI

- **API（`18-computer-use.md` v1.0 → v2.0）**：**废弃所有公共 HTTP 端点**（`GET /connector/computer/permissions` + `PUT /config/connectors/computer` 不存在）。agent 走 tool→port（进程内注入），UI 走 Electron IPC。唯一 HTTP-ish 面 = dev-only loopback 通道（`GET /permissions` + `POST /screenshot` + `POST /invoke` 泛路由，127.0.0.1 + token，Electron 主进程 ↔ bun 后端）。
- **UI（`05-connectors.md` + `section-computer-connector.md`）**：连接器页加「电脑 tab」= **权限引导卡片**（非连接器状态机）。权限两行（辅助功能 / 屏幕录制）+ 引导按钮 + 测试截图；走 `window.rockyComputer` Electron IPC（`getPermissions/requestAccessibility/openScreenRecordingSettings/testScreenshot`），非 HTTP。启动/自动刷新绝不主动触发权限请求（不变量）。

## 五、已知局限

- **listApps 仅运行态 app**（NSWorkspace `.regular`）；open-codex list_apps 还含「近 14 天用过（Spotlight `kMDItemUseCount`）」。本版本 = 运行态语义；已装/近期 app 枚举 = 未来 `mdfind` 扩展。
- 非 macOS：addon 加载返 undefined → 全方法 fail-closed；linux/windows 原生实现推后。
