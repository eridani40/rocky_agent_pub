# v0.0.38 PRD Change Log — fs store 文件写加锁（基础设施）

> version: 1.0 · 2026-07-01
> 一句话定位：**纯基础设施改动**——FsCrudStore 写路径并发串行化 + file-write/file-edit 工具加锁。**无用户可见功能变化、无 UI/API 契约变更**。
> 权威 tech 文档：`specs/tech/version_logs/v0.0.38/change_log.md` + `specs/tech/persistence/[P1]file_write_lock.md`。

---

## 1. 范围声明（为何 PRD overall 无改动）

本版本是 persistence 层并发安全基础设施，**不引入任何新产品概念、不改任何用户路径、不改任何 HTTP API 契约或 UI 组件**：

- `putAsync`/`deleteAsync` 是 FsCrudStore 的 **engine 内部扩展方法**，不在 CrudStore interface 上，对 HTTP 调用方透明（caller 仍是 store 层内部）。
- file-write/file-edit 工具加锁是**实现细节**，工具 input/output 契约不变（agent 视角无感）。
- 无新页面、无新组件、无 testid 变化。

故 `specs/prd/overall/*` 与 `specs/ui/overall/*` 本版**零改动**。

## 2. 动机（用户间接感知）

squad 多角色场景下，同 session/squad 的并发写操作可能在 await 点交错，导致丢更新 / jsonl 段文件 tmp 覆盖 / counters.json 计数器竞态 / file-edit read-modify-write 竞态。本版通过进程内 async path-lock 串行化写操作，消除上述竞态——**用户感知仅是「squad 多角色并发不再偶发数据丢失/错乱」**（可靠性提升，非新功能）。

## 3. 影响面

| 维度 | 影响 |
|---|---|
| 产品功能 | 无变化 |
| 用户路径 | 无变化（所有既有路径行为一致） |
| HTTP API 契约 | 无变化 |
| UI 组件 / testid | 无变化 |
| 数据落点 | 无变化（squad/member/session/message/run/summary + board 仍全 fs；sqlite 仅 app/connector/kv config） |

## 4. 验证

UT 3663 passed / AT 3 passed（真服务，覆盖并发 put 无丢更新 + squad 多角色并发激活 + file-edit 并发锁内重判）/ typecheck 0。详 tech change_log §5。

## 5. 后续可观测项（非本版交付）

未来如发现 squad 并发写仍有性能瓶颈或竞态遗漏，关注：锁等待时长/队列深度 metric（当前 out of scope）；多进程共享 root（当前明确不支持）。
