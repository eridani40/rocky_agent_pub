# §1 Action 级差异（逐 action 对比）

**前置**：见 `overview.md` 摘要与优先级。本文按 action 逐个对比参数模型 / 实现 / fallback / 判定。

**参数模型差异总述**：open-codex 每个 action 均**要求 `app` 参数**（`requireString("app", ...)`，`ComputerUseToolDispatcher.swift:60`），流程绑一个 `snapshotsByApp[query]` 缓存快照；我们所有 action 的 `app` 都是 optional，缺省用 `frontmost` 或 `lastPid`。

---

## 1.1 `screenshot`

- **参数**：ours = `app?`（`app/server/src/tools/computer-use/actions/screenshot.ts:35`）；open-codex = **不存在为独立 action**，功能合并到 `get_app_state`；MCP 层只暴露 8 个 action。
- **落盘**：ours = `saveSnapshot` 到 `<workdir>/snapshots/<toolCallId>.png` + 主对话上下文只留路径 TextBlock（v0.0.157 INV-157-1/3/4）；open-codex = 直接 png bytes 塞进 ToolCallResult 的 `content[]` 作 `pngImage`（`refs/.../ComputerUseService.swift:1694`）。
- **bounded**：open-codex 有 `boundedScreenshotPNGData` 900KB / 1280px 降采样迭代（`refs/.../AccessibilitySnapshot.swift:530`）；ours 有相同上限（`Screenshot.swift:25-27`）— 已对齐。
- **判定**：`[不移植]` — screenshot 独立 action 是我们 v0.0.105 有意保留的省 token 路径，与 open-codex 设计理念不同（他们靠 tool_search 收敛）。落盘策略 v0.0.157 已定，本质架构差异。

## 1.2 `list_apps`

- **参数**：ours = 无（`list-apps.ts:18`）；open-codex = 无（`ComputerUseToolDispatcher.swift:48`）。
- **实现**：ours = `NSWorkspace.runningApplications` 过滤 `.regular`（`AccessibilitySnapshot.swift:145-158`）；open-codex 更丰富：**同时枚举 Spotlight 索引的 recent apps**（`kMDItemLastUsedDate_Ranking`、`kMDItemUseCount`）+ 运行中 apps，按 frontmost > running > lastUsed > uses 排序，非运行至多 10 个（`refs/.../AppDiscovery.swift:72-121`）。
- **返回格式**：ours = 结构化 `[{bundleId,name,pid,isRunning}]` → tool 层格式化；open-codex = 直接返 rendered text `"Xcode — com.apple.dt.Xcode [frontmost, running, last-used=2026-07-01, uses=48]"`（`refs/.../AppDiscovery.swift:20-36`）。
- **判定**：`[可选]` — Spotlight 索引 recent apps 是 LLM 探索价值增强，但对 Rocky 场景边际；且需要 `NSMetadataQuery` Spotlight 权限，可能引入新用户许可维度。

## 1.3 `read_ax_tree` / `get_app_state`

- **参数**：ours 与 open-codex `get_app_state` 参数一致（app / text_limit / max_tree_nodes / max_tree_depth）。
- **text_limit 语法**：open-codex 支持 `"max"` 字符串关键字 = 无上限（`SnapshotTextLimit.maxKeyword`，`refs/.../AccessibilitySnapshot.swift:68`）；ours 只支持整数。判定 `[可选]`。
- **AX 树渲染差异（大）**：ours 简洁——`{index} {role} "{title}" Value: {value} Secondary Actions: {actions}`（`AccessibilitySnapshot.swift:60-66`）；open-codex 极精细，`TreeRenderer` 一个函数 170+ 行（`refs/.../AccessibilitySnapshot.swift:666-838`）：
  - `traits`（AXSubrole + 状态位）
  - `link` role 走 markdown `[label](url)` 格式（`markdownLinkText`）
  - `label` / `help` / `identifier` / `url` / `value` / `placeholder` 分段
  - `AXRow` role 拆 flat text
  - `outlineRowSummary` 折叠子行
  - `shouldElideNode` 隐藏空 generic Electron wrapper
  - `summarizedGenericText` 合并只含文本子孙的容器（避免 Electron 深嵌 wrapper 灌爆 token）
  - `isSyntheticText` 记录（对 `AXStaticText` 无 action 时"补一层"用于 click 判定）
