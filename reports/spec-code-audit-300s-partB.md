# spec↔code 同步审计 B — v0.0.324 → v0.0.342（15 个版本）

> 审计人：doc-modifier2 · 日期：2026-08-12
> 范围：`specs/tech/version_logs/` v0.0.324 / 325 / 326 / 327 / 328 / 329 / 330 / 331 / 334 / 334.attach_regression_fix / 336.attach_close_process_leak / 337 / 337.attach_launch_failure_leak / 338.mate_exit_interrupted_tip / 339-file-open-strategy / 340-squad-defaults-and-rename / 342-build-offline
> 方法：读 change_log → 逐改动点核 spec（ui/tech/api/prd）→ 抽查代码（渲染树引用为主，非仅文件存在）→ 双向判定。
> 铁律遵守：只审计不改代码不改 spec；偏差记入本报告由 leader 拍板。

## 总览

| 版本 | spec 同步 | 说明 |
|---|---|---|
| v0.0.324 文件树搜索裁剪树 | ❌ | component-workspace-panel.md §4.6 仍是 320 旧描述；tech frontend/index 无概念行 |
| v0.0.325 html 浏览器打开按钮 | ❌ | section-preview-area.md §5.6/§5.8/i18n 三处漏记（无独立 floating-actions spec） |
| v0.0.326 usage 环优化 | ❌ 重灾区 | component-usage-panel.md 通篇 320 旧形态 + 消费方引用已退役组件；section-chat-session.md 门控矩阵滞后 |
| v0.0.327 搜索树可交互 | ❌ | component-workspace-panel.md §4.6 未记 merge-expanded / 命中目录不展开 |
| v0.0.328 纯文本打开 | ⚠️ 部分 | workspace-panel.md 防抖 500ms 已同步 ✅；tech frontend/index getFileFormat 白名单扩充未记 ❌ |
| v0.0.329 门三态 | ✅ | section-preview-area.md + frontend/index + preview_hooks + i18n 全同步，代码抽查一致 |
| v0.0.330 browser attach 修复 | ⚠️ 部分 | browser_tool / instance_manager / api 08-web-tools 全同步 ✅；scripts.md 契约清单缺 cleanup-chrome-debug.sh ❌ |
| v0.0.331 a2a out 信封空白 | ✅ | a2a-envelope / message_interface §4.6 / subagent_derivation §5.1 / api 10a / KB log 全同步 |
| v0.0.334 browser 简化 + sqlite 台账 | ✅ | browser_tool / instance_manager / api 08-web-tools 1.6 全同步 |
| v0.0.334.attach_regression_fix | ❌ | 无 change_log（文档同步疑似从未做）；discardInstance 即时清账 + userDataDir 候选注入零 spec |
| v0.0.336.attach_close_process_leak | ✅ | CloseResult / 三层一致 / G1-G6 全同步（browser 两 KB + api 1.7） |
| v0.0.337 update-app 白屏 | ✅ | scripts.md §3.4 契约 + [v0.0.337] 注记全同步 |
| v0.0.337.attach_launch_failure_leak | ✅ | H1-H9 signal 链 / 失败入台账全同步（browser 两 KB + api 1.8） |
| v0.0.338 mate 退出 interrupted 提示 | ✅ | agent_loop_unified §3.2 钦定文案全同步 |
| v0.0.339 文件打开分流 | ✅ | workspace-panel §4.4 / preview-area §10 / _overview 规则8 / app-guide / frontend index / package_structure §4.4 / api 2.6.9 全同步 |
| v0.0.340 squad 默认关群聊 + 改名 | ✅ | data_model / squad_tools / a2a_protocol / subagent_derivation / api 11a / ui 06-studio + group-chat-toggle / KB log 全同步 |
| v0.0.342 打包离线化 | ✅ | packaging_toolchain §3.10/§4.2/§5 + scripts.md §3.3 + index 原则16 全同步 |

## 偏差明细（需 leader 拍板）

