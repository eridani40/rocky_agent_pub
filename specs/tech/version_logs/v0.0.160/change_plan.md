# v0.0.160 变更计划书 — computer-use 全面对齐 open-codex（17 项 gap）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> **主题**：computer-use 17 项 gap 全面对齐 open-codex（3 必移植 + 6 值得移植 + 8 可选，用户裁决全做）。承接 v0.0.159 已交付 `ClickStrategy` 策略层 + `AccessibilitySnapshot` rawActions/copyParent/hasAncestorRole，本版本**增量扩展、不重写**。

## 架构原则（不可偏离）

1. **逐字对齐 open-codex，不创新**：函数命名 / 算法 / 参数 / 注释注解一律照抄；只在必要粘合层（TS ↔ Swift bridge、error code 映射、Rocky electron 集成）做适配。
2. **tool schema 层不动**（用户裁决 2026-07-16）：`computer` 保持单 tool + action-discriminated（**不拆 11 独立 tool**）；MCP annotations 不引入；`schema.ts` 结构不改，只扩 `text_limit` 类型。
3. **v0.0.159 已交付函数保留不重命名**：`shouldPreferContainingWebRowAXClick` / `performContainingWebRowClick` / `performPreferredClick` / `performAXClickSequence` 保持；仅在其之上扩展新层次（activation-only fallback / descendant / hit-test 双候选）。
4. **文件 ≤ 300 行硬约束**：`SoftwareCursorOverlay` / `TreeRenderer` / `CursorMotionModel` 拆多文件。
5. **jodges 粘合层设计**：Swift → TS 错误映射通过 `ComputerUseError.code` → `native-port.ts::ComputerErrorCode` 静态表；不引 MCP annotations；`text_limit "max"` 走「TS Union → Swift SnapshotTextLimit.maxKeyword」两侧解析。
6. **架构原则依赖注入**：本版本延续 v0.0.159 `ClickStrategy` 静态命名空间 + `AccessibilitySnapshot` 静态命名空间，不引入 `Service` 之外的实例状态（除 `SoftwareCursorOverlay` 光标动力学的 idle state）。
7. **不引入新第三方依赖**（Foundation / ApplicationServices / AppKit / CoreServices / ScreenCaptureKit / QuartzCore 均系统 framework）。

## 前置决策（用户裁决前架构建议）

### 决策 P1：项 12 FixtureBridge 环境（Xcode 缺失）

**方案 A（推荐）**：**本版本只移植 `FixtureBridge.swift` bridge 层 139 行**（Codable structs + `readState/writeState/post` DistributedNotificationCenter），**Service 侧加 `.fixture` mode 判定占位**（fixture mode 未激活时透明 no-op）；**RockyComputerUseFixture app + XCTest 全套推迟到用户装 Xcode 后单独版本**。理由：(1) FixtureBridge.swift 本体只依赖 Foundation + CoreGraphics（CLT 可编）；(2) 装 Xcode 是用户环境事，架构侧不该阻塞交付；(3) 结构落地后未来无需回改 Service 编排。**Service.click/type/scroll/... 加 `if snapshot.mode == .fixture` 分支**（当前用 dummy 常量 `.accessibility` 走原路径，未来 fixture app 就绪再实装分支体）。

方案 B：整个项 12 推迟到 Xcode 就绪。缺点：本版本 gap 未闭合、后续 refactor 阻力。

### 决策 P2：项 10 Spotlight recent apps 权限

**方案 A（推荐）**：**本版本加 Info.plist `NSMetadataQuery` 权限声明**（`NSMetadataQueryScope` 用户桌面级读，无敏感数据）；`AppDiscovery` 走 `NSMetadataQuery` + `kMDItemLastUsedDate_Ranking`/`kMDItemUseCount` 合并运行中排序，未安装权限时降级为**仅运行中 app**（既有行为）。理由：(1) 用户明确「17 项全做」；(2) Spotlight 索引是标准 macOS API，`NSMetadataQuery` 无 TCC 二次授权（读用户目录 metadata 无需弹窗）；(3) 降级路径已存在。**Info.plist 由 orchestrator 授权直接改**（memory `orchestrator-can-edit-devconfig-plugin-ext`）。

方案 B：推迟。缺点：项 10 空跑。

## 引用符号核对状态（architect grep 已确认存在）

- `kAXRaiseAction` / `kAXMainAttribute` / `kAXFocusedAttribute` / `kAXWindowRole` / `kAXListRole` / `kAXSelectedChildrenAttribute` / `kAXFocusedUIElementAttribute` / `kAXPlaceholderValue`（无常量、走裸字符串）/ `kAXIdentifierAttribute` / `kAXDescriptionAttribute` / `kAXHelpAttribute` / `kAXTextFieldRole` / `kAXStaticTextRole` / `kAXSubroleAttribute` / `kAXRoleDescriptionAttribute` / `kAXRowRole` / `kAXSelectedAttribute` / `kAXExpandedAttribute`：均系统标准常量（Xcode SDK / ApplicationServices.framework）。
- `AXUIElementCopyElementAtPosition` / `AXUIElementCreateSystemWide`：ApplicationServices 系统 API。
- `NSMetadataQuery` / `kMDItemContentType` / `kMDItemLastUsedDate_Ranking` / `kMDItemUseCount`：CoreServices/Foundation 系统 API（`import CoreServices`）。
- `DistributedNotificationCenter.default().postNotificationName`：Foundation 系统 API。
- `NSRunningApplication.unhide()` / `.activate(options:)`：AppKit 现有 API。
- 现存符号：`AccessibilitySnapshot.copyParent` / `hasAncestorRole` / `frameOf` / `rawActionsOf` / `stringAttr` / `childrenOf`（v0.0.159 已建）；`ClickStrategy.hasPrimaryClickAction` / `isLikelyContainingRowActionFrame` / `performAction` / `performContainingWebRowClick` / `performPreferredClick` / `performAXClickSequence`（v0.0.159 已建）；`ElementRecord.rawActions`（v0.0.159 已建）。
- **注意 gap**：`ComputerUseError.stateUnavailable` 不存在（本版本 A-1 新增）；`ComputerNativePort.ComputerErrorCode` 不含 `state_unavailable`（本版本 J-1 新增）；`ElementRecord.identifier/isSyntheticText/prettyActions` 不存在（本版本 B-2 新增）；`SnapshotTextLimit` 类型不存在（本版本 B-6 新增）；`AppDiscovery` / `SoftwareCursorOverlay` / `CursorMotionModel` / `SoftwareCursorGlyphRenderer` / `FixtureBridge` 均不存在（本版本新建）。

## 17 项 gap → method 级行索引

| Gap# | 主题 | 覆盖行（模块-行号） |
|---|---|---|
| 1 | type_text 三段式（必移植） | E-1, E-2, E-3, E-4, E-5, E-6 |
| 2 | click activation-only fallback（必移植） | C-8, C-9, C-10, C-11 |
| 3 | scroll AX-first 路径（必移植） | E-9, E-10 |
| 4 | descendantClickCandidates | C-1, C-2, C-3, C-4 |
| 5 | coordinate click 双候选 | D-1, D-2, D-3, D-4, D-5, D-6 |
| 6 | recoverVisibleWindow | B-9, B-10 |
| 7 | isLikelySyntheticSideAction filter | C-5, C-6 |
| 8 | selectContainingListItem | C-7 |
| 9 | stateUnavailable 错误分类 | A-1, A-2, J-1 |
| 10 | Spotlight recent apps | H-1, H-2, H-3, H-4, H-5 |
| 11 | SoftwareCursorOverlay 视觉光标 | G-1, G-2, G-3, G-4, G-5, G-6 |
| 12 | FixtureBridge | I-1, I-2, I-3, I-4 |
| 13 | AX 树精细化 render | F-1, F-2, F-3, F-4, F-5, F-6, F-7, F-8 |
| 14 | ElementRecord 字段扩展 | B-2, B-3 |
| 15 | text_limit "max" 语法 | B-6, B-7, B-8, J-2, J-3 |
| 16 | set_value 后 sleep | E-11 |
| 17 | pretty actions 别名 | E-7, E-8 |

---

