# v0.0.159 — Tech Change Log（computer tool click 对 Electron/web content 修复）

> 跨版本发布说明（版本轴）。本目录级变更见：
> - `specs/tech/agent/platform/log.md`（2026-07-16 块）
>
> 权威变更契约见同目录 `change_plan.md`（method 级 23 行，5 模块）+ 收尾偏离尾注 §D-1/§D-2/§D-3。

## 概览

**根因**：`Service.swift:82-83` v0.0.105 单步 AXPress-only 策略对 Electron / Chromium web content **空转**——`AXUIElementPerformAction(kAXPressAction)` 返 `.success`，但 React 合成事件 / DOM onClick 未触发（WorkBuddy / wb-clone / Lark / Feishu 场景实证）。AXPress 命中后 short-circuit `return` 掩盖了失败信号，CGEvent postToPid 兜底路径永不达。

**方案**：参考 `refs/open-codex-computer-use` 移植 3 条策略（策略层新文件 `ClickStrategy.swift` 独立命名空间）：
1. **web row 6 层祖先 AXPress**（`performContainingWebRowClick`）——Electron/Chromium web content 特化路径，向上遍历 6 层找带 primary action 的行动区祖先 → 对其 AXPress。
2. **AX action 多步序列**（`performPreferredClick`）——左键 `AXPress → AXConfirm → AXOpen`；右键 `AXShowMenu`；任一 true 即停。
3. **AXPress 失败必落 CGEvent 兜底**（`Service.click` short-circuit `return` 删除）——`ClickStrategy.performAXClickSequence` 返 false 时必走 `InputSimulation.clickTargeted(postToPid)`。

**Electron 判定 = 双闸兼收**（架构原则 3，覆盖 WorkBuddy 这类 bundleId 不含 electron 字样场景）：
- 核心必要条件 = `hasAncestorRole("AXWebArea")` 命中
- 加速通道 = `isElectronScopedTarget(bundleId, appName)`（`com.electron.` prefix / `.electron.` substring / `lark`/`feishu`；appName `Lark`/`Feishu`/`飞书`）
- 兜底 = role ∈ {AXStaticText, AXGroup, AXUnknown} 时也放行（近似 open-codex 的 isSyntheticText，我们 `ElementRecord` 无此字段）

**设计约束**（不可偏离，见 change_plan §附「核心约束」）：
- **TS 侧完全不动**（`tools/computer-use/actions/click.ts` / `platform/computer/native-port.ts` / `addon.cc` 均不改，TS 契约不变）
- **祖先深度硬编码 6 层**（对齐 open-codex），不参数化
- **AX action 顺序左键 = AXPress → AXConfirm → AXOpen**，不重排
- **AXPress 失败必 fallback CGEvent**，兜底不删
- **不引入新第三方依赖**（纯 Foundation / ApplicationServices / AppKit）

## §1 影响面（method 级，详 change_plan）

### `app/computer-native/swift/Sources/RockyComputerCore/` — 3 文件改 + 1 新增

- **`AccessibilitySnapshot.swift`**（模块 A）：
  - `ElementRecord` 加 `rawActions: [String]`（未过滤 AXPress 的全动作列表）；`actions` 保留原语义（已过滤 AXPress 的 secondary，AX 文本渲染不变，避免 LLM 视角回归）
  - `walk` 一次 `AXUIElementCopyActionNames` 采集两用（rawActions 全量 + actions filtered 派生）
  - 新增 `rawActionsOf` / `copyParent(of:)` / `hasAncestorRole(_:of:maxDepth:12)` static helper

- **`ClickStrategy.swift`**（模块 B，**新文件**）：enum 命名空间集中策略函数（无实例）
  - 常量：`axOpenAction = "AXOpen"` / `axWebAreaRole = "AXWebArea"`（系统未提供对应 `k*` 常量）
  - 判定函数：`isElectronScopedTarget` / `shouldPreferContainingWebRowAXClick` / `hasPrimaryClickAction` / `isLikelyContainingRowActionFrame`（纯逻辑，UT 全覆盖）
  - 执行函数：`performAction` / `performContainingWebRowClick`（6 层祖先）/ `performPreferredClick`（AXPress→Confirm→Open / ShowMenu）
  - **主入口**：`performAXClickSequence` — 单一 API 给 `Service.click` 消费

- **`Service.swift`**（模块 C）：
  - 新增私有字段 `lastBundleId: String?` / `lastAppName: String?`（`readAxTree` / `getAppState` 同步写入，复用现有 `NSRunningApplication` 局部）
  - `click(_:)` element_index 分支重写：`try ClickStrategy.performAXClickSequence(...)` → true return / false 走 `InputSimulation.clickTargeted`。**删旧 `if AXPress .success → return` short-circuit**

- **`Package.swift`**（模块 D）：新增 `executableTarget "RockyComputerCoreTestRunner"`（**收尾偏离 原 `testTarget`**，详 change_plan §D-1）

- **`Tests/RockyComputerCoreTestRunner/main.swift`**（模块 D，**新文件**）：executable + 手写 `expect()` runner，覆盖 `ClickStrategy` 4 个纯逻辑函数（`isElectronScopedTarget` / `isLikelyContainingRowActionFrame` / `hasPrimaryClickAction` / `shouldPreferContainingWebRowAXClick`），31 assertions 全绿

