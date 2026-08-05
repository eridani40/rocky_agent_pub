# open-codex vs rocky_agent computer-use 全面差异（v0.0.159 基线）— 概览 + 摘要

**调研范围**：`refs/open-codex-computer-use/packages/OpenComputerUseKit/Sources/OpenComputerUseKit/`（Swift kit，9349 行）+ `apps/OpenComputerUse/`（app 壳，2174 行）— vs — `app/computer-native/swift/Sources/RockyComputerCore/`（1397 行）+ `app/server/src/tools/computer-use/` + `app/server/src/platform/computer/`。

**基线**：v0.0.159 已移植 click 的 web content 特殊路径 + AXPress→AXConfirm→AXOpen 序列 + 6 层 web row 祖先遍历（`ClickStrategy.swift` 281 行 + `AccessibilitySnapshot.swift` 加 `copyParent/hasAncestorRole/rawActionsOf`）。**其他 action 与架构层未系统对齐**。

## 报告结构
- `overview.md`（本文）— 摘要 + 优先级建议 + finding + 遗漏跟进
- `actions-diff.md` — §1 各 action 逐个对比（screenshot / list_apps / read_ax_tree / get_app_state / click / perform_secondary_action / scroll / drag / type_text / press_key / set_value）
- `architecture-diff.md` — §2-§8 架构层 / 权限 / AX snapshot / 错误 / 测试 / 视觉反馈 / MCP schema

---

## 摘要

系统差异总计约 **28 项**，分类判定：
- **[必移植]**：3 项（其中 2 项影响 click 完整性、1 项影响 type_text 语义可靠性）
- **[值得移植]**：6 项（scroll AXScrollByPage / recoverVisibleWindow / activation-only fallback / synthetic side action 过滤 / descendant click candidates / hit-test element 补偿）
- **[可选]**：8 项（SoftwareCursorOverlay 视觉反馈、fixture bridge、richer AX render、ElementRecord 字段扩展、text_limit "max" 语法、Spotlight recent apps、AppSafetyPolicy 屏蔽名单、set_value 后 sleep）
- **[不移植]**：11 项（都属本质架构差异或与 Rocky 电子集成模式冲突：MCP stdio server、独立 CLI 可执行、TCC db onboarding UI、PermissionOnboardingApp、CGWindow layer sort 精细化、`MacOSAppAgentProxy` 代理路径、macOS app agent bundle、release/dev bundle 双身份、软件光标 CursorMotionModel 1506 行动力学、多 bundle candidate 查找、dragGlobally HID 事件全局）

## 最有价值 3 个 finding（可作决策入口）

1. **`type_text` 语义差距（比 click 差距更大）**：我们 `Service.type` 直接走 CGEvent keyboard event postToPid（`InputSimulation.swift:80-95`），**始终 keyboard**。open-codex 三段式（`ComputerUseService.swift:576-595`）：先 `typeTextBySettingFocusedValueIfAvailable`（focused element settable → AX setValue 拼旧值直入 DOM）→ 失败看 `canTypeTextUsingKeyboardFallback`（role 是 text field/area 或 value settable 才允许 keyboard）→ 否则 `stateUnavailable` 明确报错。这个差异让 open-codex 在 Electron 输入框（Lark 消息、VSCode 命令面板、React 合成事件层）远比我们健壮——同 v0.0.159 click 一样的类型问题，type 完全没做。

2. **`scroll` 有 AX 语义路径（AX-first, CGEvent fallback 的对称补充）**：open-codex 检查元素 `rawActions` 是否含 `AXScrollUpByPage/DownByPage/LeftByPage/RightByPage`——命中 + pages 是整数 → 对元素直接 `AXUIElementPerformAction`（`ComputerUseService.swift:535-541`）；失败 fallback CGEvent scrollWheel。比 CGEvent + point 精确得多（不受 hit-test 精度影响；语义翻页而非近似像素）。我们 `scroll` 只走 CGEvent scrollWheel（`InputSimulation.swift:53-63`），Chromium 里被 momentum scrolling 篡改，翻页量不稳。**是已移植 click AX-first 后的自然对称补充**。

