import ApplicationServices
import CoreGraphics
import Foundation

@testable import RockyComputerCore

// Block5Tests —— v0.0.160 块 5（TreeRenderer 大重写）UT，覆盖 gap #13。
//
// 拆自 main.swift；`expect()` 由 main.swift 定义（同 target 模块作用域可见）。
// AX-dependent 函数（summarizeTraits/preferredDisplayTitle/render 主体等）不能纯 UT，
// 需 dev dogfood 6+ app 手验；本 UT 只覆盖 pure helper + 边界。
//
// 参考: specs/tech/version_logs/v0.0.160/change_plan.md 模块 F

func runBlock5Tests() {
    // MARK: - sanitizeText

    expect(sanitizeText("  hello world  ") == "hello world",
           "sanitizeText trim + no truncate")
    expect(sanitizeText("line1\nline2") == "line1\\nline2",
           "sanitizeText \\n → \\\\n（折行归一）")
    expect(sanitizeText(String(repeating: "a", count: 600), textLimit: SnapshotTextLimit(maxCount: 10)) == String(repeating: "a", count: 10) + "...",
           "sanitizeText 截断 = prefix + '...'")
    expect(sanitizeText(String(repeating: "a", count: 600), textLimit: .max) == String(repeating: "a", count: 600),
           "sanitizeText .max 不截断")
    expect(sanitizeText("") == "", "sanitizeText 空字符串 → 空")

    // MARK: - displayIdentifier

    expect(displayIdentifier(nil) == nil, "displayIdentifier nil → nil")
    expect(displayIdentifier("") == nil, "displayIdentifier empty → nil")
    expect(displayIdentifier("_NS:12345") == nil, "displayIdentifier '_NS:' 前缀 → nil (AppKit 内部命名不展示)")
    expect(displayIdentifier("my-btn") == "my-btn", "displayIdentifier 正常值 → 原样")

    // MARK: - displayWindowTitle

    expect(displayWindowTitle(nil, appName: "Safari") == "Safari",
           "displayWindowTitle nil → appName 兜底")
    expect(displayWindowTitle("", appName: "Safari") == "Safari",
           "displayWindowTitle empty → appName")
    expect(displayWindowTitle("Safari – Apple", appName: "Safari") == "Safari",
           "displayWindowTitle 前缀匹配 → appName 去重复")
    expect(displayWindowTitle("Downloads", appName: "Safari") == "Downloads",
           "displayWindowTitle 正常值 → 原样")

    // MARK: - splitCamelCase / humanizeAXToken

    expect(splitCamelCase("") == "", "splitCamelCase empty → empty")
    expect(splitCamelCase("A") == "A", "splitCamelCase 单字符 → 无前导空格")
    expect(splitCamelCase("ShowMenu") == "Show Menu", "splitCamelCase 拆 CamelCase")
    expect(humanizeAXToken("AXPopUpButton") == "pop up button",
           "humanizeAXToken 去 AX + 拆 + 小写")
    expect(humanizeAXToken("Button") == "button", "humanizeAXToken 无 AX 前缀也小写")

    // MARK: - markdown link 转义

    expect(markdownEscapedLinkText("hello") == "hello", "markdownEscapedLinkText 无特殊字符 → 原样")
    expect(markdownEscapedLinkText("a [b] c") == "a \\[b\\] c",
           "markdownEscapedLinkText 方括号转义")
    expect(markdownEscapedLinkText("path\\dir") == "path\\\\dir",
           "markdownEscapedLinkText 反斜杠转义")
    expect(summaryMarkdownLinkText(text: "Google", url: "https://g.com") == "[Google](https://g.com)",
           "summaryMarkdownLinkText 基本组装")

    // MARK: - Label / Value / Placeholder / Identifier segments

    // Label
    expect(formattedLabelSegment(nil, title: "T", linkText: nil) == "",
           "formattedLabelSegment nil label → 空")
    expect(formattedLabelSegment("same", title: "same", linkText: nil) == "",
           "formattedLabelSegment label==title → 空")
    expect(formattedLabelSegment("desc", title: "T", linkText: nil) == " Description: desc",
           "formattedLabelSegment 正常 → ' Description: <label>'")
    expect(formattedLabelSegment("Go", title: nil, linkText: "[Go](https://g.com)") == "",
           "formattedLabelSegment label 已在 linkText → 空")

    // Value with separator
    expect(formattedValueSegmentWithSeparator(" Value: v", precedingSegments: []) == " Value: v",
           "formattedValueSegmentWithSeparator 无 preceding → 原样")
    expect(formattedValueSegmentWithSeparator(" Value: v", precedingSegments: [" Description: d"]) == ", Value: v",
           "formattedValueSegmentWithSeparator 有 preceding → 前逗号")
    expect(formattedValueSegmentWithSeparator("", precedingSegments: [" Description: d"]) == "",
           "formattedValueSegmentWithSeparator 空段 → 空")
    expect(formattedValueSegmentWithSeparator(" val", precedingSegments: [" Description: d"]) == " val",
           "formattedValueSegmentWithSeparator 非 Value: 前缀 → 不改")

    // Placeholder
    expect(formattedPlaceholderSegment(nil, title: nil, label: nil, value: nil, precedingSegments: []) == "",
           "formattedPlaceholderSegment nil → 空")
    expect(formattedPlaceholderSegment("Search", title: "Search", label: nil, value: nil, precedingSegments: []) == "",
           "formattedPlaceholderSegment == title → 空")
    expect(formattedPlaceholderSegment("Search", title: nil, label: nil, value: nil, precedingSegments: []) == " Placeholder: Search",
           "formattedPlaceholderSegment 无 title 无 preceding → 空格前缀")
    expect(formattedPlaceholderSegment("Search", title: "T", label: nil, value: nil, precedingSegments: []) == ", Placeholder: Search",
           "formattedPlaceholderSegment 有 title → 逗号前缀")

    // shouldCommaSeparateActions
    expect(shouldCommaSeparateActions(title: nil, inlineRowSummary: nil, genericTextSummary: nil, segments: []) == false,
           "shouldCommaSeparateActions 全 nil / 空 → 空格分隔")
    expect(shouldCommaSeparateActions(title: "T", inlineRowSummary: nil, genericTextSummary: nil, segments: []) == true,
           "shouldCommaSeparateActions 有 title → 逗号分隔")
    expect(shouldCommaSeparateActions(title: nil, inlineRowSummary: "summary", genericTextSummary: nil, segments: []) == true,
           "shouldCommaSeparateActions 有 inlineRowSummary → 逗号")
    expect(shouldCommaSeparateActions(title: nil, inlineRowSummary: nil, genericTextSummary: nil, segments: [" Value: v"]) == true,
           "shouldCommaSeparateActions 有 segment → 逗号")

    // displayIdentifierSegment
    expect(displayIdentifierSegment(role: "AXButton", identifier: nil, title: nil) == "",
           "displayIdentifierSegment nil identifier → 空")
    expect(displayIdentifierSegment(role: "AXButton", identifier: "btn-1", title: nil) == " ID: btn-1",
           "displayIdentifierSegment 正常 → ' ID: <id>'")
    expect(displayIdentifierSegment(role: kAXOutlineRole as String, identifier: "list", title: "list") == "",
           "displayIdentifierSegment outline + title==id → 空 (open-codex 归一)")
    expect(displayIdentifierSegment(role: kAXListRole as String, identifier: "list", title: "other") == " ID: list",
           "displayIdentifierSegment list + title!=id → 展示")

    // MARK: - shouldElideNode / shouldPreserveWebAreaGenericContainer / traitsAreNonDescriptiveWrapperTraits

    expect(!shouldElideNode(role: kAXButtonRole as String, title: nil, label: nil, value: nil,
                            identifier: nil, traits: [], actions: [], childCount: 0),
           "shouldElideNode 非 generic role → false")
    expect(shouldElideNode(role: kAXGroupRole as String, title: nil, label: nil, value: nil,
                           identifier: nil, traits: [], actions: [], childCount: 0),
           "shouldElideNode 空 group → true (elide)")
    expect(!shouldElideNode(role: kAXGroupRole as String, title: "T", label: nil, value: nil,
                            identifier: nil, traits: [], actions: [], childCount: 0),
           "shouldElideNode group 有 title → false")
    expect(!shouldElideNode(role: kAXGroupRole as String, title: nil, label: nil, value: nil,
                            identifier: nil, traits: [], actions: [], childCount: 0,
                            genericTextSummary: "hello"),
           "shouldElideNode 有 genericTextSummary → false")
    expect(shouldElideNode(role: kAXGroupRole as String, title: nil, label: nil, value: nil,
                           identifier: nil, traits: [], actions: [], childCount: 1),
           "shouldElideNode single-child empty wrapper → true")
    expect(shouldElideNode(role: kAXGroupRole as String, title: nil, label: nil, value: nil,
                           identifier: nil, traits: ["settable", "string"], actions: [], childCount: 1),
           "shouldElideNode single-child + wrapper-traits → true (traits 视为非描述性)")

    expect(shouldPreserveWebAreaGenericContainer(childCount: 2, webAreaDepth: 1) == true,
           "shouldPreserveWebAreaGenericContainer webArea 后代 childCount>1 → true")
    expect(shouldPreserveWebAreaGenericContainer(childCount: 1, webAreaDepth: 1) == false,
           "shouldPreserveWebAreaGenericContainer childCount<=1 → false")
    expect(shouldPreserveWebAreaGenericContainer(childCount: 5, webAreaDepth: nil) == false,
           "shouldPreserveWebAreaGenericContainer 非 webArea 后代 → false")

    expect(traitsAreNonDescriptiveWrapperTraits([]) == true, "traitsAreNonDescriptiveWrapperTraits 空 → true")
    expect(traitsAreNonDescriptiveWrapperTraits(["settable", "string"]) == true, "traits [settable, string] → true")
    expect(traitsAreNonDescriptiveWrapperTraits(["selected"]) == false, "traits [selected] → false")

    // MARK: - shouldSuppressChildren / displayRoleText

    expect(shouldSuppressChildren(role: kAXMenuBarItemRole as String, title: nil, genericTextSummary: nil) == true,
           "shouldSuppressChildren menubar item → true")
    expect(shouldSuppressChildren(role: "AXLink", title: "[label](url)", genericTextSummary: nil) == true,
           "shouldSuppressChildren AXLink + [ 前缀 → true")
    expect(shouldSuppressChildren(role: "AXLink", title: "raw", genericTextSummary: nil) == false,
           "shouldSuppressChildren AXLink 无 [ → false")
    expect(shouldSuppressChildren(role: kAXButtonRole as String, title: nil, genericTextSummary: "summary") == true,
           "shouldSuppressChildren 有 genericTextSummary → true")

    expect(displayRoleText(baseRoleText: "button", role: kAXMenuBarItemRole as String, title: nil, label: nil, suppressChildren: false) == "",
           "displayRoleText menubar item → 空")
    expect(displayRoleText(baseRoleText: "link", role: "AXLink", title: nil, label: nil, suppressChildren: true) == "link",
           "displayRoleText AXLink → 保 baseRoleText")
    expect(displayRoleText(baseRoleText: "button", role: kAXButtonRole as String, title: nil, label: nil, suppressChildren: true) == "container",
           "displayRoleText suppressChildren=true → container")
    expect(displayRoleText(baseRoleText: "radio group", role: kAXRadioGroupRole as String, title: nil, label: "opt", suppressChildren: false) == "",
           "displayRoleText radio group + label 无 title → 空")
    expect(displayRoleText(baseRoleText: "button", role: kAXButtonRole as String, title: "OK", label: nil, suppressChildren: false) == "button",
           "displayRoleText 正常 → baseRoleText")

    // MARK: - shouldMergeTextOnlySiblings / isSiblingCounterText / isStandaloneTimeRangeText

    expect(shouldMergeTextOnlySiblings(["a", "b"]) == true, "shouldMergeTextOnlySiblings 短 2 项 → true")
    expect(shouldMergeTextOnlySiblings(Array(repeating: "x", count: 9)) == false,
           "shouldMergeTextOnlySiblings >8 项 → false")
    expect(shouldMergeTextOnlySiblings([String(repeating: "a", count: 300)]) == false,
           "shouldMergeTextOnlySiblings 总长 >220 → false")
    expect(shouldMergeTextOnlySiblings(["日期", "时间"]) == false,
           "shouldMergeTextOnlySiblings 日期+时间双语 → false")
    expect(shouldMergeTextOnlySiblings(["1 / 3", "next"]) == false,
           "shouldMergeTextOnlySiblings 含计数器 → false")
    expect(shouldMergeTextOnlySiblings(["10:00 - 11:30"]) == false,
           "shouldMergeTextOnlySiblings 含时间段 → false")

    expect(isSiblingCounterText("1 / 3") == true, "isSiblingCounterText '1 / 3' → true")
    expect(isSiblingCounterText("42/100") == true, "isSiblingCounterText '42/100' → true")
    expect(isSiblingCounterText("hello") == false, "isSiblingCounterText 非计数器 → false")

    expect(isStandaloneTimeRangeText("9:00-10:30") == true, "isStandaloneTimeRangeText '9:00-10:30' → true")
    expect(isStandaloneTimeRangeText("10:00 - 11:30") == true, "isStandaloneTimeRangeText '10:00 - 11:30' → true")
    expect(isStandaloneTimeRangeText("10:00") == false, "isStandaloneTimeRangeText 单时间 → false")

    expect(shouldRenderGenericTextSummaryAsChildren("summary", summaryImageCount: 1) == true,
           "shouldRenderGenericTextSummaryAsChildren summary + images → true")
    expect(shouldRenderGenericTextSummaryAsChildren("summary", summaryImageCount: 0) == false,
           "shouldRenderGenericTextSummaryAsChildren summary + 0 image → false")
    expect(shouldRenderGenericTextSummaryAsChildren(nil, summaryImageCount: 1) == false,
           "shouldRenderGenericTextSummaryAsChildren nil summary → false")

    // MARK: - meaningfulActions

    // AXPress / AXShow* / AXConfirm / AXScrollToVisible 一律过滤
    let filtered = meaningfulActions(["AXPress", "AXShowMenu", "AXConfirm", "AXScrollToVisible", "AXCustom"], role: "AXButton")
    expect(filtered == ["Custom"],
           "meaningfulActions 过滤内隐 UI action + pretty → ['Custom']")

    // menubar 内 AXCancel / AXPick 额外过滤
    let menuFiltered = meaningfulActions(["AXCancel", "AXPick", "AXRaise"], role: kAXMenuItemRole as String)
    expect(menuFiltered == ["Raise"], "meaningfulActions menubar 系过滤 AXCancel/AXPick")

    // AXScrollArea 有 Up/Down 分页时过滤 Left/Right 分页
    let scrollFiltered = meaningfulActions(
        ["AXScrollUpByPage", "AXScrollDownByPage", "AXScrollLeftByPage", "AXScrollRightByPage"],
        role: kAXScrollAreaRole as String
    )
    expect(scrollFiltered == ["Scroll Up", "Scroll Down"],
           "meaningfulActions AXScrollArea 有 Up/Down 时过滤 Left/Right")

    // 无 Up/Down 时 Left/Right 保留
    let scrollLR = meaningfulActions(["AXScrollLeftByPage", "AXScrollRightByPage"], role: kAXScrollAreaRole as String)
    expect(scrollLR == ["Scroll Left", "Scroll Right"],
           "meaningfulActions AXScrollArea 无 Up/Down → Left/Right 保留")

    // MARK: - shouldContinueRendering / childTraversalAttributes

    let limits = AccessibilityTreeLimits.defaults
    expect(shouldContinueRendering(nextIndex: 0, depth: 0, limits: limits), "shouldContinueRendering 起点 → true")
    expect(!shouldContinueRendering(nextIndex: limits.maxNodeCount, depth: 0, limits: limits),
           "shouldContinueRendering nextIndex >= max → false")
    expect(!shouldContinueRendering(nextIndex: 0, depth: limits.maxDepth, limits: limits),
           "shouldContinueRendering depth >= max → false")

    // 非 rows/visible primary role → 拉 kAXChildren + rows + contents + visibleChildren
    let generalAttrs = childTraversalAttributes(role: kAXButtonRole as String, hasRows: false, hasVisibleChildren: false)
    expect(generalAttrs.first == kAXChildrenAttribute && generalAttrs.contains(kAXRowsAttribute) && generalAttrs.count == 4,
           "childTraversalAttributes 非 rows-primary → kAXChildren 首位 + 4 通道")

    // list role + hasRows → 跳过 kAXChildren
    let listAttrs = childTraversalAttributes(role: kAXListRole as String, hasRows: true, hasVisibleChildren: false)
    expect(!listAttrs.contains(kAXChildrenAttribute),
           "childTraversalAttributes list-primary + hasRows → 不拉 kAXChildren")

    // list role + hasVisibleChildren → 跳过 kAXChildren
    let listVisAttrs = childTraversalAttributes(role: kAXListRole as String, hasRows: false, hasVisibleChildren: true)
    expect(!listVisAttrs.contains(kAXChildrenAttribute),
           "childTraversalAttributes list-primary + hasVisibleChildren → 不拉 kAXChildren")

    expect(usesRowsAsPrimaryRole(kAXOutlineRole as String), "usesRowsAsPrimaryRole outline")
    expect(usesRowsAsPrimaryRole(kAXListRole as String), "usesRowsAsPrimaryRole list")
    expect(usesRowsAsPrimaryRole(kAXTableRole as String), "usesRowsAsPrimaryRole table")
    expect(usesRowsAsPrimaryRole("AXBrowser"), "usesRowsAsPrimaryRole AXBrowser")
    expect(!usesRowsAsPrimaryRole(kAXButtonRole as String), "usesRowsAsPrimaryRole button → false")

    expect(usesVisibleChildrenAsPrimaryRole(kAXListRole as String), "usesVisibleChildrenAsPrimaryRole list → true")
    expect(!usesVisibleChildrenAsPrimaryRole(kAXOutlineRole as String), "usesVisibleChildrenAsPrimaryRole outline → false")

    // MARK: - windowRelativeFrame

    let elementFrame = CGRect(x: 100, y: 200, width: 50, height: 30)
    let windowBounds = CGRect(x: 20, y: 40, width: 800, height: 600)
    let localFrame = windowRelativeFrame(elementFrame: elementFrame, windowBounds: windowBounds)
    expect(localFrame == CGRect(x: 80, y: 160, width: 50, height: 30),
           "windowRelativeFrame = screen frame - window origin")

    // MARK: - AccessibilityTreeLimits

    expect(AccessibilityTreeLimits.defaults.maxNodeCount == 1200,
           "AccessibilityTreeLimits.defaults.maxNodeCount == 1200 (对齐 v0.0.105 语义)")
    expect(AccessibilityTreeLimits.defaults.maxDepth == 64,
           "AccessibilityTreeLimits.defaults.maxDepth == 64")
    let custom = AccessibilityTreeLimits(maxNodeCount: 500, maxDepth: 20)
    expect(custom.maxNodeCount == 500 && custom.maxDepth == 20,
           "AccessibilityTreeLimits 自定义 init 正确")

    // MARK: - RenderContext 构造（AXUIElement 依赖 focusedElement 传 nil 走 sentinel）

    let ctx = RenderContext(
        windowBounds: CGRect(x: 0, y: 0, width: 100, height: 100),
        focusedElement: nil,
        textLimit: .defaults,
        treeLimits: .defaults
    )
    expect(ctx.textLimit == .defaults && ctx.treeLimits == .defaults,
           "RenderContext 构造 + Equatable 一致")

    // TreeRenderer 初始状态
    let renderer = TreeRenderer(context: ctx)
    expect(renderer.nextIndex == 0 && renderer.lines.isEmpty && renderer.records.isEmpty && renderer.focusedSummary == nil,
           "TreeRenderer init 状态：nextIndex=0 / lines empty / records empty / focusedSummary nil")
}
