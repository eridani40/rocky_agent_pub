# studio-panorama — 首页 IA + 任务 tab + token 小组件冒烟（v0.0.240 改造后）

> v0.0.240 首页 IA 改造后板块冒烟：首页 tab 改名 / token 小组件点击 / 任务 tab 4 列 / 归档开关 / 成员·N / 第二栏全景内嵌。
> 纯自然语言，零断言零录制；executor 读 case.md + `specs/ui/overall/00-app-guide.md` + `specs/ui/overall/06-studio.md` 按 snapshot 文案/位置自选定位方式。
> 设计稿：`reqs/[working] v0.0.240.squad_task/demo-home.html`（视觉契约——按需跑 vision_check compare）。

## Use Case
作为团队用户，我打开 Studio 首页，一眼看到 token 用量图文趋势（点击进 token 统计详情）、roster「成员·N」（N 已减队长），
首页底部第二栏直接是项目全景（不再独立路由），首个固定 tab 是「任务」（kanban 按状态分 4 列：未开始/等待中/进行中/已结束），
可以拖卡片改状态、点卡片编辑、卡片归档、切「含归档」开关看归档项——验证首页 IA + 任务 tab + token 小组件全链路。

## 前置条件
- env.sh 已起好环境（headless 或 electron 模式）。
- LLM provider 可用（minimax 优先；429 则按 skipped 口径汇报，不算 fail）。
- 环境为全新 DATA_DIR 或可复用既有 squad（首个 squad 即可）。
- squad 已有至少 1 个 mate（让 roster 非空，便于看「成员·N」计数）。

## 操作目标（编号步骤）

1. **进入 Studio 首页**：照 app-guide 打开 Studio → 选中一个 squad → 主区落在首页 SeatsPanel。
2. **验收首页 tab 改名（P6）**：SeatsPanel 头部三 tab 第一项文案是「首页」（**原「坐席」已改名**）。
3. **验收 roster 头计数（P6）**：roster 白卡头部计数文案是「成员 · N」，N = 总人数 − 队长（如 squad 1 leader + 2 mate → 「成员 · 2」）。
4. **验收 token 小组件（P3）**：首页左列队长卡下方有 TokenWidget 图文组件（**非原 4 宫格 SeatStats、非 TeamEntryRow**）：
   - 今日三色比例条（输入=蓝 / 输出=紫 / 缓存=绿，各带 M 数字）
   - 7 日迷你柱状（蓝→青渐变）
   - 累计/预算 amber 进度条
5. **点击 token 小组件（P3）**：整卡可点击 → 主区切到 token 统计详情页（头部返回键回首页 seats）。
6. **验收第二栏全景内嵌（P6）**：首页底部有「项目全景」栏（**非独立路由、无返回键头部**），内嵌 PanoramaRoute：
   - tab 条首个固定 tab = 「任务」（builtin，永远首项）
   - 若 leader DSL 有动态 views（如「按进展看板」等），按序跟在「任务」之后
7. **点「任务」tab（P4）**：渲染 kanban，按状态分 **4 列**（未开始 / 等待中 / 进行中 / 已结束；列头色带 + 卡片左缘色条；等待中列=amber 警示）。
8. **建任务（可选，若无任务可让 leader 在群聊用 panorama 工具建）**：点 toolbar「+新建」按钮 → 弹层填 title/owner → 提交后卡片出现在「未开始」列。
9. **拖卡片改状态（P4）**：把一张任务卡片从「未开始」拖到「进行中」→ 卡片移动到进行中列（或非法跃迁时回弹 + toast）。
10. **点卡片（P4）**：弹实体编辑弹层（status 字段只读，状态变更走拖拽/transition）。
11. **卡片归档（P4）**：hover 一张卡片 → 出现归档按钮（icon）→ 点击 → 卡片从活跃视图消失（PATCH archived:true）。
12. **切「含归档」开关（P4）**：toolbar 左侧「活跃 / 含归档」segmented 开关 → 点「含归档」→ 归档 task 重新出现（视觉弱化 opacity 0.55）；切回「活跃」→ 归档项再次隐藏。

## 验收口径（executor 自由心证）
- **pass**：tab「首页」+ roster「成员·N」+ TokenWidget（图文 + 整卡点击进 token-stats）+ 第二栏全景「任务」tab 4 列 + 拖拽/卡片点击/归档/开关 全链路贯通。
- **small**：主链路通，但有小瑕疵（如三色比例条像素偏差、kanban 列色微差、7 日柱宽度不一）。
- **blocking**：tab 仍叫「坐席」/ roster 计数仍含队长 / TokenWidget 不渲染或点击无效 / 第二栏无任务 tab / 任务 tab 不是 4 列 / 拖拽 + 归档 + 开关 任一关键功能坏。
- **skipped**：LLM 429 导致 leader 无法建任务（环境问题非产品 bug，如实记 reason）。

## 视觉保真度比对（设计稿 demo-home.html，MANDATORY）
executor 跑完操作目标后按需 `python3 tests/e2e/vision_check.py compare <首页 impl 截图> "reqs/[working] v0.0.240.squad_task/demo-home.html" '<checks_json>'`，checks 建议：
- layout：首页整体布局（左列队长+token / 右列 roster / 底部第二栏全景）
- color：token 三色比例条（input-blue / output-violet / cache-green）+ 累计 amber 进度条
- layout/color：任务 tab kanban 4 列（未开始 gray / 等待中 amber / 进行中 blue / 已结束 green）+ 列头色带 + 卡片左缘色条
- font：tab 条「首页」+ roster 头「成员·N」文案

## 依赖
- specs/ui/overall/00-app-guide.md（Studio 路径）
- specs/ui/overall/06-studio.md（首页 IA + 第二栏全景）
- specs/ui/components/studio-page/component-token-widget.md（token 小组件契约，含视觉基线）
- specs/ui/components/studio-page/component-panorama-{route,view}.md（全景契约）
- specs/api/overall/14-panorama-endpoints.md v1.3（task builtin + filter + 归档）
