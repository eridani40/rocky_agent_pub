# Team Sync 端点契约（v0.0.319 — 11a-squad-endpoints.md 姊妹文件）

> version: 1.0 · 引入版本 v0.0.319
> 管什么：团队同步（导入导出团队配置）的**完整端点契约**——`GET /squad/:id/export` 导出 zip 下载流 + `POST /squad/import?step=preview|execute` 两阶段导入建队。
> 不管什么：squad/member CRUD 与 hire（→ `11a-squad-endpoints.md` §1/§2）；zip 数据结构细节（→ `specs/prd/v0.0.319-team-sync.md` §3）；导入建队机制（→ `specs/tech/version_logs/v0.0.319/change_plan.md` D1-D3）。
> **本文件是 AT（API Test）team-sync 端点的唯一依据**：api-verifier 黑盒 curl，不读代码。
>
> **权威概念源**：`specs/tech/version_logs/v0.0.319/change_plan.md` + `specs/prd/v0.0.319-team-sync.md`。

> **路由顺序（MANDATORY）**：`squad-routes.ts` 的 `dispatchSquadRoutes` 中 export/import 分发 **MUST 在 `/squad/:id` CRUD 之前匹配**（`/squad/import` 会被 CRUD 当 squadId='import' 吞掉；`/squad/:id/export` 同理）。

## 1. `GET /squad/:id/export` — 导出团队 zip 下载（v0.0.319 新增）

| 方法 | 路径 | 语义 | 成功响应 |
|------|------|------|---------|
| `GET` | `/squad/:id/export` | 导出 squad 配置为 zip 二进制下载流 | `200` + `application/zip` + `Content-Disposition` |

**响应**：
- `Content-Type: application/zip`
- `Content-Disposition`：`attachment; filename="rocky_agent_team_{asciiName}_{YYYYMMDD_HHmmss}.zip"`；**非 ASCII 团队名（中文）追加 RFC 5987 `filename*`**（`filename*=UTF-8''{encodeURIComponent(name)}`），HTTP header 仅允许 ASCII，中文走 filename* 编码（coder2 汇报偏离 → leader 裁决接受，见 `specs/tech/version_logs/v0.0.319/change_log.md`）
- body = zip 二进制流（非 JSON）

**zip 内容**（白名单，天然排除运行时/产物）：
- `manifest.json`（从 `members/*.json` 生成：leader 提顶层 `leaderName`/`leaderIntro`，mate 入 `members[]`；slug/name/description 从 squadEntity 取；builtin 固定 false）
- `AGENTS.md`（存在才加）
- `.rocky/agents/{name}.md`（`{name}-{memberId}.md` → 去 memberId 后缀；**[v0.0.321] leader 实名特例**：`{leaderName}-{memberId}.md` 经 `restoreAgentFileName` 还原为模板 key `leader.md`，旧 `leader-{id}.md` 走 strip 兼容）
- `.rocky/{skills,memory,templates,commands}/`（递归）
- `.rocky/settings.json`（存在才加）
- **排除**：`members/*.json` 原文件、`outputs/`、`reports/`、`states/`、`specs/`、`panorama/`、`images/`、`project` symlink
- **symlink 防护（导出侧）**：`lstatSync` 检测 symlink → skip（不跟随，防读 squad 外文件）

