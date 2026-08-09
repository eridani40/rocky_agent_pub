# studio-squad-status-nav — 会话页成员状态入口（squad 图标 + running badge + 面板 + 两级导航）

> v0.0.268 关键用户路径 case。纯自然语言，零断言零录制零 testid 预定义；executor 读 case.md + app-guide 按 snapshot 文案/位置自选定位方式。
> PRD 源：`specs/prd/version_logs/v0.0.268.squad_status_nav/prd.md` 关键用户路径 UC-1~8。

## Use Case
作为团队用户，我进入 squad 的**会话落地页**（单聊/群聊），顶部导航应常驻 **squad 图标 + running badge**（当前 running 成员数，含 leader，0 时不显数字；数字随成员状态变化实时刷新）。点图标展开**成员状态面板**：上区 running / 下区 idle 分区，行内展示 presence 工作标记；hover 成员行出现「进入对话」icon，点击直达该成员会话；从面板进入的会话点返回键，**恒回 squad 首页**（两级导航，不逐级回退）。

## 前置条件
- env.sh 已起好环境（headless 或 electron 模式）。
- LLM provider 可用（minimax 优先；429 则按 skipped 口径汇报，不算 fail）。
- 环境为全新 DATA_DIR 或可复用既有 squad；**executor 自建 squad + ≥1 成员**（保证面板非空、能进会话）。
- squad 内成员 session 可用（可进单聊/群聊落地页）。

## 操作目标（编号步骤）

1. **进入 Studio 首页**：照 `specs/ui/overall/00-app-guide.md` §3.2——nav-rail「Studio」→ 选/建 squad → 落首页（SeatsPanel）。
2. **建 squad + 成员（若无）**：若环境无 squad，新建一个 + 至少 1 个 mate（可 hire/deploy 一个成员）。
3. **进入会话落地页**：坐席卡「进入对话」（单聊）或队长卡「群聊」按钮 → 落到会话落地页（UC-1/UC-7）。
4. **验收顶部入口（UC-1）**：会话落地页 **topbar 左侧、返回键旁** 常驻 squad 图标 + running badge：
   - 当前无成员 running → **只显示图标，不显示数字**（UC-8）。
   - 若有成员 running（含 leader）→ 显示数字（= running 成员数；suspended 不计）。
5. **验收 badge 实时刷新（UC-2，尽力而为）**：若环境可让某成员 session 进入 running（如让 agent 执行一个耗时操作/LLM 生成中），badge 数字应随状态变化**实时 +1/-1**（无需刷新页面）。无法稳定制造 running 时此项可降级观察（记录现象，不算 fail）。
6. **点 squad 图标展开面板（UC-3）**：点击图标 → 弹出成员状态面板。
7. **验收面板分区 + presence（UC-3）**：
   - **上区 running**：running 成员行（含 leader），行内 = 头像 + 名字 + role 标识 + presence 工作标记（当前工作文字；空则「运行中」类 fallback）。
   - **下区 idle**：idle 成员行（deployed 非 running），presence 文字同理（空则「在线」类 fallback）。
   - benched 成员不显示。
8. **验收 hover 进入对话 icon（UC-4）**：hover 任一成员行 → 该行右侧出现「进入对话」icon（**无文字**，仅 icon）。
9. **点 icon 进入成员会话（UC-4）**：点击 icon → 进入该成员会话落地页（面板关闭）。
10. **验收返回恒回首页（UC-5）**：在该会话点**返回键** → 直接回到 **squad 首页**（SeatsPanel），**不是**回到之前看的会话。
11. **关闭面板（UC-6）**：再进一个会话 → 点图标开面板 → 点面板外区域 / 按 Esc → 面板关闭，会话页正常使用。

## 验收口径（executor 自由心证）
- **pass**：入口常驻（图标 + badge，0 running 不显数字）；点图标面板弹出；running 上 / idle 下分区 + presence 文字；hover 出现进入对话 icon（无文字）；点 icon 进会话；返回**恒回 squad 首页**（两级导航）；点外/Esc 关面板。
- **small**：主链路通，但有小瑕疵（badge 数字刷新有延迟、面板视觉微差、presence 文案 fallback 措辞略异，不影响主路径）。
- **blocking**：会话落地页无入口 / badge 数字错误（含 leader 但没算 / suspended 算进去了）/ 点图标面板打不开 / 面板无 running·idle 分区 / hover 无进入对话 icon / 点 icon 进不了会话 / 返回不回首页（逐级回退或回错地方）。
- **skipped**：无法自建 squad/成员（环境问题非产品 bug，如实记 reason）。

## 依赖
- specs/ui/overall/00-app-guide.md §3.2（Studio 路径 + 「会话页成员状态入口（v0.0.268）」段）
- specs/ui/components/studio-page/component-squad-status-entry.md（入口 + 面板组件契约）
