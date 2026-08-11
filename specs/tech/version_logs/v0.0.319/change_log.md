---
type: change_log
title: v0.0.319 — 团队同步（导入导出团队配置）
version: v0.0.319
date: 2026-08-10
related_prd: specs/prd/v0.0.319-team-sync.md
related_change_plan: specs/tech/version_logs/v0.0.319/change_plan.md
grounded: PRD §2/§3/§5 + change_plan D1–D7 + coder2 汇报 2 处偏离（leader 裁决接受）
---

# v0.0.319 — 团队同步（导入导出团队配置）

> 一句话：**应用设置新增「团队同步」tab（配置同步下方）**，当前团队配置（AGENTS.md + .rocky 全套 + manifest）导出 zip 下载 / 两阶段导入建新团队，程序化实现（读目录 + manifest + adm-zip，不靠 LLM）。

## 1. 变更总览

**后端（3 新建 + 2 修改）**：

| 模块 | 文件 | 说明 |
|------|------|------|
| 导出服务 | `app/server/src/services/team-sync-export-service.ts`（新建） | `buildManifest`（读 members/*.json，leader 提顶层）+ `exportSquadToZip`（manifest.json + AGENTS.md + .rocky 全套打包，排除运行时/产物，symlink skip） |
| 导入服务 | `app/server/src/services/team-sync-import-service.ts`（新建） | `validateZipEntries`（拒 `..`/绝对路径/盘符）+ `parseManifestFromDir` + `unpackToTemp` + `importSquadFromTempDir`（createSquadService + best-effort hire + copyTemplateFiles）+ `ImportKeyStore`（5min TTL） |
| API handler | `app/server/src/handlers/team-sync-handler.ts`（新建） | `GET /squad/:id/export` + `POST /squad/import?step=preview\|execute` + modelDefault 继承（当前 session squad → 系统 fallback） |
| 模板服务 | `app/server/src/services/squad-template-service.ts`（修改） | `copyTemplateFiles` 加 export 关键字（零逻辑变化） |
| 路由 | `app/server/src/routes/squad-routes.ts`（修改） | export/import 分发在 `/squad/:id` CRUD 之前匹配（MANDATORY） |

**前端（1 新建 + 2 修改 + 2 i18n）**：

| 模块 | 文件 | 说明 |
|------|------|------|
| tab 注册 | `app/web/src/components/app-dev-config-page/app-settings-config-defs.ts` | `TabId` 加 `'team_sync'`；`APP_SETTINGS_TABS` memory 后插入；`TAB_KV_GROUPS.team_sync = []` |
| 路由 | `app/web/src/components/app-dev-config-page/section-tab-panel.tsx` | switch 加 `case 'team_sync'` → `<SectionTeamSync />`（不走 SaveBar / dirty） |
| 页面 | `app/web/src/components/app-dev-config-page/section-team-sync.tsx`（新建） | landing/export/import 三态 + 重名检测（前端 listSquads 比对）+ ConfirmModal |
| API client | `app/web/src/lib/squad-api.ts` | `exportSquad` + `previewImport` + `executeImport`（coder2 拆分到 team-sync-api.ts 防超 300 行） |
| i18n | `app/web/src/i18n/locales/{zh-CN,en}/app-dev-config.json` | `tab.team_sync.label` + 导入导出文案 |

## 2. 偏离项（coder2 汇报 → leader 裁决接受 → 本文件记录）

| # | 偏离 | 类型 | 裁决 | 代码位置 |
|---|------|------|------|----------|
| 1 | **RFC 5987 中文文件名**：change_plan D3 原文 `Content-Disposition: attachment; filename="rocky_agent_team_{name}_{timestamp}.zip"`，实现因 **HTTP header 仅允许 ASCII**，对非 ASCII 团队名（中文）追加 RFC 5987 `filename*=UTF-8''{encodeURIComponent(name)}`（ASCII 名同时给 `filename` 兼容旧客户端） | 实现偏离 | **接受**（否则中文团队名下载文件名乱码/header 报错；下载语义不变） | `app/server/src/handlers/team-sync-handler.ts` `handleTeamSyncExport` |
| 2 | **ImportKeyStore.take 原子消费**：change_plan D2 原文 `get` + `delete` 两步，实现改为 `take()` 单方法原子消费（取出即从 Map 删除 + 清 TTL timer，防重复 execute 建两个队） | 实现偏离 | **接受**（更安全：execute 只消费一次；不存在/过期返 undefined → 400 `import session expired`） | `app/server/src/services/team-sync-import-service.ts` `ImportKeyStore.take` |

## 3. 编码阶段修复（AT/ET 后追加，commit 记录）

### 3.1 leader.md 命名 bug（commit 69d21673f）

**现象**：从模板创建团队 / 319 导入建队后，`copyTemplateFiles` 无法把 `.rocky/agents/leader.md` 改名为 `leader-{memberId}.md`——leader 由 `createSquadService` 先于 `applyTemplate` 创建，**不在 manifest.members 内**，`nameToId` 无 leader 映射 → leader 个人 AGENTS 注入失效（`*-{memberId}.md` 扫描约定）。

**修复**（存量 bug，影响模板创建 + 319 导入两条路径）：
- `squad-template-service.ts` `applyTemplate` 新增可选参数 `leaderMemberId?`，`nameToId` 补 `'leader' → leaderMemberId`（copyTemplateFiles 按文件名 role 查询，必须 set `'leader'` 而非 manifest.leaderName）
- `handlers/squad.ts` 传 `created.leaderMember.id`
- `team-sync-import-service.ts` `importSquadFromTempDir` 内部解构 `leaderMember` 并补 `'leader'` 映射（导出 zip 的 `.rocky/agents/` 含 `leader.md`——导出时 `leader-{memberId}.md` 被 stripMemberIdSuffix 还原为 `leader.md`）

**影响面**：`applyTemplate` 签名变化（新增可选参数，向后兼容）；API 契约不变（POST /squad body 无变化）。

### 3.2 团队同步 squadId 来源修复（commit befd80f6c，ET blocking）

**现象**：section-team-sync.tsx 用 `useChatStore`（`activeSessionId` + `sessions.find().squadId`）取 squadId——**导出按钮永远 disabled**。

**根因**（ET 报告 + 核实）：`useChatStore` 是 playground 专属 store（`chat-slice.ts:183` 拒纳 biz=studio 会话），studio 团队会话永远不进 store → squadId 永远 undefined。

**修复**：squadId/activeSessionId 改从 `listStudioSessions`（`GET /session?biz=studio`，按 updatedAt desc）取**最近活跃带 squadId 的 studio 会话**。查证后排除 chrome 方案（SessionChromeView 无 squadId 字段且需先持 sessionId）与全局 store 方案（前端无跨 view 的当前 session 状态）。PRD 语义保持：无 studio 会话 → 导出 disabled + 提示；有团队会话 → 导出可用。**纯前端修复，API 无变化。**

## 4. 其他实现要点（与 change_plan 对齐）

- **路径安全 MANDATORY**：导入侧 `validateZipEntries` 拒 `/` 开头（绝对路径）/ `..` / Windows 盘符 → InvalidZipError → 400；导出侧 `lstatSync` 检测 symlink → skip。
- **临时目录清理**：preview 校验失败立即 rmSync；execute `finally` 确保 rmSync（即使建队失败）；ImportKeyStore 5min TTL setTimeout 兜底（`timer.unref()` 不阻塞进程退出）。
- **best-effort hire**：manifest.members 逐个 createMemberService，失败记 `failed` 不中断（如新 squad 内 manifest 自身重名 member）；copyTemplateFiles 内部 best-effort。
- **modelDefault 继承**：请求头 `x-session-id` → 当前 session squad → 继承其 modelDefault(+providerId)；fallback 系统第一个 enabled provider 的第一个 enabled model；均取不到 → 400「默认模型无效」。
- **zip 内 manifest 定位**：zip 根或一层子目录兜底（导出 zip 根目录为 `{squadName}/`）。
- **agents 去 memberId**：`stripMemberIdSuffix` 用 ULID 后缀正则 `/-[0-9A-HJKMNP-TV-Z]{26}\.md$/` 精确匹配。

## 5. 老板拍板 4 点核对（doc-modifier 阶段 5）

| 拍板点 | PRD | 实现 | 一致 |
|--------|-----|------|------|
| ①完全复用（workspace 不管） | §1.3「不导出/导入 workspace 内容」 | 导出白名单不含 workspaces/；导入 copyTemplateFiles 不碰 workspace | ✅ |
| ②名字保留 | §2.3「成员名直接复用 manifest 中的 name」 | `leader: { name: manifest.leaderName }` + hire `name: spec.name` | ✅ |
| ③明文 zip | §1.3「不加密 zip（团队配置无 API key）」 | AdmZip 明文打包，无加密层 | ✅ |
| ④程序化 | §1.2「纯后端代码，不靠 LLM」 | `importSquadFromTempDir` 纯代码建队 | ✅ |

## 6. 相关文档

- API 契约：`specs/api/overall/11d-squad-team-sync.md`（完整）+ `specs/api/overall/11a-squad-endpoints.md` §5（短指针）