**错误**：`404` squad 不存在（`{error:'squad not found'}`）；`500` 导出失败（如「团队数据异常：无成员记录」——members/*.json 缺失或为空）。

## 2. `POST /squad/import?step=preview` — 导入预览（解包校验，v0.0.319 新增）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/squad/import?step=preview` | 解包 zip → 安全校验 → 解析 manifest → 登记 importKey（5min TTL）→ 返预览 | `FormData(file)` | `200` + `{ importKey, manifest }` |

**请求**：`multipart/form-data`，字段 `file` = zip 文件（Blob）。

**行为**：
1. `req.formData()` 取 `file`（缺失/非 Blob → 400 `file field required`；formData 解析失败 → 400「请选择有效的团队导出文件（.zip）」）
2. `unpackToTemp`：new AdmZip → `validateZipEntries`（**路径安全 MANDATORY**：entry 名含 `/` 开头（绝对路径）、`..`、Windows 盘符 `C:` → throw `InvalidZipError`）→ 解包到 `os.tmpdir()/rocky-import-{ulid}`（解包失败 → 400「文件已损坏，无法解压」）
3. `parseManifestFromDir`：找 `manifest.json`（zip 根或一层子目录兜底）→ JSON.parse + 校验必填字段（slug/name/description/leaderName/members[]，缺 → 400「文件格式不正确：manifest 缺少 {字段}」；members 非数组 → 400「manifest 结构无效」；JSON 损坏 → 400「manifest.json 无法解析」）
4. 登记 `importKey = ulid()` → `ImportKeyStore.set({ tmpDir, manifest, srcDir })`（5min TTL setTimeout 兜底清理；`timer.unref()` 不阻塞进程退出）
5. 返 `200 + { importKey, manifest }`；校验失败 → rmSync 临时目录后返 400

```typescript
interface ImportPreviewResponse {
  importKey: string;      // 5min TTL；execute 阶段消费
  manifest: ManifestSchema;
}
interface ManifestSchema {
  slug: string;           // 原团队 slug（导入时忽略，新 squad 用新 id）
  name: string;           // 原团队名（预填导入页，用户可改）
  description: string;
  leaderName: string;     // leader 名（直接复用）
  leaderIntro?: string;
  builtin: boolean;       // 固定 false
  members: MemberSpec[];  // 非 leader 成员
}
interface MemberSpec {
  name: string;
  intro: string;
  skillConfig: { mode: 'inherit'; overrides: Record<string, boolean> };
}
```

**错误**：`400` InvalidZipError（path traversal / manifest 缺失 / 结构不合法，带可读中文 message）；`400` 无 file 字段 / formData 解析失败 / 解压失败。

## 3. `POST /squad/import?step=execute` — 导入建队（v0.0.319 新增）

| 方法 | 路径 | 语义 | 请求体 | 成功响应 |
|------|------|------|--------|---------|
| `POST` | `/squad/import?step=execute` | 按 importKey 取临时目录 → createSquadService + 批量 hire + copyTemplateFiles → 清理 | `FormData(importKey, name)` | `201` + `{ squadId, created, failed }` |

**请求**：`multipart/form-data`，字段 `importKey`（必填）+ `name`（必填，trim 后非空；缺失 → 400 `importKey required` / `name required`）。

**行为**：
1. `importKeyStore.take(importKey)`（**原子消费**：取出即从 Map 删除 + 清 TTL timer，防重复 execute；不存在/过期 → 400 `import session expired`）
2. `resolveModelDefaultAsync`：请求头 `x-session-id` → 当前 session 的 squad → 继承其 modelDefault(+providerId)；fallback 系统第一个 enabled provider 的第一个 enabled model；均取不到 → 400「默认模型无效，请先配置模型 provider」（并清理临时目录）
3. `importSquadFromTempDir`（**程序化建队，MANDATORY**）：
   - `createSquadService({ name: 用户填名, description: manifest.description, modelDefault, modelDefaultProviderId?, leader: { name: manifest.leaderName } })`（建 squad 事务：leader member + session + squadChat + 目录骨架）
   - 遍历 `manifest.members` → `createMemberService(mode='fresh', name/intro/skillConfig)` **best-effort**：失败记 `failed` 不中断（如新 squad 内 manifest 自身重名 member）
   - `copyTemplateFiles(srcDir, newSquadDir, nameToId)`（复用 squad-template-service；AGENTS.md 覆盖 / agents 改名关联新 memberId / skills·memory·templates·commands merge / settings.json 仅不存在才复制；内部 best-effort）
4. `finally` rmSync 临时目录（**MANDATORY**，即使建队失败也清理）
5. 返 `201 + { squadId, created: string[], failed: string[] }`

```typescript
interface ImportExecuteResponse {
  squadId: string;        // 新 squad id
  created: string[];      // 成功 hire 的 member name 列表
  failed: string[];       // 失败跳过（best-effort）的 member name 列表
}
```

**modelDefault 继承**（PRD §5.5）：当前 session 有 squad → 用当前 squad 的 modelDefault；无 → 系统默认 model；继承的 modelDefault 在目标机器无效 → 400「默认模型无效」。

**错误**：`400` importKey/name 缺失、importKey 过期（`import session expired`）、默认模型无效；`500` 建队失败（createSquadService 异常，已清理临时目录）。

## 4. 错误汇总

| 错误场景 | 状态码 | message |
|----------|--------|---------|
| zip entry path traversal（`/` 开头 / `..` / 盘符） | 400 | `invalid zip entry: path traversal detected ({name})`（InvalidZipError） |
| 非 zip 文件 / formData 解析失败 | 400 | `请选择有效的团队导出文件（.zip）` |
| zip 损坏（截断/篡改） | 400 | `文件已损坏，无法解压` |
| 缺 manifest.json | 400 | `文件格式不正确：缺少 manifest.json` |
| manifest JSON 语法错误 | 400 | `文件已损坏：manifest.json 无法解析` |
| manifest 缺必填字段 | 400 | `文件格式不正确：manifest 缺少 {字段名}` |
| manifest.members 非数组 | 400 | `文件格式不正确：manifest 结构无效（members 非数组）` |
| importKey 缺失 | 400 | `importKey required` |
| name 缺失 | 400 | `name required` |
| importKey 过期/不存在 | 400 | `import session expired` |
| modelDefault 无效 | 400 | `默认模型无效，请先配置模型 provider` |
| squad 不存在（导出） | 404 | `squad not found` |
| 导出失败（无成员记录） | 500 | `团队数据异常：无成员记录` |