## 模块 A：错误分类扩展（Support.swift + TS 错误码映射） — gap#9

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| errors | app/computer-native/swift/Sources/RockyComputerCore/Support.swift | `ComputerUseError.stateUnavailable(String)` case | A | 新增 case（对齐 open-codex `Errors.swift:11`）：语义 =「元素还在但没坐标 / 元素消失 / 无 backing AX object」等运行时状态问题，与 `.message` 通用错误区分 | 只加 case，不改现有 6 case 语义；case body 类型 `String`（message payload） | open-codex Errors.swift:11；research architecture-diff.md §5.3 | +1 |
| errors | app/computer-native/swift/Sources/RockyComputerCore/Support.swift | `ComputerUseError.code` / `.text` | M | `code` switch 加 `.stateUnavailable → "state_unavailable"`；`text` switch 加 `.stateUnavailable(m) → m`（直接透传 message，对齐 open-codex `errorDescription`） | code 字符串必须与 J-1 的 TS `ComputerErrorCode` 值 `'state_unavailable'` 逐字一致 | 对齐 native-port.ts::ComputerErrorCode | +2 |

---

## 模块 B：AccessibilitySnapshot 增强（ElementRecord + text_limit + recover） — gap#6, #14, #15

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ax_snapshot | app/computer-native/swift/Sources/RockyComputerCore/AccessibilitySnapshot.swift | `ElementRecord.identifier: String?` | A | 新增字段，采集 `AXIdentifier` 属性（`kAXIdentifierAttribute`）；未采集/空返 nil | 存 raw AXIdentifier 不做展示归一（open-codex `AccessibilitySnapshot:686`） | open-codex `ElementRecord:9`；architecture-diff.md §4.1 | +1 |
| ax_snapshot | app/computer-native/swift/Sources/RockyComputerCore/AccessibilitySnapshot.swift | `ElementRecord.isSyntheticText: Bool` | A | 新增字段（默认 false）；由 F 模块 `TreeRenderer.renderSyntheticText` 折叠短文本合成节点时置 true | 仅 renderer 合成节点写 true，walk 路径始终 false（保 v0.0.159 语义等价） | open-codex `ElementRecord:14`；architecture-diff.md §4.1 | +1 |
| ax_snapshot | app/computer-native/swift/Sources/RockyComputerCore/AccessibilitySnapshot.swift | `ElementRecord.prettyActions: [String]` | A | 新增字段：`rawActions` 的人类可读别名（如 `AXPress → Press`），供 `Service.performSecondaryAction` 两级 match | 由 F 模块 `meaningfulActions(rawActions, role)` 计算填入；F 模块未启用前 = rawActions 原样透传（保后向兼容） | open-codex `AccessibilitySnapshot:689`；architecture-diff.md §4.1 | +1 |
| ax_snapshot | app/computer-native/swift/Sources/RockyComputerCore/AccessibilitySnapshot.swift | `ElementRecord` init | M | 加三新字段构造参数：`identifier: String? = nil, isSyntheticText: Bool = false, prettyActions: [String] = []`（默认空保 v0.0.159 兼容） | 保持既有 walk 路径不改；F 模块启用后 walk 路径填 identifier + prettyActions | 兼容 v0.0.159 | +3 |
| ax_snapshot | app/computer-native/swift/Sources/RockyComputerCore/AccessibilitySnapshot.swift | `walk(_:depth:...)` | M | 采集 `stringAttr(element, kAXIdentifierAttribute)` 填 `identifier`；`prettyActions` 暂用 `rawActions` 透传（等 F 模块 `meaningfulActions` 就绪切换） | 不动 render text 输出，避免 LLM 视角回归；F 模块启用前 prettyActions = rawActions | 对齐 open-codex `TreeRenderer.render:686-689` | +3 |
| ax_snapshot | app/computer-native/swift/Sources/RockyComputerCore/AccessibilitySnapshot.swift | `SnapshotTextLimit` struct | A | 值类型 `let maxCount: Int?`（nil = 无上限）；静态 `defaults`(500) / `max`(nil) / `maxKeyword = "max"`（字符串常量） | 逐字对齐 open-codex `AccessibilitySnapshot:67`；`init(maxCount: Int)` precondition `> 0`；私有 `init(maxCount: Int?)` 供 `.max` 单例用 | open-codex `SnapshotTextLimit`；actions-diff.md §1.3 | +14 |
| ax_snapshot | app/computer-native/swift/Sources/RockyComputerCore/AccessibilitySnapshot.swift | `build(pid:bundleId:textLimit:maxNodes:maxDepth:)` | M | `textLimit` 参数改为 `SnapshotTextLimit`（原 `Int` deprecated 别名 `Int` 走 `SnapshotTextLimit(maxCount:)` 内部转换）；walk / truncate 内消费 `textLimit.maxCount ?? Int.max` | MUST 后向兼容：Service 侧调用签名不变（Int 传入自动 wrap 为 SnapshotTextLimit）；J-3 TS bridge 把 "max" 字符串 → nil 直接透传 | actions-diff.md §1.3；对齐 open-codex `SnapshotBuilder.build` | +6/-2 |
| ax_snapshot | app/computer-native/swift/Sources/RockyComputerCore/AccessibilitySnapshot.swift | `truncate(_:limit:)` | M | 支持 `limit == Int.max` 直接跳过截断（即 "max" 无上限语义） | 保原短路：`s.count > limit` false 则原样返回 | 对齐 SnapshotTextLimit 消费 | +1 |
| ax_snapshot | app/computer-native/swift/Sources/RockyComputerCore/AccessibilitySnapshot.swift | `recoverVisibleWindow(for:appElement:preferredWindow:) -> Bool` | A | 尝试恢复被隐藏 / 最小化的窗口：`NSRunningApplication(pid).unhide()` → `.activate(options:.activateAllWindows)` → `NSWorkspace.shared.open(URL(fileURLWithPath:"/usr/bin/open"))` bundle → `AXUnminimize` set false → `kAXMainAttribute=true` / `kAXFocusedAttribute=true`。任一成功 `recovered = true`，末尾 sleep 0.7s | 逐字对齐 open-codex `AccessibilitySnapshot:245-269`；MUST **不** spawn 独立 `/usr/bin/open`（保 Rocky 「不 spawn 子进程」承诺，改用 `NSWorkspace.shared.open(bundleIdentifier:configuration:completionHandler:)` API 等价路径） | open-codex `recoverVisibleWindow`；架构原则 5 | +25 |
| ax_snapshot | app/computer-native/swift/Sources/RockyComputerCore/AccessibilitySnapshot.swift | `build` 内窗口失联分支 | M | 现走 `AXUIElementCreateApplication(pid)` 后无窗口自愈；新增：首次 `focusedWindow == nil` 时调 `recoverVisibleWindow`，成功后重试一次 focused window 查找；仍失败 throw `.stateUnavailable(computerUseNoWindowFoundMessage)` | 常量 `computerUseNoWindowFoundMessage` 从 open-codex `Errors.swift:3` 迁入（value = `"Apple event error -10005: cgWindowNotFound"`） | open-codex `SnapshotBuilder.build:160-168` | +8 |

---

## 模块 C：ClickStrategy 3-level fallback 扩展 — gap#2, #4, #7, #8

