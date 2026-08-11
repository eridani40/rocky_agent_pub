# v0329-door-model — 329 门模型三态切换主链路

> 一次性 case（v0.0.329，非入库）：验证区域2/3 门模型三态（center/left/right）切换行为 + 三个不变 + 禁直跳 + 把手铁律。
> PRD 路径源：`specs/prd/version_logs/v0.0.329-region23-door.md` §3/§4/§7（UC-1~6、UC-10）+ §12 验收标准。
> testid 锚点：`specs/tech/version_logs/v0.0.329/change_log.md`（实测坐标）+ `section-preview-area.tsx` / `component-preview-collapse-toggle.tsx`。

## Use Case
作为 Rocky 用户，我希望 chat 与预览之间的分隔是「可横向滑动的门」：居中 2/3 共存（细线 + 左◀右▶ 双把手），点 ◀ 门滑最左（预览占满门框、chat 隐藏），点 ▶ 门滑最右（chat 占满门框、preview 隐藏），left/right 态点粗线或唯一把手回居中；left↔right 不能直跳；门框（2+3）总宽/位置三态恒定；区域1/4 不受影响；内容不移位。

## 前置条件
- `bash tests/e2e/env.sh start v0329-door-model --mode=headless`
- Playground 新建会话 → ws-panel 打开一个文本文件进预览区（2+3 共存 = center 态默认）。
- 定位锚点（组件 spec §5.7 + change_log 实测）：
  - **center**：`pv-door-left`（◀ 贴细线左）/ `pv-door-right`（▶ 贴细线右）/ `pv-resize-left`（细线，两把手之间）
  - **left**：`pv-collapsed-rail`（粗线贴门框左缘）+ `pv-door-center`（▶ 贴粗线右）
  - **right**：`pv-collapsed-rail`（粗线贴门框右缘）+ `pv-collapse-expand`（◀ 贴粗线左）
- 几何测量：`playwright-cli --raw eval` 取元素 boundingBox（x/y/width）+ 区域1 右缘 / 区域4 左缘坐标，比较三态。

## 操作目标（编号步骤）

1. **进入并展开预览（center 态确认）**：Playground → 会话 → ws-panel 点文件 → 预览 tab 打开 → snapshot 断言：`pv-door-left` + `pv-door-right` 双把手可见、`pv-resize-left` 细线在两者之间、chat 消息区与 preview 并存。
2. **center → left（UC-1 / 验收2）**：点 `pv-door-left` → 断言：`pv-collapsed-rail` 粗线贴门框左缘（≈ 区域1 右边界）、`pv-door-center` ▶ 贴 rail 右侧、chat 区消失（消息 DOM / 输入框不可见）、preview 占满 2+3 门框。
3. **left → center（UC-3 / 验收4）**：点 ▶（`pv-door-center`）→ 断言：双把手回位（`pv-door-left`/`pv-door-right` 可见）、chat 区恢复。
4. **center → right（UC-2 / 验收3）**：点 `pv-door-right` → 断言：`pv-collapsed-rail` 贴门框右缘（≈ 区域4 左边界）、`pv-collapse-expand` ◀ 贴 rail 左侧、preview 不可见、chat 占满 2+3 门框。
5. **right → center（UC-5 / 验收4）**：点 ◀（`pv-collapse-expand`）→ 断言：双把手回位。
6. **left → center via 粗线（UC-4）**：点 `pv-door-left` 再进 left → 点粗线 rail 本体 → 断言回 center（双把手回位）。
7. **right → center via 粗线（UC-6）**：点 `pv-door-right` 进 right → 点粗线 rail 本体 → 断言回 center。
8. **left↔right 禁直跳（UC-10 / 验收5）**：left 态 snapshot 中**无 ◀ 入口**（仅 rail + ▶）；right 态 snapshot 中**无 ▶ 入口**（仅 rail + ◀）；界面上无跨态直达按钮。
9. **三个不变（红线 / 验收7）**：记录三态下 区域1 右缘 x、区域4 左缘 x、门框（2+3）总宽、preview/chat 内容边界 → 三态一致；left/right 态 rail 贴缘处无空白区、内容无跑位。
10. **把手位置铁律（§2.3 / 验收1）**：boundingBox 验证：center 左把手右缘 ≤ 细线左缘、右把手左缘 ≥ 细线右缘；left ▶ 左缘 ≥ rail 右缘；right ◀ 右缘 ≤ rail 左缘。

## 验收口径（executor 自由心证）
- **pass**：1-10 全走通——三态渲染/切换正确、把手贴线侧别正确、门框总宽三态恒定、区域1/4 不动、无跑位空白、禁直跳成立。
- **small**：主链路通但有瑕疵（如视觉小偏差、过渡观感、偶发需多等一拍）。
- **blocking**：三态渲染错（把手跑异侧 / 门框总宽变 / 区域跑位 / 空白区）、点击无反应、chat 消息丢失、出现直跳入口、关键元素缺失。

## 依赖
- specs/prd/version_logs/v0.0.329-region23-door.md §2.3/§3/§4/§7/§12
- specs/tech/version_logs/v0.0.329/change_log.md（testid 锚点 + 实测坐标）
- specs/ui/components/chat-page/section-preview-area.md §5.7
- specs/ui/overall/00-app-guide.md §3.1（Playground 导航）
