# v0.0.163 变更计划书 — Studio 未读红点 race bug 修复

> **method 级 review 合同**。架构期冻结：coder 按本表实现，code-reviewer 按本表查偏离。

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| agent/session/unread | app/server/src/agent/session-unread-ops.ts | markUnreadTrue | 修改 | L56 `void crud.putAsync(...)` → `await crud.putAsync(...)`；移除 `.catch` 链（异常自然抛给调用方，与 markUnreadTrue 已 async 语义一致）；纠正函数上方 fNF 相关注释（说清 "await 是因为 emit/broadcast 前必须落盘，否则 SessionUnreadRuntime 后续 broadcast(sid) 同步 crud.get 读到旧值 unread=false"） | MUST 保留幂等 CAS 判定（rec.unread===true 早退）；MUST NOT 改函数签名/返回值语义；MUST NOT 改 broadcast/emit 调用逻辑 | session_state.md §4.4 timing「产生」+ §6.3 不变量 3；本次 req 根因分析 | +3 / -3 |
| agent/session/unread | app/server/src/agent/session-unread-ops.ts | markReadAndEmit | 修改 | L85 `void crud.putAsync(...)` → `await crud.putAsync(...)`；移除 `.catch` 链；L83-84 注释纠正：把「emit 不依赖 put 落盘（CAS 判定 + event 数据自包含），故 emit 在 fNF put 后即可发」删掉，改为「emit 前必须 await put 落盘——SessionMetaBroadcaster 收到 session_read_update 会同步 fan-out 调 broadcast(sid) 重读 crud，未落盘会广播旧值 unread=true」 | MUST 保留幂等 CAS 判定（rec.unread!==true 早退）；MUST 保留 emit session_read_update 语义（data.unread=false）；MUST NOT 改函数签名/返回值语义 | session_state.md §4.4 timing「消除」+ session_event.md §2；本次 req 根因分析 | +5 / -5 |
| agent/session/unread | app/server/src/agent/__tests__/session-unread-ops.test.ts（若不存在则新建） | UT: markReadAndEmit_落盘后立即可读 | 新增 | 断言：给定 rec.unread=true → markReadAndEmit → 返回后立即 crud.get(sid) 读到 unread=false；同批断言 emit 帧 data.unread=false | MUST 用真 CompositeStore（或最小 fake）+ 真 statusBus fake（捕获 emit）；MUST NOT mock crud.putAsync 让它同步返回（那就绕开了本次修复的 race 验证意图） | 本次 acceptance criteria；CLAUDE.md tests-respect-product-architecture | +40 / -0 |
| agent/session/unread | app/server/src/agent/__tests__/session-unread-ops.test.ts | UT: markUnreadTrue_落盘后立即可读 | 新增 | 对称断言：给定 rec.unread=false → markUnreadTrue → 返回后立即 crud.get(sid) 读到 unread=true | 同上 | 同上 | +25 / -0 |

## 影响面评估

- **改动范围**：单文件 `session-unread-ops.ts` + 一个 UT 文件（新建或补条）。零跨模块 API 变化。
- **契约变化**：markReadAndEmit / markUnreadTrue 均是 `async Promise<boolean>` 签名不变，但返回时机从「put 排队即返回」变为「put 落盘完成才返回」。
  - 上游 `handleSessionRead`（`app/server/src/handlers/session-read.ts:46`）本就 `await deps.store.markRead(id)`，行为对齐即可（POST /read 响应从 fNF-return 变成 write-return，多等 fs 写 ~几 ms，用户无感）
  - 上游 `SessionUnreadRuntime.handleSessionEvent`（`session-unread-runtime.ts:113-119`）用 `.then(changed => ...)`，`markUnreadTrue` 返回时机后移不影响 `.then` 语义
- **无破坏性**：无签名/入参/返回值改动，无 API 契约改动。
- **依赖顺序**：单文件，无依赖顺序。
- **风险点**：
  1. 若 CompositeStore.putAsync 在某种压力下卡住 → POST /read 延迟增加；但 file_write_lock §6.1 保证串行锁能吞掉高频，实际影响可控
  2. UT 需真 putAsync 路径，若测试用 fake crud 需保证 putAsync 走真 async（否则测不到 race）

## 反馈回路

- 实现改文件外符号 / 破约束列 / 影响行严重偏离 → 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
