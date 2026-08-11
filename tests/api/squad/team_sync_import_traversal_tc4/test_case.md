# team_sync_import_traversal_tc4 — 恶意 zip（../ 路径遍历）→ preview 400

## 覆盖契约

| 端点 | spec | 验证点 |
|------|------|--------|
| `POST /squad/import?step=preview` | change_plan.md D2 路径安全（MANDATORY） | 含 `../` entry 的恶意 zip → preview 400 + path traversal 错误（validateZipEntries 生效） |

## 断言面

- preview 上传含 `../evil.txt` entry 的 zip → `400`
- `.error exists` + `.error ~= ".."`（traversal 线索；handler 透传 InvalidZipError.message 必含 entry 名）

## 设计说明

- 恶意 zip fixture：`zipfile.writestr('../evil.txt', 'evil')` → entryName = `../evil.txt`
- `validateZipEntries` 在解包前遍历 entries 拦截（`name.includes('..')`）→ `InvalidZipError('invalid zip entry: path traversal detected (../evil.txt)')` → handler 400
- 绝对路径 `/etc/passwd` 与 Windows 盘符 `C:` 同样被该函数拦截（同一分支），UT 覆盖三种变体；AT 取 `../` 代表性变体（test-plan tc4 指定）

## 不调 LLM

纯 HTTP 安全路径，全确定性。
