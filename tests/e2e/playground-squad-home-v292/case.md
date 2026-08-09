# playground-squad-home-v292 — Squad 首页修复 + Leader 卡片重设计（v292）

> v0.0.292 关键用户路径 case。纯自然语言，零断言零录制零 testid 预定义；executor 读 case.md + app-guide 按 snapshot 文案/位置自选定位方式。
> PRD 源：`specs/prd/v0.0.292-squad-home-fixes/PRD.md` 5 点改动。

## Use Case
作为团队用户，我进入 squad 首页（SeatsPanel），应看到：成员列表头「成员·N」计数**含 leader**（实际总数）；**Leader 行整行黑底白字反色高亮**（全场视觉焦点，hover 时黑底变微灰）；右侧全景有**外层卡片边界**（同左侧卡片风格）、内容自适应撑开**不在内部滚动**；整个页面**可垂直滚动**（内容超出视口时）；群聊入口开关在**管理 tab**（不是自动工作 tab）。

## 前置条件
- env.sh 已起好环境（headless 或 electron 模式）。
- 存在（或临时创建）一个 squad，含 **leader + ≥1 个 deployed mate + ≥1 个 benched mate**（保证成员卡非空、能验证 leader 反色 + 三分区）。创建路径照 `00-app-guide.md` §3.2 + `06-studio.md` §3.1。
- 群聊开关可在管理 tab 开启/关闭（验证点5 挪 tab）。

## 操作目标（编号步骤）

1. **进 Studio 选 squad 落首页**：照 `00-app-guide.md` §3.2——nav-rail「Studio」→ 选 squad → 落首页。确认布局正常加载（左竖条 token+成员 / 右全景）。

2. **验收成员计数（点1）**：成员列表头部「成员·N」——N 应为**列表实际长度（含 leader）**。数一下页面显示的成员行总数（leader + running mates + idle mates），确认 N 等于这个总数（不再排除 leader）。

3. **验收 Leader 卡片反色高亮（点2 核心）**：找到 Leader 行（通常在列表最上方/running 首位）——确认它是**整行黑底白字反色高亮**（其他成员行是白底黑字，leader 与之形成强烈反差）。Leader 是**全场视觉焦点**（一眼就能锁定）。badge 样式强化（半透明白底）。avatar 保持原色（不反色）。

4. **验收 Leader hover（点2 补充）**：hover Leader 行——确认 hover 时**黑底变微灰**（不是大跳变、不是位移，只是底色微调，如 bg-fg → bg-fg/90 的微灰效果）。hover 移开后恢复黑底。

5. **验收全景卡片边界（点3）**：右侧全景区域——确认它有**外层整体卡片边界**（圆角 + 边框 + 背景，与左侧 token 卡/成员卡同样的卡片风格）。不再是裸露无边界的区域。

6. **验收全景自适应不内部滚动（点3 老板确认）**：右侧全景——确认内容**自适应撑开**（有多大内容就多大），整个卡片展开，**不在卡片内部滚动**（无内部滚动条）。

7. **验收整页滚动（点4 老板确认）**：当内容超出视口高度时——确认**整个页面可以垂直滚动**（不是某个卡片内部滚，是整页滚）。如果内容不超视口则不出现滚动条（正常）。试试缩放窗口或查看较长内容时页面整体滚动。

8. **验收群聊开关位置（点5）**：进入 squad 设置——确认群聊入口开关在**「管理」tab**（不是「自动工作」tab）。在管理 tab 找到群聊开关；切到自动工作 tab 确认那里**没有**群聊开关。

## 验收口径（executor 自由心证）
- **pass**：5 点全部正确——成员计数含 leader；Leader 行黑底白字反色（视觉焦点）+ hover 微灰；全景有外层卡片边界 + 自适应不内部滚动；整页可垂直滚动；群聊开关在管理 tab（不在自动工作 tab）。
- **small**：主链路通但有瑕疵（Leader 反色但 hover 效果不明显、全景卡片边界样式微差、滚动略卡，不影响功能验证）。
- **blocking**：成员计数仍排除 leader / Leader 无反色高亮（白底黑字同其他成员） / 全景无卡片边界 / 全景内部滚动 / 整页无法滚动 / 群聊开关仍在自动工作 tab / 关键区域空白或报错。
- **skipped**：无法自建 squad/成员（环境问题非产品 bug，如实记 reason）。

## 依赖
- `specs/ui/overall/00-app-guide.md` §3.2（Studio 路径）
- `specs/ui/components/studio-page/component-seats-body.md`（v292 更新）
- `specs/ui/components/studio-page/component-member-roster-list.md`（v292 更新）
- `specs/prd/v0.0.292-squad-home-fixes/PRD.md`
