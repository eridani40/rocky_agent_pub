# Counter HTTP API（mock 计数器后端接口）

> version: 1.0 · 设计稿 2026-06-19
> 管什么：`/counter` 系列端点的 HTTP 接口契约（路径 / 方法 / 请求 / 响应 / 错误 / 持久化位置），供 api-verifier 黑盒 curl、供 web 渲染层 fetch。
> 不管什么：渲染层 UI（→ `specs/ui/overall/01-counter.md`）；server 实现细节（node:http 路由分发、文件读写 API → 代码层）；端口 schema 与 DATA_DIR 取值规则（→ `app/envs/[P0]environments.md`）；包边界（→ `app/package/[P0]package_structure.md`）。
> 边界归属规则见 [docs_guide.md](../../tech/docs_guide.md) §4。

## 1. 概述

v0.0.1 的 mock 计数后端由 `app/server` 用 `node:http` 暴露两个 HTTP 端点：读当前计数、自增 1 返回新值。接口走 HTTP（非 IPC，见 PRD §5.1），让 api-verifier 可直接 curl、web 渲染层可独立 fetch，**不依赖 Electron runtime**。

一句话：**`GET /counter` 读、`POST /counter/inc` 自增 1，响应体统一 JSON `{ value, updatedAt }`，计数落盘到本环境 `DATA_DIR` 下的 `counter.json`**。

### 1.1 数据流

```
┌──────────────┐   GET /counter / POST /counter/inc   ┌─────────────────────────────┐
│ api-verifier │ ─────────── HTTP 127.0.0.1:API_PORT ─►│ app/server (node:http)      │
│ (curl)       │ ◄────────── JSON { value, updatedAt } │  └─► ${DATA_DIR}/counter.json │
└──────────────┘                                       └─────────────────────────────┘
                                                              ▲
┌──────────────┐   fetch(http://127.0.0.1:API_PORT/...)       │
│ web 渲染层   │ ─────────────────────────────────────────────┘
│ (browser)    │
└──────────────┘
```

- 渲染层（web）经 `WEB_PORT` 加载页面、经 `API_PORT` fetch 数据，两端口分离见 `app/envs/[P0]environments.md` §3.1 / §4.5。
- api-verifier 只 curl `API_PORT`，e2e-verifier 只驱动 `WEB_PORT`，两者职责互不重叠。

## 2. 接口定义

### 2.1 监听地址

| 项 | 取值 | 来源 |
|----|------|------|
| host | `127.0.0.1`（loopback，仅本机） | 本文件契约 |
| port | `API_PORT`（test `3700` / dev `3710` / prod `3720`） | `app/envs/[P0]environments.md` §3.1 |
| 协议 | `http`（无 TLS） | v0.0.1 本机场景，签名为 OUT OF SCOPE（PRD §7.2） |

> `API_PORT` 是 server 启动时从环境读取的值；接口契约只规定「监听 `http://127.0.0.1:${API_PORT}`」，具体端口数值归属 envs schema。

### 2.2 端点总表

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `GET` | `/counter` | 读当前计数 | 无 | `200` · `CounterResponse` |
| `POST` | `/counter/inc` | 自增 1，返回**自增后**的新值 | 无（空 body） | `200` · `CounterResponse` |

> v0.0.1 无 reset 端点（见 §3.3 决策）。无 `/` 根路径、无 `/health`（健康端点归属见 §5）。

### 2.3 类型定义

```typescript
/** 计数器统一响应体 —— GET 与 POST 共用同一 schema */
interface CounterResponse {
  /** 当前计数值。GET 返回读到的值；POST /counter/inc 返回自增 1 后的新值。 */
  value: number;
  /** value 最后更新时间，ISO 8601 UTC（见 convention.md §4）。首次返回文件首次写入时间。 */
  updatedAt: string;
}
```

| 字段 | 类型 | 必含 | 语义 |
|------|------|------|------|
| `value` | `number` | 是 | 当前计数（整数语义，inc 每次固定 +1） |
| `updatedAt` | `string` | 是 | 上次写入时间，ISO 8601 UTC，形如 `2026-06-19T07:30:00.000Z` |

> `value` 类型为 `number`；v0.0.1 语义为整数（初始 `0`，每次 inc `+1`），不强制 JSON Schema `integer`，但实现侧不应产生小数。

