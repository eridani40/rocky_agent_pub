# v0.0.116 API change_log — 心跳升级 squad 级 + member presence

> 类型：契约变更（②，含破坏性删除）。概念先行 pass 产出；完整架构阶段（change_plan）再细化 AT case 映射。
> 权威概念：`specs/tech/scheduling/[P1]heartbeat_handler.md §0` + `specs/tech/squad/[P1]data_model.md §1.1a/§1.2b`。

## 变更端点（`specs/api/overall/11a-squad-endpoints.md`）

### 1. `PATCH /squad/:id` — 加 heartbeatConfig（②，squad 心跳配置唯一写入口）

`PatchSquadBody` + `SquadDetail` 加 `heartbeatConfig`：

```typescript
heartbeatConfig?: {
  interval: 5 | 15 | 30 | 60;                            // 分钟，默认 15
  activeWindows: Array<{ start: string; end: string }>; // "HH:mm" 多段；段间不重叠 + 单段 start<end（不跨0点）；空=全天
  scope: { mode: "all" | "whitelist"; memberIds: string[] };  // all=全员/whitelist=白名单（新增成员不自动纳入）
} | null;  // PATCH: null=清空回默认 / undefined=不修改；SquadDetail: null 也回显
```

- 写后 `scheduler.reloadSquad()` 重建 squad heartbeat job（实时生效）。
- `budget` null=off=不限量 / 非 null=on=限量（语义显式化，字段形态不变）。
- 新错误：`400` activeWindows 段间重叠 / 单段 start>=end / interval 非枚举 / scope.mode 非法。

### 2. `Member` 加 currentWork（②，presence）+ heartbeat 标 dead

```typescript
currentWork: { text: string; updatedAt: string } | null;  // presence 工具 set/clear；旧 record 可能缺
heartbeat: {...} | null;  // dead：per-member 心跳废弃，响应可能返旧值，UI 不消费
```

- `SquadDetail.members[].currentWork` 回显（UI 展示 leader team-status 时读）。
- presence 写走 `presence` agent 工具（`squad_tools.md §6a`），**无专用 HTTP 端点**。

### 3. `PATCH /squad/:id/member/:mid/heartbeat` — 废弃删除（②，破坏性）

- 端点 + `PatchHeartbeatBody` + `scheduler.reloadRole` + `handlers/squad-heartbeat-handler.ts` 全删。
- 心跳配置改走 #1（PATCH /squad heartbeatConfig）；成员范围由 scope 控制，非 per-member 开关。
- 旧 AT case 迁移到 PATCH /squad heartbeatConfig 校验。

## AT 影响（完整架构阶段细化）

- 新：PATCH /squad heartbeatConfig 正常写 + 校验 400（重叠/跨0点/interval 枚举）+ GET 回显。
- 新：presence 工具 set/clear → GET /squad members[].currentWork 反映（AT 走 tool_chat 或直查 member）。
- 删/迁：`heartbeat_patch_tc1` / `patch_heartbeat_400_start_ge_end` → PATCH /squad heartbeatConfig。
