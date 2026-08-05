---
type: log
title: Platform KB 变更记录
updated: 2026-07-16
---

# Platform KB 变更记录（ISO 倒序，最新在前）

> 本目录级变更日志（位置轴）。跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 一行一 feature；版本块尾指向该版本 change_log 详情。

## 2026-07-16 · v0.0.160（computer-use 全面对齐 open-codex 17/17 gap 闭合）

- **`[P1]computer_native_capability.md §2`**：`AxTreeOptions.textLimit` 类型扩 `number | 'max'`；新增 `AppInfo` 行含 v0.0.160 optional `line/isFrontmost/lastUsed/uses`；`ComputerErrorCode` 加 `state_unavailable` + 语义说明（对齐 Swift `ComputerUseError.stateUnavailable`）。
- **`[P1]computer_native_capability.md §5`**：Swift 文件表全面刷新——从 8 行扩到 25+ 行覆盖 v0.0.160 33 个 top-level .swift 文件（`WindowRecovery / ClickCoordinateHitTest / TypeTextStrategy / AppDiscovery / SpotlightAppIndex / FixtureBridge / TreeRenderer + Segments + Helpers + Summary / SoftwareCursorOverlaySupport + Overlay + Animation + Rendering / SoftwareCursorGlyphRenderer / CursorMotionPath + Geometry + Spring + Official + HeadingDriven + Descriptors + Metrics + VisualDynamics / ServiceHelpers`）；`AccessibilitySnapshot` 行加 `SnapshotTextLimit / SnapshotMode / prettyActionName / AxSnapshot.records: [Int:ElementRecord]` + `build()` focused nil → `WindowRecovery.recoverVisibleWindow` 集成 → throw stateUnavailable；`ClickStrategy` 行加 4 层 fallback 编排 + 签名扩 `includeNearbyHitTesting/allowActivationFallback/pid/allRecords`；`Service` 行加 type 三段式 + scroll AX-first + setValue sleep + matchingAction 两级 match；`Tests` 行改 Block1-6 分文件累计 419 asserts。
- **`[P1]computer_native_capability.md §6`**：element_index 描述简化引用 §5 表；coordinate 分支明确走 `ClickCoordinateHitTest.clickCandidates` 双候选 + 严格 `includeNearbyHitTesting:false, allowActivationFallback:false` open-codex 契约。
- **`[P1]computer_native_capability.md §6.1`**（新章）：视觉光标 overlay ——13 文件 2967 行 逐字对齐 open-codex；`@MainActor` 主线程隔离 + `nonisolated static func` fire-and-forget 主线程调度；`VisualCursorSupport.isEnabled` env 门禁（`ROCKY_CU_VISUAL_CURSOR` 默认关，Rocky 换名）；**Service 集成推迟单独版本**（G-6 决策）；`rockyComputerUseTurnEndedNotificationName = com.rocky.agent.turn-ended`。
- **`[P1]computer_native_capability.md §8`**：已知局限全条重写——17/17 gap 全闭合列表；刻意不移植 11 项列表；listApps 语义调整（Spotlight + running 合并，fail-closed）；FixtureBridge = bridge only + Rocky 命名空间偏离；G-6 光标 Service 集成推迟；stateUnavailable 分类 + TS friendly 文案；TreeRenderer LLM 视角变化 dogfood 要求 6+ 场景（Safari/Finder/Xcode/VSCode/Lark/WorkBuddy）。
- **`[P1]computer_native_capability.md` frontmatter**：`notes` 精简为 v0.0.160 三行摘要（17/17 闭合 + G-6 推迟 + FixtureBridge bridge only）。
- **打包（`app/electron/electron-builder.yml`）**：`mac.extendInfo.NSMetadataQueryUsageDescription`（Spotlight 权限声明，中英双语），供 `AppDiscovery.SpotlightAppIndex` 读 metadata 无 TCC 弹窗；spec 侧 §5 SpotlightAppIndex 行已注明。
- **TS bridge**：`native-port.ts::ComputerErrorCode` +`state_unavailable`；`native-port-types.ts::AxTreeOptions.textLimit` `number → number|'max'` + `AppInfo` +4 optional 字段；`schema.ts::text_limit` oneOf + secondary_action pretty/raw 双写法说明；`target.ts::resolveAxOptions` 'max' 分支；`actions/type-text.ts` + `set-value.ts` state_unavailable 友好中文文案分支；`actions/list-apps.ts` 用 line 优先输出；`electron/computer-native-{addon,port,types}.ts` code 透传链。
- **验证**：Swift UT 419 asserts 全绿；`build-native.sh` release build 全绿；`bun run typecheck` 全绿；TS UT 72/72 全绿；AT/ET 依用户「普通 feature 不新增 AT/ET」铁律 → dev dogfood + 冒烟回归覆盖。
- **关键决策**：G-6 光标 Service 集成推迟（用户裁决 dogfood 后单独版本）；FixtureBridge = bridge only（本机 CLT 缺 Xcode 无法建 fixture app + XCTest）；SwiftPM 一律 top-level 平铺（避免 SwiftPM「multiple producers」冲突）。