### 2.4 错误响应

所有错误响应体统一为 JSON `{ "error": string }`，`Content-Type: application/json`。

| HTTP status | 触发条件 | 响应体 | 说明 |
|-------------|---------|--------|------|
| `200` | `GET /counter` / `POST /counter/inc` 成功 | `CounterResponse` | 见 §2.3 |
| `404` | 未匹配的路径（如 `/`、`/counter/dec`、`/foo`） | `{ "error": "Not Found" }` | 仅 `/counter`、`/counter/inc` 两个路径合法 |
| `405` | 已知路径但方法不对（如 `PUT /counter`、`DELETE /counter/inc`、`PATCH /counter`） | `{ "error": "Method Not Allowed" }` | `Allow` 响应头列出该路径允许的方法（`/counter` → `GET`；`/counter/inc` → `POST`） |

> v0.0.1 不引入 `400`（请求体无校验需求）、不引入 `500`（实现应吞下 IO 异常返回 200 初始值，见 §3.2 反例除外）。若 server 内部 panic，`node:http` 默认行为返回连接错误，不在本契约覆盖范围。

## 3. 设计决策

### 3.1 接口走 HTTP，非 Electron IPC

**结论**：mock 计数后端用 `node:http` 暴露 HTTP（`/counter`、`/counter/inc`），渲染层经 `fetch` 调用，**不**走 Electron IPC。
**理由**：让 api-verifier 可直接 curl 验证后端、不依赖 Electron runtime；同时让 web dev server 可独立于 Electron 外壳被 e2e-verifier 驱动。与 PRD §5.1 决策一致（本契约落地该决策）。
**反例**：若用 IPC，则 AT 必须拉起整个 Electron 才能调计数接口，慢且脆弱；web 也无法脱离 Electron 独立测试，与 PRD §5.2 的「ET 驱动 web dev server」冲突。

### 3.2 持久化落盘到 `${DATA_DIR}/counter.json`，非纯内存

**结论**：计数器状态持久化到本环境 `DATA_DIR` 下的单一文件 `${DATA_DIR}/counter.json`，文件内容即 `{ "value": number, "updatedAt": string }`。`GET` 读该文件（不存在则视为 `{ value: 0, updatedAt: <现在> }` 并返回，不写盘）；`POST /counter/inc` 读改写回。
**理由**：让 PRD 路径 2「环境隔离」测试（UC-3.2.2）有意义——dev 写 `~/.rocky_agent_dev/counter.json`、test 读 `~/.rocky_agent_test/counter.json`，三环境物理隔离、互不串数据。文件持久化让「重启 server 后计数保留」可观测，强化 DATA_DIR 的价值证明。一个 JSON 存全部状态，最小存储、零依赖（不引 persistence 引擎，呼应 PRD §7.2 OUT OF SCOPE）。
**反例**：若用纯内存计数（进程内变量），则 dev/test 三环境天然隔离（进程隔离即可测出），DATA_DIR 这一配置项在计数功能上沦为死字段，UC-3.2.2 退化成「重启不串数据」而非「不同目录不串数据」，测不出 DATA_DIR 真实价值。

### 3.3 不设 reset 端点

**结论**：v0.0.1 只暴露 `GET /counter` + `POST /counter/inc`，**不**提供 `POST /counter/reset` 或 `DELETE /counter`。
**理由**：PRD §3.4 / §4 路径 1 仅要求「读 + 自增」，所有用户路径（UC-3.4.1 / UC-3.4.2）覆盖这两个端点即可；reset 在测试侧可通过删除 `${DATA_DIR}/counter.json` 文件后重启 server 实现，无需暴露成 API。保持接口面最小，减少 v0.0.1 契约面积与测试 case 数量。
**反例**：若加 reset 端点，则需额外规定其语义（重置到 0？重置到任意值？是否清空 updatedAt？）、额外 case 覆盖、额外错误分支，契约面积增大；而该能力在 v0.0.1 无用户路径需要它。

### 3.4 错误用 HTTP status + JSON body，非裸文本

