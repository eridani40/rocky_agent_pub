# cascade-delete — 删 parent session 级联删子孙 + 清 cron

## 覆盖契约

| 端点 | spec | 验证点 |
|------|------|--------|
| `POST /session` | 04 §2.1 | 建 parent（playground，预绑定 minimax） |
| `POST /session/:id/messages` | 04 §3.2 | 发消息驱动 agent 工具 spawn explorer 子 agent（生产路径） |
| `GET /session/:id/children` | 10 §3 | sync spawn 完成后 child 在 `terminated[0]` |
| `GET /session/:id` | 04 §2.3 | child `derivation=subagent` + `parentSessionId` 落库 |
| `POST /session/:sid/cron` | 16 §2.2 | 给 child 挂 cron（HTTP 确定性构造「挂 cron 的子孙」）→ `201` |
| `GET /session/:sid/cron` | 16 §2.1 | 删前确认 cron job 落库（`.items[0].id`） |
| `DELETE /session/:id` | 04 §2.4（v0.0.192 修订） | 补 `collectDescendants` BFS → 级联删全部子孙 + 每 descendant 触发 `onSessionDestroyed` |
| `GET /session/:id` | 04 §2.3 | parent + child 解散后均 `404`（无孤儿 — N2 核心） |
| `GET /session/:sid/cron` | 16 §2.1 | child cron 端点随 session 同灭 → `404` |

## 断言面

**建 child（spawn，真调 minimax）**
- SSE `spawn_run.count(type=run_end) == 1` + `absent(type=error)`（parent run 正常完成）
- `GET /children` → `.terminated[0].sessionId exists`
- `GET /session/{child}` → `.derivation == "subagent"` + `.parentSessionId exists`

**挂 cron（HTTP 确定性）**
- `POST /session/{child}/cron` → `.id exists` + `.cron == "*/30 * * * *"`
- `GET /session/{child}/cron` → `.items[0].id exists`

**级联删（N2 核心 + N3 间接）**
- `DELETE /session/{parent}` → `204`
- `GET /session/{child}` → `404`（child 级联删，无孤儿）
- `GET /session/{parent}` → `404`
- `GET /session/{child}/cron` → `404`（cron 注册表随 session 同灭）

## AT vs UT 边界（设计权衡）

- **AT 验 session 级 404**：child record + cron HTTP 端点随 session 消失（黑盒可观测的级联契约）。
- **UT 补全**（`session-cascade.test.ts`）：
  - `collectDescendants` BFS 多层（A→B→C）+ 环防御 + 无 children 返空
  - `listSessionsBySquad` 过滤（含 spawn child 带 squadId）
  - **`onSessionDestroyed` 触发次数 = descendants + 1**（直接验 N3 内存 cron 注销，AT 无 endpoint 可查）
- **PRD 路径 C「重启不复活」**：AT 不 mid-case 重启 server，由 UT（onSessionDestroyed 计数）+ 启动期 boot.ts:259 wire 覆盖。

## 调 LLM

spawn child 必须走 agent 工具（HTTP 无创建 child+parentSessionId 的端点）。真调 minimax；429 → 框架自动 skip。cron 创建走 HTTP（确定性）。

## 设计假设（spec 支持，若执行发现偏差报 doc-sync）

- `POST /session/:sid/cron`（16 §2.2）对 subagent session 无 403（仅 404/400）；agent 工具层 subagent policy 限制不作用 HTTP 端点。故可在 spawn 出的 subagent child 上 HTTP 建 cron，确定性构造「挂 cron 的子孙」。