| # | 版本 | 改动点 | 状态 | 具体偏差 | 建议修法 |
|---|---|---|---|---|---|
| 1 | 324 | 搜索态与树态互斥→FileTree 常驻 | ❌ spec 落后 | `component-workspace-panel.md §4.6` 仍写「query 非空 → 渲染结果列表（ws-search-results），父级隐藏 PathBar/FileTree」；代码已 FileTree 常驻、搜索态切换裁剪树数据源（section-workspace-panel.tsx L310-314） | §4.6 改写：搜索态 = FileTree 数据源切裁剪树（buildFilterTree），PathBar 仍隐藏，结果列表渲染已退役 |
| 2 | 324 | 搜索上限 200→100 | ❌ spec 落后 | §4.6 写「合并后 >200 提示」；前后端 SEARCH_LIMIT 均 100（前端 component-ws-search-box.tsx L40 / 后端 session-workspace-search.ts L24） | §4.6「>200」改「>100」 |
| 3 | 324 | Props 删 onOpenFile/onToggleDir 加 onResult | ❌ spec 超前 | §4.6 仍写「结果项点击：文件→onOpenFile / 文件夹→onToggleDir」——两 prop 已删（change_log D3），代码只有 onResult 回调 | §4.6 删 onOpenFile/onToggleDir 句，改为「onResult 上报 → buildFilterTree → 裁剪树」 |
| 4 | 324 | 裁剪树纯函数 ws-filter-tree.ts | ❌ spec 落后 | `specs/tech/app/frontend/index.md` 无 v0.0.324 概念行（PRD/change_plan 有，tech index 概念表缺） | index.md ① 概念表补 buildFilterTree/裁剪树行 + log.md 条目 |
| 5 | 325 | 只读态新增「浏览器打开」按钮 | ❌ spec 落后 | `section-preview-area.md §5.6` 只读态仍写「1 个编辑按钮」；代码已 2 按钮（pv-float-edit + pv-float-browser，component-preview-floating-actions.tsx L88-92） | §5.6 只读态补浏览器按钮（isHtml 条件 + GlobeIcon + i18n openInBrowser） |
| 6 | 325 | preview-icons 5→6 图标 | ❌ spec 落后 | §5.8 写「5 个图标」；代码 6 个 export function（+GlobeIcon，preview-icons.tsx L79） | §5.8「5 个」改「6 个」+ 补 GlobeIcon 行 |
| 7 | 325 | i18n 新 key openInBrowser | ❌ spec 落后 | §i18n 列表（L202 workspace.preview.* 枚举）无 openInBrowser；代码 zh/en chat.json L194 已有 | i18n 列表补 openInBrowser（浏览器打开 / Open in Browser） |
| 8 | 326 | 环默认 28→36 + 删文字/chevron/tooltip | ❌ spec 落后 | `component-usage-panel.md §3.1` 仍写「UsageRing 28×28 + 已用/总 + UsageExpandBtn(chevron) + hover UsageTip」；代码已 36 环 + 百分比叠层 + 整环 onClick toggle（component-usage-panel.tsx L121-127） | §3.1/§4.2 按 v0.0.326 重写收起态（环 36 + 百分比 + 点击展开，无 chevron/tooltip/文字） |
| 9 | 326 | CompactBtn/ClearBtn 移入 panel head | ❌ spec 落后 | usage-panel.md 无 head 按钮区/onCompact/onClear 透传描述；代码已 props 透传 + head 内渲染（L50-63, L151-153） | 补「浮层 head 右侧 CompactBtn(h-7 w-7)/ClearBtn」段 + props 契约 |
| 10 | 326 | 消费方 component-chat-topbar-right.tsx | ❌ spec 超前 | usage-panel.md「消费方」列 `component-chat-topbar-right.tsx`——该文件已退役删除（git 0cfff8164 chore 删死代码）；现状唯一入口 = section-chat-session topbarRight | 消费方清单删退役文件，改注「唯一入口 section-chat-session.tsx topbarRight」 |
| 11 | 326 | caps 门控收窄 usage 单门控 | ❌ spec 落后 | `section-chat-session.md` 门控矩阵仍「usage 三件套 + CompactBtn | usage / compact」+「ClearBtn | clear」；代码 = caps.usage 单门控 + onCompact/onClear 透传 panel（section-chat-session.tsx L191-198） | 门控矩阵改 usage 单门控行（compact/clear 透传 panel 内部门控） |
| 12 | 327 | merge-expanded + 命中目录不自动展开 | ❌ spec 落后 | `component-workspace-panel.md §4.6` 未记 merge-expanded action / 命中文件夹不自动展开 / 搜索态手动展开生效；代码 ws-filter-tree.ts L133-140 + workspace-reducer.ts L56 已落地 | §4.6 补：命中目录不自动展开（仅祖先路径）+ filterResult→merge-expanded 初始合并（不覆盖用户手动展开） |
| 13 | 328 | getFileFormat 白名单扩充 | ❌ spec 落后 | `specs/tech/app/frontend/index.md` 无 v0.0.328 概念行（KNOWN_TEXT_BASENAMES/KNOWN_TEXT_STEMS 顺序语义未记）；PRD v0.0.328-text-file-open.md 有 ✅；workspace-panel.md 防抖 500ms 已同步 ✅ | frontend/index.md 概念表补 v0.0.328 行（basename 精确集 + stem fallback 顺序：扩展名查表先、stem 后）+ log.md |
| 14 | 330 | scripts/cleanup-chrome-debug.sh | ❌ spec 落后 | 代码 scripts/cleanup-chrome-debug.sh 存在 ✅；`specs/tech/app/envs/[P0]scripts.md` 脚本清单（§1 概述 + §2 契约总表 + §6 边界表）未收录该脚本（337 只把 update-app 补成「四脚本」） | scripts.md 补第 5 脚本（一次性清理指引：只读检测 + 引导，不 kill 用户 Chrome；无 env source） |
| 15 | 334.fix | attach 失活即时清账（discardInstance） | ❌ spec 落后 | `browser_instance_manager.md` 失活表行仍「attach_lost + 置 dead + manager 收尾 disconnect」；代码已 impl 即时 `env.ledger.delete` + `env.discardInstance`（attach-mode-impl.ts L142-150），manager 收尾退化为防御 catch | 失活表行 + §3.3 流程序补「impl 即时清账（ledger.delete + discardInstance，best-effort 幂等）」 |
| 16 | 334.fix | connect 注入默认 userDataDir 候选 | ❌ spec 落后 | `defaultChromeUserDataDirCandidates` 全局 specs 0 命中；代码 attach-instance.ts L45-53 已注入首个存在候选（Bug1 修复） | browser_tool.md §4.1 target 解析段补「334 fix：connectAttachSession 注入默认 userDataDir 候选（复用 devToolsActivePortCandidates dirname 派生），无候选传 undefined」 |
| 17 | 334.fix | 版本记录 | ❌ 缺日志 | 该版本无 change_log.md（仅 change_plan.md）——15 个版本中唯一无日志，文档同步从未落地（15/16 偏差的直接原因） | 补 change_log.md（F1-F7 实现核对 + doc 同步记录），或由 leader 裁决并入 334/336 注记 |