**结论**：404 / 405 响应体统一为 `{ "error": string }`，`Content-Type: application/json`；成功响应也是 JSON。
**理由**：响应体始终可被 `JSON.parse` 解析，api-verifier 的 checkpoint check 表达式（如 `jq .error`）保持一致；`Allow` 头让 405 客户端能自动发现允许的方法。
**反例**：若错误返回裸文本（如 `"Not Found"`、`Content-Type: text/plain`），则 verifier 的 check 表达式要分情况（成功 JSON.parse / 失败按文本匹配），易写错。

## 4. 示例

> 以下示例中 `${API_PORT}` 取 test 环境 `3700`；dev / prod 替换为 `3710` / `3720`。所有响应体完整无省略。

### 4.1 初次 GET（文件不存在）

```bash
curl -i http://127.0.0.1:3700/counter
```

```http
HTTP/1.1 200 OK
content-type: application/json

{"value":0,"updatedAt":"2026-06-19T07:30:00.000Z"}
```

> 文件不存在时 server 返回 `value: 0` + 当前时间；不落盘，等首次 inc 才写。

### 4.2 POST 自增

```bash
curl -i -X POST http://127.0.0.1:3700/counter/inc
```

```http
HTTP/1.1 200 OK
content-type: application/json

{"value":1,"updatedAt":"2026-06-19T07:30:05.000Z"}
```

### 4.3 连续两次 inc 后再 GET（验证持久化）

```bash
curl -s -X POST http://127.0.0.1:3700/counter/inc    # → {"value":2,"updatedAt":"..."}
curl -s -X POST http://127.0.0.1:3700/counter/inc    # → {"value":3,"updatedAt":"..."}
curl -s http://127.0.0.1:3700/counter                # → {"value":3,"updatedAt":"..."}（与上一次 inc 的 updatedAt 一致）
```

> 重启 server 后再 GET，应返回上次落盘的 `value`（验证 `${DATA_DIR}/counter.json` 持久化）。

### 4.4 落盘文件形态（`${DATA_DIR}/counter.json`）

```json
{"value":3,"updatedAt":"2026-06-19T07:30:10.000Z"}
```

### 4.5 错误：405（已知路径方法错）

```bash
curl -i -X DELETE http://127.0.0.1:3700/counter/inc
```

```http
HTTP/1.1 405 Method Not Allowed
allow: POST
content-type: application/json

{"error":"Method Not Allowed"}
```

### 4.6 错误：404（未知路径）

```bash
curl -i http://127.0.0.1:3700/counter/dec
```

```http
HTTP/1.1 404 Not Found
content-type: application/json

{"error":"Not Found"}
```

### 4.7 api-verifier check 表达式（checkpoint.json 复用模板）

```jsonc
// UC-3.4.1 链路：POST inc → GET，验证 value +1
{
  "steps": [
    { "id": "inc1", "call": "POST /counter/inc", "store": "v1 = response.value" },
    { "id": "get1", "call": "GET /counter",      "assert": "response.value == v1 + 1 - 1" }
  ],
  "checks": [
    { "expr": "inc1.status == 200",                "desc": "inc 返回 200" },
    { "expr": "get1.status == 200",                "desc": "get 返回 200" },
    { "expr": "get1.body.value == inc1.body.value", "desc": "GET 与上次 inc 一致" },
    { "expr": "inc2.body.value == inc1.body.value + 1", "desc": "二次 inc 后值 +1" }
  ]
}
```

## 5. 边界

| 零件 | 归属 |
|------|------|
| `/counter` / `/counter/inc` 的方法、路径、请求/响应 schema、错误 status、持久化文件位置与形态 | 本文件 ✅ |
| `API_PORT` / `WEB_PORT` / `DATA_DIR` 的取值与 env schema | `app/envs/[P0]environments.md` §3.1 / §4.5 / §4.6 |
| server 实现代码（node:http 路由、文件读写、错误包装） | 代码层 `app/server/` |
| 渲染层 UI 契约（testid、视觉断言、交互链路） | `specs/ui/overall/01-counter.md` |
| 健康检查端点 `/health`（test env 的 `HEALTH_ENDPOINT`） | `app/envs/[P0]environments.md` §3.2 + tests 模板（计数器契约不含 /health） |
| Bootstrap 状态端点 `/bootstrap/status`（v0.0.150）| 本文件 §6 ✅ |
| 包边界（server 零 electron、web 沙箱 fetch） | `app/package/[P0]package_structure.md` §2.1 / §3.3 |
| 跨模块零件通用归属规则 | [docs_guide.md](../../tech/docs_guide.md) §4 |

