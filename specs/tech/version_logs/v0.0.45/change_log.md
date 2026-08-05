# v0.0.45 Tech Change Log — @ Mention 系统首版

> version: 1.0 · 2026-07-15
> 范围：新增 `mention` 子系统（KB `specs/tech/mention/`）——provider 注册 + 搜索 + 消息 content 结构化。三处输入区（playground / studio 单聊 / studio 群聊）统一迁移到共享 `ChatComposer`（Tiptap 编辑器），`POST /messages` body 从纯 string 升级为 `MessageContent[]` 结构化数组，新增 `GET /mention/search` 端点。全局 type alias 提取 `BizType` / `SessionType`（新增 `'rocky'` 值）到 `app/shared/src/types/session-types.ts`。
> 权威方案：`specs/prd/version_logs/v0.0.45-mention-system.md`（PRD 8 条用户路径 M1-M8）+ `specs/tech/mention/`（KB 4 件：index/log/provider-interface/message-content/search-api）。
> 验证：UT + AT + ET（详见 `states/v0.0.45.mention_system/verify/`）。

---

## 1. 改动摘要

### 1.1 新增子系统 KB：`specs/tech/mention/`

- `index.md`（6 章总起：核心概念 / 边界 / 系统关系 / 设计原则 / 决策记录 / 目录导航）
- `log.md`（本 KB 变更记录，ISO 倒序）
- `provider-interface.md`（`MentionProvider` 接口 + `SearchCtx` + `MentionItem` 结构 + FileProvider / SkillProvider 实现要点）
- `message-content.md`（`MessageContent` 结构化数组 = `text` + `mention` 混合节点；落库/回放/LLM 拼接三统一；向后兼容旧 string）
- `search-api.md`（server 端 mention-search service 设计：sessionId → workspaceDir 解析，按 bizType/sessionType 分流）

### 1.2 顶层 tech index 补 `mention` 条目

- `specs/tech/index.md §① 核心概念表` + `§⑤ 本目录导航` 加 `mention` 一行。

### 1.3 API 契约变更

- 新增 `GET /mention/search?provider=file|skill&query=...&sessionId=...&limit=20&cursor=...`（详见 `specs/api/mention/GET-search.md` + `specs/api/overall/12-mention.md`）。
- `POST /session/:id/messages` body `content` 类型扩展 `string | MessageContent[]`；server 归一化 string → `[{ kind: 'text', text }]`；落库存结构化数组到 `metadata.structuredContent`（详见 `specs/api/mention/POST-message.md` + `specs/api/overall/04-agent-session.md §3.2`）。
- 向后兼容：旧客户端发 `{ content: string }` 不受影响。

### 1.4 UI 契约变更（三个新组件）

三处输入区（playground `SectionChatDetail` / studio 单聊 `SectionMemberChat` / squad 群聊 `SectionSquadChat`）统一迁移到共享 `ChatComposer`。新增组件 spec：

- `specs/ui/components/chat-page/chat-composer.md`（pill-aware Tiptap 编辑器 + @ 触发 popover + focus 管理 + 发送序列化 `MessageContent[]`）
- `specs/ui/components/chat-page/mention-popover.md`（多 tab + search input + 滚动结果列表 + 键盘导航）
- `specs/ui/components/chat-page/mention-pill.md`（`primitive-mention-pill.tsx`，输入区 / 消息区共用同一 pill 组件）

新增 testid：`chat-composer` / `chat-composer-editor` / `chat-composer-send` / `mention-popover*` / `mention-pill`（含 `data-mention-type` / `data-mention-label`）。

### 1.5 全局 type alias 提取

`app/shared/src/types/session-types.ts` 落 `BizType = 'playground' | 'studio'` + `SessionType = 'rocky' | 'leader' | 'mate' | 'squad' | 'subagent'`（新增 `'rocky'` 供 playground 主会话 + SearchCtx 使用）；顺手收敛 5+ 处内联 union。

### 1.6 editor 选型决策：Tiptap

选择 `@tiptap/react` + `@tiptap/starter-kit` + `@tiptap/suggestion`（ProseMirror 基础）。理由：suggestion 插件原生支持 `@` 触发 + 浮动面板 + 键盘导航；`atom: true` inline node 天然支持 pill 整颗删除；schema 保证 pill 序列化健壮。bundle size 代价 ~150KB 在桌面端可接受。详见 `specs/tech/mention/index.md §⑤ editor 选型决策`。

### 1.7 轻量 Registry（不走 plugin EP）

`MentionProviderRegistry` 是独立静态注册容器（不挂 plugin ExtensionPoint）。理由：plugin system 是纯 server-side，无前端 UI 贡献能力；首版内置 2 provider（`FileProvider` + `SkillProvider`）足够，第三方扩展机制后续按需设计。详见 `specs/tech/mention/provider-interface.md`。

---

## 2. 工程教训（v0.0.45 血泪）

### 2.1 BUG-001：vite proxy 漏配 `/mention` 前缀

**现象**：dev 环境点击 `@` 触发 popover 时，`GET /mention/search` 返回 HTML（index.html 的 SPA fallback），前端 JSON.parse 抛错；E2E 环境同样中招。

