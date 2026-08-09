# playground-squad-home-layout — Squad 首页 3 板块布局重构（左竖条 token+成员 / 右全景）

> v0.0.288 关键用户路径 case。纯自然语言，零断言零录制零 testid 预定义；executor 读 case.md + app-guide 按 snapshot 文案/位置自选定位方式。
> PRD 源：`specs/prd/version_logs/v0.0.288.studio_layout/prd.md` 关键用户路径 UC-1~UC-9。

## Use Case
作为团队用户，我进入 squad 首页（SeatsPanel），应看到 **3 板块布局**：左侧竖条（上方 token 统计卡 + 下方成员列表卡）+ 右侧主体区全景。token 卡变矮（今日总量/60 天总量 + 7 日迷你柱，无三色比例条）；成员卡头部为「成员·N」标题 + 右对齐的「在岗/全部切换 + 群聊图标（群聊开启时）+ 加号」（全是 icon 无文字）；成员列表分 running/idle（全部视图含 benched，benched 最下且更灰）；全景填满右侧主体，左右不横滑、正常上下滚动。

## 前置条件
- env.sh 已起好环境（headless 或 electron 模式）。
- 存在（或临时创建）一个 squad，含 **≥1 个 deployed mate + ≥1 个 benched mate**（保证成员卡非空、能验证三分区）。创建路径照 `00-app-guide.md` §3.2 + `06-studio.md` §3.1（新建 squad 自动带队长；roster 头加号建 mate；mate 行更多菜单 bench 一个）。
- LLM provider 可用仅建 squad 时需要；本 case 的布局/切换/图标查看均为确定性 UI 操作，不依赖 LLM 回复质量。

## 操作目标（编号步骤）

1. **进 Studio 选 squad 落首页（UC-1 布局）**：照 `00-app-guide.md` §3.2——nav-rail「Studio」→ 选 squad → 落首页。确认 **3 板块**：
   - **左竖条**（约 296px 宽）：**上方 token 统计卡** + **下方成员列表卡**（上下排列）。
   - **右侧主体区**：全景（PanoramaRoute）填满，不再在页面底部。
2. **验收 token 卡（UC-3）**：左竖条上方 token 卡——看到「**今日总量 / 60 天总量**」两个数据并排 + **7 日迷你柱**（高度较矮）；**没有**三色比例条（Input/Output/Cache 三段条已去除）。
3. **验收 token 卡点击（UC-2）**：整卡点击 → 进入 token-stats 统计页。点返回/导航回首页。
4. **验收成员卡头部（UC-1/D5）**：左竖条下方成员卡头部——左侧标题「**成员·N**」（N=成员计数）；右侧从「在岗」开始**全部右对齐**，依次：在岗/全部切换 → **群聊图标**（icon-only 无文字，群聊开启时才显示）→ **加号**（icon-only 无文字，添加成员）。
5. **验收成员卡在岗/全部切换（UC-4/UC-5）**：默认「在岗」= running + idle 分区（benched 不显）；切到「全部」= running + idle + **benched 三分区**，benched 在**最下面**且比 idle **更灰**（透明度更低、文字更淡）。
6. **验收成员行 hover（UC-8）**：hover 任一成员行 → 右侧出现「进入对话」icon（无文字）；点击进入该成员单聊（可选验证后返回）。
7. **验收群聊图标（UC-9，群聊开启时）**：若 squad 群聊开关开启，成员卡头部有群聊图标；点击进入 squad 群聊页（入口已从原队长卡迁移到头部）。群聊未开启则此图标不显示，标记观察记录。
8. **验收全景区（UC-7）**：右侧主体区全景——卡片独立有自己的区域和高度，**填满屏幕主体，左右不横滑**（overflow-x 隐藏），**正常上下滚动**。

## 验收口径（executor 自由心证）
- **pass**：3 板块布局正确（左竖条 token+成员 / 右全景）；token 卡今日/60 天两数据 + 7 日柱无三色条 + 整卡可点进统计页；成员卡头部「成员·N」+ 右对齐（切换+群聊图标+加号，icon-only）；在岗/全部切换分区正确（全部含 benched 最下更灰）；hover 出进入对话 icon；全景右区填满不横滑可上下滚动。
- **small**：主链路通但有瑕疵（视觉微差、benched 灰度不明显但仍可辨、全景滚动略卡、群聊图标位置略偏，不影响主路径）。
- **blocking**：布局错乱（不是左竖条+右全景）/ token 卡仍显三色条或无今日/60 天数据 / 成员卡头部无切换或无图标 / 在岗全部切换无效或 benched 不显或不更灰 / 全景横滑或不滚动 / 关键区域空白或报错。
- **skipped**：无法自建 squad/成员（环境问题非产品 bug，如实记 reason）。

## 依赖
- `specs/ui/overall/00-app-guide.md` §3.2（Studio 路径）
- `specs/ui/components/studio-page/component-seats-body.md`（288 布局契约）
- `specs/ui/components/studio-page/component-member-roster-list.md`（成员列表契约）
- `specs/prd/version_logs/v0.0.288.studio_layout/prd.md` §4（UC-1~UC-9）