详情：`specs/tech/version_logs/v0.0.160/{log.md, change_plan.md}`

## 2026-07-16 · v0.0.159（computer tool click 对 Electron/web content 修复）

- **`[P1]computer_native_capability.md §5`**：Swift 文件表 —
  - `AccessibilitySnapshot.swift` 行增补「rawActions（未过滤 AXPress）+ `copyParent(of:)` / `hasAncestorRole(_:of:maxDepth:12)` AX 祖先遍历 primitive」
  - `Service.swift` 行加缓存字段 `lastBundleId` / `lastAppName`，click 走 `ClickStrategy.performAXClickSequence` → 失败 fallback `InputSimulation.clickTargeted`
  - **新增 `ClickStrategy.swift` 行**（策略层：`isElectronScopedTarget` / `shouldPreferContainingWebRowAXClick` / `hasPrimaryClickAction` / `isLikelyContainingRowActionFrame` / `performAction` / `performContainingWebRowClick` 6 层祖先 / `performPreferredClick`（AXPress→Confirm→Open / ShowMenu）/ `performAXClickSequence` 主编排）
  - **新增 `Tests/RockyComputerCoreTestRunner/main.swift` 行**（executable + 手写 `expect()` runner，31 assertions，`swift run --package-path app/computer-native/swift RockyComputerCoreTestRunner`）
- **`[P1]computer_native_capability.md §6 element_index`**：策略描述从「AXPress 语义动作 或 postToPid」改为「AX click 序列（web content 特殊路径 6 层祖先 AXPress → 左键 AXPress→AXConfirm→AXOpen / 右键 AXShowMenu）→ 失败落 postToPid CGEvent 兜底」+ **v0.0.159 修订标注**（v0.0.105 单步 AXPress 对 Electron/Chromium web content 空转的根因说明）。
- **`[P1]computer_native_capability.md §8 已知局限`**：新增「click 策略未覆盖场景（v0.0.159 有意留白，后续按失败率调优）」小节，显性化 5 条 open-codex 未移植路径（`descendantClickCandidates` / `clickActionPoints` / `canUseActivationOnlyClickFallback` / `selectContainingListItem` / `isLikelySyntheticSideAction`）。
- **根因**：v0.0.105 单步 AXPress-only 策略对 Electron/Chromium web content 空转（AX 返 `.success` 但 React onClick / DOM 未触发），WorkBuddy / wb-clone / Lark / Feishu 场景实证。**方案**：参考 `refs/open-codex-computer-use` 移植 web row 6 层祖先 AXPress + AX action 多步序列，独立策略层 `ClickStrategy.swift`。**TS 侧完全不动**（tools/actions/click.ts / native-port.ts / addon.cc 均不改）。
- **收尾偏离**（doc-sync 记录，详 `specs/tech/version_logs/v0.0.159/change_plan.md` 尾注）：① `testTarget` → `executableTarget RockyComputerCoreTestRunner`（本机 CLT 缺 XCTest.framework）；② build-native.sh 加 `--product RockyComputerCore` 过滤；③ AccessibilityHelperTests 未建（AXUIElement 无 mock 途径，附录允许）。

