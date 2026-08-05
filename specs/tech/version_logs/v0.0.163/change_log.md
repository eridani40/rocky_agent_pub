# v0.0.163 change log — Studio 未读红点 race bug 修复

## 现象

Studio 会话列表红点 session：点击 → 红点消失 → 短暂后**又出现** → 再点才彻底消失（session 全程 idle，不产生新会话）。

## 根因

`app/server/src/agent/session-unread-ops.ts` 的 CAS + broadcast 之间存在 fire-and-forget 落盘 race：

- `markReadAndEmit`：`void crud.putAsync(unread=false)` → 立即 `statusBus.emit(session_read_update)` → wrap 同步 fan-out `SessionMetaBroadcaster.broadcast(sid)` → `crud.get` 重读；**此刻 putAsync 未落盘**，读到旧 `unread=true` 广播 `session_meta_update(unread=true)` → 前端本地乐观清红点被广播的旧值重置回来。
- `markUnreadTrue`：对称 bug（fNF put + `SessionUnreadRuntime.handleSessionEvent` 立即 `broadcaster.broadcast(sid)`），产生路径会广播旧 `unread=false`。idle 场景未观察到但根因同。

## 修法

`app/server/src/agent/session-unread-ops.ts` 两处 `void crud.putAsync(...)` → `await crud.putAsync(...)`：

- `markUnreadTrue`：await put → return true → 调用方 `SessionUnreadRuntime.handleSessionEvent().then(broadcaster.broadcast)` 触发广播时 crud 已是最新值
- `markReadAndEmit`：await put → emit `session_read_update` → statusBus wrap 同步 fan-out broadcast 时 crud 已是最新值

同批纠正原函数上方内联注释中「emit 不依赖 put 落盘」的错误表述——改为「emit/broadcast 前必须 await put 落盘（broadcaster 同步重读 crud，未落盘广播旧值）」。

## 断言（新增 UT）

`app/server/src/agent/__tests__/session-unread-ops.test.ts` 新增 4 UT，用**真** CompositeStore + FsCrudStore（withFileLock 真 async 路径）+ 真 statusBus wrap + `SessionMetaBroadcaster`：

- `markReadAndEmit_await put 后 broadcast 读到 unread=false`（broadcaster 广播 payload 断言）
- `markReadAndEmit_await put 后 crud.get 立即读到 unread=false`
- `markUnreadTrue_await put 后 broadcast 读到 unread=true`（对称）
- `markUnreadTrue_await put 后 crud.get 立即读到 unread=true`

修复前 fail（读到旧值），修复后 pass。

## 影响

- **API 契约**：`POST /session/:id/read` 响应时机从 fNF-return 变 write-return，多等 fs 落盘 ~几 ms，用户无感（file_write_lock §6.1 串行锁吞高频）。
- **无签名/入参/返回值改动**：`markUnreadTrue` / `markReadAndEmit` 仍 `async Promise<boolean>`，`SessionUnreadRuntime` 的 `.then` 语义不变。
- **副作用**：`session-meta-broadcaster.test.ts` 的 `flushMicrotasks(5)` 因 `markUnreadTrue` 内新增 `await putAsync` 增加了微任务深度而不够，bump 到 10 轮修复（await 修复的合理副作用，非测试逻辑改动）。

## Spec 同步

- `specs/tech/agent/session/[P0]session_state.md`
  - §4.4 timing 表：调用方栏细化为 `markUnreadTrue` / `markReadAndEmit` + 落盘时序描述；新增「落盘时序不变量」段说明 broadcaster 同步重读 crud 的 race
  - §6.3 新增不变量 7（unread CAS 落盘时序）
  - §7 顶层不变量 7 追加落盘时序引用
- `specs/tech/app/frontend/[P0]sse_channel.md §10.4`：`broadcast(sessionId)` 描述加**同步**语义强调 + 约束触发方 await put

## 非目标

- 不改 `SessionMetaBroadcaster`「全量 payload 重读 crud」的语义
- 不引入 broadcast 覆盖字段参数（保留最简修法）
- 不新增 AT/ET case（按 CLAUDE.md 冒烟集入选标准豁免——非 LLM 不确定性场景）
