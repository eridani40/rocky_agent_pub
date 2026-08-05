---
type: index
title: i18n 子系统总起
priority: P0
updated: 2026-07-04
---

# i18n 子系统总起

## ① 是什么

i18n 模块定义 **中英双语（zh-CN / en）国际化基础设施**——回答「哪些文本走翻译、按什么 key 查、bundle 怎么组织、locale 怎么切换、后端字段怎么渲染」。机制层定 4 件事：KKV 占位符协议 + locale bundle 结构 + react-i18next 集成 + 缺 key 报错；不在本模块做大规模迁移（迁移分批走后续版本）。

| 核心概念 | 一句话 |
|---|---|
| **KKV 占位符协议** | key × language → value；占位符 key 走翻译查表，字面文本直展，**判定原则 = 「UI 上能看到 → i18n」** |
| **占位符四规则** | (1) 字面文本→直展 (2) 占位符 key→查 KKV (3) 当前语言缺→兜底链 当前→en→zh-CN (4) 三级全缺→开发期报错 |
| **locale bundle** | `app/web/src/i18n/locales/{zh-CN,en}/<ns>.json`，ns = page 模块（chat / studio / providers / ... / common / error） |
| **key 命名** | dot.notation + camelCase leaf：`<ns>.<scope>.<leaf>`，如 `chat.sendButton` / `error.llm.authInvalid` |
| **type 走映射、动态文本走直展** | 可枚举 type（displayReason category 等）→ 后端发 code、前端按 locale 查表；自由文本（error_message / squad name / LLM 回复）→ 原样 |
| **locale 开关** | `app_config.locale.language`（值 `zh-CN` / `en`，已在 config KB §3.3 预留）；启动期 init（对齐 theme-init BUG-001 范式）+ 切换实时生效 + 持久化 |
| **后端范式样板（displayReason）** | 后端发 `errorCategory` code（不变）、前端按 locale 查 `error.llm.<category>` 表；后端 `displayReason` 字段作 zh-CN 兜底（向后兼容，零 API breakage） |

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| KKV 占位符协议 + 兜底链 + 缺 key 报错机制 | 具体页面文本迁移（→ Batch 2 后续版本，PRD §6） |
| locale bundle 物理结构 + 命名空间拆分 + key 命名规范 | 配置体系逐项 i18n 清单（PRD S6 梳理产物） |
| react-i18next 集成形态（init / useTranslation / changeLanguage） | LLM prompt 内容（system/agent prompt 不翻译，硬边界） |
| locale 开关前端链路（启动 init + 切换实时生效 + 持久化） | 用户数据翻译（squad name / session title / user_memory 等不翻译，硬边界） |
| displayReason 后端范式契约（前端按 category 查表） | 动态自由文本翻译（error_message 原样直展，硬边界） |
| 后端 type 字段 vs 动态文本判定流程 | 后端产生本地化文案（HTTP 错误体 i18n / plugin.json label i18n → 后续版本预留） |

## ③ 与系统的关系

```
   app_config.locale.language (config KB §3.3, 已预留)
        │  (GET /config/app?group=locale)
        ▼
   i18n（启动期 init: locale-Init.ts，对齐 theme-init BUG-001 范式）
        │
        ├── react-i18next instance (resources/lng/fallbackLng/parseMissingKeyHandler)
        │     └── useTranslation(ns) → t(key)  ←──── 前端组件消费
        │     └── changeLanguage(lng) → 实时切 + PUT /config/app?group=locale
        │
        ├── locale bundle: app/web/src/i18n/locales/{zh-CN,en}/<ns>.json
        │     ├── chat.json / studio.json / providers.json / plugin-config.json
        │     ├── app-dev-config.json / skill.json / connector.json
        │     ├── framework.json / common.json
        │     └── error.json  (后端 type 映射：error.llm.<LlmErrorCategory>)
        │
        └── 后端 type → 前端按 locale 查表
              ↑ errorCategory (RunErrorInfo, 02-llm-chat.md) ──── 后端发 code（不变）
              │ displayReason 字段 ──────────────────────── 后端兜底 zh-CN（不变，向后兼容）
              │ finish_reason 等 ──────────────────────── 未来同范式（PRD S2）
              └─ 自由文本（error_message / squad name / LLM 回复）─ 原样直展，不进 i18n
```

**对外协作点**：i18n 入口落 `app/web/src/i18n/`（init + bundle 导入 + locale-Init）；locale 选择器落 settings 页 locale group（详见 `specs/ui/overall/03-config-center.md` v0.0.59 段）；displayReason 契约变更见 `specs/api/overall/02-llm-chat.md` v0.0.59 段。

