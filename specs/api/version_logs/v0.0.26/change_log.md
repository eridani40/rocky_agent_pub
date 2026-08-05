# v0.0.26 API 变更日志 — config center scope 维度

> 概述：ext-impl 配置层加 `scope` 维度。新增 scope CRUD + EP 激活端点；现有 `/config/plugin` PUT op 加 `scopeId` 可选字段；GET inventory 加 `scopeId` query + 返回 scope 元信息/激活状态。
> 权威 spec：`specs/tech/config/[P0]ext_impl_scope.md`（技术模型）+ `specs/prd/version_logs/v0.0.26/change_log.md`（语义）。
> 既有契约不变：`/config/app` `/config/dev` `/provider` `/provider/:id/model` 端点完全不动；`/config/plugin` 现有 op（缺省 scopeId=default）向后兼容。
> 本文件是 `specs/api/overall/03-config-center.md` §3 的 v0.0.26 增量补充（doc-modifier 阶段 5 同步进 overall）。

## 1. 新增端点：scope CRUD

scope 一等实体管理（底经 `PluginScopeStore`）。

### 1.1 `GET /config/plugin/scopes`

列所有 scope。

- 响应：`200` · `{ "items": PluginScope[] }`（default 必在首位，按 createdAt 升序）。

```json
{
  "items": [
    { "scopeId": "default", "name": "Default", "description": "默认基线 scope", "createdAt": "2026-06-19T00:00:00.000Z" },
    { "scopeId": "release", "name": "Release", "description": "发布模式", "createdAt": "2026-06-27T10:00:00.000Z" }
  ]
}
```

> **字段名约定**：scope 业务 id 字段为 `scopeId`（与 `PluginScope` interface 一致，`specs/tech/config/[P0]ext_impl_scope.md` §2 / `plugin-scope-store.ts` PluginScope interface 同源）。

### 1.2 `POST /config/plugin/scopes`

创建 scope。

- 请求体：`{ "id": "<snake_case>", "name": "<显示名>", "description"?: "<说明>" }`。
- 校验：`id` 必填、snake_case、不等于 `default`、不与现有 scope 冲突；`name` 必填非空。
- 响应：`201` · `{ "scope": PluginScope }`（含 createdAt=now）。
- 错误：`400`（id 非法/缺 name）；`409`（id 已存在）。

### 1.3 `DELETE /config/plugin/scopes/:id`

删除 scope（cascade 清 activation + plugin_policy impl record）。

- 路径参数：`:id` = scopeId。
- 响应：`200` · `{ "ok": true }`。
- 错误：`400`（`id === 'default'` 拒绝——default 不可删）；`404`（scope 不存在）。

## 2. 新增端点：per-EP 激活

### 2.1 `POST /config/plugin/scopes/:id/activate/:pointId`

激活某 scope 的某 EP（复制 default snapshot + 写 activation record）。

- 路径参数：`:id` = scopeId，`:pointId` = EP id。
- 响应：`200` · `{ "ok": true, "activated": true }`（已激活时幂等返 `"activated": false` 表示无变化）。
- 错误：`400`（`id === 'default'` 拒绝——default 已激活基线）；`404`（scope 或 point 不存在）。

### 2.2 `DELETE /config/plugin/scopes/:id/activate/:pointId`

取消激活某 scope 的某 EP（删 activation + 删该 scope 此 EP 的 plugin_policy impl record，回退取 default）。

- 路径参数同上。
- 响应：`200` · `{ "ok": true, "deactivated": true }`（未激活时幂等返 `"deactivated": false`）。
- 错误：`400`（`id === 'default'` 拒绝）；`404`（scope 不存在）。

### 2.3 `GET /config/plugin/scopes/:id/activations`

查某 scope 激活的 EP 列表（default 返全 EP）。

- 响应：`200` · `{ "items": [{ "pointId": "..." }] }`（当前仅返 pointId；activatedAt 后续按需扩展）。

## 3. 现有端点扩展：`/config/plugin`

### 3.1 `GET /config/plugin?scopeId=<id>`

inventory 按 scope 查询。

- Query：`scopeId` 可选，缺省 = `'default'`（向后兼容，与现状完全一致）。
- 响应：`200` · `{ "tree": PluginInventoryTree }`（v0.0.26 增量字段见下）。

**v0.0.26 响应增量字段**：

```json
{
  "tree": {
    "scope": { "id": "custom", "name": "Custom", "description": "自定义风格" },
    "scopes": [
      { "scopeId": "default", "name": "Default", "description": "...", "createdAt": "..." },
      { "scopeId": "custom", "name": "Custom", "description": "...", "createdAt": "..." }
    ],
    "plugins": [ /* 不变 */ ],
    "groups": [
      {
        "groupId": "provider",
        "points": [
          { "pointId": "llm_provider", "activated": false }
        ],
        "extImpls": [
          {
            /* 既有字段不变（pluginId/implId/pointId/type/pluginEnabled/enabled/order/schemaConfig/config/description/pointDescription/pluginDescription） */
            "pointActivated": false
          }
        ]
      }
    ]
  }
}
```