**根因**：`app/web/vite.config.ts` 的 `server.proxy` 白名单只列了 `/session` / `/config` / ...，v0.0.45 新增 `/mention` 端点未加入白名单 → vite dev server 命中 SPA fallback。

**修复**：`app/web/vite.config.ts` proxy 白名单补 `/mention` 前缀。

**教训**：**新增顶级 HTTP 路径必须同步更新 vite proxy 白名单**。作为流程规范固化到 `specs/tech/app/frontend/`（后续 doctor 可以加规则扫）。

### 2.2 E2E case timeout：checkpoint 未设 `timeout_seconds`

**现象**：mention 相关 E2E case 步骤 ≥8 时，默认 60s 超时被击穿（Tiptap 首次加载 + Playwright 截图 + vision_check 串行），run_all 报 timeout 但实际功能已通过。

**根因**：checkpoint.json 未显式设 `timeout_seconds` 字段，走默认值 60s；实测 ≥8 步 case 需要 180s。

**修复**：mention 相关 case checkpoint 加 `timeout_seconds: 180`。

**教训**：**e2e-test-designer 后续默认给 ≥8 步 case 加 `timeout_seconds: 180`**。已作为 designer skill 规范固化。

### 2.3 Spec 双源冲突：pill testid

**现象**：`specs/ui/components/chat-page/chat-composer.md` 写 pill testid = `chat-composer-pill`；`specs/ui/components/chat-page/mention-pill.md` 写 `mention-pill`；实现 `app/web/src/components/chat-page/primitive-mention-pill.tsx` 用 `mention-pill`。E2E designer 从任一 spec 读都可能拿错。

**修复（v0.0.45 doc 同步阶段）**：以实现 + `mention-pill.md`（数据权威所在）为准，把 `chat-composer.md` 那行改成 `mention-pill`（附加 `data-mention-type` / `data-mention-label`），并加一条 note 说明「pill DOM 契约见 `mention-pill.md`」。

**教训**：**同一 testid 在 UI KB 内的两个组件 spec 出现时，必须由被组合方（primitive）作为唯一权威**，父组件 spec 只可引用不可另行声明。作为 UI conventions 补一条规则。

### 2.4 验证迭代纪律：短循环整轮重跑

**现象**：v0.0.45 mention 系统开发中，orchestrator 因短反馈循环 + 不读原始产出 + 违规委派 coder 跑 E2E，攒出 E2E 5 round + API 7 round，wall time 近 3h，mention case 通过率几乎零进展。

**根因**：
1. 每改一处就跑整轮全量 case（26 E2E + 56 API），而不是增量重跑 fail 白名单。
2. orchestrator 只看 executor 汇报的聚合 pass/fail 计数，不 Read `states/v0.0.45.mention_system/verify/*/round-N/run_all_result.json` 里的 `desc` + `tests/*/last_run.json` 详情 → 归因靠猜。
3. coder 越权跑 E2E（本该由 executor 唯一入口）。

**修复**：
- `.qoder/agents/coder.md` 加硬禁令：coder 不得跑 E2E / API test（唯一入口 = executor 的 `run_all.sh`）。
- `.qoder/agents/test-executor.md` 强化：只跑 + 汇报，不改任何文件。
- `AGENTS.md` 加「验证迭代纪律 五条铁律」（增量重跑 / 必读原始产出 / 逐级验证 / round 目录零膨胀 / 范围纪律），已固化为 orchestrator 硬约束。

**教训**：**每一层 agent 都必须严守职责边界，orchestrator 短循环重跑是流程反模式**。见 `AGENTS.md §验证迭代纪律 铁律 1-5`。

---

## 3. 变更清单

### 3.1 tech（本文件所在 KB 层）

- 新增 `specs/tech/mention/`（5 件：index.md / log.md / provider-interface.md / message-content.md / search-api.md）
- `specs/tech/index.md` §① / §⑤ 加 mention 条目

### 3.2 api

- 新增 `specs/api/mention/GET-search.md` + `POST-message.md`
- 新增 `specs/api/overall/12-mention.md`（overall 索引）
- `specs/api/overall/04-agent-session.md` §3.2 加 `content: string | MessageContent[]` 增量描述

### 3.3 ui

- 新增 `specs/ui/components/chat-page/chat-composer.md` + `mention-popover.md` + `mention-pill.md`
- `specs/ui/overall/02-llm-chat.md` §3 补 v0.0.45 mention 三组件条目

### 3.4 prd

- 新增 `specs/prd/version_logs/v0.0.45-mention-system.md`（PRD 8 条用户路径 M1-M8）
- `specs/prd/overall/03-llm-chat.md` §3.1 加 v0.0.45 mention 条目 + §4 追加 v0.0.45 关键用户路径 M1-M8

---

## 4. 已知限制（后续版本）

- `/` `#` 触发字符未实现（仅 `@`）。
- `.gitignore` 默认不开启（`FileProvider` 仅排除 `node_modules` + `.git`，走 dev config 开关默认关）。
- plugin system 未扩展到前端（无 UI 贡献能力）。
- 第三方 mention provider 贡献机制未做（内置 2 provider 足够）。
- mention pill 内部不做 markdown 渲染（原子节点）。
