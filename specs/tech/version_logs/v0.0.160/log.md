---
type: log
title: v0.0.160 变更记录 — computer-use 全面对齐 open-codex（17 项 gap 全闭合）
version: v0.0.160
updated: 2026-07-16
---

# v0.0.160 变更记录

**主题**：computer-use 全面对齐 open-codex 17 项 gap（用户裁决「不创新、全对齐」，3 必移植 + 6 值得移植 + 8 可选，逐字迁移）。承接 v0.0.159 已交付 `ClickStrategy` 策略层 + `AccessibilitySnapshot.rawActions/copyParent/hasAncestorRole`，本版本**增量扩展、不重写**。

**关联文件**：`change_plan.md`（method 级契约，架构期冻结）+ `../../agent/platform/[P1]computer_native_capability.md`（现状 spec）+ `../../agent/platform/log.md`（KB 位置轴 log）。

## 交付一览

| 层 | 新增 | 修改 |
|---|---|---|
| Swift（`app/computer-native/swift/Sources/RockyComputerCore/`） | 25 文件新增（33 文件 top-level 平铺共 6912 行） | 6 文件扩展（AccessibilitySnapshot / ClickStrategy / Service / Support / KeyMapping 无变 / Screenshot 无变） |
| Swift UT（executable runner） | 6 Block 分文件（Block1-6Tests.swift），累计 419 asserts 全绿 | main.swift 加 6 行 runBlockNTests() 调用 |
| TS bridge（`app/server/src/platform/computer/` + `app/electron/src/`） | 无新文件 | `native-port.ts` `ComputerErrorCode` +`state_unavailable`；`native-port-types.ts` `AxTreeOptions.textLimit: number\|'max'` + `AppInfo` 加 4 optional 字段；`schema.ts` `text_limit` oneOf + secondary_action 说明；`target.ts::resolveAxOptions` 'max' 分支；`actions/type-text.ts` + `set-value.ts` 加 state_unavailable 友好文案；`actions/list-apps.ts` 用 line 优先；`electron/computer-native-{addon,port,types}.ts` code 透传链 |
| 打包（`app/electron/electron-builder.yml`） | 无 | `mac.extendInfo.NSMetadataQueryUsageDescription`（Spotlight 权限声明，中英双语） |
| TS UT | 无新文件 | `target.test.ts` +5 / `computer.test.ts` +8 / `computer-native-port.test.ts` +3 覆盖新语义 |
| Spec | `version_logs/v0.0.160/{change_plan.md, log.md}` | `[P1]computer_native_capability.md` §2/§5/§6/§6.1/§8 更新；`platform/log.md` 加 v0.0.160 块 |

## 17 gap 闭合摘要（详见 change_plan.md 17-item 索引表）

| Gap# | 主题 | 落点 |
|---|---|---|
| 1 | type_text 三段式（必） | `TypeTextStrategy.swift` 三段式 + Service.type stateUnavailable |
| 2 | click activation-only（必） | `ClickHitTest.canUseActivationOnlyClickFallback` + `activateClickTarget`（AXRaise+kAXMain+kAXFocused）+ `performAXClickSequence` ⑤层 |
| 3 | scroll AX-first（必） | Service.scroll `integralScrollPageCount + rec.rawActions AXScroll<Dir>ByPage` 命中走 AX；否则 CGEvent |
| 4 | descendantClickCandidates | `ClickHitTest.descendantClickCandidates` 3 层子树扫 + `clickPriority`/`frameArea` 排序 |
| 5 | coordinate click 双候选 | `ClickCoordinateHitTest.clickCandidates` (`bestElement + hitTestElement` 去重) |
| 6 | recoverVisibleWindow | `WindowRecovery.swift` recoverVisibleWindow + `AccessibilitySnapshot.build` 集成（focused nil → recover → 重查 → 仍 nil throw stateUnavailable） |
| 7 | isLikelySyntheticSideAction filter | `ClickHitTest.isLikelySyntheticSideActionCandidate` trailing-band + compact + 关键词 |
| 8 | selectContainingListItem | `ClickHitTest.selectContainingListItem` + `performPreferredClick` 左键前置 |
| 9 | stateUnavailable 错误分类 | Swift `ComputerUseError.stateUnavailable(String)` + TS `ComputerErrorCode` `'state_unavailable'` + tool actions 友好文案 |
| 10 | Spotlight recent apps | `AppDiscovery.swift` + `SpotlightAppIndex.swift` + `electron-builder.yml NSMetadataQueryUsageDescription` |
| 11 | SoftwareCursorOverlay 视觉光标 | `SoftwareCursorOverlay*` 4 + `CursorMotion*` 8 + `SoftwareCursorGlyphRenderer` 1 = 13 文件（**Service 未集成，默认关**，见 G-6 决策） |
| 12 | FixtureBridge | `FixtureBridge.swift` bridge only（fixture app + XCTest 推迟单独版本） |
| 13 | AX 树精细化 render | `TreeRenderer.swift` + `TreeRendererSegments/Helpers/Summary.swift` 4 文件；`AccessibilitySnapshot.build` 换调 TreeRenderer |
| 14 | ElementRecord 三字段扩展 | `ElementRecord` 加 `identifier / isSyntheticText / prettyActions`；walk 采 `kAXIdentifierAttribute` |
| 15 | text_limit "max" | Swift `SnapshotTextLimit`；TS `number\|'max'` union；tool schema oneOf；`resolveAxOptions` max 分支 |
| 16 | set_value 后 sleep | Service.setValue 尾 `Thread.sleep(0.1)` |
| 17 | pretty actions 别名 | `ServiceHelpers.matchingAction` 两级 match（rawActions exact → prettyActions 反查）；tool schema secondary_action 说明双写法 |

