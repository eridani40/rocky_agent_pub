---
type: spec
title: 团队同步（导出 zip / 两阶段导入建队）服务层
priority: P1
updated: 2026-08-13
---

# 团队同步（team-sync）服务层

## ① 是什么

应用设置「团队同步」tab 的后端服务层：当前团队配置（manifest + AGENTS.md + .rocky 全套）导出 zip 下载；zip 两阶段导入建新团队。**程序化实现**（读目录 + manifest + adm-zip，不靠 LLM）。UI 契约见 `specs/ui/components/app-dev-config-page/section-team-sync.md`；API 契约见 `specs/api/overall/11d-squad-team-sync.md`。

| 概念 | 说明 |
|---|---|
| **team-sync-export-service** | `app/server/src/services/team-sync-export-service.ts`——buildManifest（members/*.json 读，leader 提顶层）+ exportSquadToZip（adm-zip 打包 → buffer） |
| **team-sync-import-service** | `app/server/src/services/team-sync-import-service.ts`——validateZipEntries + parseManifestFromDir + unpackToTemp + importSquadFromTempDir + ImportKeyStore |
| **team-sync-handler** | `app/server/src/handlers/team-sync-handler.ts`——`GET /squad/:id/export` + `POST /squad/import?step=preview\|execute` + modelDefault 继承 |
| **ImportKeyStore** | 模块级单例 Map（importKey → {tmpDir, manifest, srcDir}），5min TTL 自动清理 |
| **路由** | `squad-routes.ts` export/import 分发在 `/squad/:id` CRUD **之前**匹配（MANDATORY，否则 `export` 被当 id 吃掉） |

## ② 导出链路（exportSquadToZip）

`exportSquadToZip(squadDir, squad) → { buffer, memberCount }`：

1. **buildManifest**：读 `members/*.json`（symlink skip、解析失败 skip）→ leader（`role==='leader'`）提顶层 `leaderName/leaderIntro`，mate 入 `members[]`（name/intro/skillConfig）；slug/name/description 取自 squadEntity；`builtin: false`。members 目录缺失/无记录 → throw（PRD §5.6 团队数据异常）。
2. **zip 内容（白名单，天然排除其他）**：`manifest.json` + `AGENTS.md`（存在才加）+ `.rocky/agents/*.md` + `.rocky/{skills,memory,templates,commands}/` 递归 + `.rocky/settings.json`。**不含** members/ outputs/ reports/ states/ specs/ panorama/ images/ project symlink。
3. **agents 文件名还原**：`restoreAgentFileName(file, leaderName)`——实名 leader `{leaderName}-{ULID}.md` → `leader.md`（v0.0.321）；其余 `stripMemberIdSuffix` 用 ULID 后缀正则 `/-[0-9A-HJKMNP-TV-Z]{26}\.md$/` 精确去后缀。
4. **symlink 安全**：`lstatSync` 检测 symlink → skip（不跟随，防读 squad 目录外文件）。
5. **下载头（handler）**：`Content-Disposition` 对非 ASCII 团队名（中文）追加 RFC 5987 `filename*=UTF-8''{encodeURIComponent(name)}`（HTTP header 仅允许 ASCII；ASCII 名同时给 `filename` 兼容旧客户端——v0.0.319 编码偏离，leader 裁决接受）。

## ③ 导入链路（两阶段）

**preview**：`POST /squad/import?step=preview`（FormData file）→ `unpackToTemp`（解包到 `os.tmpdir()/rocky-import-{ulid}`，**先 validateZipEntries 再解包**）→ `parseManifestFromDir`（zip 根或**一层子目录兜底**找 manifest.json + `assertManifestShape` 必填 slug/name/description/leaderName/members 数组）→ `importKeyStore.set()` 返 `{ importKey, manifest }`。校验失败立即 `rmSync` 临时目录。

**execute**：`POST /squad/import?step=execute`（importKey + name）→ `importKeyStore.take(importKey)`（**原子消费**：取出即删 Map + 清 TTL timer，防重复 execute 建两个队；不存在/过期 → 400 `import session expired`）→ `importSquadFromTempDir`：

1. `createSquadService`（用户填的 name + manifest.description + 继承 modelDefault + `leader: {name: manifest.leaderName}`）
2. 遍历 manifest.members **best-effort hire**（`createMemberService`，失败记 `failed` 不中断）；`nameToId` 先补 `'leader' → leaderMember.id` 映射（leader 不在 manifest.members，但导出 zip 的 `.rocky/agents/` 含 leader.md——copyTemplateFiles 需此映射改名 `leader-{memberId}.md`，v0.0.319-fix）
3. `copyTemplateFiles(srcDir, 新 squad 目录, nameToId, manifest.leaderName)`（v0.0.321 起实名 leader 文件格式）
4. execute `finally` 确保 `rmSync` 临时目录（即使建队失败）

**modelDefault 继承**（handler）：请求头 `x-session-id` → 当前 session 的 squad → 继承其 `modelDefault(+providerId)`；fallback 系统第一个 enabled provider 的第一个 enabled model；均取不到 → 400「默认模型无效」。

## ④ 路径安全（MANDATORY）

| 侧 | 措施 |
|---|---|
| 导入 | `validateZipEntries` 拒 `/` 开头（绝对路径）/ 含 `..` / Windows 盘符（`/^[A-Za-z]:/`）→ `InvalidZipError` → 400 |
| 导出 | 全程只读 squad 目录内文件；`lstatSync` symlink 检测 → skip 不跟随 |
| 清理 | preview 失败立即 rmSync；execute finally rmSync；ImportKeyStore **5min TTL** setTimeout 兜底（`timer.unref()` 不阻塞进程退出） |

## ⑤ 边界

- **不导出/导入 workspace 内容**（老板拍板①：完全复用，workspace 不管）——导出白名单不含 `workspaces/`，导入 copyTemplateFiles 不碰 workspace。
- **明文 zip**（老板拍板③：团队配置无 API key，不加密）。
- **成员名保留**（老板拍板②）：`leader: {name: manifest.leaderName}` + hire `name: spec.name` 直接复用 manifest。
- **ImportKeyStore 进程内存**：重启即丢（tmpdir 由 OS 兜底清理，可接受）；不持久化。
- **best-effort 语义**：hire 失败/模板复制失败均记 failed 不中断导入主流程。
- 前端 `section-team-sync.tsx` 的 squadId 取法：从 `listStudioSessions`（`GET /session?biz=studio`，updatedAt desc）取最近活跃带 squadId 的 studio 会话（`useChatStore` 是 playground 专属 store，studio 会话永不在内——v0.0.319.2 修复）。