> **注意**：v0.0.159 已交付 `performContainingWebRowClick` / `performPreferredClick` / `performAXClickSequence` / `hasPrimaryClickAction` / `isLikelyContainingRowActionFrame`；本模块**扩展**（不重写），加 activation-only / descendant / hit-test 三层 fallback，编排接入既有 `performAXClickSequence`。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| click_strategy | app/computer-native/swift/Sources/RockyComputerCore/ClickStrategy.swift | `descendantClickCandidates(of:windowBounds:depth:) -> [ElementRecord]` | A | 3 层子树扫（`depth < 3` 硬约束）：`AccessibilitySnapshot.childrenOf(element)` 递归取 rawActions + frame 构造 `ElementRecord`（index=-1, identifier=nil, isSyntheticText=false）；返回全部候选（排序由调用方做） | 逐字对齐 open-codex `ComputerUseService:1073-1095`；只用 raw AX API 不查缓存 | open-codex `descendantClickCandidates:1073`；actions-diff.md §1.4 ② | +22 |
| click_strategy | app/computer-native/swift/Sources/RockyComputerCore/ClickStrategy.swift | `descendantClickCandidates(for:snapshot:sideActionScope:) -> [ElementRecord]` | A | 上层 wrapper：调 depth=0 版本 + `filter { !isLikelySyntheticSideAction($0, in: sideActionScope ?? record) }` + `sorted { clickPriority ASC, frameArea ASC }` | `snapshot` 传 windowBounds；side action scope 逐字对齐 open-codex `ComputerUseService:1048` | 同上 | +18 |
| click_strategy | app/computer-native/swift/Sources/RockyComputerCore/ClickStrategy.swift | `clickPriority(for:) -> Int` | A | 静态：rawActions 含 primary AXPress/AXConfirm/AXShowMenu/AXRaise → 0；否则 element 可 set kAXMainAttribute/kAXFocusedAttribute → 1；否则 2 | 逐字对齐 open-codex `ComputerUseService:1005-1022`；供 descendant 与 bestElement 排序共用 | open-codex `clickPriority:1005` | +18 |
| click_strategy | app/computer-native/swift/Sources/RockyComputerCore/ClickStrategy.swift | `frameArea(of:) -> CGFloat` | A | frame nil → `.greatestFiniteMagnitude`；否则 `width * height` | 简单几何，供排序 | open-codex `frameArea:1024` | +6 |
| click_strategy | app/computer-native/swift/Sources/RockyComputerCore/ClickStrategy.swift | `accessibilityLabels(for:) -> [String]` | A | element 依次读 `kAXTitleAttribute` / `kAXDescriptionAttribute` / `kAXHelpAttribute` / `kAXValueAttribute` / `"AXIdentifier"`；非 nil compactMap | 逐字对齐 open-codex `ComputerUseService:1206-1220` | 同上 | +8 |
| click_strategy | app/computer-native/swift/Sources/RockyComputerCore/ClickStrategy.swift | `isLikelySyntheticSideAction(_ candidate:in parent:) -> Bool` | A | Wrapper 转纯函数 `isLikelySyntheticSideActionCandidate(parentFrame,candidateFrame,hasPrimaryAction,labels)`：trailing-band ≥ maxX-`min(max(parentWidth*0.22,56),140)`；compact = `width ≤ max(88,parentWidth*0.18)` && `height ≤ max(44,parentHeight*1.2)`；label 含「完成/done/complete/archive」或 「mark…(done\|complete)」→ hasSideActionLabel；三条件组合返 true/false | 逐字对齐 open-codex `ComputerUseService:191-235`；参 accessibilityLabels + hasPrimaryClickAction；纯几何+字符串，供 UT 覆盖 | open-codex `isLikelySyntheticSideActionCandidate:191`；actions-diff.md §1.4 附属 | +48 |
| click_strategy | app/computer-native/swift/Sources/RockyComputerCore/ClickStrategy.swift | `selectContainingListItem(for:) throws -> Bool` | A | 从 element 向上 8 层 copyParent，找 `role == kAXListRole && isSettable(kAXSelectedChildrenAttribute)`；找到即 `AXUIElementSetAttributeValue(list, kAXSelectedChildrenAttribute, [directChild] as CFArray)`；`.success` → sleep 0.15 + return true；容忍失败 → false；未知 → throw `.message` | 逐字对齐 open-codex `ComputerUseService:769-811`；只对左键单击、非 web area 调用（编排在 performPreferredClick 内） | open-codex `selectContainingListItem:769` | +32 |
| click_strategy | app/computer-native/swift/Sources/RockyComputerCore/ClickStrategy.swift | `canUseActivationOnlyClickFallback(role:) -> Bool` | A | `role == kAXWindowRole as String` 返 true；否则 false | 逐字对齐 open-codex `ComputerUseService:277-283` | 同上 | +6 |
| click_strategy | app/computer-native/swift/Sources/RockyComputerCore/ClickStrategy.swift | `activateClickTarget(element:availableActions:) throws -> Bool` | A | 尝试三步任意成功即 true：`performAction(kAXRaiseAction, ...)` → `setBoolAttribute(kAXMainAttribute)` → `setBoolAttribute(kAXFocusedAttribute)` | 逐字对齐 open-codex `ComputerUseService:924-940`；三步独立 `||` 累积，非短路 | open-codex `activateClickTarget:924`；actions-diff.md §1.4 ① | +15 |
| click_strategy | app/computer-native/swift/Sources/RockyComputerCore/ClickStrategy.swift | `setBoolAttribute(named:on:) throws -> Bool` | A | `AXUIElementSetAttributeValue(element, attribute as CFString, kCFBooleanTrue)`：`.success → true`；`.failure/.attributeUnsupported/.actionUnsupported/.cannotComplete/.noValue/.invalidUIElement/.illegalArgument → false`；其他 → throw `.message` | 逐字对齐 open-codex `ComputerUseService:942-952`；与 performAction 同错误处理模式 | 同上 | +14 |
| click_strategy | app/computer-native/swift/Sources/RockyComputerCore/ClickStrategy.swift | `performPreferredClick(record:button:clickCount:)` | M | 左键分支加前置：`clickCount <= 1 && !hasAncestorRole("AXWebArea", of: record.element)` 时先 `selectContainingListItem(for: record.element)` 成功即 return true；其余不变（保 v0.0.159 AXPress→AXConfirm→AXOpen 序列） | 逐字对齐 open-codex `ComputerUseService:707-741`；不破 v0.0.159 已交付语义 | 参考 open-codex `performPreferredClick:707` | +6 |
| click_strategy | app/computer-native/swift/Sources/RockyComputerCore/ClickStrategy.swift | `performAXClickSequence(record:bundleId:appName:button:clickCount:includeNearbyHitTesting:allowActivationFallback:) throws -> Bool` | M | **签名扩展** 加两 bool 参数（默认 `includeNearbyHitTesting=true, allowActivationFallback=true`，保 v0.0.159 调用点不改）；主编排改为：① web row 优化（未变）→ ② 未走 web row 时先 `performPreferredClick`（未变）→ ③ 加 `descendantClickCandidates(for:snapshot:sideActionScope:nil)` 循环尝试 `performPreferredClick` → ④ `includeNearbyHitTesting` 时对 `clickActionPoints(for:)` 每点 `hitTestElement(at:) ?? bestElement(containing:)` 拿候选，过 `isLikelySyntheticSideAction` filter，再 `performPreferredClick` → ⑤ `allowActivationFallback && !record.isSyntheticText && button==.left && canUseActivationOnlyClickFallback(role)` → `activateClickTarget` | 逐字对齐 open-codex `performAXClickSequence:813-897`；MUST 保留原 web row + preferred 两层入口不改；每 sleep 0.15 命中即 return true；hit-test / snapshot 依赖由 Service 侧传入（见 D 模块） | open-codex `performAXClickSequence:813`；actions-diff.md §1.4 | +48/-4 |
| click_strategy | app/computer-native/swift/Sources/RockyComputerCore/ClickStrategy.swift | `clickActionPoints(for record:) -> [CGPoint]` | A | 由 `clickFrame(for record:)` 拿 target frame（`isSyntheticText` 且非 web area 时向上找 row frame，否则 record.screenFrame）→ 若 `isSyntheticText` 只返 leading 点；否则 `abs(leading.x - center.x) < 1` → 单 center；否则 `[center, leading]` | 逐字对齐 open-codex `localClickActionPoints:159-189` + `clickActionPoints:1040`；leading = frame.minX + min(24, frame.width*0.3) | open-codex `clickActionPoints:1040`；actions-diff.md §1.4 附属 | +24 |
| click_strategy | app/computer-native/swift/Sources/RockyComputerCore/ClickStrategy.swift | `shouldScanDescendantsOfHitRecord(originalFrame:hitFrame:) -> Bool` | A | hitArea > `max(originalArea*12, 20_000)` → false；hitFrame 高 > `max(originalFrame.h*4, 96)` 且 宽 > `max(originalFrame.w*2, 240)` → false；否则 true | 逐字对齐 open-codex `ComputerUseService:237-255`；nil frame 默认 true | 同上 | +14 |

---

## 模块 D：coordinate click 双候选（bestElement + hitTestElement） — gap#5

