# Skill 管理 HTTP API（v0.0.21 — skill 端点域）

> version: 1.1 · 引入版本 v0.0.21 · 2026-07-26 · **[v0.0.205.t2_cons]** §3 `GET /skill` 加 query `?sessionId=`（按 session record 解析 workspace + group 层，与 `?workspace=` 并存时 sessionId 优先，session not found→404）+ `SkillEntry.scope` 值域 `'squad'`→`'group'`（破坏性值变更，group=squad/classroom 团队 ws `.rocky/skills/`，原 `.rocky_squad/skills/` 废止）——chat 悬浮菜单 skills 入口数据源。详 `specs/api/version_logs/v0.0.205.t2_cons/change_log.md`。**[v0.0.113 doc-fix]** §3.2 GET /skill 列表 `SkillEntry.scope` 从「双层 app|workspace」订正为**三层 builtin|app|workspace**（对齐 `SkillScope`/v0.0.33.3 builtin 层；member skills overlay 分层基础）
> 管什么：v0.0.21 skill 管理 page 后端的 HTTP 端点契约（路径 / 方法 / 请求 / 响应 / 错误）—— install / list / toggle / delete / preview(tree+file)。
> 不管什么：skill 读工具（agent tool，见 `specs/tech/agent/skills/[P0]skill_tool.md`，非 HTTP）；system prompt skills mapper 注入（见 `specs/tech/agent/context/[P0]system_prompt.md` §4）；渲染层 UI（→ `specs/ui/`）。
> **本文件是 AT（API Test）skill 域的唯一依据**：api-verifier 黑盒 curl，不读代码。
> 技术架构：`specs/tech/agent/skills/[P0]skill_architecture.md`。

## 1. 概述

skill 管理 = 5 个端点，全部**非流式**（JSON 请求/响应，无 SSE）。skill 用 `name`（kebab-case）作主标识；同名冲突（app 级 + workspace 级都有）时用 `scope` 区分。

**双层 scope**（对齐 `[P0]skill_definition.md` §4）：
- `app`：`<dataDir>/skills/<name>/`（全局，所有 workspace 共享）
- `workspace`：`<workspace>/.rocky/skills/<name>/`（当前 workspace 专属）

**workspace 参数**：list/patch/delete/tree/file 端点接受 query param `?workspace=<absPath>` 指定当前 workspace。缺省 = 只扫/操作 app 级。

**enabled 默认**：新装 skill 默认 enabled（`app_config.skill_state` group 无 record → fallback true）。

**标识决策**：`name`（kebab-case，与 frontmatter 一致）+ `scope`（app|workspace）复合定位。install 不返回独立 id（name 即 id，scope 决定层）。同名跨层共存合法（workspace 覆盖 app 仅在 agent 可见性合并时生效；管理 API 显式按 scope 操作）。

## 2. `POST /skill/install`（安装 skill）

multipart 上传 file/folder/zip/.skill → 后端解压 + 校验 + 落盘 + 扫描 → 返回元数据。

### 2.1 请求

- Content-Type: `multipart/form-data`
- 表单字段：

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `files` | File（1 或多个） | 是 | 上传文件。**每个 part 的 `filename` = 相对 skill 根的路径**（webkitRelativePath 约定，如 `my-skill/SKILL.md`、`my-skill/docs/guide.md`）。后端按 filename 重建目录树。**兼容字段名 `file`**（旧 run.sh）；兼容旧约定：filename 仅基名时读表单字段 `relativePath` 或 `relativePath_<basename>` 取相对路径。 |
| `scope` | string | 否 | `app`（默认）\| `workspace` |
| `workspace` | string | `scope=workspace` 时必需 | workspace 绝对路径 |

**格式识别（决策1）**：单 part `.zip`/`.skill` → adm-zip 解压；单 part `.md` → 直接放置为 SKILL.md；多 part（folder）→ 按 filename 重建目录树。统一一个 handler（不拆 3 端点）。

### 2.2 响应

- `202 Accepted` · `{ "skill": SkillEntry }`