## 同步良好版本（代码抽查均一致，无需动作）

- **329**：pv-door 三态/DoorState/旧 key 迁移/direction prop/i18n doorLeft·doorRight·doorCenter/chatCollapsed 引擎分支——spec 与代码逐点吻合（use-preview-collapsed.ts L19-89 vs section-preview-area.md L41-53）。
- **331**：extractSendMessageBody 四形态 / _rawTruncated「发送失败（参数截断）」/ normalizeContentBlocks 语义唯一来源——spec 四处全同步。
- **334**：instance-ledger.ts/chrome-version.ts 台账 schema 与 spec §4.4/§4.9 一致；api 1.6 尾注准确。
- **336**：CloseResult 三层一致/G1-G6/killOrphanMcpWatchdog——browser 两 KB + api 1.7 与代码逐点吻合。
- **337**：scripts.md §3.4 update-app 7 步契约含 sync+sleep 3 ✅；**337.attach**：signal 链 H4-H8/lastSpawnPid/失败入台账——browser_tool §4.1 + api 1.8 全同步。
- **338**：agent_loop_unified §3.2「退出原因行（[v0.0.338] 条件追加）」钦定文案（查证）与代码逐字一致。
- **339**：openLocalPath 三分流/stat 三端（HTTP stat + shell:stat IPC + statWorkspaceFile）/api §2.6.9——spec 六处全同步，代码抽查全中。
- **340**：enableGroupChat 默认 false/改名写时全同步（sessionStore + titled 保护）/memberStore 读单一源——spec 八处全同步。
- **342**：packaging_toolchain §3.10 两联网点根因 + electronDist copyDir 分支/scripts.md §3.3/index 原则 16 全同步。

## 附注

1. 偏差集中在 **324-328（前端 UI 迭代带）**：这批版本 doc 同步依赖 doc-modifier 事后补记，但组件级 spec（component-workspace-panel / component-usage-panel / section-preview-area）未跟随，累积成 4 个版本的滞后。tech frontend/index 概念表 324/328 两版本缺失。
2. **334.attach_regression_fix 无 change_log** 是唯一「文档同步为零」的版本，其 3 项偏差（15/16/17）建议一并处理。
3. spec 超前仅 2 处：#3（324，onOpenFile/onToggleDir props 已删）与 #10（326，引用已退役 component-chat-topbar-right.tsx）。
4. 未发现代码落后于 spec 的「spec 超前」功能项（除退役引用外无凭空功能）；未见渲染树断线。
