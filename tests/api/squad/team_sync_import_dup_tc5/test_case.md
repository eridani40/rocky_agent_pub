# team_sync_import_dup_tc5 — 导入重名建队（后端允许重名 → 201，两个同名 squad 共存）

## 覆盖契约

| 端点 | spec | 验证点 |
|------|------|--------|
| `POST /squad/import?step=execute` | change_plan.md D2+D3（v0.0.319） | 导入 name 与已有 squad 同名 → 201 成功（后端不拒重名）；两个同名 squad 共存 |
| `POST /squad` + `GET /squad/:id` | 11a §1.1 + §1.3 | setup 建已有同名 squad；GET 新旧两 squad 均为同名 |
| PRD UC-4 | specs/prd/v0.0.319-team-sync.md | 「导入重名团队名 → 提醒不拦」：重名检测在前端（listSquads 比对），后端允许 |

## 断言面

- setup 建 `name=ts-dup-name` squad（已有同名团队）
- preview 合法 zip → importKey
- execute `name=ts-dup-name` → 201 + `.squadId exists` + `.created[] any . == "ts-mate-a"` / `"ts-mate-b"`（建队成功，不因重名失败）
- `GET /squad/{dup_new_id}` → name == `ts-dup-name`（新 squad 存在）
- `GET /squad/{dup_existing_id}` → name == `ts-dup-name`（旧 squad 仍存在，两同名共存）

## 设计说明

- `createSquadService` 对 squad name 无唯一性校验（仅非空），成员名才是 squad 内唯一 → 重名导入必然成功。
- 重名提醒是前端行为（listSquads 比对 + 提示不拦），后端 API 层面无拒绝逻辑 → AT 断言后端契约（允许重名）。
- check 右侧不插值 → 两个 squad 分别用 request path 插值 GET 比对 name。

## 不调 LLM

纯 HTTP（建队 + preview + execute + GET），全确定性。