```json
{
  "skill": {
    "name": "my-skill",
    "description": "When user asks about X, use this skill.",
    "scope": "app",
    "skillDir": "/home/u/.rocky_agent_dev/skills/my-skill",
    "enabled": true,
    "source": "user",
    "productionMethod": "download",
    "mutable": false
  }
}
```

### 2.3 错误

| HTTP | 触发 | 响应体 |
|------|------|--------|
| `400` | multipart 缺 file；解压失败；无 SKILL.md；frontmatter 缺 name；name 非 kebab-case / >64 字符 | `{ "error": "<原因>" }` |
| `404` | scope=workspace 但 workspace 路径不存在/非目录 | `{ "error": "workspace not found" }` |
| `409` | 目标 scope 同名 skill 已存在（不自动覆盖） | `{ "error": "skill already exists", "name": "...", "scope": "..." }` |
| `413` | 解压后体积超限（如 >50MB） | `{ "error": "skill too large" }` |

## 3. `GET /skill`（列表）

### 3.1 请求

- query：`?workspace=<absPath>`（可选；提供则同时扫 workspace 级）
- query：**`?sessionId=<sid>`**（可选，**[v0.0.205.t2_cons] 新增**；提供则按 session record 解析 workspace=session.workspaceDir + group 层（session.squadId / session.classroomId → group ws `.rocky/skills/`），与 `?workspace=` 并存时 **sessionId 优先**；session not found → `404`）——chat 悬浮菜单 skills 入口数据源，前端免组装 session 字段。

### 3.2 响应

- `200` · `{ "items": SkillEntry[] }`

**四层**合并去重（group → workspace → app → builtin fallback，对齐 resolver 语义；**[v0.0.33.3]** 加 builtin 层——随 app 发版的内置 skill okf-skill/teamwork-leader/teamwork-mate 也在列表内；**[v0.0.205.t2_cons]** squad 层改名 **group 层** + 路径 `.rocky_squad/skills/` → `.rocky/skills/`）；每项含 enabled 状态。`SkillEntry.scope` 值域 = `'builtin' | 'app' | 'workspace' | 'group'`（后端 `SkillScope`，`skills/types.ts`；**[v0.0.205.t2_cons]** `'squad'` 改名 `'group'`——破坏性值变更，前端按 scope 分组逻辑需同步）。

```json
{
  "items": [
    { "name": "a-skill", "description": "...", "scope": "workspace", "skillDir": "/ws/.rocky/skills/a-skill", "enabled": true },
    { "name": "team-skill", "description": "...", "scope": "group", "skillDir": "/dataDir/squads/<sid>/.rocky/skills/team-skill", "enabled": true },
    { "name": "b-skill", "description": "...", "scope": "app", "skillDir": "/dataDir/skills/b-skill", "enabled": false },
    { "name": "okf-skill", "description": "...", "scope": "builtin", "skillDir": "/app/resources/skills/okf-skill", "enabled": true }
  ]
}
```

> 注：列表的「scope」反映合并后命中层（group > workspace > app > builtin）；如需看全量原始（含被覆盖的下层同名），用 `?raw=1`（P1+，本期不实现）。
> **install scope 仍双层**（`POST /skill` 的 `scope` 参数 = `app|workspace`，§2）——不能装到 builtin（app 发版只读层）也不能装到 group（团队 ws 资产走文件管理）；但**列表/toggle 的 SkillEntry.scope 含 builtin/group 四层**。这是 v0.0.113 成员 skills overlay 的 catalog 分层基础（`specs/tech/squad/[P1]session_config_studio.md §3.2`：builtin/app 层受 overlay 治理，workspace/group 恒生效）。

## 4. `PATCH /skill/:name`（toggle enabled）

### 4.1 请求

- path：`:name` = skill name（kebab-case）
- body：`{ "enabled": boolean, "scope"?: "app"|"workspace", "workspace"?: string }`
  - `scope` 缺省 = 合并层命中（workspace 优先）；显式指定则操作该层
  - `workspace`：scope=workspace 时必需

### 4.2 响应

- `200` · `{ "skill": SkillEntry }`（enabled 已更新）

### 4.3 错误

| HTTP | 触发 | 响应体 |
|------|------|--------|
| `400` | body 缺 enabled / 类型错 | `{ "error": "..." }` |
| `404` | name 在指定/合并层不存在 | `{ "error": "Not Found" }` |