3. **click 三层 fallback 未完整**：v0.0.159 只移植了「web row 6 层 + AXPress→AXConfirm→AXOpen」两层；**未移植**：
   - open-codex 第三层 `activationOnlyClickFallback`（`ComputerUseService.swift:924-940` + `:277-283`）：对 `AXWindow` 元素 AXRaise + kAXMainAttribute + kAXFocusedAttribute 组合激活。**修「点窗口标题栏切窗口」类空转**。
   - `descendantClickCandidates`（`:1048-1095`）：对目标元素 3 层子树深度扫，取有 primary action 的最内层小面积候选。**修「Chromium 大 AXGroup 元素无 action、内部 button 有」类空转**。
   - coordinate 分支 `clickCandidates(at:)` = `bestElement(containing:) + hitTestElement(at:)` 双候选补偿（`:743-767`）。**修「LLM 给错 3-5px 坐标」时的命中**。

## v0.0.159 遗漏 / 代码-spec 不一致

- **不一致（轻微）**：`specs/tech/version_logs/v0.0.159/change_plan.md` §模块 A `walk` 契约行标 +3/-1，实际 walk 内 rawActions 采集逻辑重构了 5-6 行；属合理偏离，无需修 spec。
- **未偏离但可细化**：`ClickStrategy.performAXClickSequence` 里成功时 `Thread.sleep(0.15)` 与 `performAction` 内 `repeatCount>1` 时 `Thread.sleep(0.05)` 会叠加——一次 clickCount=2 双击累计 200ms sleep，加外层 150ms 共 350ms。open-codex 单一入口 sleep 逻辑相同（`ComputerUseService.swift:824-828` 每命中即 sleep 0.15，不叠加 performAction 内 sleep），但是 open-codex 的 performAction repeatCount 循环 sleep 也是相同 50ms，因此**行为等价**——不是 bug。
- **spec 描述与实现字段一致性**：`specs/tech/agent/platform/[P1]computer_native_capability.md` §5 Swift 文件表已添加 ClickStrategy 行（v0.0.159 doc-modifier 同步）；§6 element_index 说明已改为 AX click 序列描述；§8 已列 open-codex 未覆盖场景（descendant candidates / hit-test 补偿 / AXWindow activation / selectContainingListItem）— **spec 已明确 flag 差距**。

## 综合优先级建议

### 立即移植（Critical）— 3 项
1. **`type_text` 三段式**（详见 `actions-diff.md` §1.9）：AX setValue 优先 → keyboard fallback + role/roleDescription 门禁 → stateUnavailable 明确错误。规模约 50 行 Swift；改 `Service.type`。
2. **click activation-only fallback**（`actions-diff.md` §1.4 ①）：`AXWindow` role 时 AXRaise + kAXMain + kAXFocused。规模约 25 行 Swift；加进 `ClickStrategy` 主编排 fallback 尾部。
3. **`scroll` AX-first 路径**（`actions-diff.md` §1.6）：整数 pages + 元素含 `AXScrollByPage` → 直接 AX perform；否则落 CGEvent。规模约 20 行 Swift；改 `Service.scroll` + 微调 `AccessibilitySnapshot` render（让 LLM 看到 `AXScrollDownByPage`）。

### 下版本考虑（Major）— 6 项
4. **`descendantClickCandidates`**（`actions-diff.md` §1.4 ②）：Chromium wrapper 元素扫子树命中。规模 ~90 行。
5. **coordinate click 双候选（bestElement + hitTestElement）**（`actions-diff.md` §1.4 ③）：LLM 给错 3-5px 时的补偿。规模 ~80 行。
6. **`recoverVisibleWindow`**（`actions-diff.md` §1.3）：窗口最小化/隐藏时激活恢复。规模 ~25 行 + BlockingAsyncBridge 一并考虑。
7. **`isLikelySyntheticSideAction` filter**（`actions-diff.md` §1.4 附属）：过滤误认的"侧边动作按钮"。规模 ~40 行。前置：§4 移植 `isSyntheticText` 或用 role 近似。
8. **`selectContainingListItem`**（`actions-diff.md` §1.4 附属）：Finder / 邮件 / 消息 sidebar 类 list 选项优化。规模 ~40 行。
9. **`stateUnavailable` 错误分类**（`architecture-diff.md` §5.3）：TS 侧能区分「元素还在但没坐标」vs「元素消失了」。规模 5 行 Swift + `native-port.ts` 加一个 code。

