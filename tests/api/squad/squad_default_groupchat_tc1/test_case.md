# squad_default_groupchat_tc1 — 新团队默认关闭群聊 + 存量兜底

## 覆盖契约

| 端点 | spec | 验证点 |
|------|------|--------|
| `POST /squad` | 11a §1.1（v0.0.340 修订） | 建新队 → `201` 响应 `.enableGroupChat == false`（默认关群聊） |
| `GET /squad/:id` | 11a §1.3（v0.0.270 兜底） | 新建 squad 回读 `.enableGroupChat == false`（落盘持久） |
| `GET /squad/:id` | 11a §1.3（v0.0.270 兜底） | 存量 record（无 enableGroupChat 字段）→ `.enableGroupChat == true`（`?? true` 兜底=开，存量不受影响） |

## 断言面

**新队默认关群聊（需求 1 主契约）**
- `POST /squad` → `.enableGroupChat == false`
- `GET /squad/{id}` → `.enableGroupChat == false`（落盘持久，非仅建队响应）

**存量 squad 兜底不受影响（需求 1 次契约 / change_plan 决策 3）**
- files 原语写 legacy record `squad/01KZZZZZZZZZZZZZZZZZZZZZZZX.json`（完整 required 字段 + 信封，**不含 enableGroupChat**，模拟 v0.0.270 前遗留数据）
- `GET /squad/01KZZZZZZZZZZZZZZZZZZZZZZZX` → `.enableGroupChat == true`（`?? true` 兜底生效）
- 必填字段齐全（id/name/modelDefault/leaderId/memberIds/squadChatSessionId/enableHeartBeat + 信封），fs-store `readJsonFileSync` 直读不校验 schema；`memberIds: []` → `listMembers` 对不存在 members 目录走 `readDirSafeSync` 安全返回空

## 设计权衡

- **legacy fixture 用 files 原语手写**而非「建队后删字段」：删字段无 HTTP 端点，files 直写最贴近真实存量形态；fs-store get 不做 schema 校验（仅 put 校验）→ 无字段 record 可正常读取
- **不调 LLM**：纯 HTTP 事务 + files 原语，全确定性，`modelDefault=MiniMax-M3` 仅过建队写入校验
- **teardown**：DELETE 解散新建 squad；legacy fixture 由 files 原语自动清理

## 前置依赖

- v0.0.340 `squad-service.ts` createSquadService `enableGroupChat: false` 已实现（否则建队断言 fail）
- `handlers/squad.ts` toDetail `s.enableGroupChat ?? true` 兜底已存在（v0.0.270 既有，未动）