## 5. `DELETE /skill/:name`（物理删除）

### 5.1 请求

- path：`:name`
- query：`?scope=app|workspace`（缺省 = 合并层命中）+ `?workspace=<absPath>`（scope=workspace 时）
- **删除语义**：目录 mv 到 `<dataDir>/soft_deleted/skills/<scope>/<name>-<ts>/`（项目约定：rm 需审批会中断自动化，故用 mv 而非 fs.rm；API 语义对前端仍是"删除后不可见"）。前端确认后调本端点。

### 5.2 响应

- `200` · `{ "ok": true }`

### 5.3 错误

| HTTP | 触发 | 响应体 |
|------|------|--------|
| `404` | name 不存在 | `{ "error": "Not Found" }` |

## 6. `GET /skill/:name/tree`（预览：文件树）

### 6.1 请求

- path：`:name`
- query：`?workspace=<absPath>`（可选）

### 6.2 响应

- `200` · `{ "tree": SkillFileNode[] }`

```typescript
interface SkillFileNode {
  name: string;       // 文件/目录名
  path: string;       // 相对 skillDir 的路径（防泄漏绝对路径）
  type: 'file' | 'dir';
  size?: number;      // file 字节数
}
```

```json
{
  "tree": [
    { "name": "SKILL.md", "path": "SKILL.md", "type": "file", "size": 1234 },
    { "name": "references", "path": "references", "type": "dir" },
    { "name": "guide.md", "path": "references/guide.md", "type": "file", "size": 5678 }
  ]
}
```

### 6.3 错误

| HTTP | 触发 | 响应体 |
|------|------|--------|
| `404` | name 不存在 | `{ "error": "Not Found" }` |

## 7. `GET /skill/:name/file`（预览：单文件内容）

### 7.1 请求

- path：`:name`
- query：`?path=<relativePath>`（相对 skillDir；必填）+ `?workspace=<absPath>`（可选）

### 7.2 响应

- `200` · `{ "path": "...", "content": string, "truncated": boolean, "binary": boolean }`
  - 文本文件：content = 文件内容（>256KB 截断 + truncated=true）
  - 二进制文件（图片等）：content 空，binary=true（前端显示「二进制文件不可预览」）

### 7.3 错误

| HTTP | 触发 | 响应体 |
|------|------|--------|
| `400` | 缺 path；path 越界（resolve 后非 startsWith skillDir） | `{ "error": "invalid path" }` |
| `404` | name 或文件不存在 | `{ "error": "Not Found" }` |

> **[v0.0.214] 实现注（对外契约未变）**：本端点的读原语（路径越界守卫 + 二进制识别 + 256KB 截断）已抽出为 `app/server/src/skills/file-io.ts`（`readSkillFile` / `writeSkillFile` / `resolveInsideDir` / `isBinaryBuffer`），由本端点与 academy 版本 skill 文件端点（`18-academy.md §1.11`）**共用同一原语** —— 两处响应 shape 因此一致，前端可共用解析。`handlers/skill.ts handleFile` 只保留 skill 目录定位（`locateSkillDir` / `lookupScope`）+ error→HTTP 映射。

## 8. 数据模型

### SkillEntry（列表/安装/toggle 响应共用）

```typescript
interface SkillEntry {
  name: string;                  // kebab-case，= 目录名 = frontmatter name
  description: string;           // frontmatter description
  /** 命中层（四层合并高层胜出：group > workspace > app > builtin） */
  scope: 'builtin' | 'app' | 'workspace' | 'group';
  skillDir: string;              // 绝对路径
  enabled: boolean;              // app_config.skill_state 持久化，fallback true
  // —— 治理字段（单维度 evolvable；PATCH /skill/:name/governance 读写 frontmatter evolvable）——
  source?: 'user' | 'agent';
  productionMethod?: 'handwritten' | 'consolidation' | 'download';
  /** 是否允许 agent 自进化（false/缺省 → skill_manage 写类 action REJECT） */
  evolvable?: boolean;
  /** 更新时间（ISO 8601，源自 frontmatter updated/updatedAt）；缺省 → L0 注入分组排序按 epoch0 置组内最末 */
  updatedAt?: string;
  // —— 市场来源锚点（仅市场安装写，见 §12.5）——
  marketRef?: string;            // provider ref（如 github/awesome-copilot/git-commit）
  marketSource?: string;         // provider id（如 skills_sh）
  installedHash?: string;        // 安装时内容哈希（与 detail.hash 不同 → 可更新）
}
```