## ④ 核心设计原则（跨文件不变量）

1. **type 走映射、动态文本走直展**——后端可枚举 type（displayReason category / finish_reason）→ 后端发 code、前端按 locale 查 `error.llm.<code>` / `finish.<code>` 表；自由文本（error_message / squad name / session title / LLM 回复）→ 原样展示，不进 i18n。判定流程见 `[P0]i18n_overview.md §6`。→ 一刀切原则：**UI 上能看到 → i18n**（PRD §2.1 划分线）。

2. **占位符四规则（核心）**——(1) 字面文本直展（用户数据走这条）(2) 占位符 key 查 KKV 翻译 (3) 当前语言缺→兜底链 当前→en→zh-CN（始终有文本可见，不空白）(4) 三级全缺→开发期报错「资源 xxx 不存在」（抓漏迁移 key）。→ `[P0]i18n_overview.md §3`

3. **一个 locale 开关驱动**——`app_config.locale.language` 单一开关；前端 i18next 初始化/切换全经此开关；后端**本版本不需要 locale**（displayReason 范式是后端发 code、前端查表，后端透明）；「LLM 输出语言引导」仅开关语义预留，不在本版本。后端产生本地化文案是未来扩展点（HTTP 错误体 / plugin.json label → 后续版本）。→ `[P0]i18n_overview.md §5`

4. **locale 启动期 init（对齐 theme-init BUG-001 范式）**——main.tsx 在任何 React 渲染前 `await initI18nFromConfig()` 读 locale → i18n.use(lng)；避免刷新回退 / 首屏闪烁。复用 `lib/theme-init.ts` 同款「启动期 GET /config/app → 应用」范式（不重新发明）。→ `[P0]i18n_overview.md §4.2`

5. **displayReason 零 API breakage**——后端契约（`RunErrorInfo = { errorCategory, displayReason, errorDetail? }`）**不变**；前端启用 i18n 后**前端侧**优先 `t('error.llm.' + errorCategory)` 查 locale 表、查不到回退 `displayReason` 字段（zh-CN 兜底）；后端 `deriveDisplayReason` 函数保持不变。→ `[P0]i18n_overview.md §7` + `specs/api/overall/02-llm-chat.md` v0.0.59 段

6. **bundle 按 page 模块拆 ns**——ns = 一级 page 目录名（chat / studio / providers / plugin-config / app-dev-config / skill / connector / framework / common / error），物理上一 ns 一 JSON 文件；跨 page 复用文本进 common；后端 type 映射独立 error ns（覆盖 18 个 LlmErrorCategory leaf）。→ `[P0]i18n_overview.md §4.1`

7. **硬边界：不翻译 LLM 向内容 + 用户数据 + 自由文本**——system/agent prompt / 用户输入 / LLM 回复 / squad name / member name / session title（命名后）/ provider label / board 工作项 / user_memory / 用户自建 skill / error_message 一律原样直展。这是 PRD §2.2 Non-goals，i18n 机制不触及这些字段。→ `[P0]i18n_overview.md §2`

8. **type code 走映射、后端 sample 字段走「signal+查表回退」**——可枚举 type（`errorCategory` / `stopReason` / `state` 等）后端发 code、前端按 locale 查 `<ns>.<entity>.<field>.<camelCaseCode>` 表（见 §⑥ 累积表）；后端 sample 字段（zh-CN 兜底文案 + signal bool）保留，前端优先查 locale 表、查不到回退 sample 字段（零 API breakage 范式，详见 `[P0]i18n_overview.md §7/§8` + 本节 §⑥ session.defaultTitle 条目）。

## ⑤ 本目录导航

| 文档 | 管什么（一句话） | 优先级 | 链接 |
|---|---|---|---|
| `i18n_overview.md` | KKV 协议 + bundle 结构 + react-i18next 集成 + locale 开关链路 + type 渲染判定 + displayReason 契约 | P0 | [link]([P0]i18n_overview.md) |
| `manifest_i18n.md` | manifest 占位符协议（`__MSG_<key>__`）+ `resolveI18nField` helper 契约（[P0] §3 在 manifest 场景的扩展） | P1 | [link]([P1]manifest_i18n.md) |

## ⑥ type code 跨版本累积映射表（权威源）

**通用范式**（v0.0.59 §7 抽象）：可枚举 type 字段，后端发 code 字符串不变，前端按 locale 查 `<ns>.<entity>.<field>.<camelCaseCode>` 表；查不到走 §3 兜底链（当前→en→zh-CN）→ 全缺走规则 (4) 报错。**后端永远不直接返回 i18n key 字符串**（避免「key 漏迁移 + 显示 raw key」事故）。

