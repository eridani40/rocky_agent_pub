# team_sync_import_invalid_tc3 — 非 zip 文件 → preview 400

## 覆盖契约

| 端点 | spec | 验证点 |
|------|------|--------|
| `POST /squad/import?step=preview` | change_plan.md D2+D3（v0.0.319） | 非 zip 文件（text）→ 400 + 可读错误（AdmZip 构造失败 → InvalidZipError → handler 400） |

## 断言面

- preview 上传纯文本文件（`content_type: text/plain`，非 zip 魔数）→ `400`
- `.error exists`（可读错误文案）

## 设计权衡

- 断言 400 + error 存在，不绑定具体文案（多语言可读错误文案由 UT `team-sync-handler.test.ts` 覆盖；handler 对 InvalidZipError 返回 `{error: message}`）。

## 不调 LLM

纯 HTTP 错误路径，全确定性。
