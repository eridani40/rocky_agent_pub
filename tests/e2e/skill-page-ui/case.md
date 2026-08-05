# skill-page-ui — Skill 页 UI 优化（安装弹层 + 来源筛选）

> PRD v0.0.198 §3 关键用户路径 A + B（E2E 主验证）。纯自然语言，零断言零录制。
> executor 读 case.md + `specs/ui/overall/00-app-guide.md` 按文案/位置自选定位方式。
> **不验证安装流程**（用户明确不验证；安装成功自动收起由 UT 覆盖）。

## Use Case
作为 Rocky 用户，我想在 Skill 管理页体验 v0.0.198 新增的两件 UI 优化：
(1) 安装区改成弹层（默认收起，tab 栏最右「+」按钮主动唤起）；
(2) 「我的」列表上方加来源筛选条（全部/内置/市场/Rocky），快速按来源缩小范围。
验证主路径贯通、视觉对齐。

## 前置条件
- env.sh 已起好环境（headless 或 electron 模式）。
- Skill 页有若干已装 skill（dev config seed 自带 builtin：panorama-designer / okf-skill / teamwork-leader / teamwork-mate）。

## 操作目标（编号步骤）

### 路径 A：安装区弹层化（PRD §3 路径 A）

1. **进入 Skill 页**：照 `specs/ui/overall/00-app-guide.md`——从 nav-rail 点 SKILLS 入口，落到 Skill 管理页。
2. **默认收起验证**：「我的」tab 默认激活；列表上方**不应**看到拖拽落点区（旧版常驻的「拖拽 Skill 到此处安装」）；列表占据顶部主视觉位置。
3. **「+」按钮位置验证**：tab 栏（「我的」「市场」同行）最右侧有一个「+」按钮（黑色圆/方块 + 白色 + 图标，dark 反色），与 tabs 同行靠右对齐。
4. **点「+」展开弹层**：点击「+」→ 列表上方出现安装区（复用 `component-skill-drop-zone`：「拖拽 Skill 到此处安装」标题 + 「选择文件」「选择文件夹」按钮）；安装区右上角有「×」关闭按钮。
5. **「+」变「×」**：展开时「+」按钮旋转 45°变成「×」视觉（提供「再点收起」语义）。
6. **点「×」关闭弹层**：点安装区右上角「×」按钮 → 安装区消失（条件渲染，彻底卸载），列表回占顶部；「×」按钮恢复为「+」。
7. **再点「+」/ 再点「×」**：再次点「+」→ 弹层重新展开；点「+」（此时是×态）→ 弹层收起。toggle 行为双向可逆。

### 路径 B：来源筛选条（PRD §3 路径 B）

1. **筛选条位置**：「我的」列表上方、安装弹层之下，有 4 个筛选选项横排：全部 / 内置 / 市场 / Rocky。默认激活「全部」（accent 色 + 底下划线）。
2. **切到「内置」**：点击「内置」→ 列表只剩 `scope === 'builtin'` 的 skill（dev 自带 4 个：panorama-designer / okf-skill / teamwork-leader / teamwork-mate）；「内置」选项激活。
3. **切到「市场」**：点击「市场」→ 列表只剩有 `marketRef` 的 skill（若当前环境无市场安装 skill，列表显示空态「还没有已安装的 Skill」属正常）；「市场」选项激活。
4. **Rocky hover tooltip**：鼠标 hover 到「Rocky」选项 → 弹出 tooltip 显示「来自于 Rocky 的自我迭代和进化」。
5. **切到「Rocky」**：点击「Rocky」→ 列表只剩 `productionMethod === 'consolidation'` 的 skill（若当前环境无 Rocky 自进化 skill，空态正常）。
6. **切回「全部」**：点击「全部」→ 列表恢复全量（含 builtin 4 个 + 任何其他来源）；「全部」选项激活。
7. **切到「市场」tab（nav）**：点击 nav tab「市场」→ 市场内容区挂载；**来源筛选条不应在市场 tab 渲染**（manage tab 独有）。
8. **切回「我的」**：点击 nav tab「我的」→ 来源筛选条恢复，激活态保留之前选择（如「全部」）。

## 验收口径（executor 自由心证）

- **pass**：路径 A 的弹层展开/收起/toggle 全通；路径 B 的 4 类筛选切换 + 列表正确过滤 + Rocky tooltip 显示 + 切 nav tab 后筛选条显隐正确。主链路贯通、视觉对齐既有 skill 页调性。
- **small**：主链路通但有视觉小瑕疵（如「+」旋转过渡偶发不流畅、tooltip 偏移、空态文案微差等，不影响功能验证）。
- **blocking**：找不到「+」按钮 / 点击无反应 / 弹层展开后找不到 drop-zone 内容 / 来源筛选条不渲染 / 切筛选列表不更新 / Rocky hover 无 tooltip / 切 nav tab 后筛选条错误渲染到市场 tab 等。

## 不覆盖（用户明确不验证）

- **安装流程**：拖拽/选择文件 → install 202 → 列表刷新 → 自动收起（由 UT 覆盖 `handleInstall` 成功分支调 `setInstallExpanded(false)`）。
- **AT**：纯前端无 API 契约变更，豁免。

## 依赖
- `specs/ui/overall/00-app-guide.md`（nav-rail → SKILLS 入口路径）
- `specs/ui/overall/04-skill-page.md` §2 页面结构（v0.0.198 弹层化 + 筛选条更新由 doc-modifier 同步）
- `specs/ui/components/skill-page/component-skill-source-filter.md`（筛选条组件契约）
- `specs/ui/components/skill-page/page-skill.md`（弹层 state + visibleSkills 派生模型）
