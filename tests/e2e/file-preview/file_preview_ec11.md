# ET case: 双分隔条拖拽（chat|预览 + 预览|工作区 独立调整）

> case_id: file_preview_ec11
> 来源: PRD §6 EC-11（UC-8 覆盖）+ test-plan §4 EC-11
> 前置: v0.0.320 三栏动态布局已编码完成（Task 2 D1/D2/D3），dev 环境已启动

## 前置条件
- dev app 已启动，进入有 workspace 的 chat 页（playground 或 studio 单聊，三栏布局）
- 预览区已展开（有 tab 或空态占位均可）

## 操作目标

1. 确认三栏布局 + 两条分隔条：
   - `.pv-resize-left`：chat | 预览区 之间（贴预览左缘）
   - `.pv-resize-right`：预览区 | 工作区 之间（贴预览右缘，复用 ws-resize 模式）
2. **拖 chat|预览 分隔条**（`.pv-resize-left`）：
   - 向左拖 → chat 变宽 / 预览区变窄（反向亦然）
   - 断言 chat 与预览区宽度独立变化，互不越界（clamp 生效）
3. **拖 预览|工作区 分隔条**（`.pv-resize-right`）：
   - 向左拖 → 预览区变宽 / 工作区变窄
   - 向右拖 → 预览区变窄 / 工作区变宽
   - 断言预览区与工作区宽度独立调整
4. **拖到极限**（很窄）：断言各栏压缩到各自最小可用（chat 320px / 预览 240px / 工作区 232px），不强制固定比例
5. **刷新页面** → 断言宽度持久化（localStorage `pv-width-<sid>` 生效，宽度保持）
6. 截图留证：初始三栏 + 拖左条后 + 拖右条后 + 极限窄 + 刷新后

## 判定
- pass: 双分隔条独立拖拽，各栏宽度独立变化，clamp 生效，刷新后宽度持久化
- small: 拖拽正常但边界 clamp/持久化有小瑕疵
- blocking: 分隔条缺失 / 拖拽无效果 / 两条分隔条互相干扰（拖一条另一条跟着动）/ 拖到越界

## 备注
- 双分隔条（PRD §2.1 D1/D2/D3）：`.pv-resize-left`（side='left' posSide='left'，贴预览左缘，拖拽=预览变宽）+ `.pv-resize-right`（side='right'，贴预览右缘，拖拽=预览变宽）
- 复用 `component-col-resize-handle` 通用拖拽手柄（delta 算法，mousedown 捕获 startRef，mousemove 算 dx，clamp 后 onResize）
- 宽度范围：chat clamp [320px, 近全屏]；预览 clamp [240px, 近全屏]；工作区 clamp [232px, 近全屏]（PRD §2.1）
- 宽度 + 收起态 localStorage per session（`pv-width-<sid>` + `pv-collapsed-<sid>`）
- playwright 拖拽：可用 mouse down/move/up 模拟（或 drag 命令），拖拽距离建议 100-200px
