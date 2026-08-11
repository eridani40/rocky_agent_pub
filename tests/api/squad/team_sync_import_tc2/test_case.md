# team_sync_import_tc2 — 导入 preview + execute 建队（合法 zip 往返）

## 覆盖契约

| 端点 | spec | 验证点 |
|------|------|--------|
| `POST /squad/import?step=preview` | change_plan.md D2+D3（v0.0.319） | FormData(file) → `{importKey, manifest}`；manifest 名字/leader/members 正确 |
| `POST /squad/import?step=execute` | change_plan.md D2+D3 | FormData(importKey, name) → `201 {squadId, created, failed}`；importKey 消费后失效 |
| `GET /squad/:id` | 11a §1.3 | 新 squad 可查，成员名与 zip 一致（leader=manifest.leaderName + mates） |

## 断言面

**preview（硬编码合法 zip fixture）**
- 200 + `.importKey exists`
- `.manifest.name == "ts-import-src"` / `.leaderName == "ts-leader"` / `.slug == "ts-import-src-slug"` / `.builtin == false`
- `.manifest.members[] any .name == "ts-mate-a"` / `"ts-mate-b"`

**execute**
- 201 + `.squadId exists`
- `.created[] any . == "ts-mate-a"` / `"ts-mate-b"`（best-effort hire 成功）
- `.failed[] all . != "ts-mate-a"`（不误报失败）

**建队后可查**
- `GET /squad/{new_id}` → name == 用户填名；members 含 leader + 2 mates（与 zip 一致）

## 设计权衡（框架限制）

- **case 间无状态共享** + 导出响应二进制 decode → tc2 不能直接复用 tc1 的 zip；改用结构等价的硬编码合法 zip fixture（manifest + AGENTS.md + .rocky/agents/ + .rocky/skills，与导出格式一致）。真实「导出→导入→比对」往返由 ET 覆盖（test-plan §5）。
- **zip 内容 DEFLATE 不可见** → manifest 内容正确性由 preview 返回断言（黑盒往返验证）。
- **execute modelDefault**：无 `x-session-id` 头 → handler fallback 系统第一个 enabled provider 的第一个 enabled model（AT env 有全局 provider pool）。

## 不调 LLM

纯 HTTP（preview + execute + GET），全确定性。
