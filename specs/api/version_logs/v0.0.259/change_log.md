# v0.0.259 — API Change Log（panorama POST entities 幂等 + response 加 created + PATCH coerce）

> 增量变更。全量权威：`specs/api/overall/14-panorama-endpoints.md`（v1.5）。
> 权威输入：`specs/tech/version_logs/v0.0.259/change_plan.md` + `change_log.md`。

## §1 POST entities 端点契约变更（14 §2.2）

### 1.1 Response shape 加 `created: boolean`（additive）

**契约**（additive，向后兼容）：

```typescript
// v0.0.259 前
201 + { ok: true, id: string }

// v0.0.259 起
201 + { ok: true, id: string, created: boolean }
```

- `created: true` = 本次新建（走建路径）
- `created: false` = 幂等命中已存在 id（短路返，不写库）

**AT 影响**：旧 case 若用严格等值 `response == {ok:true, id:"X"}` 会破；`any/all` 量词断言 `response.ok==true / response.id==X` 不破。需 designer 调整为字段存在 + 值断言。

### 1.2 create 改 skip-if-exists 幂等

**行为**（破坏性语义变更——id 已存在不再报错）：

- v0.0.259 前：id 已存在 → 400 `panorama_duplicate_id`（实例写校验引擎报）
- v0.0.259 起：id 已存在 → `201 {ok:true, id, created:false}`（**短路在 coerce+validate 之前**，不写库 / 不 emit entity.created / 不触发 afterTaskWrite）

理由：bulk create 重试场景下，agent 不 query 现存就批量写——硬拒引发 `panorama_duplicate_id` 一片失败（prod 553 次 / 123 失败里 ~15% 是此）。skip-if-exists 与项目数据安全口径一致：**不静默覆盖已有数据，要改用 PATCH**。

### 1.3 `panorama_duplicate_id` 错误码消失

`panorama_duplicate_id` **不再从 create 路径产出**（`validateInstance` create 分支 duplicate check 删除，调用方短路在 coerce+validate 之前）。该码仅作 update 路径历史保留，实例写校验表已无此码。AT case 若断言该码从 create 产出会 fail（需调整为 `created:false` 断言）。

## §2 PATCH entities 加 coerceRecord（14 §2.2 行为补充）

PATCH 实例的 merged record（existing + patch）在 `validateInstance` 之前过 `coerceRecord`——按声明类型无损 coerce（number↔string / boolean←"true","false"）。例如 PATCH `{chapter_count_done:"1928"}` 与库里 number merge后 coerce 写回一致类型。

- 无损 round-trip 守门：有损/不合法值（`"0x10"`/`"1.0"`/`""`/enum 非法）保留原值交下游 check 报错。
- 不影响 response shape（PATCH 仍返 `200 {ok:true}`）。

## §3 工具 panorama create（agent 侧）

agent 工具 `panorama(action="create", entity, fields)` 与 HTTP POST 同款变更：

```typescript
// v0.0.259 前
{ ok: true, id: string }

// v0.0.259 起
{ ok: true, id: string, created: boolean }
```

- 同样 skip-if-exists（命中 `store.hasId` 短路返 `created:false`）。
- 同样在 coerce+validate 之前短路（幂等命中不触发校验）。
