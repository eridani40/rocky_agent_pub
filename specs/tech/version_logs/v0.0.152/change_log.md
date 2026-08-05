# v0.0.152 — Tech Change Log（squad 单聊补齐 effort + 审批模式 picker + 审批卡，零后端改动）

> 跨版本发布说明（版本轴）。本目录级变更见 `specs/tech/squad/log.md`（2026-07-15 块，零变更引用核实条目）。
> 权威变更契约见同目录 `change_plan.md`（13 行符号级变更 + §0 零变更引用三处 + §1-§2 拆分方案）。

## 概览

v0.0.148 交付的 session 级 `effort`（4 档推理强度）+ `approvalMode`（normal/greenlight）注入链路（`buildSessionConfigFromDeps` chokepoint）对 studio session 天然连通（不分 scope），但 studio UI 从未挂过配置入口，恒为缺省值；studio 单聊也从未挂过 `component-pending-approval-card`，`need_approval` 悬挂时无出口。本版本纯前端补齐两处 UI 挂载点，**server 端零改动**。

**设计意图**：不新造能力、不动运行时管道——`session-config.ts`/`bootstrap.ts`/`engine.ts` 三处已在 v0.0.148 就绪且经本版本逐一 grep 核实（`change_plan.md §0`）。唯一工作是前端把已有能力（session 级 effort/approvalMode + 已有 `component-pending-approval-card` 组件）接到 studio 单聊 input-bar。

## §1 useStudioChatChrome 扩展（studio 单聊 chrome hook）

- **`app/web/src/components/studio-page/use-studio-chat-chrome.ts`**：`StudioChatChrome` 新增只读字段 `effort`/`approvalMode`（复用同一次 `getSession` 响应回填，不新增网络请求）；`UseStudioChatChromeResult` 新增命令式 `setEffort`/`setApprovalMode`（`mutate` 乐观本地写 + fire-and-forget `updateSession` PUT /session/:id，同 `page-chat.tsx` 乐观更新范式，不调 `reload()`）。184 行，仍是 GET-once 非 area-hook 定性不变（不订 SSE）。

## §2 300 行红线拆分（studio 单聊输入区新组件）

- **`section-member-chat.tsx`**（既存 335 行超线债务）拆到 258 行：输入区渲染整体移出到新组件 `component-member-chat-input-bar.tsx`（212 行）——按钮行两新 picker（`InputApprovalModePicker`/`InputEffortPicker`）+ HITL `subState` 分流（`need_approval`→`ComponentPendingApprovalCard` / `need_feedback`→`ComponentPendingQuestionCard`，此前只挂提问卡）+ 原有 model picker/send/stop/enqueue 逻辑原样迁入。零新增 API 调用路径（`postMessage`/`patchMember`/`cancelEnqueue`/`updateSession` 均既有）。

## §3 测试范围

- **UT**：`use-studio-chat-chrome.test.ts` 新增 effort/approvalMode 回填 + setter 乐观写用例；`section-member-chat.test.tsx` 迁出输入区专属用例（507→470 行）；新建 `component-member-chat-input-bar.test.tsx`（9 用例，承接迁出用例 + 两 picker + 审批卡分流新用例）；`section-squad-chat.test.tsx` 新增 1 条负断言（两 picker 不渲染，锁定群聊裁决边界）。全量 `bun run test` 629 passed / 0 failure。
- **AT/ET**：豁免（纯前端 UI 挂载点扩展，零 API 契约变更，依据 `ui-only-ut-skip-at-et` 用户裁决——orchestrator 已核实确无接口/落库/后端逻辑变更）。
- 不新增 AT/ET 持久 case（用户铁律：普通 feature 不进冒烟集）。

## §4 spec 同步清单

| KB / 目录 | 文件 | 变更 |
|---|---|---|
| squad tech | `log.md` | 新增 2026-07-15 块：零变更引用核实（session_config_studio.md §2/§3 已支持 studio effort/approvalMode，本版纯前端） |
| ui studio-page | `member-chat-page.md` | input-bar 布局 3→5 控件（新增 approval-mode/effort picker）；补 HITL `subState` 分流挂载点；渲染主体改组合 `component-member-chat-input-bar.tsx`；顺带订正既存 run 态引擎描述 drift（单一 `useSessionRunState`→实际 5 个 area-hooks，先于本版本存在） |
| ui studio-page | `component-member-chat-input-bar.md` | 新增组件 spec（先 spec 后实现），承接输入区渲染 + 两 picker + HITL 分流契约 |
| ui studio-page | `squad-chat-page.md` | 显式补「不挂两 picker」裁决说明（`studio-squad` tool bound 无 bash，审批语义空洞），防未来误加 |
| ui chat-page | `component-pending-approval-card.md §复用关系` | 补 studio 单聊挂载点一行（`component-member-chat-input-bar`，与 `section-chat-detail` 并列） |
| tech frontend | `[P0]component_data_map.md §6.2` | `useStudioChatChrome` 契约块补 effort/approvalMode 字段 + 两 setter |
| prd overall | `08-squad-studio.md §8.7` | 承接表追加 v0.0.152 一行 |
| prd overall | `10-tool-permission.md §10.7` | 补一句 studio 单聊已接入绿灯 picker + 审批卡 |