## 关键实施决策（架构原则外的实施偏离，doc-modifier 收尾归档）

### G-6：光标 overlay Service 集成推迟（用户裁决）

**背景**：change_plan.md 模块 G 第 6 行 `service | Service.swift click/setValue 光标 overlay 集成` 未实施。

**决策（v0.0.160 收尾定）**：光标 API 全套（3 public 入口 + `@MainActor` 主线程隔离 + `VisualCursorSupport.isEnabled` env guard + 66 UT asserts）**就位并默认关**（`ROCKY_CU_VISUAL_CURSOR` 未设 = 关）；**Rocky Service.click / setValue 未集成**——需真机 dogfood 验证 Rocky Electron/多显示器场景后单独版本一起做。

**理由**：（1）默认关状态下即使集成也自动 no-op，但 Service 侧代码路径变化本身需回归；（2）用户明确本版本不 dogfood 视觉光标；（3）保住 Service.swift 295 行未逼近 300 硬约束。

**未来集成方式（记录，本版本不做）**：`Service.click` 内 CGEvent post 前后调 `SoftwareCursorOverlay.moveVisualCursor + pulseVisualCursor`；`Service.setValue` 内调 `moveVisualCursor + settleVisualCursor`；均 fire-and-forget 不 await（否则阻塞 addon N-API 回调）。

### 文件拆分（change_plan G-1 建议 9 → 实际 13）

- SoftwareCursorOverlay 主 enum + Rocky wrapper 后单文件仍 >300 → 拆 `SoftwareCursorOverlaySupport / SoftwareCursorOverlay / SoftwareCursorOverlayAnimation / SoftwareCursorOverlayRendering` 4 文件
- CursorMotionModel 1506 行按 open-codex `MARK: -` 边界拆 5 文件时 HeadingDriven 主体仍 >300 → 拆 `CursorMotionPath / Geometry / Spring / Official / HeadingDriven / Descriptors / Metrics / VisualDynamics` 8 文件
- SwiftPM 一律 top-level 平铺（避免「multiple producers」冲突）

所有拆分维护 open-codex 逐字对齐、无语义偏差。

### TreeRenderer 拆分（change_plan F 建议 2 → 实际 4）

Helpers 单文件预估 380 行超硬约束 → 拆 `TreeRenderer / TreeRendererSegments / TreeRendererHelpers / TreeRendererSummary` 4 文件保各 ≤ 300。

### AccessibilitySnapshot.records 类型改（改契约 + 兼容处理）

- 类型 `[ElementRecord]` → `[Int: ElementRecord]`（对齐 open-codex 索引 map 语义）
- Service.readAxTree / getAppState 已删 Dictionary 转换 + `nodes` 输出改 `values.sorted{$0.index<$1.index}.map`
- CBridge 序列化保稳定输出