> **文件拆分决策**：新增 `ClickHitTest.swift` 独立文件承载几何/hit-test helpers；`ClickStrategy.swift` 保持 ≤ 300 行（当前 280 行，模块 C 扩展后预估 350 行 → 已超 → C 模块新增函数落 `ClickHitTest.swift`，见文末决策 D-1）。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| click_hittest | app/computer-native/swift/Sources/RockyComputerCore/ClickHitTest.swift | `ClickHitTest` enum | A | 命名空间（无实例），承载：`bestElement(containing:in:) / hitTestElement(at:in:pid:) / clickCandidates(at:in:pid:) / sameElement(_:_:)`；配合 D-1 决策承接部分 C 模块 helper（若行数超限） | 与 ClickStrategy 分工：ClickStrategy=决策序列；ClickHitTest=几何 / hit-test | 架构原则 4 | +6 |
| click_hittest | app/computer-native/swift/Sources/RockyComputerCore/ClickHitTest.swift | `ClickHitTest.bestElement(containing point:in records:) -> ElementRecord?` | A | 从 records 数组（Service 传入 lastRecords.values）filter `localFrame?.contains(point)`；`sorted { lhs, rhs in clickPriority(lhs) < clickPriority(rhs) ?? frameArea(lhs) < frameArea(rhs) }`；first | 逐字对齐 open-codex `ComputerUseService:970-983`；clickPriority/frameArea 复用 ClickStrategy | open-codex `bestElement:970` | +18 |
| click_hittest | app/computer-native/swift/Sources/RockyComputerCore/ClickHitTest.swift | `ClickHitTest.hitTestElement(at point:in appElement:windowBounds:) throws -> ElementRecord?` | A | `AXUIElementCopyElementAtPosition(appElement, Float(point.x), Float(point.y), &hitElement)` → success 时构造 `ElementRecord(index:-1, identifier:nil, element:hitElement, screenFrame:frame, actions:[], rawActions:copyActions, prettyActions:copyActions, isSyntheticText:false)` | 逐字对齐 open-codex `ComputerUseService:985-1003`；appElement 由 Service 侧 `AXUIElementCreateApplication(pid)`；point = 全局屏幕点（open-codex 走 screenshotToGlobalPoint，我们已由 TS 换算好） | open-codex `hitTestElement:985` | +18 |
| click_hittest | app/computer-native/swift/Sources/RockyComputerCore/ClickHitTest.swift | `ClickHitTest.clickCandidates(at point:in records:appElement:) throws -> [ElementRecord]` | A | 组合：`bestElement(containing:) + hitTestElement(at:)` 收集非重复候选（`sameElement` 判等）；返回顺序 = bestElement first, hitTest second | 逐字对齐 open-codex `ComputerUseService:743-759`；unique 用 `CFEqual` | open-codex `clickCandidates:743`；actions-diff.md §1.4 ③ | +14 |
| click_hittest | app/computer-native/swift/Sources/RockyComputerCore/ClickHitTest.swift | `ClickHitTest.sameElement(_:_:) -> Bool` | A | 两 optional element `CFEqual(lhs!, rhs!)`；任一 nil → false | 简单 CF 判等 | 同上 | +6 |
| service | app/computer-native/swift/Sources/RockyComputerCore/Service.swift | `click(_:)` coordinate 分支 | M | 现直接 CGEvent postToPid → 改为：**① `AXUIElementCreateApplication(pid)` 拿 appElement**（Service.lastPid 走上文既有 resolvePid）→ **② `ClickHitTest.clickCandidates(at:global point, in: lastRecords.values, appElement:)` 取候选** → **③ 逐个 `ClickStrategy.performAXClickSequence(record, bundleId, appName, button, count, includeNearbyHitTesting:false, allowActivationFallback:false)` 尝试** → **④ 全失败 fallback `InputSimulation.clickTargeted`（既有 CGEvent 兜底不删）**。element_index 分支不动（v0.0.159 已过） | MUST 保留 CGEvent 兜底（memory `pkill-wide-match-kills-other-worktrees`：底层备份不删）；`includeNearbyHitTesting=false` 严格对齐 open-codex（coord 分支不再递归 hit-test） | 对齐 open-codex `click:434-482`；架构原则 3 | +16/-3 |

---

## 模块 E：Service 各 action 编排（type_text 三段 + scroll AX-first + set_value sleep + pretty） — gap#1, #3, #16, #17

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| service | app/computer-native/swift/Sources/RockyComputerCore/Service.swift | `type(_:)` | M | 三段式（对齐 open-codex `typeText:576-595`）：① 拿 `focusedElement`（`AXUIElementCopyAttributeValue(systemWide, kAXFocusedUIElementAttribute)`）→ ② `TypeTextStrategy.typeTextBySettingFocusedValueIfAvailable(text, focused)` 成功 → sleep 0.1 return → ③ `TypeTextStrategy.canTypeTextUsingKeyboardFallback(focused)` false → throw `.stateUnavailable("type_text requires a focused editable text element. Click a text entry area first, or use set_value on a settable text element.")` → ④ true → `InputSimulation.typeText`（既有路径） | MUST 逐字对齐 open-codex 报错文案；systemWide 元素查找由 Service 侧做（TypeTextStrategy 参数只吃 focused element） | open-codex `typeText:576`；actions-diff.md §1.9 | +14/-6 |
| type_strategy | app/computer-native/swift/Sources/RockyComputerCore/TypeTextStrategy.swift | `TypeTextStrategy` enum | A | 新 namespace（无实例），承载 4 helper：`typeTextBySettingFocusedValueIfAvailable / canTypeTextUsingKeyboardFallback / editableBaseValue / editableDescendantTextValues / looksLikeEditablePlaceholder / normalizeEditablePlaceholderText` | 独立文件避免 ClickStrategy / Service 超行；不复用 ClickStrategy 常量 | 架构原则 4 | +6 |
| type_strategy | app/computer-native/swift/Sources/RockyComputerCore/TypeTextStrategy.swift | `typeTextBySettingFocusedValueIfAvailable(_:in:) throws -> Bool` | A | focused element `isSettableForSetValue(kAXValueAttribute)` false → return false；调用 `editableBaseValue(for:)` 拿旧值 → `AXUIElementSetAttributeValue(focused, kAXValueAttribute, (baseValue + text) as CFString)` → `.success → true`；`.failure/.attributeUnsupported/.actionUnsupported/.cannotComplete/.noValue/.invalidUIElement/.illegalArgument → false`；其他 → throw `.message` | 逐字对齐 open-codex `typeTextBySettingFocusedValueIfAvailable:1222-1241`；`isSettableForSetValue` 复用 Service 既有 setValue 内的判定或独立静态 helper | open-codex `:1222` | +18 |
| type_strategy | app/computer-native/swift/Sources/RockyComputerCore/TypeTextStrategy.swift | `canTypeTextUsingKeyboardFallback(in:) throws -> Bool` | A | `role = stringAttr(focused, kAXRoleAttribute)`；`roleDescription = stringAttr(focused, kAXRoleDescriptionAttribute) ?? humanizedRoleDescription(for:role)`；`isValueSettable = isSettableForSetValue(kAXValueAttribute)`；调 `canUseKeyboardTextFallback(role, roleDescription, isValueSettable)`：valueSettable → true；role ∈ {AXTextField/AXTextArea/AXTextView} → true；roleDescription lowercased 含 "text field/area/entry" → true；否则 false | 逐字对齐 open-codex `canTypeTextUsingKeyboardFallback:1243-1257` + `canUseKeyboardTextFallback:285-305` | open-codex `:1243, :285` | +26 |
| type_strategy | app/computer-native/swift/Sources/RockyComputerCore/TypeTextStrategy.swift | `editableBaseValue(for:) -> String` | A | 递归 `editableDescendantTextValues(in:element, depth:0)` 过滤 placeholder → 非空 joined；否则读 `kAXValueAttribute` 归一化占位过滤 → 非 placeholder 返 raw 值 | 逐字对齐 open-codex `editableBaseValue:1272-1298` + `editableDescendantTextValues:1301-1322`；depth ≤ 4 | open-codex `:1272` | +24 |
| type_strategy | app/computer-native/swift/Sources/RockyComputerCore/TypeTextStrategy.swift | `looksLikeEditablePlaceholder(_:) / normalizeEditablePlaceholderText(_:)` | A | normalize 去 `\u{200B}` 零宽 + trim；looksLike 匹配特定 Lark 占位文本 `"沟通时请保持"公开可接受""`；用于过滤 placeholder | 逐字对齐 open-codex `:1324-1333` | 同上 | +10 |
| service | app/computer-native/swift/Sources/RockyComputerCore/Service.swift | `performSecondaryAction(_:)` | M | 现直接 `AXUIElementPerformAction(rec.element, action)`；改：先 `matchingAction(requested:action, record:rec)` 两级 match（exact rawActions case-insensitive → prettyActions 位置索引反查 rawActions 名）→ 找到则 perform → 未找到 throw `.invalidArguments("invalid secondary action '<action>' for element_index=<idx>")` | 逐字对齐 open-codex `matchingAction:691-701` + `performSecondaryAction:485-...`；不改文案（保 v0.0.105 用户契约兼容） | open-codex `:691`；actions-diff.md §1.5 | +10/-4 |
| service | app/computer-native/swift/Sources/RockyComputerCore/Service.swift | `matchingAction(requested:record:) -> String?` | A | 私有 helper：`rec.rawActions.first { $0.caseInsensitiveCompare(requested) == .orderedSame }` → 非 nil 返；否则 `zip(rawActions, prettyActions).first { $0.1.caseInsensitiveCompare(requested) == .orderedSame }?.0` | 逐字对齐 open-codex `matchingAction:691` | 同上 | +8 |
| service | app/computer-native/swift/Sources/RockyComputerCore/Service.swift | `scroll(_:)` | M | element_index 分支加 AX-first 优先：① `integralScrollPageCount(pages)` 非 nil + `rec.rawActions.first { caseInsensitiveCompare("AXScroll\(direction.capitalized)ByPage") == .orderedSame }` 命中 + `rec.element` 存在 → 对元素 `AXUIElementPerformAction(element, rawAction)` × repeatCount 次（每次 sleep 0.05）② 否则落既有 `InputSimulation.scrollTargeted`；coordinate 分支不动 | 逐字对齐 open-codex `scroll:535-541`；`integralScrollPageCount` 判整数（浮点 tolerance 0.000001），非整数直接 fallback | open-codex `scroll:535`；actions-diff.md §1.6 | +14/-1 |
| service | app/computer-native/swift/Sources/RockyComputerCore/Service.swift | `integralScrollPageCount(_:) -> Int?` | A | 私有 helper：`rounded = pages.rounded(.toNearestOrAwayFromZero)`；`abs(pages - rounded) < 0.000001` → `max(Int(rounded), 1)`；否则 nil | 逐字对齐 open-codex `:1601-1607` | 同上 | +6 |
| service | app/computer-native/swift/Sources/RockyComputerCore/Service.swift | `setValue(_:)` | M | 尾部加 `Thread.sleep(forTimeInterval: 0.1)`（AX set 后 UI 反应窗口） | 逐字对齐 open-codex `setValue:643`；MUST 在 set 成功后、return 前 | open-codex `setValue:643`；actions-diff.md §1.10 | +1 |