### 长期观察（Minor）— 8 项
10. AX render 精细化（`markdownLinkText / traits / label-help-identifier segments`）— 大工程且 LLM 视角改动风险高（`actions-diff.md` §1.3）
11. `AXIdentifier` 字段（`architecture-diff.md` §4.1）
12. `text_limit "max"` 语法（`actions-diff.md` §1.3）
13. `set_value` 后 100ms sleep（`actions-diff.md` §1.10）
14. `pretty actions` 别名（`actions-diff.md` §1.5）
15. `SoftwareCursorOverlay` 视觉反馈（`architecture-diff.md` §2.4）— 除非产品明确要求
16. `containingRowFrame` click frame 优化（`actions-diff.md` §1.4 附属）
17. XCTest 环境（要求装完整 Xcode）+ fixture bridge（`architecture-diff.md` §6）

### 明确不移植 — 11 项
1. **MCP stdio server**（`architecture-diff.md` §2.2）— 架构冲突
2. **独立 Swift executable / CLI**（同 §2.2）— 我们是 in-process addon
3. **`PermissionOnboardingApp` SwiftUI onboarding**（§3.3）— electron UI 已覆盖
4. **多 bundle candidate 查找**（§3.2）— 单安装路径
5. **`MacOSAppAgentProxy`**（apps/OpenComputerUse/Sources）— 属 Codex 特定运行时代理
6. **`AppDiscovery.launchIfPossible` + Spotlight recent apps**（`actions-diff.md` §1.2）— 边际价值
7. **`AppSafetyPolicy.blockedBundleIdentifier`** — 由 rocky tool policy 层管
8. **release / dev 双 bundle 身份**（§3.2）— 我们只有一个 rocky bundle
9. **CGWindow layer sort 精细化**（`AccessibilitySnapshot.swift:495+` `usableCandidates`）— 我们 `Screenshot.swift` frontWindow 已够
10. **`OpenComputerUse.app` macOS app bundle 本身** — rocky electron 就是 host
11. **`dragGlobally` HID event tap fallback**（`actions-diff.md` §1.7）— 破坏 "不抢前台" 约束

## 附：本次调研未覆盖 / 需二次跟进的点

1. **v0.0.159 `hasAncestorRole maxDepth=12` vs `performContainingWebRowClick` 深度 6 分层**：真机 Electron 深嵌 DOM 场景（Lark 消息 wrapper 常 8-10 层）是否够，需 dogfood 实测。open-codex 也用 12 / 6 两层，我们对齐，但设计意图无源头解释。
2. **`type_text` 移植后与既有 keyboard fallback 的兼容性**：如果元素 focused 但 value 不 settable 且 role 不含 text field，我们目前直接 CGEvent typeText → 改成先门禁可能出现「原本能 type 现在报 stateUnavailable」。需要 case 清单：哪些 focused role 是我们 keyboard-only 能过、open-codex 门禁会拒的。
3. **CBridge 单例 vs snapshotsByApp 边界**：我们 `sharedService` 单例的 `lastRecords` 全 process 共享；未来若 Rocky 放开 tool policy 允许多 session 用 computer tool，是**必爆的踩坑点**（session A 覆写 B 的 lastRecords）。虽本调研范围外，为未来 architecture pivot 提前 flag。
4. **`AXOpen` action 的 `attributeUnsupported` 特例**（`ClickStrategy.swift:158-160` / open-codex `:912`）：两侧都对 AXOpen 走「.attributeUnsupported = success」特例。为什么存在、遇到过什么 case——refs 里没找到注释解释。未来遇到 AXOpen 假成功场景可能需回溯 open-codex commit history。
5. **AXScrollByPage 分支的整数 pages 限制**：open-codex `integralScrollPageCount(pages)`（`:1601-1607`）——非整数直接 fallback。我们 TS 侧 scroll 参数是 `integer`（`schema.ts:86`），但底层 Swift 收 Double；如果移植 AX 路径要注意浮点判等 tolerance 0.000001。

**调研耗时**：约 35 分钟。
