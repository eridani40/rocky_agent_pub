# playground-seats-bench-filter — Squad 首页 seats 在岗视图 + 视图筛选 + 恢复

> seats 板块首个冒烟 case（v0.0.244）。照 `playground-send-message/case.md` 样例模板：纯自然语言，零断言零录制零 testid 预定义；executor 读 case.md + app-guide 按 snapshot 文案/位置自选定位方式。

## Use Case
作为 Rocky 的用户，我打开一个 squad 的首页 seats 面板，默认看到的是**在岗视图**——成员列表只有 deployed mate，下岗（benched）成员不混杂进来，roster 头计数就是在岗数；需要时我可以点 roster 头的视图筛选切到「全部」，看到被视觉弱化的下岗成员，并用现有「更多」菜单的 deploy 项把他恢复回在岗。

## 前置条件
- env.sh 已起好环境（headless 或 electron 模式）。
- 存在（或临时创建）一个 squad，含 **≥1 个 deployed mate + ≥1 个 benched mate**。在 app 内达成方式：
  1. nav-rail「Studio」→ 左 sidebar「+ 新建」建一个 squad（向导完成后自动带队长）；
  2. 首页 seats roster 头「＋ 新增成员」创建至少 2 个 mate（如「小甲」「小乙」）；
  3. 把其中 1 个 mate 变 benched：该 mate 行 hover 揭示 ops 列 → 点「更多」→ 菜单「bench」项 → BenchModal 填 reason（必填）→ 提交。该成员即变 benched（路径见 `06-studio.md` §3.1 菜单规则：bench 仅 mate + deployed 渲染）。
  - 备选：在 leader 单聊/群聊里让 leader 用 `team bench` 工具 bench 一个成员（真调 LLM，较慢，非首选）。
- LLM provider 可用仅在建 squad/发消息类操作时需要；本 case 的 bench/deploy/视图切换均为确定性 UI 操作，不依赖 LLM 回复质量。

## 操作目标（编号步骤）

1. **进 squad 首页 seats 看默认在岗视图**：照 `00-app-guide.md` §3.2——nav-rail 点「Studio」→ 左 sidebar 点该 squad 行 → 落首页面板（首页 tab 缺省，右列即 roster，见 `06-studio.md` §3.1）。确认：roster 列表里**只见 deployed mate 行**（benched 的「小乙」不在列表中）；roster 头计数「成员 · N」的 N = 在岗 mate 数（本例应为 1，即只剩「小甲」）。
2. **点视图筛选切「全部」**：roster 头有一个视图筛选 toggle（「在岗」/「全部」两态，默认「在岗」；详见 `00-app-guide.md` §3.2 seats roster 视图筛选 + `06-studio.md` §3.1 视图筛选交互）。切到「全部」后确认：列表显含 benched 行（「小乙」出现，视觉弱化——整行偏淡/降不透明度，who 列显 `mate · benched`）；roster 头计数变为全队 mate 数（本例应为 2）。
3. **用现有菜单 deploy 恢复下岗成员**：在「全部」视图下，hover benched 行揭示 ops 列 → 点「更多」→ 菜单中应有「deploy」项（deploy 仅 benched 渲染，见 `06-studio.md` §3.1 菜单规则）→ 点 deploy。确认：操作成功后该成员 state 回到 deployed（SSE 推送自动刷新，无需手动刷新页面）；把视图筛选切回「在岗」，刚恢复的成员（「小乙」）出现在列表中，计数回到 2。
4. **（边界）在岗视图 deployed=0 显空态**：把当前所有 deployed mate 逐个 bench 掉（同前置条件第 3 步：行「更多」→ bench → 填 reason）。保持在/切回「在岗」视图确认：mates=0 时 roster 体内显空态占位，roster 头与「＋ 新增成员」按钮仍在，计数为 0。（顺手验证：切「全部」视图能看到刚 bench 掉的成员们，说明数据未丢。）

## 验收口径（executor 自由心证）
- **pass**：4 步全走通——默认在岗视图不含 benched、计数口径跟随视图、切全部见弱化的 benched 行、菜单 deploy 恢复成功且回在岗视图即见、全 bench 后在岗视图显空态；无瑕疵。
- **small**：走通了但有瑕疵不阻塞合并（如文案微差、benched 行弱化视觉不明显但仍可辨、SSE 刷新略慢需稍等）。
- **blocking**：走不下去——视图筛选 toggle 找不到/点了无效、在岗视图仍混显 benched、菜单没有 deploy 项或点了报错、deploy 后成员状态不变、bench 操作失败、关键 API 5xx。

## 依赖
- `specs/ui/overall/00-app-guide.md` §3.2（Studio 板块入口与首页路径）
- `specs/ui/overall/06-studio.md` §3.1（首页 tab roster 结构 / 菜单 bench·deploy 渲染规则 / offline 卡行呈现）
- `specs/prd/version_logs/v0.0.244.member_bench_filter/prd.md` §3.2 + §4（UC-U1~U4、P1/P2 路径）