- **恢复失败窗口**：open-codex 有 `recoverVisibleWindow`（unhide + activate + open bundle + unminimize + raise，`refs/.../AccessibilitySnapshot.swift:245-269`）；ours 直接 fail。
- **判定**：AX 树渲染 `[可选]`（收益大但风险也大：一变则 LLM 视角全洗，需大量真机测试；当前简洁 render 对 LLM 基本够用）；`recoverVisibleWindow` 恢复策略 `[值得移植]`（用户体验直接受益：窗口最小化 / 隐藏时不再直接失败）；`text_limit "max"` `[可选]`。

## 1.4 `click` — 已部分移植（v0.0.159），仍缺 3 层能力

已移植（v0.0.159）：
- ✅ web row 6 层祖先 AXPress
- ✅ AXPress → AXConfirm → AXOpen 序列（左键）
- ✅ AXShowMenu（右键）
- ✅ CGEvent postToPid 兜底（自 v0.0.105 就有）
- ✅ Electron 判定 + 双闸兼收（bundle + AXWebArea 兜底 + role 白名单）

未移植（open-codex 有，ours 无）：

### ① `activationOnlyClickFallback` — 对 `AXWindow` 元素的第三层 AX fallback

- **位置**：open-codex `ComputerUseService.swift:924-940` (`activateClickTarget`) + `:277-283` (`canUseActivationOnlyClickFallback`)
- **逻辑**：如果目标 role == `AXWindow`（LLM 想切窗口），先试 `AXRaise` action，再 set `AXMain=true`、`AXFocused=true`。任一 set 成功 = 视为「激活成功」。
- **调用条件**：`allowActivationFallback: true` + `!record.isSyntheticText` + `button == .left` + role 是 AXWindow（`:880-895`）
- **我们缺失场景**：LLM 点了 `AXWindow` 元素想"切到这个窗口"，我们直接落 CGEvent postToPid 打空间坐标（无窗口聚焦语义）；open-codex 走 AX 语义激活，与切窗口意图对齐。
- **判定**：`[必移植]` — 简单（~25 行 Swift），修一整类交互 bug（点窗口切前）。

### ② `descendantClickCandidates` — 对元素 3 层子树扫，取有 primary action 的最内层

- **位置**：open-codex `ComputerUseService.swift:1048-1095`（`descendantClickCandidates(of:windowBounds:depth:)`）
- **逻辑**：target 元素本身无 primary click action，向下扫 3 层子树（`depth < 3`），收集所有 `AXPress/AXConfirm/AXOpen/AXShowMenu` 候选 → 过滤掉 `isLikelySyntheticSideAction`（后置）→ 按 `clickPriority` + `frameArea` 从小到大排序 → 逐个尝试 `performPreferredClick`。
- **我们缺失场景**：LLM 拿到的 element_index 指向 Chromium AXGroup（无 action 但有 hover 效果，视觉像按钮），我们直接 AXPress 空转 → 落 CGEvent 打中心 → 可能落在子按钮之外的 padding 区。
- **判定**：`[值得移植]` — 修 Chromium wrapper 类元素的 click 命中率。规模稍大（40 行 Swift + `clickPriority` 20 行 + `frameArea` 5 行 + `isLikelySyntheticSideAction` 依赖 accessibilityLabels 30 行 ~= 90 行总）。

### ③ `clickActionPoints` + `hitTestElement`（coordinate 分支的候选生成）

- **位置**：open-codex `ComputerUseService.swift:434-482`（click 的 x/y 分支）+ `:743-767`（`clickCandidates`）
- **逻辑**：coordinate click 时 `clickCandidates(at:)` 拿 (`bestElement containing point`, `hitTestElement at point`) 双候选，逐个 `performAXClickSequence` 尝试；element_index 分支 `includeNearbyHitTesting=true` 时也拿 `clickActionPoints(for:record)`（center + 30% leading）逐点做 hit-test 找隐藏候选。
- **我们缺失场景**：LLM 给了错的 x/y（差 3px），我们直接 CGEvent postToPid 打偏；open-codex 从 point 反查 AX 元素补偿。
- **判定**：`[值得移植]`（coordinate 分支健壮性）；耦合度高——需要 `bestElement`（AX 树几何查找）+ `AXUIElementCopyElementAtPosition`（不确定 pid 上下文对不对）。规模约 80 行。

