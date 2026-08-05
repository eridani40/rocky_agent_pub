# dissolve-preserve — 解散团队保留工作产出

## 覆盖契约

| 端点 | spec | 验证点 |
|------|------|--------|
| `POST /squad` | 11a §1.1 | 建队事务（record + leader + squadChat + 目录骨架，含 `squads/{id}/workspaces/{memberId}/`） |
| `POST /squad/:id/member` | 11a §2.1 | hire fresh mate → 建 mate session + workspace 目录；响应直连 `{member, sessionId}` |
| `DELETE /squad/:id` | 11a §1.5（v0.0.192 修订） | 硬删 team：dispose → listSessionsBySquad 删各 session → deleteSquad → **删管理性子路径（非整目录）** → `200 {deleted:true}` |
| `GET /squad/:id` | 11a §1.3 | 解散后 → `404`（record 已删） |
| `GET /session/:id` | 04 §2.3 | mate / squadChat session 解散后 → `404`（级联删 session record） |
| `POST /session` `{workspaceDir}` | 04 §2.1 | 指向存活 workspaceDir → `201`（server 校验目录 exists+isDir；旧 bug 整目录删会致 `400`） |
| `GET /session/:id/workspace/tree` | 04 §2.6.1 | 读存活目录树，含 marker 文件（内容存活） |

## 断言面

**管理性数据已删（黑盒 404）**
- `GET /squad/{id}` → `404`（squad record 删）
- `GET /session/{mate_sid}` → `404`（mate session 删）
- `GET /session/{squadchat_sid}` → `404`（squadChat session 删）

**工作产出存活（fs 验证 — N1 头条契约）**
- `DELETE /squad` → `.deleted == true`
- 植 marker `squads/{id}/workspaces/{mate_mid}/KEEP.md`（files 原语，解散前）
- 解散后读解散前保存的 mate `workspaceDir` 绝对路径 → `POST /session {workspaceDir}` → `201`（目录存活；旧 bug rmSync 整个 squadRoot → 目录消失 → `400`）
- `GET /session/{verify_sid}/workspace/tree` → `.tree[] any .name == "KEEP.md"`（内容存活）

## AT vs UT 边界（设计权衡）

- **AT 受限**：`files` 原语只写不读 + DSL 插值无 dirname，只能验证「能从 HTTP 响应拿到绝对路径的 workspace 目录」存活。
- **UT 补全**（`squad-dissolve.test.ts`）：`existsSync` 断言四目录全存活（`workspaces/outputs/reports/board`）+ 管理性子项全删（`members/charter.md/.rocky_squad/panorama/charter_history/index.md/log.md`）。
- workspace 是 agent 写的代码/文件（最具价值产出），AT 验其存活即覆盖 N1 用户可感知契约。

## 不调 LLM

纯 HTTP 事务 + files 原语，全确定性。`modelDefault=MiniMax-M3` 仅过建队写入校验；本 case 从不 `run` session。

## 前置依赖

- v0.0.192.delete_cleanup 的 `deleteSquadAdministrativeSubpaths` 已实现（否则存活 check 会 fail —— 这是 case 编码的 post-fix 契约，fix 未落地时 fail 即正确暴露）。
