# v0.0.319 变更计划书 — 团队同步（导入导出团队配置）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 架构判断（已核实源码）

| 判断项 | 结论 | 核实依据 |
|--------|------|----------|
| 后端服务复用 | **高度复用** | `createSquadService`（squad-service.ts）、`createMemberService`（member-service.ts）、`applyTemplate`+`copyTemplateFiles`（squad-template-service.ts）全部可直接复用 |
| 新 API 形态 | **2 个新端点** | GET `/squad/:id/export` → zip 流下载；POST `/squad/import` → multipart zip 上传 → 建队 |
| zip 处理 | **adm-zip**（后端已有依赖） | 导出：读 squad 目录 → adm-zip 打包 → Response stream；导入：FormData 解析 → adm-zip 解包到临时目录 → 建队 → 清理 |
| 临时目录 | **os.tmpdir() + UUID 子目录** | 导出无临时目录（直接内存打包）；导入解包到 `os.tmpdir()/rocky-import-{ulid}`，用完 `rmSync(recursive:true)` 清理 |
| 路径安全 | **zip entry 校验** | 解包前遍历 zip entries，拒绝含 `..` 或绝对路径的 entry（防 path traversal） |
| manifest 类型 | **复用 ManifestSchema** | squad-template-service.ts 已定义 `ManifestSchema`，导出/导入直接复用 |
| copyTemplateFiles | **导出改为 export，函数需 export** | 当前 `copyTemplateFiles` 是 squad-template-service.ts 内部函数，导入侧需 export 复用 |
| 前端复用 | **NewSquadModal 参考 + 新 section** | 参考 v0.0.318 config_sync 范式，新增 team_sync tab + section-team-sync.tsx |

## 设计决策（D 编号）

### D1: 后端导出服务 — team-sync-export-service.ts

**文件**：`app/server/src/services/team-sync-export-service.ts`（新建）

**功能**：
- `buildManifest(squadDir, squadEntity): ManifestSchema`
  - 读 `members/*.json` → 逐个 JSON.parse → 提取 name/intro/role/skillConfig
  - role=leader → 提取到顶层 `leaderName`+`leaderIntro`，不放入 members[]
  - role=mate → 放入 members[]
  - squad 级元数据（name/description/slug）从 squadEntity 取
- `exportSquadToZip(squadDir, squadEntity): Promise<{buffer: Buffer, memberCount: number}>`
  - buildManifest → JSON.stringify → zip.addFile('manifest.json', ...)
  - AGENTS.md → zip.addFile（存在才加）
  - `.rocky/agents/{name}-{memberId}.md` → 读取 → 去 memberId → zip.addFile(`{name}.md`)
  - `.rocky/{skills,memory,templates,commands}/` → 递归遍历 → zip.addFile（相对路径）
  - `.rocky/settings.json` → zip.addFile
  - 排除：`members/`、`outputs/`、`reports/`、`states/`、`specs/`、`panorama/`、`images/`、`project` symlink
  - 返回 adm-zip toBuffer()

**路径安全（导出侧）**：
- 只读 squad 目录内的文件，不跟随 symlink（防读 squad 外文件）
- `lstatSync` 检测 symlink → skip