### click 其他 open-codex 特色（未在 v0.0.159 移植内）

- **`selectContainingListItem`** — 左键单击且**非** web area 时，向上 8 层找 `AXList`，若 list 支持 `kAXSelectedChildrenAttribute` set，直接 set 该 list item = 选中；对 Finder 侧边栏这类 list 特别有效。位置 `refs/.../ComputerUseService.swift:769-811`。判定 `[值得移植]`。
- **`containingRowFrame`** — click frame 计算辅助：目标 role=`AXStaticText` 且非 syntheticText 时向上 4 层找「宽 ≥ text+40 / 高 ≤ text*4 / 高 ≤ 96」的 row frame 作 click frame；提升点文本时命中率。位置 `:1352-1373`。判定 `[可选]`。
- **`isLikelySyntheticSideAction` filter**（`:1097-1104` + `:191-235`）：过滤掉误认的"侧边动作按钮"——检查是否 trailing-band 位置 (candidateFrame.midX ≥ parentFrame.maxX - trailingBandWidth) + compact (宽 ≤ 88 或 22% 父宽；高 ≤ 44 或 1.2 倍父高) + 有 primary action 或标签含 "完成/done/complete/archive"。作为 hit-test 补偿的第二关，防止把"右侧完成按钮"当行来点。判定 `[值得移植]`。
- **sleep 尾部**：open-codex 每个 primary action 成功后统一 `Thread.sleep(0.15)`；ours 已对齐（`ClickStrategy.swift:259/265`）。

## 1.5 `perform_secondary_action`

- **参数**：ours = `element_index + secondary_action`（`perform-secondary-action.ts:22-28`）；open-codex = `element_index + action`（`ComputerUseToolDispatcher.swift:68-73`）。
- **实现**：ours 直接对 `record.element` 调 `AXUIElementPerformAction(action)`，`.success` 否则报错（`Service.swift:178-187`）；open-codex 有两级 match：先 `rawActions` case-insensitive 精确匹配，然后 `prettyActions`（人类可读别名，如 `AXPress` → `Press`）匹配（`refs/.../ComputerUseService.swift:691-701`）。这解释了他们文档里能让 LLM 直接说 `Raise` 而不需要说 `AXRaise`。
- **判定**：`[可选]` — 我们 AX 树 render 直接把 raw AX action 名喂给 LLM（`AXRaise` 不 pretty），LLM 直接抄够用。pretty 映射除非移植他们完整 render 逻辑否则收益低。

## 1.6 `scroll` — 差异较大

- **参数**：ours = `direction + target(elementIndex|coord) + pages? + app?`（`scroll.ts:26-42`）；open-codex = `direction + element_index + pages?`（**必须 element_index，无 coordinate 分支**，`ComputerUseToolDispatcher.swift:74-79`）。
- **实现**：ours 只走 CGEvent scrollWheel event（`InputSimulation.swift:53-63`，`wheel1/wheel2/scrollDelta`：pages*12 单位）；open-codex 先看 `record.rawActions` 是否含 `AXScrollUpByPage/DownByPage/LeftByPage/RightByPage`——命中 + pages 是整数 → 对元素直接 `AXUIElementPerformAction`（`refs/.../ComputerUseService.swift:535-541`），失败 fallback CGEvent scrollWheel（`performScrollEvent`）。
- **我们缺失场景**：Web 页面里 `role=AXWebArea` 或 `role=AXScrollArea` 支持 `AXScrollDownByPage`，AX 语义翻页比 CGEvent scrollWheel + 近似像素精准（scrollWheel 事件在 Chromium 里被 momentum scrolling 篡改，一次 12 单位在不同浏览器状态下翻页量不稳定）。
- **判定**：`[必移植]` — `AXScrollByPage` 分支约 20 行 Swift；对齐 click 的「AX-first, CGEvent fallback」哲学；需要在 TS `scroll.ts` 传 element_index 时优先走这个路径。
- **反向差异**：我们保留 coordinate scroll（open-codex 无）——LLM 指定 x/y 滚动某个 pane 内容，这是 Rocky 场景有意义的能力，**保留**。

## 1.7 `drag`