---

## 模块 F：TreeRenderer 大重写（LLM 视角 render 精细化） — gap#13

> **文件拆分决策**：新增 `TreeRenderer.swift`（承载 renderer 主逻辑 + segments 计算）与 `TreeRendererHelpers.swift`（承载 markdownLinkText / traits / labels / placeholder / summarizedGenericText 等纯函数）；`AccessibilitySnapshot.swift` 保持 ≤ 300 行（当前 159，加 recover + text_limit 后预估 220，可承载 walk 入口调 TreeRenderer）。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tree_renderer | app/computer-native/swift/Sources/RockyComputerCore/TreeRenderer.swift | `TreeRenderer` struct | A | 逐字迁 open-codex `AccessibilitySnapshot:658-914`（256 行）：`context: RenderContext`, `records: [Int: ElementRecord]`, `focusedSummary`, `lines`, `nextIndex`；核心 `render(_ root:depth:ancestors:)` | 单文件 ≤ 300 行；主编排（约 170 行）单独 struct，纯函数拆到 Helpers | open-codex `TreeRenderer` | +260 |
| tree_renderer | app/computer-native/swift/Sources/RockyComputerCore/TreeRenderer.swift | `RenderContext` struct | A | 承载 walk 上下文：`textLimit: Int?, treeLimits: AccessibilityTreeLimits, windowBounds: CGRect?, focusedElement: AXUIElement?` | 值类型；供 TreeRenderer 只读 | 同上 | +8 |
| tree_renderer | app/computer-native/swift/Sources/RockyComputerCore/TreeRenderer.swift | `TreeRenderer.render(_:depth:ancestors:)` | A | 主渲染：`shouldContinueRendering` 门禁 → `shouldElideNode` 隐藏空 wrapper → 组装 `traitsSegment/titleSegment/rowSummarySegment/labelSegment/helpSegment/urlSegment/identifierSegment/valueSegment/placeholderSegment/actionsSegment` → `linePrefix "\(index) \(roleText)"` → append lines → 记 `records[index] = ElementRecord(...)`（含 identifier/isSyntheticText/prettyActions 三新字段） | 逐字对齐 open-codex `render:666-838`；ancestors 用 `CFEqual` 判环；children 走 `children(of:)` 走 `kAXRowsAttribute / axContentsAttribute / axVisibleChildrenAttribute` 优先级 | 同上 | 主体已入 `TreeRenderer` 计 |
| tree_renderer | app/computer-native/swift/Sources/RockyComputerCore/TreeRenderer.swift | `renderSyntheticText(_:representedBy:depth:)` | A | 短文本合成节点渲染：`index += 1`；`lines.append("\(depth tabs)\(index) text \(text)")`；`records[index] = ElementRecord(...isSyntheticText:true)` | 逐字对齐 open-codex `:840-858`；仅此路径设 `isSyntheticText=true` | 同上 | 主体已入 |
| tree_helpers | app/computer-native/swift/Sources/RockyComputerCore/TreeRendererHelpers.swift | 一组纯函数 | A | `sanitizeText / sanitizedValue / displayIdentifier / summarizeTraits / meaningfulActions / roleDescription / preferredDisplayTitle / markdownLinkText / outlineRowSummary / shouldSuppressChildren / shouldElideNode / summarizedGenericText / summaryImageDescendants / flattenedRowTexts / childTraversalAttributes / usesRowsAsPrimaryRole / usesVisibleChildrenAsPrimaryRole / shouldSkipChild / shouldContinueRendering / displayWindowTitle / formattedLabelSegment / formattedURLSegment / displayIdentifierSegment / formattedValueSegment / formattedValueSegmentWithSeparator / formattedPlaceholderSegment / shouldCommaSeparateActions / summaryImageChildren` | 逐字迁 open-codex `AccessibilitySnapshot:928-1200+` 一整块辅助函数；单文件 ≤ 300 行，超时拆 Helpers2 | open-codex 同区段 | +290 |
| tree_helpers | app/computer-native/swift/Sources/RockyComputerCore/TreeRendererHelpers.swift | `meaningfulActions(_ rawActions:role:) -> [String]` | A | 过滤内隐 menu action / role 无关 action → 生成 pretty 别名（如 `AXPress → Press` / `AXConfirm → Confirm` / `AXShowMenu → Show Menu` / `AXOpen → Open` / `AXRaise → Raise`）；不在 map 内的 raw action 原样保留 | 逐字对齐 open-codex `meaningfulActions`（存于 `AccessibilitySnapshot.swift`）；供 walk 填 ElementRecord.prettyActions | actions-diff.md §1.5 | 计入上一行 |
| tree_helpers | app/computer-native/swift/Sources/RockyComputerCore/TreeRendererHelpers.swift | `shouldElideNode(...)` | A | 隐藏空 Electron generic wrapper 判定：role == AXGroup/AXUnknown + 无 title/label/value/identifier + 无 traits/actions + 无 children/genericSummary → true | 逐字对齐 open-codex；供 render 早退递归 | 计入 | 计入 |
| ax_snapshot | app/computer-native/swift/Sources/RockyComputerCore/AccessibilitySnapshot.swift | `build(...)` | M | walk 逻辑改为构造 `RenderContext` + `TreeRenderer` 实例 → `renderer.render(app)` → `AxSnapshot(text: renderer.lines.joined(separator: "\n"), records: renderer.records)` | 现走 `walk(_)` 递归函数**保留但由 TreeRenderer 内部调**（避免大改）；`AxSnapshot.records` 类型从 `[ElementRecord]` 改 `[Int: ElementRecord]`（对齐 open-codex，供 Service `lastRecords = snap.records` 直接赋值） | actions-diff.md §1.3；架构原则 4 | +10/-6 |
| ax_snapshot | app/computer-native/swift/Sources/RockyComputerCore/AccessibilitySnapshot.swift | `AxSnapshot.records` | M | 类型 `[ElementRecord]` → `[Int: ElementRecord]`；`Service.readAxTree` 内 `Dictionary(...)` 转换代码删除（直接赋值 lastRecords）；`nodeDict` 遍历改 sorted keys | 对齐 open-codex 索引 map 语义；影响 CBridge nodes 数组序列化（sorted by index 保稳定输出） | 兼容 CBridge 输出契约 | +2/-2 |

---

## 模块 G：SoftwareCursorOverlay 视觉光标（NSWindow + CursorMotionModel + GlyphRenderer） — gap#11