详情：`specs/tech/version_logs/v0.0.159/log.md` + `change_plan.md`

## 2026-07-16 · v0.0.157（ComputerScreenshotResult.data 不再 inline 进 ImageBlock）

- **`[P1]computer_native_capability.md §2`**：`ComputerScreenshotResult.data` 注释从「直接进 `ImageBlock.source.data`」改为「tool 经 `saveSnapshot` 落盘 + 路径文本（不再 inline 进 ImageBlock.source.data）」。`native-port-types.ts:208` 顶部注释同步改写。**ComputerNativePort 接口 + 数据形状未改**（仍是 `{ok, mediaType?, data?(裸 base64), width?, height?, windowBounds?, scaleFactor?, reason?}`）——只是消费方（tool 层）从 `wrapScreenshot → ImageBlock` 改为 `saveSnapshot → 路径文本`。**根因**：纯文本模型（M3）不支持 image block → provider 400（详见 `../tools/log.md` 同版本块 + `specs/tech/version_logs/v0.0.157/log.md`）。

详情：`specs/tech/version_logs/v0.0.157/log.md` + `change_plan.md` + `../tools/log.md`（主变更）

## 2026-07-10 · v0.0.105（新建 platform KB — computer native capability；pivot 后）

- **新建 `index.md`**（本目录总起）+ **新建 `[P1]computer_native_capability.md`**（computer use 平台原生能力权威）。**删** `[P1]computer_driver.md`（旧 spawn Swift helper 方案，pivot 全废）。
- **架构 pivot**：真机 dogfood 发现裸 spawn Swift helper 子进程拿不到 macOS TCC 权限（TCC 按进程签名身份判定）。废除「ConnectorManager → spawn helper → IPC session」三层，改为「Rocky Electron 主进程注入 `ComputerNativePort` → server tool 直调 port」。memory `macos-tcc-spawn-no-perm-use-electron-host`。
- **`ComputerNativePort`**（纯 TS 接口，server 零 electron）：11 能力（checkPermissions/screenshot/getAppState/readAxTree/listApps + click/type/scroll/pressKey/drag/setValue/performSecondaryAction）；`native-port.ts`（行为契约）+ `native-port-types.ts`（数据形状，拆出控体量）。截图结果字段 `mediaType`（非 mime）。
- **主进程实现 = native addon**（`app/computer-native/` Swift dylib + N-API），继承主进程 TCC 身份；ScreenCaptureKit 单窗口截图 + AXUIElement + CGEvent postToPid。**绝不 spawn helper**。
- **三态注入 precedence**：`resolveMockComputerNativePort ?? resolveLoopbackComputerNativePort ?? getComputerNativePort()`（AT mock / dev loopback 127.0.0.1+token / packaged registry 直调）；两处 deps 组装点注入 ctx.config（router.sessionDeps + bootstrap.setResolveConfig 闭包，BUG-001）。
- **坐标 = window-relative 三段式**（`pixel/scaleFactor + windowBounds.origin`）；element_index 主（AX 零像素数学）/ coordinate 辅。
- 已知局限：listApps 仅运行态 app（NSWorkspace `.regular`）；已装/近期 app 枚举 = 未来 mdfind 扩展。
- 蓝本：iFurySt open-codex（`specs/research/v0.0.105-cu-ifuryst-open-codex.md`）。

详情：`specs/tech/version_logs/v0.0.105/change_log.md` + `change_plan_v2.md` + `change_plan_v2_batch2.md`
