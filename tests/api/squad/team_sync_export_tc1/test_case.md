# team_sync_export_tc1 — 导出成功（GET /squad/:id/export → zip 下载流）

## 覆盖契约

| 端点 | spec | 验证点 |
|------|------|--------|
| `GET /squad/:id/export` | change_plan.md D1+D3（v0.0.319） | 200 + zip 魔数 `PK`；zip 含 `manifest.json` + `AGENTS.md` + `.rocky/` 全套（agents 去 memberId / skills / memory / settings.json）；**排除** `members/` `outputs/` `reports/` `states/` `specs/` `panorama/` `images/` `project` |
| `POST /squad` + `POST /squad/:id/member` | 11a §1.1 + §2.1 | setup 建源 squad + hire 2 mates（导出数据源） |

## 断言面

**成功（zip 魔数）**
- `GET /squad/{id}/export` → 200，body 以 `PK` 开头（zip 魔数；AT 框架不返回 headers，content-type/content-disposition 由 UT `team-sync-handler.test.ts` 断言）

**内容包含（entry 名明文可见）**
- `manifest.json` / `AGENTS.md`（setup 植入）存在
- `.rocky/agents/ts-leader.md` / `ts-mate-a.md` / `ts-mate-b.md` 存在，且 **无 memberId 后缀**（植入 `{name}-{ULID}.md`，导出后应 strip 为 `{name}.md`，断言 `!~= "01KZA6D535N86AM008T34N1B82"`）
- `.rocky/skills/ts-skill.md` / `.rocky/memory/ts-memory.md` / `.rocky/settings.json` 存在

**排除（断言不打包）**
- `members/` `outputs/` `reports/` `states/` `specs/` `panorama/` `images/` `project` 均 `!~=`（不出现）

## 设计权衡（框架限制）

- **headers 不可断言**：`http_request` 不返回 headers → content-type/content-disposition 交给 UT。
- **DEFLATE 内容不可见**：adm-zip 默认 DEFLATE，entry 名明文但内容压缩 → manifest 内容正确性由 tc2 preview 往返验证。
- **新建 squad 骨架无 AGENTS.md/.rocky 文件** → setup 用 files 原语植入 fixture 再导出。
- **fresh hire 不写 .rocky/agents/** → 植入 `{name}-{ULID}.md` 验证去后缀契约。

## 不调 LLM

纯 HTTP（建队 + hire + GET 导出），全确定性，无 429/flaky 风险。