> **规模最大（~2669 行）单独块**。文件拆分：`SoftwareCursorOverlay.swift`（NSWindow / NSView / 生命周期，约 870 行 → 拆 3 文件：Overlay / OverlayWindow / OverlayView 各 ≤ 300）+ `CursorMotionModel.swift`（动力学 1506 行 → 拆 5 文件：Model / Solver / Path / Rotation / Idle 各 ≤ 300）+ `SoftwareCursorGlyphRenderer.swift`（293 行，单文件）。**总计约 9 个 Swift 文件**。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| cursor_overlay | app/computer-native/swift/Sources/RockyComputerCore/SoftwareCursorOverlay/Overlay.swift | `SoftwareCursorOverlay` class | A | 主入口：`moveVisualCursor(to:) / pulseVisualCursor(at:clickCount:mouseButton:) / settleVisualCursor(at:)` 三 public API；`shared` 单例（Service 通过它调）；内部持 `motionModel: CursorMotionModel` + `window: OverlayWindow` + `view: OverlayView` | 逐字对齐 open-codex `SoftwareCursorOverlay.swift`；MUST 走 `DispatchQueue.main.async`（addon 无 main run loop → 主线程 dispatch）；MUST `NSApp.setActivationPolicy(.accessory)` 避免抢焦点 | open-codex `SoftwareCursorOverlay`；architecture-diff.md §2.4 | +290 |
| cursor_overlay | app/computer-native/swift/Sources/RockyComputerCore/SoftwareCursorOverlay/OverlayWindow.swift | `OverlayWindow` class | A | `NSWindow` 子类：`styleMask=.borderless`, `level=.screenSaver`, `isOpaque=false`, `backgroundColor=.clear`, `ignoresMouseEvents=true`；生命周期 `setup / teardown / makeKeyAndOrderFront` | 逐字对齐 open-codex；MUST 不接收鼠标事件（`ignoresMouseEvents=true`）；SecureCoding 兼容 macOS Big Sur+ | open-codex 同文件 §NSWindow 段 | +180 |
| cursor_overlay | app/computer-native/swift/Sources/RockyComputerCore/SoftwareCursorOverlay/OverlayView.swift | `OverlayView` class | A | `NSView` 子类：draw glyph + pulse animation；`CADisplayLink` 60fps 时序；drawRect 走 GlyphRenderer | 逐字对齐 open-codex；MUST 用 CGContext / CoreGraphics 绘图不引入第三方 UI 库 | 同上 | +290 |
| cursor_motion | app/computer-native/swift/Sources/RockyComputerCore/CursorMotionModel/Model.swift + Solver.swift + Path.swift + Rotation.swift + Idle.swift | 分 5 文件承载 | A | 逐字迁 open-codex `CursorMotionModel.swift`（1506 行）：velocity solver / rotation model / idle timeout / eased motion / path smoothing | MUST 单文件 ≤ 300 行；分文件按 open-codex `MARK: -` section 边界；不改函数命名 | open-codex `CursorMotionModel`；总 1506 行分 5 文件均 ≤ 300 | +1506 |
| cursor_glyph | app/computer-native/swift/Sources/RockyComputerCore/SoftwareCursorGlyphRenderer.swift | `SoftwareCursorGlyphRenderer` | A | 逐字迁 open-codex 293 行 SVG-ish 光标形状 CoreGraphics 绘制 | 单文件 ≤ 300；直接迁不拆 | open-codex `SoftwareCursorGlyphRenderer` | +293 |
| service | app/computer-native/swift/Sources/RockyComputerCore/Service.swift | `click(_:)` / `setValue(_:)` | M | click 前后加 `SoftwareCursorOverlay.shared.moveVisualCursor(to:target)` + `pulseVisualCursor(at:target, clickCount:count, mouseButton:button)`；setValue 前后 move + `settleVisualCursor` | Overlay 未初始化不阻塞（.shared 内 `DispatchQueue.main.async` fire-and-forget）；MUST 不 await 光标动画完成（否则阻塞 addon N-API 回调） | 对齐 open-codex click 编排 | +8 |

---

## 模块 H：Spotlight recent apps（NSMetadataQuery） — gap#10

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| app_discovery | app/computer-native/swift/Sources/RockyComputerCore/AppDiscovery.swift | `AppDiscovery` enum | A | 命名空间 + 常量 `listAppsQuery / lastUsedDateRankingAttribute / useCountAttribute / maxRecentNonRunningApps=10 / standardApplicationSearchRoots`；主入口 `static listCatalog() -> [ListedAppDescriptor]` | 逐字对齐 open-codex `AppDiscovery.swift:51-122`；引入 `import CoreServices` | open-codex `AppDiscovery`；actions-diff.md §1.2 | +80 |
| app_discovery | app/computer-native/swift/Sources/RockyComputerCore/AppDiscovery.swift | `ListedAppDescriptor` struct | A | 结果结构：`name / bundleIdentifier / isRunning / isFrontmost / lastUsed:Date? / uses:Int?` + `renderedLine` computed（`"<name> — <bundleId> [frontmost, running, last-used=YYYY-MM-DD, uses=N]"`） | 逐字对齐 open-codex `:12-37` | 同上 | +32 |
| app_discovery | app/computer-native/swift/Sources/RockyComputerCore/SpotlightAppIndex.swift | `SpotlightAppIndex` enum | A | `recentApps(cutoffDate:) -> [SpotlightAppRecord]`：同步 `NSMetadataQuery`（走 `NSMetadataQueryLocalComputerScope`）→ `predicate = kMDItemContentType == "com.apple.application-bundle" && kMDItemFSName == "*.app"`；`sortDescriptors` = kMDItemLastUsedDate_Ranking desc；attributes 全读 → 构造 SpotlightAppRecord | 逐字对齐 open-codex `SpotlightAppIndex`（AppDiscovery.swift 内 private struct）；单文件 < 300；超时 5s；失败返 [] | 同上 | +140 |
| app_discovery | app/computer-native/swift/Sources/RockyComputerCore/AccessibilitySnapshot.swift | `Applications.list()` | M | 从「只列运行中 `.regular`」改为调 `AppDiscovery.listCatalog()` → map 成 `[{bundleId,name,pid,isRunning,lastUsed?,uses?,isFrontmost}]`；pid 走 running app 匹配缺失=0 | 保留 spec 「listApps 只列运行中」的语义降级路径：`AppDiscovery.listCatalog` 内 running 优先，非运行取前 10 recent；用户 v0.0.156 裁决「只管运行中」在 spec §8 保留提示，但既然用户裁决全 17 项就跟 open-codex 走 | 契约调整：TS AppInfo 加 optional `lastUsed`/`uses`/`isFrontmost`（J 模块） | actions-diff.md §1.2 | +14/-8 |
| app_discovery | app/electron/Resources/rocky-agent.app/Contents/Info.plist（打包侧）+ dev 配置 | `NSMetadataQuery` 权限声明 | A | 加 `NSMetadataQueryScope` 权限描述条目；packaged app 走 Info.plist（`scripts/build-dmg.sh` 期间注入），dev 走 electron-builder 声明 | orchestrator 直接改（memory `orchestrator-can-edit-devconfig-plugin-ext`）；MUST 不引入用户可见 TCC 弹窗（NSMetadataQuery 读用户 metadata 无需 TCC 授权） | 前置决策 P2 方案 A | +6 |

---

## 模块 I：FixtureBridge（bridge 层 only） — gap#12

> **前置决策 P1 方案 A**：本版本只落 bridge 层 139 行；fixture app + XCTest 推迟到用户装 Xcode 后单独版本。

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| fixture | app/computer-native/swift/Sources/RockyComputerCore/FixtureBridge.swift | `FixtureRect / FixtureElementState / FixtureAppState / FixtureCommand` Codable structs | A | 逐字迁 open-codex `FixtureBridge.swift:4-88` | 全 public + Codable + Sendable；不改字段名 | open-codex 同文件；architecture-diff.md §2.5 | +80 |
| fixture | app/computer-native/swift/Sources/RockyComputerCore/FixtureBridge.swift | `FixtureBridge` enum | A | `appName = "OpenComputerUseFixture"` + `distributedNotificationName` + `stateFileURL`（`NSTemporaryDirectory/open-computer-use-fixture/state.json`）+ `readState() throws -> FixtureAppState?` + `writeState(_:)` + `post(_:)` DistributedNotificationCenter | 逐字对齐 open-codex `:90-138`；`readState` 5 次重试 sleep 0.05 应对写方原子未落 | open-codex `:90` | +50 |
| fixture | app/computer-native/swift/Sources/RockyComputerCore/AccessibilitySnapshot.swift | `SnapshotMode` enum | A | `case accessibility / .fixture`；`AxSnapshot` 加 `mode: SnapshotMode` 字段（默认 `.accessibility`） | 逐字对齐 open-codex `:35-38 + AppSnapshot.mode`；预留 Service 侧未来 fixture 分支 | open-codex `SnapshotMode` | +5 |
| service | app/computer-native/swift/Sources/RockyComputerCore/Service.swift | `readAxTree/getAppState/click/type/scroll/drag/setValue/pressKey/performSecondaryAction` 前置 | M | 加 `let mode = snap.mode` 常量透传 + 编排前置检查 `if mode == .fixture { /* 未来 fixture 分支占位 */ }`（当前 body 为空注释 TODO，透明落 accessibility 路径） | MUST 现阶段占位不实装（fixture app 依赖 Xcode）；spec 明确本版本 fixture 分支 = no-op | 前置决策 P1 方案 A | +9（每 method 1 行占位） |

---