> **权威源**：`app/server/src/skills/types.ts`（后端）+ `app/web/src/lib/api-client.ts`（前端镜像，两侧字段一致）；治理语义见 `specs/tech/agent/skills/[P0]skill_definition.md §2/§6` + `06a-skill-governance.md`。

## 9. 关键用户路径映射（测试覆盖）

| PRD 路径 | API case |
|---------|----------|
| 安装 skill（拖拽 zip）| POST /skill/install |
| 列表查看 | GET /skill |
| 开关 enabled | PATCH /skill/:name |
| 删除 | DELETE /skill/:name |
| 预览文件树 | GET /skill/:name/tree |
| 预览文件内容 | GET /skill/:name/file |
| [v0.0.51] UI 改 mutable 字段 | PATCH /skill/:name/governance（→ `06a-skill-governance.md`） |
| agent 读 skill（工具，非 HTTP）| skill tool UT（非本 api 文档） |

## 10. 一致性约束

- **name kebab-case ≤64**：install 校验；frontmatter name 必须与目录名一致（不一致 → 400）。
- **SKILL.md 必需**：install 校验；list 扫描时遇到无 SKILL.md 的目录跳过（不报错）。
- **scope 操作原子**：PATCH/DELETE 按 scope 定位单层，不影响另一层同名 skill。
- **workspace 参数安全**：`?workspace=` 必须绝对路径 + 存在 + 是目录（仿 session-workspace-seed validateCallerWorkspaceDir）。

## 11. `GET /session/:id/debug/system-prompt`（测试调试端点，决策2）

> **仅 test 环境开放**。gate：`process.env.APP_ENV === 'test' || process.env.NODE_ENV === 'test'`；非 test 环境 → `404`（避免生产暴露 prompt 内容）。

### 11.1 请求

- path：`:id` = session id
- method：`GET`

### 11.2 响应

- `200` · `{ "sessionId": string, "systemPrompt": string }`
  - `systemPrompt` = 该 session 组装后的**完整 system prompt 文本**（经 plugin mapper/reducer 链拼接后的最终结果，含 skills L0 fragment）。
  - `[v0.0.204]` mapper/reducer 链按**该 session 的 scopeId（= SessionKind canonicalId）**解析——debug 预览与真实生产链一致（studio-squad session 含 squad_role/team_roster mapper、playground 去 squad mapper；用 default scope 预览是错误结果）。

### 11.3 错误

| HTTP | 触发 | 响应体 |
|------|------|--------|
| `404` | 非 test 环境；session 不存在 | `{ "error": "Not Found" }` |
| `500` | 组装 config 失败（如 session 无可用 provider/model）| `{ "error": "failed to build config: <原因>" }` |

### 11.4 用途

供 AT（如 `skill_toggle_inject_tc1`）**直查 system prompt**，验证 skill L0 注入（toggle enabled/disabled 后 prompt 含/不含 skill 行）。这把 L0 注入从「UT 内部覆盖」升级为「AT 黑盒可验证」。

## 12. `/skills/market/*`（skill 市场 HTTP API — [v0.0.166] 引入 + [v0.0.167] 扩展）

> **注意路径复数**：市场端点前缀 `/skills/market/`（**复数 skills**），不与 §2–§7 的 `/skill/*`（**单数 skill**，本地管理）冲突。
> handler：`app/server/src/handlers/skill-market.ts`（`handleSkillMarketRoute`，misc-routes dispatch）。所有端点先经 `resolveSkillMarketProvider` 取 exclusive 生效市场源；**无 active provider → 503**（统一门槛）。协议/能力协商权威见 `specs/tech/agent/skills/[P1]skill_market.md`。

### 12.1 `GET /skills/market/capabilities`

