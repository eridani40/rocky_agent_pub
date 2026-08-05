# v0.0.85.ui_opt Tech Change Log

> version: 1.0 · 2026-07-07
> 5 feature 全部 verified。change_plan.md = 架构期冻结契约；本文件 = 发布说明（实际落地的跨子系统变更）。
> 无 HTTP API 契约变更（D1）。

## 影响的 tech KB

### squad KB（F3 转发 3 段格式）
- `[P1]agent_squad_chat.md §2.1`：3 段转发模板（说明 / 原文 / 相关上下文，按字面 `###` 标题分隔）+ invariants（转发仍 send_message content text blocks 不扩 a2a §5 / sender 永远是 SquadChat / needReply 顶层默认 true / 不改写 user 原文 / 不创作 answer）。
- `[P1]agent_leader.md` / `[P1]agent_member.md`：补「收到 SquadChat 转发处理」段（按「### 说明」段决定是否回复；回复走 `send_message(to=SquadChat)` 必回群聊；不接受原文外二次转述）。
- `[P1]prompt_sections.md §3.1`：squad 行补 `{{squad_name}}` 代码注入说明（SquadChatContentHandler.build 跑 fillTemplate，**LLM 把 `{xxx.yyy}` 点号 brace 当字面量 echo 必须代码替换**）。
- `index.md` ④ 加核心原则 13（SquadChat 转发 3 段 + `{{squad_name}}` 代码注入 + 删 STUDIO_SQUAD_ROUTER_SYSTEM_PROMPT 硬编码）。
- 代码侧：`squad_role.ts SquadChatContentHandler.build` 跑 `fillTemplate({{squad_name}} → ctx.config.studioContext.squad.name)`；`session-config.ts` 删 `STUDIO_SQUAD_ROUTER_SYSTEM_PROMPT`（grep 0 残留），squad router systemPrompt 走 `''` 占位由 builder 注入。

### agent/session KB（F2 await ready + addDir）
- `[P0]session_workspace_manager.md §3.1`：补「await chokidar ready + addDir 显式 add」（对齐 squad_filewatch BUG-005/006 模式）。`startWatch` 内部 `await waitForChokidarReady(watcher, 5000)`（5s 超时兜底 resolve 不抛）；注册 `watcher.on('addDir', abs => watcher.add(abs))`（chokidar 4.x add 同步禁 `.catch`）。`waitForChokidarReady` 导出 helper（once('ready') + setTimeout race，超时 resolve）。
- `§4`：补「`ignoreInitial:true` 与 await ready 配合」。
- `§7`：补「subscribe hooks 改 async + await」消除 fire-and-forget 竞争。
- `index.md` ④ 加核心原则 10（SessionWorkspaceManager await ready + addDir 显式 add）。
- 代码侧：`session-workspace-manager.ts:118-168` startWatch + `waitForChokidarReady` export；`bootstrap.ts setSubscribeHooks` 改 async + await。

### app/frontend KB（F2 setSubscribeHooks async + F4 SseClient 并行模式）
- `[P0]sse_channel.md §5.1`：setSubscribeHooks async + await（消除 fire-and-forget 时序竞争）。`SubscribeHooks` 接口 `void → void | Promise<void>`；`SseChannel.subscribe/unsubscribe` 内部 `await hooks.onSubscribe?.(...)`（hook 异常 try/catch 不影响订阅本身）；bootstrap.ts hook 改 async + `await workspaceManager.startWatch/stopWatch`。向后兼容（旧 sync 实现仍工作）。
- `index.md` ① 概念表加 2 行：SseClient connect/subscribe 并行模式 + setSubscribeHooks async。
- `index.md` ④ 加核心原则 13 + 14：
  - 13 SseClient connect/subscribe 必须并行（禁链式 await）—— connect() 内部 `while(true) reader.read()` 永不 resolve；`await connect().then(subscribe)` 链式 → subscribe 永不执行 → 静默丢帧（UT mock connect 立即 resolve 测不出）。正确：`void connect(); subscribe().catch()`。反例：v0.0.85 F4 红点 bug + section-squad-chat.tsx F2 订阅同款 bug。
  - 14 setSubscribeHooks async + await（消除 fire-and-forget 竞争）。
- 代码侧：`sse-channel.ts subscribe/unsubscribe` 改 async + await hooks；`use-studio-unread-meta.ts` 并行模式（F4 红点 bug 修复后落定）。

## 验证产出

- **F2 UT**：session-workspace-manager f2.test 11 + baseline（await ready / addDir / async hooks，3x 连跑稳定）→ `states/v0.0.85.ui_opt/verify/unit-test/`
- **F3 AT**：squad_forward_3section_format_tc1 8/8 pass（real-LLM 验证 prompt 行为变更：3 段结构 / 原文一字不差 / needReply 顶层 / sender.ref=squad / squad 名替换）→ `states/v0.0.85.ui_opt/verify/api-test/`
- **F1/F4/F5 E2E**：3 case 全 pass → `states/v0.0.85.ui_opt/verify/e2e-test/`
  - F4 抓到真 bug：use-studio-unread-meta connect().then(subscribe) 永不 resolve（stream-consuming loop），改并行后 pass

## Known drift（待下版本修）

- **section-squad-chat.tsx:155-163 F2 订阅 await 链**：使用 `await sse.connect(); await sse.subscribe(...)` IIFE 链式——connect 永不 resolve→subscribe 永不执行→workspace event 静默丢弃。F2 UT 仅测后端 chokidar 未测前端订阅，E2E 未覆盖 squad 群聊 workspace 实时刷新，故 bug 未显形。spec 已记正确并行模式（`specs/tech/app/frontend/index.md ④ #13` + `specs/ui/components/studio-page/squad-chat-page.md` known drift），代码待下版本对齐。
- **F2 前端 E2E 未覆盖**：squad 群聊 workspace 实时刷新链路（SSE session_panel → handler → setLastWorkspaceEvent → ws-panel 刷新）无 E2E case（PRD 范围排除 + 文件系统时序 flaky）。下版本若修 await 链 bug 须补 E2E case 防回归。

## 版本

version 1.0（2026-07-07）：5 feature 合并发版——F1 分页（前端）/ F2 文件 watch（后端 chokidar ready+addDir + 前端 SseClient 订阅）/ F3 转发格式（prompt + 删硬编码）/ F4 studio 红点（前端 hook + DOM）/ F5 squad UI 尺寸（CSS）。
