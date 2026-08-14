---
type: log
title: Mention KB 变更记录
updated: 2026-08-14
since: v0.0.45
---

# Mention KB 变更记录（ISO 倒序，最新在前）

> 本目录级变更日志（位置轴）。跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 一行一 feature；版本块尾指向该版本 change_log 详情。

## 2026-08-14 · v0.0.346（mention 交互修复 — 触发双层门控 + 文件搜索共用 workspace-search-core）

- **`search-api.md §5 性能考量`**：FileProvider 段重写为「workspace-search-core 适配层」——`search()` 调 `searchWorkspace(ctx.workspaceDir, ctx.query)`（`app/server/src/search/workspace-search-core.ts`），与工作区搜索端点共用同一遍历/排除/上限核心（IGNORED_NAMES 单一源在 `session-workspace.ts`，排除仅 node_modules/.git）；目录命中不递归其下层；files+dirs ≥ 100 早停 truncated:true；5s 超时兜底移除；点开头不再排除。§6 未决事项 1（防抖）/4（缓存索引）标 v0.0.346 决策（不强制统一 / 不引入）。
- **`provider-interface.md`**：§1 `SearchResult` 加 `truncated?: boolean`（仅 true 输出，缺省省略向后兼容）；§5 FileProvider 实现要点更新（共用 workspace-search-core、排除仅 IGNORED_NAMES、目录匹配/不递归、100 上限+truncated、目录条目 type='file' 零新增字段）。
- **问题 4 增量（v0.0.346-2）**：`MentionItem` 加 `isDir?: boolean`（目录命中 true，缺省=文件）；FileProvider 目录条目 `isDir:true` + `listView.icon='folder'`（文件缺省 + 'file'）；subtitle 根路径 `'/'` 始终展示；`display.icon` 保持 'file'（pill 不区分）；popover 目录 FolderIcon gold / 文件 FileIcon muted，subtitle 始终渲染，非 file provider 兜底（provider-interface.md §3/§5 + search-api.md §5 + GET-search.md + mention-popover.md）。
- 详情：`specs/tech/version_logs/v0.0.346/change_log.md`（T1-T3 实现核对 + 双层门控机制 + 2 条实现偏差：T2 死 import Minor / T3 面板 null 守卫偏离 + 知悉项；T4/T5 问题 4 实现核对）

## 2026-07-19 · v0.0.177.image_copy（粘贴图片 → file mention，零新增 type）

- **复用 `file` mention type**（INV-2 type-agnostic）：粘贴剪切板图片落盘 `<workspaceDir>/images/image-<ulid>.<ext>` 后插 `<mention type="file" path="images/..." icon="file" label="image-...png"/>` pill，**不新增 mention type**。下游 see_image（v0.0.141）零改动可消费。
- **不增量 message-content schema**：`<mention type="file" path/>` flat 全属性 tag（v0.0.86 形）零变更；只是 file path 域扩到 `images/` 子目录。
- **新增客户端接线**：`paste-image-handler.ts processImagePaste()` + `component-chat-composer.tsx editorProps.handlePaste` 同步短路层（详见 `specs/ui/components/chat-page/chat-composer.md §粘贴图片`）；多图顺序 await 禁 `Promise.all`（保 pill DOM 顺序）；filename / ulid server 单一权威，client 不参与命名。
- **file provider 搜索零影响**：`FileProvider` 走 `GET /mention/search?provider=file&query=...` 搜索 workspace——`images/` 子目录天然在搜索范围内（无路径白名单排除），未来若用户 `@` 引用粘贴的图片，search 仍命中。

详情：`specs/tech/version_logs/v0.0.177/change_plan.md`（§变更清单 前端 paste 逻辑 + editorProps 接线两行）

## 2026-07-07 · v0.0.86

- **报文重构**：mention tag 从 `<mention type path/>`（两属性）改为 flat 全属性（address + display 同串持久化）—— `<mention type=".." {address} {display}/>`，详见 `message-content.md §3`。
- **翻转 v0.0.68 「核心=地址不嵌 name」决策**：display（icon/label/badge）与 address 一起序列化进**同一条字符串**，server 零处理透传；renderer 解析同一字符串取 display → pill，零 provider/store 调用（INV-1）。理由：v0.0.68 path 末段推导产生连锁缺陷（workitem pill 显示裸 ID、member pill 显示裸 ULID、LLM 收到无意义 ULID）。
- **MentionItem 加 `display: {icon,label,badge?}` 闭集合字段**（`detail` 字段 v0.0.86 删，用户判定冗余）；`listView` 保留（popover 列表渲染，与 display 并存，由 provider 同步构建）。
- **workitem address 拆 `kind`+`id`**（不再 `workitem/<kind>/<id>` 塞 path）；file/skill 仍用 `path`；member 用 `id`。
- **统一渲染器 + Glyph registry（INV-2）**：renderer 只读 `{icon,label,badge}` 三属性、无 `if(type===)` 分支；新增 Glyph registry 注册 7 个 icon key（file/skill/member + goal/kr/requirement/task）；删 `deriveMentionLabel`（path 末段 hack）+ `MentionIcon` 的 type 分支。
- **不向后兼容**：旧 tag（v0.0.45/v0.0.68 两属性格式）renderer 新正则仍能匹配但缺 display → 降级纯文本显示，不 crash、不迁移。
- **API schema 对齐**：`GET-search.md` + `overall/12-mention.md` 响应 schema 加 `display`，workitem 拆 `kind`+`id`。
- **resolver.md 不变**（D8 provider 可见性矩阵沿用）。