- **参数**：ours = `from(x,y) + to(x,y) + app?`（`drag.ts:24-40`）；open-codex = `app + from_x + from_y + to_x + to_y`（`ComputerUseToolDispatcher.swift:82-88`）——模型一致（我们扁平化了）。
- **实现**：ours = `InputSimulation.dragTargeted` postToPid，10 步插值（`InputSimulation.swift:65-78`）；open-codex 相同 10 步插值（`refs/.../InputSimulation.swift:102-120`），**外加一个全局 fallback `dragGlobally`**（`event.post(tap: .cghidEventTap)`，走真硬件 HID 事件层，会移动光标）——仅当 `OPEN_COMPUTER_USE_ALLOW_GLOBAL_POINTER_FALLBACKS=1` env 开时启用（`refs/.../ComputerUseService.swift:1641-1652`）。
- **判定**：`[不移植]` — global fallback 的意图是「postToPid 拒绝时降级为真光标」，但会破坏 Rocky「不抢前台」的核心承诺；无价值。ours = 更严格的 targeted-only 策略更符合我们定位。

## 1.8 `press_key`

- **参数 + 实现**：完全一致（我们从 open-codex 逐字迁移，`KeyPressParser` 见 `KeyMapping.swift:59-98`）。
- **差异**：open-codex 的 `keyCodeMap` 更全（有 `insert` → `kVK_Help`，我们也有），且 `kp_*` 与我们完全同（对比 `refs/.../KeyMapping.swift:1-165` vs `app/computer-native/.../KeyMapping.swift:1-99`）。
- **判定**：无差异，无需移植。

## 1.9 `type_text` — 差异最大 & 最有价值

- **参数**：ours = `text + app?`；open-codex = `app + text`（模型一致）。
- **实现分歧极大**：
  - **ours**（`Service.swift:141-148` + `InputSimulation.swift:80-95`）：直接 `InputSimulation.typeText` — 生 `keyboardSetUnicodeString` 事件 postToPid。**始终走 CGEvent 键盘输入**。
  - **open-codex**（`refs/.../ComputerUseService.swift:576-595`）：三段式：
    1. **`typeTextBySettingFocusedValueIfAvailable`**（`:1222-1241`）——先看 focusedElement 是否 `settable` for `kAXValueAttribute` → 是则拼旧值 + text 直接 AX setValue（跳过 keyboard）。旧值检测走 `editableBaseValue`（`:1272-1298`）：递归找子 `AXStaticText` value（过滤 placeholder），如无则取 focused element 的 `kAXValueAttribute`（过滤 `AXPlaceholderValue`/`AXPlaceholder`），过滤"沟通时请保持公开可接受"这类 Lark 特定占位文本。
    2. 失败 fallback **`canTypeTextUsingKeyboardFallback`**（`:1243-1257`）——focus role 是 `AXTextField/AXTextArea/AXTextView` **或** `roleDescription` 含 "text field/area/entry"，或 value settable，才允许 keyboard fallback；否则报 `stateUnavailable`「type_text requires a focused editable text element. Click a text entry area first, or use set_value on a settable text element.」
    3. keyboard fallback = 我们 `InputSimulation.typeText` 相同路径
- **我们缺失场景**：Electron 输入框（如 Lark 消息框、VSCode 命令面板）的 focus 元素支持 AX setValue 但 keyboard event 常被 React 合成事件层吃掉——open-codex 优先走 setValue 直击 DOM，我们只走 keyboard 常常 type 空转。
- **判定**：`[必移植]` — 与 v0.0.159 click 修复同源问题；type_text 移植后消息输入等场景可靠性显著提升。约 50 行 Swift。

## 1.10 `set_value`

- **参数 + 实现**：几乎一致——`element_index + value`，Swift 侧都用 `AXUIElementSetAttributeValue(element, kAXValueAttribute, value)`。
- **差异**：
  - open-codex 用 `isSettableForSetValue` 显式检测 `AXUIElementIsAttributeSettable`（`:960-968`）→ 不 settable throw `nonSettableSetValueErrorMessage = "Cannot set a value for an element that is not settable"`；ours 一样（`Service.swift:162-172` throw `notSettable`），文案不同。
  - open-codex `set_value` 结束后 `Thread.sleep(0.1)`（`:643`）；ours 无 sleep。
- **判定**：`[可选]` — 100ms sleep 语义（AX set → UI 反应）；如果发现 setValue 后立刻 read_ax_tree 有时读到旧值，加 100ms sleep 值得。
