# member_rename_envelope_tc2 — 改名信封 bug A+B 修复（写时全同步 + 读单一源）

## 覆盖契约

| 端点 | spec | 验证点 |
|------|------|--------|
| `POST /squad` | 11a §1.1 | 建队事务；响应 `201 toDetail` 含 `members[0].sessionId`（leader session） |
| `POST /squad/:id/member` | 11a §2.1 | hire fresh mate → `201 {member, sessionId}`；mate session 初始 `title == name` |
| `GET /session/:id` | 04 §2.3 | mate session 初始 title == 成员名（titled=false baseline） |
| `PATCH /squad/:id/member/:mid` | 11a §2.2（v0.0.340 修订） | 改名 → `200 {member.name == 新名}`；**同步关联 session.title**（方案 A 写时全同步，titled=false 才同步） |
| `GET /session/:id` | 04 §2.3 | 改名后 mate session `title == 新名`（写时同步生效） |
| `GET /squad/:id` | 11a §1.3 | roster `members[] any .name == 新名` |
| `POST /session/:id/messages` | 04 §3.2 | 驱动 leader 真调 send_message 工具（target=mate_sid 字符串，prod 主路径） |
| `GET /session/:id/messages` | 04 §3.3 | leader transcript `tool_result` 信封 `targetName == 新名`（方案 B 读单一源） |

## 断言面

**方案 A — 写时全同步（确定性，纯 HTTP）**
- `PATCH /squad/{id}/member/{mid}` body `{name: "zz-renamed-mate"}` → `.member.name == "zz-renamed-mate"`（memberStore 新名）
- `GET /session/{mate_sid}` → `.title == "zz-renamed-mate"`（session.title 同步；hire 时 titled=false，patch 同步 gate 命中）
- `GET /squad/{id}` → `.members[] any .name == "zz-renamed-mate"`（roster 实时权威）

**方案 B — 读单一源（真调 LLM，send_message 信封）**
- leader 发消息驱动调 send_message（target=mate_sid 字符串）→ poll leader transcript
- `until: .items[] any .content[type=tool_result].content[type=text].text ~= "targetName"`
- check：tool_result text 同时含 `"targetName"` 键 + `"zz-renamed-mate"` 值（send_message 返回 `textResult(JSON{messageId, targetName})`；resolveTargetDisplayName 反查 memberStore → 新名，非旧 session.title）

## 设计权衡

- **target 用 mate_sid 字符串**：对齐 prod 283/293 条 string target 主路径（96.6%）；resolveTargetDisplayName 对 string target 走 `getSession(targetSid) → squadId+memberId → memberStore 反查` → 命中改名后的新名
- **唯一名 `zz-renamed-mate`**：LLM 回复正文不会出现该串，双断言（targetName 键 + 新名值）防误匹配
- **POST /messages 不传 providerId/modelId**：v0.0.158 已删 body override（静默忽略）；leader 走 studio 链 `session → squad.modelDefault=MiniMax-M3` 兜底（model-resolver buildFallbackChain）
- **check RHS 不插值**：`.id == "{squad_id}"` 会拿 ULID 与字面量比永远 fail → 用 `exists`（框架惯例）
- **真调 LLM 不确定性**：leader 若无 send_message 工具/LLM 不调 → poll 超时 fail（同 agent_spawn_async_reply 先例接受度）；429/529/503 框架层自动 skip

## 前置依赖

- v0.0.340 `patchMemberService` 改名同步 session.title（titled=false gate）已实现
- `send-message-tool.ts` resolveTargetDisplayName 反查 memberStore（决策 1 读单一源）已实现
- 修复前行为：PATCH 只改 memberStore、不碰 session.title → tool_result targetName 反查 memberStore 旧名？不——修复前 targetName 用 session.title fallback = 旧名 → 本 case 断言新名即暴露 bug
