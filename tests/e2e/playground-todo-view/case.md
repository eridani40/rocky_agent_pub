# playground-todo-view — todo 视图板块冒烟（ET）

> **板块**：chat session 右侧悬浮菜单 todo 第 4 项（v0.0.223 新增）
> **范式**：v0.0.188 agent 玩 app——executor 用 playwright-cli 按本 case.md + `specs/ui/overall/00-app-guide.md` 操作，每步留证 4 件套，自由心证 blocking/small/pass。
> **视觉**：无 demo（用户授权不阻塞）→ 视觉保真 compare 跳过，本 case 只验功能链路；视觉精修留 demo 到位后补。
> **本版扩展（v0.0.228）**：目标 7-10 覆盖本版新交互——SSE 实时同步 / 打开即最新 / hover 收敛 / 尺寸响应式 + 徽章颜色（PRD `specs/prd/version_logs/v0.0.228.md` 4 条关键用户路径；无设计稿 → 免 vision compare，executor 心证）。

## Use Case
用户在会话右侧悬浮菜单（float-menu）看到 todo 第 4 项（skills 下方，badge=未完成主 item 数），点击弹出 todo modal，看到双层树视图（主 item + 步骤），悬停主 item 看结构化详情（来源/输出/备忘），确认 todo 是 agent 自主维护的 session 级双层待办。

（v0.0.228 扩展）在此基础上验证实时性与交互收敛：todo 经工具/HTTP 改动后，badge 与已开弹层**秒级自动刷新**（SSE 驱动，60s 轮询已退役）；每次点击打开弹层即见最新数据；悬停详情弹层只在**主 item 行**触发且出现在其**正下方**（步骤行不触发）；弹层宽度响应式（约 720px 档、随窗口 max-w-92vw 兜底）、高度上限 88vh；done（绿）与 not_started（灰）徽章一眼可辨。

## 前置条件
- 一个 playground session（chat 主会话，parent.main 持 todo 工具）
- session 里已有若干 todo（可经 todo 工具/HTTP 预置：≥1 个未完成主 item 含 ≥1 步骤、且带 source/output/memo 详情——悬停弹层只对「有详情」的主 item 弹出；另 1 个已完成主 item 供 badge 计数 + 灰/绿徽章对比验证）
- executor 可在 case 进行中对该 session 直接调 todo HTTP API（`specs/api/overall/20-todo.md`，env.sh 输出的 server 端口）做新增/改状态——验证实时同步与打开即最新
- env：`bash tests/e2e/env.sh start playground-todo-view`

## 编号操作目标（引用 `specs/ui/overall/00-app-guide.md` chat 板块）
1. **打开 chat session**：进入该 playground session 的聊天页，确认右侧悬浮菜单（float-menu，memory/cron/skills 竖向）渲染。
2. **见 todo 第 4 项入口**：float-menu 中 skills 下方出现第 4 项 todo icon；其 badge 显示**未完成主 item 数**（= 预置的未完成主 item 计数，已完成的不计入）。
3. **点击 todo icon 弹 modal**：见双层树视图——主 item 列表 + 每主 item 下步骤；未完成/已结束状态可辨（状态徽章/样式）。
4. **悬停状态徽章看详情**：悬停某未完成主 item 行最左的状态徽章 → 弹结构化详情（来源 source / 输出 output / 备忘 memo）。
5. **空态/已结束态**：若有 session 无 todo → modal 显 idle 空态；已完成主 item 展示已结束样式（若视图含已结束则看，否则 badge 不计即可）。
6. **只读确认**：modal 内**无编辑/删除按钮**（本版 todo 视图只读，agent 自主维护）。
7. **SSE 实时同步（UC-228-SSE-REALTIME）**：todo modal 保持打开 → 经 todo HTTP API 新增一个主 item（或把某未完成主 item 改为 done）→ 观察 float-menu badge 计数与弹层列表在**数秒内自动刷新**反映该变化——不手动重开弹层、不等 60s（本版 SSE 驱动，轮询已退役）。badge 与弹层列表同步变化（同一数据源，不出现一处变一处不变）。
8. **点击打开即最新（UC-228-OPEN-FRESH）**：关闭 todo modal → 再经 todo HTTP API 改动一个 todo（新增或改状态）→ 重新点击 float-menu todo 打开 → 弹层打开瞬间即显示含刚才改动的最新数据（非关闭前的旧快照）。
9. **hover 收敛（UC-228-HOVER-SCOPE，v0.0.229 收窄 / v0.0.240 触发域迁徽章）**：悬停某主 item 行最左的**状态徽章**（`data-action-key=chat.todo.item.status`） → 结构化详情弹层出现在**该主 item 正下方**（覆盖式浮层，不推挤后续行）；hover 触发域**仅状态徽章本身**，鼠标移出徽章（含下移进入弹层）即收起——防误触发。悬停主 item 行其余区域（desc / 步骤进度）或**步骤行** → 不触发详情弹层。
10. **尺寸响应式 + 徽章颜色（UC-228-VISUAL）**：打开 todo modal → 宽度明显大于旧 520px 窄条（约 720px 档、随窗口 max-w-92vw 兜底不溢出屏幕）；高度上限 88vh，长列表时标题栏/关闭按钮固定不滚走、列表在 body 内滚动。列表中 done 徽章呈绿色、not_started 徽章呈灰色，两者一眼可辨。

## 验收口径（pass / small / blocking）
- **pass**：目标 1-10 全走通——todo 入口/badge/modal/双层树/悬停详情/只读 全部正确；HTTP 写入后 badge 与弹层秒级自动刷新（SSE）、重新打开即最新、详情弹层只在主 item 行触发且在其正下方、宽度响应式不窄不溢、高度 ≤88vh、done 绿 vs not_started 灰一眼可辨，无瑕疵。
- **small**：走通但有瑕疵（文案微差、视觉小问题、宽度档位与 720px 略有出入但明显够用不窄、SSE 刷新略有延迟但数秒内到位、偶发 console warning）——不阻塞。
- **blocking**：走不下去（float-menu 无 todo 项 / modal 打不开 / 双层树渲染错 / badge 计数错 / 悬停无详情 / HTTP 写入后 badge 与弹层不自动刷新、需手动重开或等满 60s 才更新 / 重新打开弹层仍是旧快照 / 悬停非状态徽章区域（主 item 行 desc / 步骤进度 / 步骤行）也触发详情弹层 / 弹层仍固定 520px 窄条或溢出屏幕 / done 与 not_started 徽章同色难辨）——阻塞合并。

> **LLM 质量由人判**：executor 只判「todo 视图链路通不通 + 数据对不对」，不判视觉精修（待 demo）。