**后端 sample + signal 范式**（v0.0.59 §8 + v0.0.62 扩展）：部分字段后端除 code 外还发 sample 文案（zh-CN 兜底）+ 可选 signal bool；前端优先查 locale 表、查不到回退 sample 字段；signal bool 标识「这是占位/兜底」（用于触发查表 vs 直展判定）。零 API breakage。

| 字段 | 后端契约（不变） | 前端 locale key 模式 | leaf 集合 | 引入版本 |
|---|---|---|---|---|
| `RunErrorInfo.errorCategory`（SSE chat 域） | `LlmErrorCategory` 18 enum code + `displayReason` zh-CN 兜底 + `errorDetail?` 自由文本 | `error.llm.<camelCase>` | 18 leaf（authInvalid/rateLimited/.../abortedByUser，对齐 `display_reason.ts` DISPLAY_REASON_TABLE） | v0.0.59（首版样板） |
| `Run.stopReason`（SSE chat 域，run_end 事件） | `StopReason` 7 enum code（`no_tool_call/no_new_messages/max_iterations/doom_loop/error/require_approval/interrupted`） | `chat.run.stopReason.<camelCase>` | 6 leaf（`error` 走 RunErrorInfo.displayReason 范式，不进表） | v0.0.62 |
| `Session.state`（HTTP+SSE 域） | 5 enum（`idle/running/interrupting/interrupted/error`） | `common.sessionState.<camelCase>` | 5 leaf | v0.0.62 |
| `Member.role`（HTTP 域） | 2 enum（`leader/mate`，**领域术语保留字面英文，不查表**——见 log v0.0.62） | `studio.role.<role>` | 2 leaf（leaf 仍落以备将来扩展；当前组件直展 code） | v0.0.62 |
| `Member.state`（HTTP 域） | 2 enum（`deployed/benched`，**领域术语保留字面英文，不查表**——见 log v0.0.62） | `studio.memberState.<camelCase>` | 2 leaf（同上，备扩展） | v0.0.62 |
| `Board.taskStatus`（HTTP 域） | 5 enum（`pending/in_progress/blocked/done/cancelled`） | `studio.taskStatus.<camelCase>` | 5 leaf | v0.0.62 |
| `Board.reqStatus`（HTTP 域） | 5 enum（同 taskStatus 5 code） | `studio.reqStatus.<camelCase>` | 5 leaf | v0.0.62 |
| `AutoWork.reason`（HTTP 域） | 2 enum（`heartbeat/file-changed`，kebab-case） | `studio.autoWorkReason.<camelCase>` | 2 leaf | v0.0.62 |
| `AutoWork.result`（HTTP 域） | 5 enum（`fired/skipped_busy/skipped_budget/skipped_window/skipped_killswitch`，snake_case） | `studio.autoWorkResult.<camelCase>` | 5 leaf | v0.0.62 |
| `Connector.connection`（HTTP+SSE 域） | 4 enum（`disconnected/connecting/connected/error`，`api-client.ts:732`） | `connector.browser.connection.<camelCase>` | 4 leaf | v0.0.62 |
| `Session.title` 默认占位（HTTP+SSE 域） | `title: string`（占位时字面「新会话」）+ `titled: boolean`（v0.0.47，false=占位） | `chat.session.defaultTitle`（单 leaf，非 code 映射；前端 `titled===false ? 查表 : 直展 title`） | 1 leaf | v0.0.62 |
| HTTP 错误体（4xx/5xx response body） | `{ error: "<自由文本 msg>" }`（部分加 `detail`） | **不查表**（动态自由文本，§2.2 硬边界原样直展） | — | 永不（硬边界） |

> **新增 type code 映射的范式要求**（让本表可持续累积）：
> 1. **后端契约零 breakage**——code 字段值集合不变，最多加新 code（additive）；不删旧 code、不改语义。
> 2. **leaf 命名 = code enum 的 camelCase 形态**——SCREAMING_SNAKE_CASE → camelCase（如 `AUTH_INVALID` → `authInvalid`，`no_tool_call` → `noToolCall`）。
> 3. **后端 sample 字段（如有）与 locale zh-CN 文案一致**——保证「查不到回退 sample」时与「查到 locale」无视觉差异（displayReason 范式要求，见 §8）。
> 4. **禁止后端返回 i18n key 字符串**——避免漏迁移 key 直接暴露给用户。

> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