详情：`specs/tech/version_logs/v0.0.86.mention_refactor/change_log.md`（待补） / `change_plan.md`

## 2026-07-05 · v0.0.68

- 新增 provider：**WorkItemProvider**（`workitem/<kind>/<id>` 单类型，kind=goal|kr|requirement|task）+ **MemberProvider**（path=memberId，D4 不嵌 name）—— 实现 `MentionProvider` 接口，注册到 registry 复用既有搜索链路。
- **数据源实现细节**（spec↔code 对齐 — provider-interface.md §7/§8）：
  - WorkItemProvider 走 `boardStore.listGoals/listRequirements/listTasks(squadId)` 三次拉全集合视图层调 `buildAncestorView({goals,requirements,tasks})` 构联合检查索引，归档过滤走 `effectiveArchived(...)`（**不**调 spec 起草时写的 `BoardStore.getBoard(squadId,'all','active')`——该方法不存在，是 spec 概念误植，doc-sync 已对齐到实际 store API）
  - MemberProvider 走 `memberStore.listMembers(squadId)` + 过滤 `state==='deployed'`（**不**调 spec 起草时写的 `SquadStore.getSquad(squadId).members`——squad record 仅存 memberIds[]，member 实体在 members/ 子目录分片存储；`MemberStore` 由 `squad-store.ts` 导出）
- `MentionItem.type` 扩为开放枚举 `'file' | 'skill' | 'workitem' | 'member'`（provider-interface.md §3）；`message-content.md` 的 `<mention type path/>` 自闭合标签**零变更**（type 是开放 string，新值直接落入）。
- **新增 `resolver.md`**（D8）：`resolveMentionProviders(sessionKind) → ProviderName[]` 单一映射表，client（popover tab 派生）+ server（search 校验/过滤）共用。映射（用户确认）：playground=[file,skill]；squad 群聊=[file,skill,workitem,member]；leader/mate 单聊=[file,skill,workitem]；subagent readonly=[file,skill]。@member 仅 squad 群聊可用。
- **拒绝码口径**（resolver_reject_code 决策）：未授权 provider 试探统一返 **404** `ProviderNotFoundError`（不返 403，避免泄露 provider 存在性；与既有「未注册 provider → 404」语义一致）。`resolver.md §5.2/§6` + `specs/api/version_logs/v0.0.68.md §1.1` 三处对齐。
- 实现位置：`app/shared/mention-resolver.ts`（前后端共用，避免漂移）；handler `mention.ts` 内调 resolver 校验 provider 入参 ∈ 允许集合（搜索前置，未授权返 404）。
- 配套前端：`PROVIDER_LABELS` 扩 4 项；`primitive-mention-pill.tsx` MentionIcon 加 workitem/member 分支；各 composer `enabledProviders` 从硬编码改 resolver 派生。

详情：`specs/tech/version_logs/v0.0.68/change_log.md` §R2/R4/D8

## 2026-07-15 · v0.0.45

- 新建 mention KB：`index.md`（6 章总起）+ `log.md`（本文件）+ `provider-interface.md` + `message-content.md` + `search-api.md`。
- 定义 `MentionProvider` 接口 + `SearchCtx` + `MentionItem` 结构（provider-interface.md）。
- 定义 `MessageContent` 结构化数组（text + mention 混合节点），向后兼容旧 string（message-content.md）。
- 定义 `GET /mention/search` server 端 service 设计（sessionId → workspaceDir 解析，search-api.md）。
- 全局 type alias 提取：`BizType` / `SessionType` 落 `app/shared/src/types/session-types.ts`，新增 `'rocky'` 值。
- editor 选型决策：Tiptap（ProseMirror），理由见 index.md §⑤。
- 轻量 Registry 设计：不走 plugin EP，独立 `MentionProviderRegistry`（静态注册 + search 路由）。

详情：`specs/prd/version_logs/v0.0.45-mention-system.md`（PRD 8 条用户路径 M1-M8）
