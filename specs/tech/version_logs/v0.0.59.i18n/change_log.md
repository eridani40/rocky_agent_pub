# v0.0.59.i18n 技术变更说明（i18n 基础设施首版）

> version: 1.0 · 2026-07-04
> 一句话：搭起中英双语 i18n 基础设施（react-i18next 集成 + locale 开关 + KKV 占位符协议 + 兜底链 + 缺 key 报错）+ displayReason 后端范式样板 + 设置页语言选择器。**只搭框架，不大规模迁移**（页面级迁移走 Batch 2）。
> 概念权威源：`specs/tech/i18n/` KB（`index.md` + `[P0]i18n_overview.md` + `log.md`）。
> PRD：`specs/prd/version_logs/v0.0.59.i18n.md`。

## 1. 新建 KB：specs/tech/i18n/

i18n 是新概念，本版本首次落 KB（concept-first 原则）：

- `index.md`（5 章总起 + 7 条核心设计原则，84 行 ≤120 行硬上限）
- `[P0]i18n_overview.md`（KKV 协议 / bundle 物理结构 / key 命名 / react-i18next 集成 / locale 开关链路 / type vs 动态文本判定 / displayReason 契约 / 文件变更清单）
- `log.md`（位置轴变更日志）

## 2. 核心技术决策

| # | 决策 | 一句话 |
|---|---|---|
| 1 | KKV 占位符协议 + 四规则 | 字面文本直展 / 占位符 key 查 KKV / 当前语言缺→兜底链 当前→en→zh-CN / 三级全缺→开发期报错「【资源 xxx 不存在】」 |
| 2 | bundle 按 page 模块拆 ns | chat / studio / providers / plugin-config / app-dev-config / skill / connector / framework / common / error（10 ns × 2 lng = 20 文件） |
| 3 | key 命名 | dot.notation + camelCase leaf（`<ns>.<scope>.<leaf>`），不用 snake_case / kebab-case |
| 4 | react-i18next init | build-time 静态 import resources + lng from app_config + fallbackLng=['en','zh-CN'] + parseMissingKeyHandler + react.useSuspense=false |
| 5 | 启动期 init（对齐 theme-init BUG-001 范式） | `main.tsx` 任何 React 渲染前 `await initI18nFromConfig()` → 避免首屏闪烁/回退 |
| 6 | type 走映射、动态文本走直展 | 可枚举 type（displayReason category）→ 后端发 code、前端按 locale 查 `error.llm.<code>` 表；自由文本（error_message / 用户数据 / LLM 回复）原样直展 |
| 7 | displayReason 零 API breakage | 契约 `{ errorCategory, displayReason, errorDetail? }` 不变；前端启用 i18n 后前端侧按 errorCategory 查 locale 表、查不到回退 displayReason 字段（zh-CN 兜底） |
| 8 | 后端本版本不需要 locale | displayReason 范式 = 后端发 code、前端查表，后端透明；后端产生本地化文案（HTTP 错误体 / plugin.json label）= 未来扩展点 |

## 3. KKV 占位符协议（核心）

`KKV` = key × language → value。前端渲染一段文本按四规则顺序判定：

| 规则 | 输入 | 输出 |
|---|---|---|
| (1) 字面文本 | 用户数据 / 动态自由文本 / LLM 回复 | 直接展示，不查表 |
| (2) 占位符 key | i18n key（`<ns>.<scope>.<leaf>`，由前端硬编码 `t(key)`） | 按 lng 查 KKV 翻译 |
| (3) 当前语言缺翻译 | key 在当前 lng 缺 | 当前 → en → zh-CN 兜底（始终有文本可见） |
| (4) 三级全缺 | key 所有 lng 都不存在 | 开发期报错「【资源 xxx 不存在】」+ 渲染位置红字占位 |

**判定责任在调用方**：前端组件硬编码 `t(key)` 即声明「这是占位符」；后端不返回 i18n key 字符串。

## 4. 实现产出

| 文件 | 操作 | 摘要 |
|------|------|------|
| `app/web/package.json` | 修改 | += `i18next` + `react-i18next` |
| `app/web/src/i18n/index.ts` | 新增 | i18next instance + `initI18n(lng)` 工厂 + 导出 instance |
| `app/web/src/i18n/change-language.ts` | 新增 | `changeLanguage(lng)`：i18next.changeLanguage + `<html lang>` + PUT 持久化 |
| `app/web/src/i18n/llm-error-category.ts` | 新增 | `camelCaseCategory()` SCREAMING_SNAKE→camelCase + `localizedDisplayReason()` 查表回退 helper |
| `app/web/src/i18n/locales/{zh-CN,en}/*.json` | 新增 | 10 ns × 2 lng = 20 文件；common + error 实质覆盖（error 18 leaf），其他 8 ns 起骨架 |
| `app/web/src/lib/locale-init.ts` | 新增 | `initI18nFromConfig()`：GET /config/app?group=locale → initI18n；对齐 theme-init 范式 |
| `app/web/src/main.tsx` | 修改 | main() += `await initI18nFromConfig()`；createRoot 包 `<I18nextProvider>` |
| `app/web/src/components/app-dev-config-page/component-locale-card.tsx` | 新增 | locale group 语言选择器卡片（primitive-key-choice-cards 范式，testid `key-card-locale-language*`） |
| `app/web/src/components/chat/*`（displayReason 渲染处） | 修改 | displayReason 渲染改用 `localizedDisplayReason()`（查表回退） |
| `app/server/src/llm/caller/display_reason.ts` | **不改** | 后端兜底表保持现状（zh-CN 与前端 error.json zh-CN 一致，作向后兼容兜底） |

