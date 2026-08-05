# v0.0.125.test_refactor.1 API spec 变更说明 — doc-sync 对齐代码

> 本版本主要是 AT 框架重构（tests/api），无新 API 端点变更；doc-modifier 阶段 5 核实各 API spec 与代码实际一致，对齐三处历史偏差。

## doc-sync 对齐

### 1. `11a-squad-endpoints.md` — session 字段命名对齐 v0.0.56

事务步骤描述里的 session 角色字段从旧措辞「type=X, bizType=studio」改为 v0.0.56 统一命名「role=X, biz=studio」（§1.1 step3/step5 + §2.1 step4）。**纯文档对齐，契约不变**——字段统一早在 v0.0.56 完成（`11-squad.md §2`），11a 事务步骤残留旧措辞是 spec 落后。

### 2. `16-cron.md` §2.5 — enable 响应明示不含 nextFireAt

`POST /session/:sid/cron/:jobId/enable` 响应 `{id, enabled:true}`，**不含 nextFireAt**（nextFireAt 由 scheduler tick 异步算 + GET list/GET detail 现算）。spec 表格原本就写对，本版本加一句明示注释消除 AT designer 误读。

### 3. `11b-squad-workitems.md` §3.5.1 — triage 语义强化（accept 不改 status）

`triage decision` 三分支的 status 联动语义原本就在 spec（accept→pending / defer,reject→cancelled），本版本在描述里**强化**「accept=不改 status（仍是 pending，待拆）」——agent 工具实现 `requirement-tool.ts` line 168-172 完全对齐。W2 旧 AT case 曾按错误语义（accept→改 status）断言过，现已修正。

### 4. `11-squad.md` §4.1 — GET /session query 参数名对齐代码

`GET /session?biz=` 是实际 query 参数名（`handlers/session.ts:74` 读 `biz` 优先，向后兼容 `bizType`），spec 旧写 `?bizType=` 是过时措辞——本版本改为 `?biz=` 并保留向后兼容说明。

## 无 API 契约变更

本版本**未新增/修改/删除任何 API 端点**。所有 API spec 变更纯文档对齐，HTTP 契约（路径/方法/payload/响应/错误码）零变化。