## 模块 J：TS bridge（native-port + tool actions） — gap#9, #15

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ts_bridge | app/server/src/platform/computer/native-port.ts | `ComputerErrorCode` type | M | union 加 `\| 'state_unavailable'`（对齐 Swift `Support.swift::stateUnavailable.code`） | MUST 与 A-2 Swift 侧字符串逐字一致 | A-2；architecture-diff.md §5.3 | +1 |
| ts_bridge | app/server/src/platform/computer/native-port-types.ts | `AxTreeOptions.textLimit` / `GetAppStateOptions.textLimit` | M | 类型 `number` → `number \| 'max'`（对齐 Swift `SnapshotTextLimit`） | 缺省不变；`'max'` = 无上限 | B-6；actions-diff.md §1.3 | +2 |
| ts_bridge | app/server/src/tools/computer-use/target.ts | `resolveAxOptions(input)` | M | `text_limit` 分支加 `input.text_limit === 'max'` → `opts.textLimit = 'max'`；数字分支保持 | 双 union 保后向兼容 | 同上 | +2 |
| ts_bridge | app/server/src/tools/computer-use/schema.ts | `text_limit` schema | M | JSON schema 从 `type:'integer'` → `oneOf: [{type:'integer'},{type:'string',enum:['max']}]`（LLM 提示）；`description` 加 `"or 'max' for unlimited"` | MUST 不拆独立 tool；只扩类型 | 架构原则 2 | +5 |
| ts_bridge | app/electron/src/computer-native-port.ts（若存在，或 `port` impl 层） | native invoke wire | M | 传给 Swift 的 params dict：`textLimit` 若字符串 `'max'` → 传字符串（Swift `AxTreeOptions` 解析）；数字直接传 | Swift Service 内解析：`param["textLimit"] as? String == "max" → SnapshotTextLimit.max` else `Int → SnapshotTextLimit(maxCount:)` | 对齐 B-6/B-7 | +6 |
| ts_bridge | app/server/src/platform/computer/native-port-types.ts | `AppInfo` | M | 加 optional `lastUsed?: string / uses?: number / isFrontmost?: boolean`（对齐 Spotlight AppDiscovery 输出） | 保后向兼容（optional） | H-4 | +3 |

---

## 模块 K：Package + Tests

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| package | app/computer-native/swift/Package.swift | `Package.targets` | M | RockyComputerCore target 保持不变（新文件自动纳入 `path: "Sources/RockyComputerCore"`）；`platforms` 保持 `.macOS(.v14)`；swiftLanguageMode `.v5`（SoftwareCursorOverlay NSWindow 不与 v6 冲突） | 不引入新 target；`SoftwareCursorOverlay` 目录挂 Sources 下自动收集 | 前置 P1 fixture app 独立 target 推迟 | 0 |
| test | app/computer-native/swift/Tests/RockyComputerCoreTestRunner/main.swift | 新增 `expect` 断言 | M | 增补覆盖 `TypeTextStrategy.canTypeTextUsingKeyboardFallback`（role/roleDescription/isValueSettable 组合矩阵）+ `ClickStrategy.isLikelySyntheticSideActionCandidate`（trailing-band + compact + label 组合）+ `ClickStrategy.shouldScanDescendantsOfHitRecord`（面积 12x + 高宽 4x/2x）+ `Service.integralScrollPageCount`（整数/非整数 tolerance）+ `AppDiscovery.compareListedApps`（frontmost > running > lastUsed > uses 排序） | 文件 ≤ 300 行硬约束；超出拆 `RockyComputerCoreTestRunner2` executableTarget；无 mock AXUIElement 保 executable runner 妥协策略 | v0.0.159 test runner 妥协 | +80 |
| addon | app/computer-native/src/addon.cc | N-API 桥 | 无变 | 保持既有 3 符号（ping/invoke/free）；Service 新 method 走既有 `invoke(method, JSON)` 已覆盖 | 不改 C++ 侧；参数走 JSON 无 breaking | v0.0.105 契约 | 0 |

---

## 模块 L：Spec 更新（doc-modifier 收尾阶段落）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| spec | specs/tech/agent/platform/[P1]computer_native_capability.md | §5 Swift 文件表 | M | 新增行：`AppDiscovery.swift / SpotlightAppIndex.swift / TypeTextStrategy.swift / ClickHitTest.swift / TreeRenderer.swift + TreeRendererHelpers.swift / FixtureBridge.swift / SoftwareCursorOverlay/*.swift（3 文件）/ CursorMotionModel/*.swift（5 文件）/ SoftwareCursorGlyphRenderer.swift`；ClickStrategy 行补充「+ activation-only / descendant / hit-test 三层 fallback」；ElementRecord 补充「+ identifier / isSyntheticText / prettyActions」；AccessibilitySnapshot 补充「+ SnapshotTextLimit / recoverVisibleWindow」；Service 补充「+ 三段式 type_text / AX-first scroll / setValue sleep / matchingAction pretty match」 | 单表分隔加子节点；不改 §1-§4；§6 element_index 说明加「+ descendant + hit-test 双候选 + activation-only fallback」 | 本 change_plan 定义 | +30/-3 |
| spec | specs/tech/agent/platform/[P1]computer_native_capability.md | §5 新增子章节「视觉光标 overlay」 | M | 新增 §5.1（或 §5-cursor 子节）：SoftwareCursorOverlay 定位 + NSWindow level=.screenSaver + ignoresMouseEvents=true + click 前后 move/pulse/settle 编排 + DispatchQueue.main 线程约束 | 描述能力，不描述实现 | 本 change_plan 模块 G | +18 |
| spec | specs/tech/agent/platform/[P1]computer_native_capability.md | §5 新增「stateUnavailable 错误分类」 | M | 加 `ComputerErrorCode` 表：`state_unavailable` 语义（元素还在但没坐标 / 消失 / 无 backing AX object），与其他 code 区分表 | 对齐 native-port.ts::ComputerErrorCode | 本 change_plan 模块 A/J | +8 |
| spec | specs/tech/agent/platform/[P1]computer_native_capability.md | §8 已知局限 | M | 现「click 策略未覆盖场景（v0.0.159 有意留白）」清单**全部删除**（v0.0.160 已全落）；改为「**v0.0.160 全面对齐 open-codex** — 3 必移植 + 6 值得移植 + 8 可选，17 项 gap 全闭合。剩余不移植 11 项均属架构本质差异（见 `specs/research/v0.0.159/overview.md`），非缺陷」 | 明确 open-codex 对齐水位；用户裁决可回溯 | 本 change_plan 全局 | +4/-8 |
| spec | specs/tech/agent/platform/[P1]computer_native_capability.md | frontmatter | M | `updated: 2026-07-16`；新增 `since: v0.0.105`（保留）；加 `notes: "v0.0.160 全面对齐 open-codex 17 项 gap"` | 保 status: active | 本 change_plan 全局 | +1/-1 |

---

## 编码分块方案（6 块，每块单 coder 20 分钟可完成汇报）

> **依赖顺序**：块 1（Error + AX 基础） → 块 2（ClickStrategy 扩展）+ 块 3（其他 action 编排）**并行** → 块 4（Spotlight + Fixture bridge）+ 块 5（TreeRenderer 重写）**并行** → 块 6（SoftwareCursorOverlay 独立） → 收尾 TS 侧 + spec。

### 块 1：Error 分类 + AX 基础字段扩展（Items 6, 9, 14, 15 部分）

- **覆盖 gap**：#6（recoverVisibleWindow）、#9（stateUnavailable）、#14（ElementRecord 三新字段占位）、#15（SnapshotTextLimit 定义）
- **涉及文件**：`Support.swift` / `AccessibilitySnapshot.swift`
- **change_plan 模块 A + B（全部行）**
- **预计新增行**：~68 行
- **依赖前置块**：无（可与块 2/3 完全并行；块 5 TreeRenderer 依赖本块的 ElementRecord 三字段）
- **验证 gate**：`swift build --product RockyComputerCore` 编译过；executable UT runner 现有 31 assertions 全绿。

### 块 2：ClickStrategy 3-level fallback 扩展（Items 2, 4, 7, 8）

- **覆盖 gap**：#2（activation-only）、#4（descendantClickCandidates）、#7（isLikelySyntheticSideAction）、#8（selectContainingListItem）
- **涉及文件**：`ClickStrategy.swift`（扩展，不重写）；若超 300 行拆 `ClickHitTest.swift`（部分辅助函数外移）
- **change_plan 模块 C（全部行）**
- **预计新增行**：~250 行
- **依赖前置块**：块 1（`ElementRecord.identifier / isSyntheticText / prettyActions` 字段就绪；A-1 stateUnavailable case 就绪）
- **验证 gate**：`swift build` 编译过；`RockyComputerCoreTestRunner` 加 `isLikelySyntheticSideActionCandidate` + `shouldScanDescendantsOfHitRecord` + `canUseActivationOnlyClickFallback` 覆盖至少 12 新 assertions 全绿。