### AppInfo 加 4 optional 字段（H-4 + J-6 联动）

- Swift `Applications.list()` 输出 dict 加 `line / isFrontmost / lastUsed / uses` 同名字段
- TS server 侧 `AppInfo` + electron 侧 `NativePortAppInfo` 镜像加 optional 字段，向后兼容
- tool `list_apps` 消息头改「未发现可控 app」（原「未发现运行中的可控 app」措辞已不准）

### AXUIElement 无 mock — UT 覆盖策略

- pure math / 纯字符串 / 几何 / 排序 / Codable roundtrip：UT 覆盖（Block1-6 累计 419 asserts）
- AX-dep 函数（`copyParent` / `hasAncestorRole` / `AXUIElementPerformAction` / `descendantClickCandidates walk` / `WindowRecovery.recoverVisibleWindow` 集成路径 / `TreeRenderer` 真实 AX 输出）：**依 dev dogfood 手验**（Rocky 惯例）
- TreeRenderer LLM 视角变化 → 下游需 6+ 场景手验（Safari/Finder/Xcode/VSCode/Lark/WorkBuddy）

### Rocky 命名空间适配（守 Rocky 品牌）

- 视觉光标 env：`ROCKY_CU_VISUAL_CURSOR`（open-codex `OPEN_COMPUTER_USE_VISUAL_CURSOR`）；**默认关**（open-codex 默认开）
- 通知名：`com.rocky.agent.turn-ended`（open-codex `com.ifuryst.opencomputeruse.turn-ended`）
- Fixture appName：`RockyComputerUseFixture`（open-codex `OpenComputerUseFixture`）
- Fixture 分布式通知：`com.rocky.computer-use.fixture.command`（open-codex `dev.opencodex...`）
- Fixture stateFile 目录：`rocky-computer-use-fixture`（open-codex `open-computer-use-fixture`）
- 光标 public API：`moveVisualCursor / pulseVisualCursor / settleVisualCursor`（Rocky 命名）；内部保留 open-codex 逐字 `moveCursor / pulseClick / settle / reset`

### `WindowRecovery.openBundleIdentifier` API 替代（架构原则 5「不 spawn 子进程」守护）

change_plan B-9 参考 open-codex `NSWorkspace.shared.open(bundleIdentifier:configuration:completionHandler:)`——该签名在现代 macOS SDK 中不存在（deprecated `launchApplication(withBundleIdentifier:)`）。实现改用 `urlForApplication(withBundleIdentifier:) + openApplication(at:configuration:completionHandler:)` + DispatchSemaphore 0.5s timeout，语义等价（找不到/timeout 返 false），**保「不 spawn 子进程」承诺**。

## 验证水位

- Swift UT：`swift run --package-path app/computer-native/swift RockyComputerCoreTestRunner` — 419 asserts 全绿
- Swift release build：`bash app/computer-native/scripts/build-native.sh` — dylib + .node 就位
- TS：`bun run typecheck` 全绿；`bun --bun x vitest run app/server/src/tools/computer-use/target.test.ts app/server/src/tools/computer-use/computer.test.ts app/electron/src/computer-native-port.test.ts` — 72/72 全绿
- AT/ET：本版本纯 native 层增强 + tool schema/actions 微改；无新 LLM 不确定性场景 / 无新板块 → **不新增 AT/ET case**（用户铁律「普通 feature 一律不新增 AT/ET」），依 UT + dev dogfood 冒烟集回归覆盖
- code-review：CONDITIONAL PASS（Minor 已直接修复，含 B-10 `WindowRecovery` 集成补丁）

## 关联文档

- 现状：`../../agent/platform/[P1]computer_native_capability.md` §2 数据形状 / §5 Swift 文件表 / §6 坐标模型 / §6.1 视觉光标 / §8 已知局限（全条更新）
- KB 位置轴：`../../agent/platform/log.md`（v0.0.160 块）
- 方法级契约：`change_plan.md`（12 模块 111 method 级行）
- 调研蓝本：`specs/research/v0.0.159/{overview.md, actions-diff.md, architecture-diff.md}`
- open-codex 源：`refs/open-codex-computer-use/packages/OpenComputerUseKit/Sources/OpenComputerUseKit/`