## 6. Bootstrap Status 端点（v0.0.150 新增）

> **[v0.0.150 added]** 与 `/health` 同为非业务域的「基础设施」端点——router.ts 在 `/health` 分支之后立即分发，`getBootstrap(dataDir)` 之前。返回启动期 MigrationManager 的执行结果（app 版本号 + 迁移错误列表），供前端 AppShell 启动时拉取，errors 非空则渲染 `MigrationErrorModal`。完整架构与设计动机见 `specs/tech/migration/`。

### 6.1 端点定义

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `GET` | `/bootstrap/status` | 读当前 app 版本 + 上次版本 + 迁移错误列表 | 无 | `200` · `BootstrapStatusResponse` |

错误响应：

| HTTP status | 触发条件 | 响应体 | 说明 |
|-------------|---------|--------|------|
| `405` | 已知路径但方法不对（如 `POST /bootstrap/status`、`PUT`、`DELETE`） | `{ "error": "Method Not Allowed" }` | `Allow: GET` |

> **即使有 `migrationErrors` 仍返 200（统一放行）**：errors 是「迁移有失败但不阻塞启动」的提示信号，非 HTTP 错误；handler 抛错 / lock 冲突 / yaml 缺失等都进 errors，bootstrap 仍继续启动，前端按 errors 长度决定是否弹 modal。

### 6.2 类型定义

```typescript
interface BootstrapStatusResponse {
  /** 当前 app 版本（从 app/server/app-version.json 读，由 build step 生成） */
  appVersion: string;
  /** 上次跑完 MigrationManager 的版本（重读 <DATA_DIR>/migration_state.json 拿；缺失/损坏兜底 '0.0.0'） */
  lastAppVersion: string;
  /** 启动期 MigrationManager 收集的错误（lock 冲突 + handler 抛错）；空数组表示无错 */
  migrationErrors: Array<{ id: string; message: string; stack?: string }>;
}
```

| 字段 | 类型 | 必含 | 语义 |
|------|------|------|------|
| `appVersion` | `string` | 是 | 当前 app 版本，如 `"0.0.150"`（build step 从根 package.json 生成 `app-version.json`） |
| `lastAppVersion` | `string` | 是 | 上次跑完 MigrationManager 的版本；`"0.0.0"` 表示首次启动或 ledger 缺失/损坏 |
| `migrationErrors` | `Array<{id,message,stack?}>` | 是 | 错误列表；`id` = handler id 或 `'__manager__'`（lock/yaml 等管理器自身错误）；空数组 = 无错 |

### 6.3 示例

```bash
curl -i http://127.0.0.1:3700/bootstrap/status
```

```http
HTTP/1.1 200 OK
content-type: application/json

{"appVersion":"0.0.150","lastAppVersion":"0.0.150","migrationErrors":[]}
```

带迁移错误的响应（仍 200，前端按 errors 长度弹 modal）：

```http
HTTP/1.1 200 OK
content-type: application/json

{"appVersion":"0.0.150","lastAppVersion":"0.0.149","migrationErrors":[{"id":"some-handler","message":"boom","stack":"..."}]}
```

method 错返 405：

```http
HTTP/1.1 405 Method Not Allowed
allow: GET
content-type: application/json

{"error":"Method Not Allowed"}
```

### 6.4 设计决策

**为什么走 REST 而非 SSE / 共享文件**：bootstrap 一次性快照，REST 够用且对齐 `/health` 模式；bootstrap 期还未建 SSE 通道；`lastAppVersion` 由 handler 内重读 ledger 拿（避免 BootstrapResult 多一字段）。完整论证见 `specs/tech/migration/[P0]migration_manager.md §3.6`。

## 7. 版本

version: 1.1 `[v0.0.150 added]`：新增 §6 Bootstrap Status 端点（`GET /bootstrap/status` 返 appVersion/lastAppVersion/migrationErrors；即使有 errors 仍 200 统一放行）。1.0：v0.0.1 首版（`GET /counter` + `POST /counter/inc`）。