## 5. 验证

- **AT 2/2 pass**：覆盖 locale 读写（GET /config/app?group=locale + PUT 持久化）+ displayReason 契约（errorCategory code 不变 + zh-CN 兜底字段不变）。
- **ET**：用户自测（executor skip），case 在 `tests/e2e/i18n/`。
- **代码-spec 一致性**：见 §6 修正记录。

## 6. spec 偏差回填（MANDATORY，原则 12/13）

实施过程发现 spec 与代码 / 实测不一致，全部回填：

| # | 偏差 | 修正 |
|---|---|---|
| 1 | **displayReason 18 keys（不是 19）** | 后端 `DISPLAY_REASON_TABLE` 实测 18 行（`MAX_TOKENS_TOO_HIGH` 只出现一次）；前端 `error.json` zh-CN/en 各 18 leaf 一一对应。原 spec 多处「19 个 LlmErrorCategory」「17 行 + rev2 2 个 = 19」均修正为 18。涉及 `i18n_overview.md §1/§7/§8` + `index.md` 设计原则 6 + `02-llm-chat.md §1 [v0.0.25 rev2]/[v0.0.59]` + `04-agent-session.md §10 路径 C` |
| 2 | **fallbackNS 不自动跨 ns fallback** | react-i18next v15 数组 ns `useTranslation(['chat','common'])` **不自动跨 ns fallback**（需 init 配 `fallbackNS`，本版本 T1 未设）。修正 `i18n_overview.md §5.3`：跨 ns 取值用 `t(key,{ns:'common'})` 显式 或 `t('common:key')` 前缀；`fallbackNS` 列为后续优化项 |
| 3 | **GET /session/:id currentRun.error 契约澄清** | 实测 state=error + eager-drain（currentRunId=null）时响应**无 currentRun/error 字段**。修正 `02-llm-chat.md §1 [v0.0.25 rev2]` + `04-agent-session.md §10 路径 C`：`currentRun.error` 仅在 state=running 且 currentRunId≠null 时存在；error 态读 SSE error 事件或 history run（RunRecord） |
| 4 | **testid 同步 page-app-settings** | `i18n_overview.md §9` 挂载点 testid 修正为 `page-app-settings`（对齐 v0.0.47 设置页合并重构 + `03-config-center.md §2.2 [v0.0.59 corrected]`，原 spec 误写 `page-app-config`） |
| 5 | **§8 JSON 重复行** | `i18n_overview.md §8` JSON 文本 `maxTokensTooHigh` 重复（第 9 + 倒数第 2 行），去重到 18 行（与代码 error.json 一一对应） |
| 6 | **§10 文件清单补 helper** | 实现新增 `i18n/change-language.ts` + `i18n/llm-error-category.ts` 两个独立 helper 文件（spec 原表未列），补入 `i18n_overview.md §10` |
| 7 | **§9 component-locale-card 路径** | 实际 locale 卡片是独立组件 `component-locale-card.tsx`（不复用 component-key-card，因 testid 范式不兼容），`i18n_overview.md §10` 补正 |

## 7. 跨 KB 协同

- `specs/tech/config/[P0]app_config.md §3.3` locale group（已预留，本版本直接复用，读写经 `AppConfigService.get/set("locale","language")`）
- `specs/api/overall/02-llm-chat.md §1 [v0.0.59 modified]` displayReason 契约「字段不变、前端侧改用 errorCategory 查 locale 表」（向后兼容）
- `specs/api/overall/04-agent-session.md §10 路径 C [v0.0.59 corrected]` currentRun.error 契约澄清
- `specs/ui/overall/03-config-center.md §2.2 [v0.0.59 corrected] + §2.3a` 设置页 locale group 加语言选择器 + testid 表
- `specs/prd/overall/04-config-center-ui.md §3.9.2 [v0.0.59 modified]` app 配置页特有 group 补 locale
- `specs/tech/app/frontend/[P0]tech_stack.md` v0.0.59 段（react-i18next + i18next 依赖注释，由 coder 阶段同步）

## 8. 后续（不在本版本）

- **Batch 2**：首批高频页面迁移（chat-page / studio-page / providers）+ 梳理整个配置体系 i18n 清单。
- **fallbackNS**：如发现重复样板代码，再考虑 init 加 `fallbackNS: 'common'`。
- **后端产生本地化文案**：HTTP 错误体 i18n + plugin.json label i18n。