- **`app/computer-native/scripts/build-native.sh`**（**收尾副作用**，详 change_plan §D-2）：`swift build -c release --product RockyComputerCore` — 加 `--product` 过滤，避 release 编 TestRunner target 撞 `@testable`

### 未变的边界（TS 侧完全不动）
- `app/server/src/tools/computer-use/actions/click.ts` — 不改
- `app/server/src/platform/computer/native-port.ts` / `native-port-types.ts` — 不改
- `app/computer-native/src/addon.cc` — 不改
- 所有 TS UT / AT / ET 契约 — 未变

## §2 破坏性变更

**无破坏性变更**。TS 侧接口 / 数据形状 / N-API 桥全零改动。仅 Swift native 内部策略层升级。

## §3 不做的事（范围外，v0.0.159 有意留白）

参考 open-codex 但本版本**先不移植**（未来失败率超阈值再补）：
- `descendantClickCandidates` 循环
- `clickActionPoints` 邻近 hit-test 补偿
- `canUseActivationOnlyClickFallback`（AXWindow AXRaise+AXMain+AXFocused）
- `selectContainingListItem`（非 web area 的 list item 选择）
- `isLikelySyntheticSideAction`（右侧「完成/done」按钮误伤规避）

已在 `specs/tech/agent/platform/[P1]computer_native_capability.md §8` 显性化，便于未来定位。

## §4 测试范围（Swift 纯逻辑 UT + dev dogfood 手验）

- **Swift 纯逻辑 UT**（主验证层）：`swift run --package-path app/computer-native/swift RockyComputerCoreTestRunner` → exit 0，31 assertions 全绿
- **dev dogfood 手验**（MANDATORY，架构期约定）：dev 环境启动 → WorkBuddy 内点击 radio button / 任务卡片 / 下拉菜单 / coordinate fallback 路径（orchestrator 汇报，用户签字，可推迟到验收阶段）
- **AT / ET 豁免**：本版本纯 Swift native 改动，无 API 契约变更、无 UI 变更、无落库变更、无 TS/前端代码改动 — 符合 memory `ui-only-ut-skip-at-et` 类比场景。用户裁决 2026-07-16。
- **packaged 豁免**：native addon rebuild 走既有链路（build-native.sh → build-plugins → build-dmg），未新增第三方依赖 / 未新增 runtime env / 未涉及路径展开；持续可打包护栏四类风险均不命中。

### 验收门禁实测结果

- Swift UT：31/31 assertions 全绿（`RockyComputerCoreTestRunner` exit 0）
- `bun run typecheck`：零错（native addon rebuild 后 TS shim 未变）
- addon build：`bash app/computer-native/scripts/build-native.sh` 成功（swift dylib + electron `.node`，`nm` 校验 `_rocky_cu_ping` 导出 + `otool @rpath` 正确）
- dev dogfood 手验：待用户签字

## §5 spec 同步清单（doc-modifier）

| KB / 目录 | 文件 | 变更 |
|---|---|---|
| tech/agent/platform | `[P1]computer_native_capability.md` §5 | AccessibilitySnapshot 行加「rawActions + copyParent/hasAncestorRole 遍历 helper」；Service.swift 行加「lastBundleId/lastAppName 缓存 + click 走 ClickStrategy.performAXClickSequence → 失败 fallback InputSimulation.clickTargeted」；新增 ClickStrategy 行；新增 Tests/RockyComputerCoreTestRunner/main.swift 行 |
| tech/agent/platform | `[P1]computer_native_capability.md` §6 element_index | 「AXPress-only or postToPid」改为「AX click 序列（web content 特殊路径 6 层祖先 AXPress → AXPress→AXConfirm→AXOpen / AXShowMenu）→ CGEvent 兜底」+ v0.0.159 修订标注 |
| tech/agent/platform | `[P1]computer_native_capability.md` §8 已知局限 | 加「click 策略未覆盖场景（v0.0.159 有意留白）」小节，显性化 5 条 open-codex 未移植路径 |
| tech/agent/platform | `log.md` | 加 2026-07-16 v0.0.159 条目 |
| tech/version_logs | `v0.0.159/change_plan.md` 模块 D | 同步收尾偏离 3 项：testTarget→executableTarget、XCTestCase→手写 expect()、AccessibilityHelperTests 未建；文末加偏离尾注 §D-1/§D-2/§D-3 |
| states/v0.0.159/verify | `test-plan.md` | `swift test` → `swift run --package-path app/computer-native/swift RockyComputerCoreTestRunner`；加偏离说明 |

## §6 验证结论

- code-review PASSED（所有 task）
- Swift 纯逻辑 UT 31/31 全绿
- addon build 全链通（dylib + `.node` + rpath 校验）
- `bun run typecheck` 零错
- code-spec 一致核实：`[P1]computer_native_capability.md` §5 描述的 click 策略 == `Service.swift:97-120` + `ClickStrategy.swift` 实际实现（symbol / 顺序 / 行为一致）；旧 spec 「AXPress .success → return」描述已从 §6 element_index 清除；spec 中所有 AXPress 引用均在 v0.0.159 序列上下文中（`AXPress→AXConfirm→AXOpen`），无「AXPress-only」残留

## §7 未来扩展（按失败率调优）

见 `[P1]computer_native_capability.md §8` 「click 策略未覆盖场景」。若 dev dogfood 发现失败率超阈值，按需补齐 open-codex 剩余 5 条路径。
