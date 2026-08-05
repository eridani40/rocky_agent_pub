# API Change Log — v0.0.11

> 增量记录 v0.0.11 相对 v0.0.10 的 HTTP 端点契约变更。
> 全量契约：`specs/api/overall/`。PRD：`specs/prd/version_logs/v0.0.11/change_log.md`。

## 1. Scope

v0.0.11 **无新增/删除端点**。唯一契约层变更：`/config/dev` 的 `runtime.observability` 字段从单对象改为 **list-of-objects**（`ObservabilityConfigItem[]`，schema 见 tech `dev_config.md §3.4`），其中 `secretKey` 落到 dev_config secret 字段语义——**GET redact + PUT 占位 merge**（与 `/config/app` providers `apiKey` 同套路）。

> observability manager 的 fan-out / 容错 / handle 映射是**服务端内部实现**（不暴露 HTTP 契约），契约层只看见 `/config/dev` 的数据形状 + secret 语义。

## 2. `/config/dev` runtime.observability 字段

### 2.1 形状变更（破坏性）

- v0.0.10：`data` = `{ vendor, publicKey, secretKey, baseUrl, enabled? }`（单对象）。
- v0.0.11：`data` = `ObservabilityConfigItem[]`（列表，字段 id/name/type:'langfuse'/baseUrl/publicKey/secretKey/enabled/desc）。
- **GET/PUT 端点路径、整组提交语义、错误码全部不变**（见 overall §2.2）。

### 2.2 secretKey 语义（GET redact / PUT 占位 merge）

- **GET `/config/dev?group=runtime&key=observability`**：响应每 item 的 `secretKey` = `"***"`（redact），其余字段明文。
- **PUT `/config/dev`**（整组或单 key）：item 的 `secretKey`：
  - 值 = `"***"`（占位，前端未改）→ 服务端 merge，保留原落盘值。
  - 值 ≠ `"***"`（用户重新输入）→ 落盘新值。

完整契约补到 overall `03-config-center.md §3.5`。

## 3. AT 影响（v0.0.11 新增 case，已验证 PASS）

- dev_config observability GET 响应断言 `secretKey === "***"`（redact 生效）。
- PUT 携带占位 `"***"` → 再 GET → 原值不变（merge 生效）。
- PUT 携带真值 → 再 GET → 新值（非 `"***"`，落盘生效）。
- noop 验证：空列表/全 disabled → manager 等价 Noop，loop 无感知（端点行为不变，间接覆盖）。

> AT 3/3 全绿（no-mock，真机 langfuse 凭证）。详见 `states/v0.0.11/verify/api-test/`。

## 4. 版本

version: 1.0（v0.0.11 新建：无新端点；仅 dev_config.observability 字段形状（single→list）+ secretKey GET redact / PUT 占位 merge 语义）。