返回当前生效 provider 的能力自描述（UI 据此协商渲染/传参，缺失维度不渲染）。

- `200` · `{ id, label, capabilities }`（skills.sh：`capabilities = { stats: ['installs'] }`，无 categories/collections/sorts/stars）
- `503` · `{ error }`（无 active provider——前端据此渲染「市场未配置」引导态；api-client `getMarketCapabilities` 把 503 归一为 `null`）

```json
{ "id": "skills_sh", "label": "skills.sh", "capabilities": { "stats": ["installs"] } }
```

### 12.2 `GET /skills/market/search?q=&owner=&limit=&cursor=`

resolve → `provider.search` → 200。skills.sh 仅认 `q`（必填）/`owner`/`limit`。

- `200` · `SkillMarketSearchResult`：`{ provider, query, count, tookMs, items[], nextCursor? }`；`items[]` 每项 `{ ref, name, stats?:{installs?} }`（skills.sh search **不返回 description**，能力门控）
- `400` · `{ error: "q is required" }`（缺 `q`）
- `503` · 无 active provider

### 12.3 `GET /skills/market/detail?ref=<provider ref>`

resolve → `provider.getDetail`。ref 含 `/` → 走 **query 参数**（非路径段），api-client 侧 `encodeURIComponent`。

- `200` · `SkillMarketDetail`：`{ ref, name, description?, readme?, repository?:{url,subpath?}, hash?, files?:[{path}] }`
  - **[v0.0.167]** `hash`（当前内容哈希，前端与已安装 `SkillEntry.installedHash` 本地比对判「可更新」）+ `files:[{path}]`（仅相对路径，不含 contents）。skills.sh 无独立详情端点——getDetail 复用 fetchSkillFiles（hash/files 免费，零额外请求）
- `400` · `{ error: "ref is required" }`（缺 `ref`）
- `503` · 无 active provider

### 12.4 `POST /skills/market/install`

body `{ ref, scope?, overwrite? }` → provider.fetchSkillFiles 取文件 → installer source-无关核心落盘（治理 `production_method='download'` + `evolvable=false` 硬编码；**[v0.0.167]** 追加写来源三字段 `market_ref`/`market_source`/`installed_hash`）。

- `202` · `{ skill: SkillEntry }`（含 v0.0.167 `marketRef`/`marketSource`/`installedHash`；覆盖更新亦 202）
- `400` · ref 形状非法（非 `owner/repo/slug`）/ `scope` 非 `app`（market 安装仅支持 app scope）/ 无效 json body
- `409` · 同名冲突。**[v0.0.167] overwrite 语义**：`overwrite=true` **仅同源覆盖**——磁盘同名 skill 的 frontmatter `market_ref` 精确等于本次 ref 才删旧覆盖重装（守卫读磁盘 frontmatter，不信前端）；无 overwrite / 本地手写（无 market_ref）/ 异源同名（market_ref 不同）→ 409。**MUST NOT 覆盖本地或异源同名 skill**
- `413` · skill 体积超限（>50MB）
- `503` · 无 active provider

> **agent 路径差异**：`skill_manage(action=install)`（tool，`tools/skill-market/actions.ts:executeMarketInstall`）同写来源三元数据，但**不开放 `overwrite`**（省略=默认 false），同名恒 409，防 agent 静默覆盖已装 skill。HTTP `overwrite` 仅供 UI「更新」动作用。

### 12.5 SkillEntry 来源字段（[v0.0.167]）

install/list/toggle 响应的 `SkillEntry` 追加三个可选字段（`app/server/src/skills/types.ts`；缺省=本地/手写/builtin 来源，不报错）：

```typescript
marketRef?: string;      // 安装用 provider ref（如 github/awesome-copilot/git-commit）；UI 据有无显示「市场/本地」badge，据 item.ref===marketRef 精确匹配判同源已安装
marketSource?: string;   // provider id（如 skills_sh）
installedHash?: string;  // 安装时内容哈希（详情 detail.hash 与之不同 → 可更新）
```

> **scope 归属**：市场安装恒落 `app` scope（`POST /skills/market/install` 拒绝其他 scope）；四层 scope 枚举见 §8。