**约束**：MUST 排除 members/*.json 原文件；MUST agents 去 memberId 后缀；MUST NOT 加密；MUST NOT 读 symlink。

### D2: 后端导入服务 — team-sync-import-service.ts

**文件**：`app/server/src/services/team-sync-import-service.ts`（新建）

**功能**：
- `validateZipEntries(zip: AdmZip): void`
  - 遍历 zip.getEntries()，每个 entryName 校验：MUST NOT 含 `..`，MUST NOT 以 `/` 开头（绝对路径）
  - 违规 → throw Error('invalid zip entry: path traversal detected')
- `parseManifest(zip: AdmZip): ManifestSchema`
  - zip.getEntry('manifest.json') → 不存在 → throw
  - JSON.parse → 校验必填字段（slug/name/description/leaderName/members）
  - 返回 ManifestSchema
- `importSquadFromZip(zipBuffer, input: {name, modelDefault, modelDefaultProviderId?}, deps): Promise<ImportResult>`
  - new AdmZip(buffer) → validateZipEntries → parseManifest
  - 解包 zip 到 `os.tmpdir()/rocky-import-{ulid()}`（临时目录）
  - createSquadService({ name: input.name, description: manifest.description, modelDefault, modelDefaultProviderId, leader: { name: manifest.leaderName } })
  - 批量 createMemberService（mode=fresh，name/intro/skillConfig 从 manifest.members 取）
  - nameToId 映射收集（hire 成功的 member name → newMemberId）
  - **复用** `copyTemplateFiles(tmpDir, newSquadDir, nameToId)`（从 squad-template-service.ts export）
  - rmSync(tmpDir, { recursive: true, force: true })（finally 块确保清理）
  - 返回 `{ squadId, created: string[], failed: string[] }`

**临时目录处理**：
- `os.tmpdir() + path.join('rocky-import-' + ulid())`（避免冲突）
- `try { ... } finally { rmSync(tmpDir, { recursive: true, force: true }) }`（确保清理）

**best-effort hire**：
- manifest.members 逐个 createMemberService，失败记 failed 不中断
- copyTemplateFiles 已是 best-effort（内部 console.warn 不 throw）

**modelDefault 继承**：
- 调用方（handler）负责传 modelDefault
- 来源：当前 session 的 squadId → squadStore.getSquad → squad.modelDefault + modelDefaultProviderId
- fallback：无 squad → 系统第一个 enabled provider 的第一个 enabled model

**约束**：MUST 校验 zip entries 防 path traversal；MUST finally 清理临时目录；MUST 复用 copyTemplateFiles；MUST best-effort hire。

### D3: 后端 API handler — team-sync-handler.ts

**文件**：`app/server/src/handlers/team-sync-handler.ts`（新建）

**功能**：
- `handleTeamSyncExport(req, method, path, deps): Promise<Response | null>`
  - 路径匹配 `GET /squad/:id/export`
  - 解析 squadId → squadStore.getSquad → 不存在返 404
  - exportSquadToZip(squadDir, squad) → buffer
  - Response：`Content-Type: application/zip`，`Content-Disposition: attachment; filename="rocky_agent_team_{name}_{timestamp}.zip"`
  - body = buffer（直接返回二进制流）
- `handleTeamSyncImport(req, method, path, deps): Promise<Response | null>`
  - 路径匹配 `POST /squad/import`
  - 解析 multipart FormData → 提取 zip file buffer + name 字段
  - 获取 modelDefault：从当前 session squadId 继承（handler 从 deps 获取当前 squadId / squadStore）
  - importSquadFromZip(buffer, { name, modelDefault }, deps)
  - 成功 → 201 + `{ squadId, created, failed }`

**FormData 解析**：
- 后端无现成 multipart 解析（当前 API 都是 JSON body）
- 用 `req.formData()`（Web标准 Request.formData()，Node 18+ 原生支持）或 `req.arrayBuffer()` + 手动解析
- 简化方案：前端用 `FormData.append('file', blob)` + `FormData.append('name', teamName)` 发送

**路由注册**：
- 在 `squad-routes.ts` 的 `dispatchSquadRoutes` 中加两个分发分支：
  - `path.startsWith('/squad/') && /\/export$/.test(path)` → handleTeamSyncExport
  - `path === '/squad/import'` → handleTeamSyncImport
- **MUST 在 `/squad/:id` CRUD 之前匹配**（否则被 `/squad/:id` 吞掉）

**约束**：MUST 在 squad CRUD 之前匹配 export/import 路径；MUST 返回二进制 zip 流（非 JSON）；MUST Content-Disposition 带文件名。

### D4: copyTemplateFiles 导出 — squad-template-service.ts

**文件**：`app/server/src/services/squad-template-service.ts`（修改）

**变更**：
- `function copyTemplateFiles` → `export function copyTemplateFiles`
- 零逻辑变化（仅加 export 关键字）

**约束**：MUST NOT 改函数签名或逻辑；MUST ONLY 加 export。

### D5: 前端 TabId + tab 定义 — app-settings-config-defs.ts

**文件**：`app/web/src/components/app-dev-config-page/app-settings-config-defs.ts`（修改）

**变更**：
- `TabId` union 加 `'team_sync'`
- `APP_SETTINGS_TABS` 在 memory 后（config_sync 位置之后，318 合并后为 config_sync 后）插入 `{ id: 'team_sync', labelKey: 'tab.team_sync.label', groups: ['team_sync'], inSystemArea: false }`
- `TAB_KV_GROUPS` 加 `team_sync: []`（自渲染，不进 KV dirty）

**约束**：MUST 在用户设置区（非系统收起区）；位置标注「memory 之后、config_sync 之后」（318 合并前直接在 memory 后）。

### D6: 前端 section-tab-panel — 加 case 'team_sync'

**文件**：`app/web/src/components/app-dev-config-page/section-tab-panel.tsx`（修改）

**变更**：
- switch 加 `case 'team_sync': return <SectionTeamSync />`
- import SectionTeamSync

**约束**：MUST NOT 进 page-tab dirty / SaveBar（即时操作，同 config_sync）。

### D7: 前端团队同步页 — section-team-sync.tsx

**文件**：`app/web/src/components/app-dev-config-page/section-team-sync.tsx`（新建）

**功能**：
- 三态视图：`landing`（入口页）→ `export`（导出处理中）→ `import`（文件选择 → 预览 → 导入处理中）
- **landing 态**：
  - 显示当前团队名 + 成员数（从 useSquad 或 GET /squad/:id 获取）
  - 「导出团队」按钮 → GET `/squad/:id/export` → 浏览器下载 zip
  - 「导入团队」按钮 → 触发 `<input type="file" accept=".zip">`
- **export 流程**：
  - 点导出 → `window.location.href = '/api/squad/:id/export'`（或 `<a>` click）→ 浏览器自动下载
  - toast「导出成功」
- **import 流程**：
  - 文件选择 → FormData(file + 预览请求) → POST 到后端先解析 manifest → 返回 manifest 预览数据
  - 或：前端 JSZip 先解析 zip 预览（减少 API round-trip）
  - **方案选择**：后端预览更安全（zip 不在前端解包），加一个 POST `/squad/import/preview` 端点
  - 预览页：manifest 信息卡 + 团队名输入框（预填 manifest.name）+ 重名提示
  - 点导入 → ConfirmModal → POST `/squad/import`（FormData: file + name）→ toast + 导航到新团队

**简化决策**：**不加 preview 端点**。导入两步合一：前端选文件 → 直接 POST `/squad/import` with FormData(file) → 后端解包+解析 manifest + **返回 manifest 预览但不建队**（step=preview）→ 前端展示预览 → 用户确认 → POST `/squad/import` with FormData(file + name + step=confirm) → 后端建队。

**更简方案（选定）**：**一个 POST 两阶段**：
- POST `/squad/import` body=`FormData(file)` → 后端解包+校验 → 返回 `{ manifest: ManifestSchema, sessionId: string }`（sessionId 标识已解包的临时目录，存 server 端 Map）
- 前端拿到 manifest 展示预览 → 用户填 name + 确认 → POST `/squad/import` body=`FormData(sessionId, name)` → 后端按 sessionId 取临时目录建队

**最简方案（最终选定）**：**两次 POST，无状态**：
- POST `/squad/import?step=preview` body=`FormData(file)` → 后端解包到临时目录 → 校验 manifest → 返回 `{ manifest, importKey }`（importKey = 临时目录标识 = ulid）
- POST `/squad/import?step=execute` body=`FormData(importKey, name)` → 后端按 importKey 找到临时目录 → 建队 → 清理

**importKey → 临时目录映射**：server 端维护一个 `Map<string, string>`（importKey → tmpDir path），5 分钟 TTL 自动清理（setTimeout）。

**约束**：MUST 在 SectionTabPanel switch 加 case；MUST NOT 进 page-tab dirty；MUST 显示导入确认 modal；MUST 有重名检测（前端 listSquads 比对）。

---

## 文件级变更清单

| # | 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 预计影响行 |
|---|---------|---------|----------|------|---------|------|------|-----------|
| 1 | team-sync-export-service | `services/team-sync-export-service.ts` | `buildManifest` | 新增 | 读 members/*.json → 生成 ManifestSchema | MUST leader 提取到顶层 | D1 | ~45 |
| 2 | team-sync-export-service | `services/team-sync-export-service.ts` | `exportSquadToZip` | 新增 | 读 squad 目录 → adm-zip 打包 → buffer | MUST 排除 members/outputs/reports/states/specs/panorama/images/project | D1 | ~70 |
| 3 | team-sync-export-service | `services/team-sync-export-service.ts` | `stripMemberIdSuffix` | 新增 | agents/{name}-{memberId}.md → {name}.md | MUST 用正则去最后一个 -{ULID} | D1 | ~8 |
| 4 | team-sync-import-service | `services/team-sync-import-service.ts` | `validateZipEntries` | 新增 | 校验 zip entry 无 path traversal | MUST 拒绝 .. 和绝对路径 | D2 | ~15 |
| 5 | team-sync-import-service | `services/team-sync-import-service.ts` | `parseManifest` | 新增 | 从 zip 提取+校验 manifest | MUST 校验必填字段 | D2 | ~20 |
| 6 | team-sync-import-service | `services/team-sync-import-service.ts` | `unpackToTemp` | 新增 | 解包 zip 到 os.tmpdir() 临时目录 | MUST 返回 tmpDir 路径 | D2 | ~15 |
| 7 | team-sync-import-service | `services/team-sync-import-service.ts` | `importSquadFromTempDir` | 新增 | 从已解包临时目录建队 | MUST finally rmSync 清理 | D2 | ~50 |
| 8 | team-sync-import-service | `services/team-sync-import-service.ts` | `ImportKeyStore` | 新增 | Map<string, {tmpDir, createdAt}> + 5min TTL | MUST setTimeout 自动清理 | D2 | ~25 |
| 9 | team-sync-handler | `handlers/team-sync-handler.ts` | `handleTeamSyncExport` | 新增 | GET /squad/:id/export → zip 下载 | MUST 返回 application/zip | D3 | ~30 |
| 10 | team-sync-handler | `handlers/team-sync-handler.ts` | `handleTeamSyncImport` | 新增 | POST /squad/import?step=preview/execute | MUST 两次 POST 无状态 | D3 | ~55 |
| 11 | squad-template-service | `services/squad-template-service.ts` | `copyTemplateFiles` | 修改 | 加 export 关键字 | MUST NOT 改逻辑 | D4 | 1 |
| 12 | squad-routes | `routes/squad-routes.ts` | `dispatchSquadRoutes` | 修改 | 加 export/import 路径分发 | MUST 在 CRUD 之前匹配 | D3 | ~8 |
| 13 | app-settings-config-defs | `app-settings-config-defs.ts` | `TabId` | 修改 | 加 `'team_sync'` | MUST | D5 | 1 |
| 14 | app-settings-config-defs | `app-settings-config-defs.ts` | `APP_SETTINGS_TABS` | 修改 | 加 team_sync tab def | MUST 在 memory 之后 | D5 | 1 |
| 15 | app-settings-config-defs | `app-settings-config-defs.ts` | `TAB_KV_GROUPS` | 修改 | 加 `team_sync: []` | MUST 为空数组 | D5 | 1 |
| 16 | section-tab-panel | `section-tab-panel.tsx` | switch | 修改 | 加 `case 'team_sync'` | MUST NOT 进 dirty | D6 | 3 |
| 17 | section-team-sync | `section-team-sync.tsx` | `SectionTeamSync` | 新增 | 团队同步页（landing/export/import 三态） | MUST 自管 state | D7 | ~150 |
| 18 | squad-api | `lib/squad-api.ts` | `exportSquad` | 新增 | 触发 zip 下载（GET /squad/:id/export） | MUST 用 a[href] download | D7 | ~12 |
| 19 | squad-api | `lib/squad-api.ts` | `previewImport` | 新增 | POST /squad/import?step=preview | MUST 返 manifest | D7 | ~15 |
| 20 | squad-api | `lib/squad-api.ts` | `executeImport` | 新增 | POST /squad/import?step=execute | MUST 返 squadId | D7 | ~15 |
| 21 | i18n | `i18n/locales/*/app-dev-config.json` | tab.team_sync.label + 文案 | 新增 | zh-CN + en 双语 | MUST | D7 | ~15×2 |

---

## 导出完整流程（method 级）

```
handleTeamSyncExport(req, method, path, deps):
  squadId = parseFromPath(path)  // /squad/:id/export
  
  squad = squadStore.getSquad(squadId)
  if (!squad) return 404
  
  squadDir = squadRootDir(dataDir, squadId)
  
  // 1. 生成 manifest
  manifest = buildManifest(squadDir, squad)
    // 读 members/*.json → 逐个解析
    for each file in readdir(squadDir/members/):
      member = JSON.parse(readFile(file))
      if (member.role === 'leader'):
        manifest.leaderName = member.name
        manifest.leaderIntro = member.intro
      else:
        manifest.members.push({ name, intro, skillConfig })
    manifest.slug = squad.id  // 原 squadId 作 slug
    manifest.name = squad.name
    manifest.description = squad.description
    manifest.builtin = false
  
  // 2. 打包 zip
  zip = new AdmZip()
  zip.addFile('manifest.json', JSON.stringify(manifest, null, 2))
  
  // AGENTS.md（存在才加）
  if (exists(squadDir/AGENTS.md)):
    zip.addFile('AGENTS.md', readFile(squadDir/AGENTS.md))
  
  // .rocky/agents/ → 去 memberId
  if (exists(squadDir/.rocky/agents/)):
    for file in readdir(squadDir/.rocky/agents/):
      if (!file.endsWith('.md')) continue
      name = stripMemberIdSuffix(file)  // architect-01KZA...md → architect.md
      zip.addFile('.rocky/agents/' + name, readFile(file))
  
  // .rocky/{skills,memory,templates,commands}/ → 递归
  for sub in ['skills', 'memory', 'templates', 'commands']:
    srcPath = squadDir/.rocky/sub
    if (exists(srcPath)):
      addDirToZip(zip, srcPath, '.rocky/' + sub)
  
  // .rocky/settings.json
  if (exists(squadDir/.rocky/settings.json)):
    zip.addFile('.rocky/settings.json', readFile(squadDir/.rocky/settings.json))
  
  buffer = zip.toBuffer()
  
  // 3. 返回下载流
  filename = `rocky_agent_team_${squad.name}_${formatTimestamp()}.zip`
  return new Response(buffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
```

## 导入完整流程（method 级）

```
// ── Step 1: Preview（POST /squad/import?step=preview）──
handleTeamSyncImport(req, method, path, deps):
  formData = await req.formData()
  file = formData.get('file')  // File/Blob
  
  zipBuffer = Buffer.from(await file.arrayBuffer())
  zip = new AdmZip(zipBuffer)
  
  // 1. 安全校验
  validateZipEntries(zip)
  
  // 2. 解包到临时目录
  tmpDir = path.join(os.tmpdir(), 'rocky-import-' + ulid())
  zip.extractAllTo(tmpDir, true)  // overwrite=true
  
  // 3. 校验 manifest（tmpDir 下找 manifest.json，可能在子目录）
  manifest = parseManifestFromDir(tmpDir)
  
  // 4. 注册 importKey
  importKey = ulid()
  importKeyStore.set(importKey, { tmpDir, manifest, createdAt: Date.now() })
  
  // 5. 返回预览
  return json(200, { importKey, manifest })

// ── Step 2: Execute（POST /squad/import?step=execute）──
handleTeamSyncImport(req, method, path, deps):
  formData = await req.formData()
  importKey = formData.get('importKey')
  name = formData.get('name')
  
  entry = importKeyStore.get(importKey)
  if (!entry) return 400 'import session expired'
  
  // 1. 获取 modelDefault（从当前 session 的 squad 继承）
  modelDefault = resolveModelDefault(deps)  // 当前 squad → fallback 系统默认
  
  // 2. 建队
  result = await importSquadFromTempDir(entry.tmpDir, entry.manifest, { name, modelDefault }, deps)
  
  // 3. 清理
  importKeyStore.delete(importKey)
  rmSync(entry.tmpDir, { recursive: true, force: true })
  
  return json(201, result)

// ── importSquadFromTempDir ──
async function importSquadFromTempDir(tmpDir, manifest, input, deps):
  // tmpDir 下有 {squadName}/ 子目录或直接是扁平结构
  srcDir = resolveSrcDir(tmpDir)  // 找含 manifest.json 的目录
  
  // 1. createSquadService
  { squad, leaderMember } = await createSquadService(deps, {
    name: input.name,
    description: manifest.description,
    modelDefault: input.modelDefault,
    ...(input.modelDefaultProviderId ? { modelDefaultProviderId } : {}),
    leader: { name: manifest.leaderName },
  })
  
  // 2. 批量 hire members
  nameToId = new Map()
  created = [], failed = []
  for spec of manifest.members:
    try:
      { member } = await createMemberService(deps, {
        squadId: squad.id,
        mode: 'fresh',
        name: spec.name,
        intro: spec.intro,
        skillConfig: spec.skillConfig,
      })
      nameToId.set(spec.name, member.id)
      created.push(spec.name)
    catch:
      failed.push(spec.name)
  
  // 3. 复制配置文件（复用 copyTemplateFiles）
  destDir = squadRootDir(deps.dataDir, squad.id)
  copyTemplateFiles(srcDir, destDir, nameToId)
  
  return { squadId: squad.id, created, failed }
```

## 范式归属

| 控件/操作 | 范式 | 理由 |
|-----------|------|------|
| 团队同步 tab 整体 | **独立操作页**（非 A/B/C 配置范式） | 导入导出是即时操作，不走 SaveBar/dirty |
| 导出操作 | 即时操作 | 点导出 → 下载 zip → 完成 |
| 导入操作 | 两阶段即时操作 | preview → 填名 → confirm → 建队 |

## 路径安全（MANDATORY）

### zip entry 校验（导入侧）
```ts
function validateZipEntries(zip: AdmZip): void {
  for (const entry of zip.getEntries()) {
    const name = entry.entryName;
    // 拒绝绝对路径
    if (name.startsWith('/')) throw new Error(`unsafe entry: ${name}`);
    // 拒绝 .. 遍历
    if (name.includes('..')) throw new Error(`unsafe entry: ${name}`);
    // 拒绝盘符（Windows）
    if (/^[A-Za-z]:/.test(name)) throw new Error(`unsafe entry: ${name}`);
  }
}
```

### symlink 防护（导出侧）
```ts
// 读取文件前检查 lstat
const stat = lstatSync(filePath);
if (stat.isSymbolicLink()) continue;  // skip symlinks
```

## 风险点

1. **importKeyStore 内存泄漏**：如果用户 preview 后不 execute（关闭浏览器），临时目录不清理。5 分钟 TTL setTimeout 兜底，但 server 重启则丢失（可接受——tmpdir 会被 OS 清理）。
2. **大量 members hire 慢**：20+ members 时逐个 createMemberService（每个建 session + member record）。可加进度提示，但本版本不要求。
3. **FormData 解析兼容性**：Node 18+ 的 `req.formData()` 支持 multipart，但性能不如 busboy。当前流量下可接受。
4. **manifest.json 在 zip 子目录**：导出时 zip 根目录是 `{squadName}/`，manifest 在 `{squadName}/manifest.json`。导入解析需先找含 manifest.json 的目录（可能是一层子目录）。
5. **agents 文件 memberId 后缀格式**：`{name}-{ULID}.md`，ULID 是 26 字符固定长度。stripMemberIdSuffix 需正则 `/-[0-9A-HJKMNP-TV-Z]{26}\.md$/` 精确匹配。

## 后端改动摘要

**新增 3 文件 + 修改 3 文件**：
- 新增：team-sync-export-service.ts、team-sync-import-service.ts、team-sync-handler.ts
- 修改：squad-template-service.ts（export copyTemplateFiles）、squad-routes.ts（加路由分发）、app-settings-config-defs.ts（加 tab）