- `scope`：当前查询的 scope 元信息（default 时 = default scope）。
- `scopes`：全部 scope 列表（供 UI 切换器；default 首位）。
- `groups[].points[]`：该 group 下每个 point 的激活状态（同 point 所有 impl 共享 activated）。
- `groups[].extImpls[].pointActivated`：该 impl 所属 point 在当前 scope 的激活态（平铺便于 UI 渲染）。
- **`groups[].points[].activated === false` 时**：该 point 下 extImpls 的 enabled/order/configValues 是**回退取 default 的视图**（未激活继承）；UI 灰显 + 「继承 default」提示 + 「激活此 EP」按钮。
- **`scopeId='default'`**：全 `pointActivated=true`、`activated=true`（基线，不查 activation 表）。

### 3.2 `PUT /config/plugin`（现有 op 加 scopeId）

**所有现有 op 增加可选 `scopeId` 字段**（缺省 = `'default'`，向后兼容）：

```json
{ "op": "setImplEnabled", "implId": "...", "enabled": true, "scopeId": "custom" }
{ "op": "setExclusive",   "implId": "...", "scopeId": "custom" }
{ "op": "setPointOrders", "pointId": "...", "orders": [...], "scopeId": "custom" }
{ "op": "setImplConfig",  "implId": "...", "values": {...}, "scopeId": "custom" }
{ "op": "setOrder",       "implId": "...", "order": 1, "scopeId": "custom" }  /* deprecated */
```

- `scopeId` 缺省 = `'default'`（与 v0.0.18 行为完全一致，向后兼容）。
- **写未激活 EP 语义**（架构决策 D4，详见 `ext_impl_scope.md` §6.3）：当 `scopeId !== 'default'` 且该 impl 所属 point 在该 scope **未激活** → **自动激活**（复制 default snapshot）+ **应用本次写入**（原子）。响应不变 `{ "ok": true }`。
- `setEnabled` / `setConfig`（plugin 级）**不加 scopeId**（plugin 级配置不分 scope，PRD OUT）。

响应：`200` · `{ "ok": true }`（写入经 persist 落盘，next-get 反映）。

### 3.3 错误响应

| HTTP status | 触发条件 | 响应体 |
|---|---|---|
| `400` | PUT 缺字段/op 不识别/implId 不存在/scopeId 不存在；POST scope id 非法/缺 name；DELETE/POST activate default | `{ "error": "<原因>" }` |
| `404` | scope 不存在（DELETE/activate path）；EP 不存在（activate） | `{ "error": "Not Found" }` |
| `409` | POST scope id 已存在 | `{ "error": "scope id conflicts" }` |

## 4. AT 影响（v0.0.26 新增 case 范围）

对应 PRD §3 用户路径 P1-P8：

| 路径 | API case（建议） |
|------|----------------|
| P1 `getExtensionImpls(point)` 向后兼容 | GET /config/plugin?scopeId=default（缺省）→ 与 v0.0.18 响应结构一致（除新增 scope/scopes/pointActivated 字段） |
| P2 migrate | 启动后 GET /config/plugin → 现有 impl 配置归属 default（scope=default），行为不变 |
| P3 创建 scope + 继承 | POST scope → GET ?scopeId=custom → 全 point activated=false + extImpls 取 default 视图 |
| P4 激活 EP + 改配置 + per-EP 回退 | POST activate → PUT setImplEnabled scopeId=custom → GET ?scopeId=custom 该 point activated=true + impl 反映改动；其他 point 仍回退 |
| P5 取消激活回退 | DELETE activate → GET ?scopeId=custom 该 point activated=false + impl 回退 default |
| P6 删除 scope cascade | DELETE scope custom → GET /config/plugin/scopes 不含 custom；GET ?scopeId=custom → 404；default 配置不变；DELETE default → 400 |
| 写未激活 EP 自动激活 | PUT setImplEnabled scopeId=custom（未激活 EP）→ GET ?scopeId=custom 该 point activated=true + impl 反映改动（验证 D4） |
| snapshot 隔离 | activate custom EP E → 改 default E 某 impl order → GET ?scopeId=custom E 的 order 不变 |

具体 case 文件由 orchestrator 阶段 2.5 委派 coder 创建到 `tests/api/plugin_scope/`。

## 5. 文件级变更清单

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/handlers/config.ts` | 修改 | 新增 `handlePluginScopes`（GET/POST/DELETE scope CRUD）+ `handleScopeActivation`（POST/DELETE/GET activate）；`handlePluginConfig` GET 加 `scopeId` query 解析；PUT 现有 op body 加 `scopeId` 字段透传 service |
| `app/server/src/handlers/routes.ts`（或路由注册处） | 修改 | 注册新路由 `/config/plugin/scopes` + `/config/plugin/scopes/:id` + `/config/plugin/scopes/:id/activate/:pointId` + `/config/plugin/scopes/:id/activations` |
| `app/web/src/lib/api-client.ts` | 修改 | 新增 `listScopes/createScope/deleteScope/activateEp/deactivateEp/listActivations` 函数；`getPluginInventory` 加 scopeId 参数；`PluginPutOp` 联合体各 op 加 `scopeId?` 字段；PluginInventory 类型加 scope/scopes/pointActivated 字段 |

## 6. 版本

`specs/api/overall/03-config-center.md` version 1.3 → 1.4 `[v0.0.26 modified]`（§3 新增 scope CRUD + EP 激活端点；GET /config/plugin 加 scopeId query + 响应 scope/scopes/pointActivated 字段；PUT 现有 op 加 scopeId? 字段）。具体同步由 doc-modifier 阶段 5 执行。