### 块 3：coord click 双候选 + Service 编排（Items 1, 3, 5, 16, 17）

- **覆盖 gap**：#1（type_text 三段式）、#3（scroll AX-first）、#5（coord click 双候选）、#16（set_value sleep）、#17（pretty actions matchingAction）
- **涉及文件**：`Service.swift` / `ClickHitTest.swift`（新）/ `TypeTextStrategy.swift`（新）
- **change_plan 模块 D + E（全部行）**
- **预计新增行**：~230 行
- **依赖前置块**：块 1（ElementRecord.prettyActions 字段）+ 块 2（ClickStrategy.clickActionPoints / performAXClickSequence 签名扩展）
- **验证 gate**：`swift build` 编译过；executable UT 加 `TypeTextStrategy.canTypeTextUsingKeyboardFallback` + `integralScrollPageCount` 覆盖 10+ assertions 全绿。

### 块 4：Spotlight AppDiscovery + FixtureBridge stub（Items 10, 12）

- **覆盖 gap**：#10（Spotlight recent apps）、#12（FixtureBridge bridge only）
- **涉及文件**：`AppDiscovery.swift`（新）/ `SpotlightAppIndex.swift`（新）/ `FixtureBridge.swift`（新）/ `AccessibilitySnapshot.swift`（Applications.list wire）/ Info.plist 权限
- **change_plan 模块 H + I（全部行）**
- **预计新增行**：~330 行
- **依赖前置块**：块 1（`AxSnapshot.mode` 字段）
- **验证 gate**：`swift build` 编译过；executable UT 加 `AppDiscovery.compareListedApps` 排序覆盖 5+ assertions 全绿；`Info.plist` schema check。

### 块 5：TreeRenderer 大重写（Item 13）

- **覆盖 gap**：#13（AX 树精细化 render）
- **涉及文件**：`TreeRenderer.swift`（新）/ `TreeRendererHelpers.swift`（新）/ `AccessibilitySnapshot.swift`（build 内接入）
- **change_plan 模块 F（全部行）**
- **预计新增行**：~570 行
- **依赖前置块**：块 1（ElementRecord.identifier/isSyntheticText/prettyActions 字段就绪；SnapshotTextLimit 就绪）；**与块 2/3/4 无依赖，可并行**
- **验证 gate**：`swift build` 编译过；开发者手动跑 Safari/Finder AX 树看 render 输出符合 open-codex 精细化格式（无 executable UT，AX 树输出属真机行为）；LLM 端到端一轮 dogfood 手验。

### 块 6：SoftwareCursorOverlay 视觉光标（Item 11 独立最大块）

- **覆盖 gap**：#11（SoftwareCursorOverlay + CursorMotionModel + GlyphRenderer）
- **涉及文件**：`SoftwareCursorOverlay/*.swift`（3 文件）/ `CursorMotionModel/*.swift`（5 文件）/ `SoftwareCursorGlyphRenderer.swift` / `Service.swift`（click/setValue 编排接入）
- **change_plan 模块 G（全部行）**
- **预计新增行**：~2670 行（9 个 Swift 文件）
- **依赖前置块**：无（与所有块并行；Service 接入点需要块 3 完成 Service 骨架）
- **验证 gate**：`swift build` 编译过；packaged app 装 dmg 后真机 dogfood 手验光标显示 + 淡入淡出 + 点击 pulse。
- **风险**：UI 线程调度（addon 无 main run loop）；SecureCoding macOS Big Sur+；DispatchQueue.main.async 保护所有 NSWindow 操作。

### TS 侧收尾（与所有块并行 → 块 4/5 完成后落）

- **change_plan 模块 J + K + L**（TS bridge / native-port / spec）
- **涉及文件**：`native-port.ts / native-port-types.ts / target.ts / schema.ts / computer-native-port.ts / [P1]computer_native_capability.md`
- **预计新增行**：~55 行 TS + ~60 行 spec
- **验证 gate**：`bun run typecheck` 过；`bun run test` （UT）过；tool schema 手验 LLM 视图 `text_limit "max"` 描述正确。

---

## 影响面评估

- **规模**：Swift ~4200 行（1 块新增 ~68 + 2 块 ~250 + 3 块 ~230 + 4 块 ~330 + 5 块 ~570 + 6 块 ~2670 + Tests ~80）；TS ~55 行；Spec ~60 行。
- **跨模块**：click / type / scroll / setValue / performSecondaryAction / read_ax_tree / list_apps 7 action 全触；error 分类扩展 → TS side 消费；overlay 独立子系统入 `Service` 编排。
- **破坏性变更**：无 API breaking（tool schema 只扩不改；`ComputerNativePort` interface 不改；`AppInfo` 加 optional 字段）。**AX 树 render 输出改**（TreeRenderer 重写）→ LLM 视角变化 → 需真机 dogfood 全面回归各 action 命中率。
- **依赖顺序**（严格）：块 1 是所有其他块的前置。块 2/3 依赖块 1。块 4/5 依赖块 1（不依赖 2/3）。块 6 独立。TS 收尾在其他块后。
- **风险点**：
  1. **TreeRenderer 重写 LLM 视角变化**（块 5）：可能 LLM 对已有 click 断层，需 dogfood 覆盖 6+ 场景（Safari, Finder, Xcode, VSCode, Lark, WorkBuddy）
  2. **SoftwareCursorOverlay UI 线程**（块 6）：addon 无 main run loop，DispatchQueue.main 全覆盖漏一处即崩
  3. **XCTest 环境不装**（前置 P1）：FixtureBridge app 推迟；bridge 层单独可编但无 fixture app 联动测试
  4. **NSMetadataQuery 权限**（前置 P2）：macOS 版本差异 fallback；权限缺失路径 `AppDiscovery.listCatalog()` 只返 running（保守降级）
  5. **打包链**：新增 `.swift` 文件由 Package.swift `path` 自动纳入 dylib；`build-native.sh` 无需改；Info.plist 权限声明由 electron-builder / build-dmg 双侧覆盖（memory `native-addon-workspace-skip-install-nodegyp`）
  6. **文件 ≤ 300 行**：ClickStrategy 扩展后可能超行 → 内建 `ClickHitTest.swift` 拆分（决策 D-1）；TreeRenderer 主体拆 Helpers；CursorMotionModel 拆 5 文件；SoftwareCursorOverlay 拆 3 文件

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- **spec 对齐 open-codex 行号**：coder 实现前必须打开 `refs/open-codex-computer-use/...` 对齐锚点行；逐字对齐要求下发现 open-codex 引用符号在本项目缺失（如 `AppSnapshot.focusedElement`）时 → 汇报 orchestrator 是否新增等价结构

## 附：文末决策尾注

### D-1：ClickStrategy.swift 超行拆分（ClickHitTest.swift 新增）

**背景**：v0.0.159 交付 `ClickStrategy.swift` 280 行；模块 C 扩展加 activation-only/descendantClickCandidates/isLikelySyntheticSideAction/selectContainingListItem/clickActionPoints/shouldScanDescendantsOfHitRecord/accessibilityLabels 等，预估 +140 行 → 超 300 硬约束。

**方案**：新增 `ClickHitTest.swift` 承载几何 hit-test 辅助（`bestElement`/`hitTestElement`/`clickCandidates`/`sameElement` + `clickActionPoints` + `shouldScanDescendantsOfHitRecord` + `accessibilityLabels` + `clickPriority` + `frameArea`）；`ClickStrategy.swift` 保留决策序列（`performAXClickSequence` / `performPreferredClick` / `performContainingWebRowClick` / `selectContainingListItem` / `activateClickTarget` / `canUseActivationOnlyClickFallback` / `setBoolAttribute`）。

**结果**：两文件均 ≤ 300 行；语义分工清晰（策略 vs 几何）。

### G-1：SoftwareCursorOverlay 多文件拆分

**背景**：open-codex `SoftwareCursorOverlay.swift` 870 行 + `CursorMotionModel.swift` 1506 行 单文件超 300 硬约束。

**方案**：`SoftwareCursorOverlay/` 目录 3 文件（Overlay/OverlayWindow/OverlayView，各 ≤ 300）；`CursorMotionModel/` 目录 5 文件（Model/Solver/Path/Rotation/Idle，按 open-codex `MARK: -` section 边界拆，各 ≤ 300）；`SoftwareCursorGlyphRenderer.swift` 单文件 293 行不拆。

**结果**：9 个 Swift 文件承载视觉光标全套；命名/算法/参数对齐 open-codex 逐字。

