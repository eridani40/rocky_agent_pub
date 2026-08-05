---
type: change_log
title: v0.0.72 — web_search 协议重构 + 应用设置网络搜索 section + UI bugs（ws-tab/model-tag/path-bar）
version: v0.0.72
date: 2026-07-05
related_prd: specs/prd/version_logs/v0.0.72.md
related_change_plan: specs/tech/version_logs/v0.0.72/change_plan.md
related_api_log: specs/api/version_logs/v0.0.72.md
grounded: PRD §2 (Bug1.1–1.7) + §3 (UIFix1/2/3) + 锁定决策 D1=A/D2（states/user_query.md v0.0.72 节 + states/v0.0.72/task-board.md）
---

# v0.0.72 — web_search 协议重构 + 应用设置网络搜索 section + UI bugs

> 一句话：**EP `exclusive`→`list` + 协议加 cfg + 凭证迁 `app_config.web_search` + Zhipu 删 env 回退 + 应用设置新增「网络搜索」自渲染 section + 3 个 UI bug 修复（ws-tab 换行 / model 名宽度 / path-bar hover 打开按钮）**。

## 1. 动机

v0.0.23 落地的 `web_search` 用 `exclusive` EP + 凭证走 ext impl `configSchema`。问题：

1. **EP exclusive 强单选**：用户想切换 provider 必须先停用旧 impl 才能装新的，体验割裂；多 provider 共存更自然（list）。
2. **凭证走 ext impl configSchema**：与 v0.0.67 D1「secret 不进代码声明」政策冲突——apiKey 进 plugin manifest schema 即进代码声明，落盘 scopes/*.json 也带 apiKey 槽位。凭证应归应用配置层。
3. **协议无 cfg 入参**：impl 被迫从 `this.cfg` / env 读凭证，与「impl 无状态、tool 提供运行时上下文」原则相悖；多 provider 共存时凭证隔离也难表达。
4. **UI 三 bug**：窄宽度 ws-tab 文案换行 / model 名超长撑宽 topbar / path-bar 缺「打开文件夹」入口。

## 2. 变更总览

### 2.1 EP + 协议 + tool 路由（tech `agent/tools` + `plugin_system`）

- `WebSearchProviderPoint.cardinality` 由 `exclusive` → `list`（`extension-point.ts:194-199`，`scopes/default.json` 删 `exclusivePicks.web_search_provider`）。
- `WebSearchProvider` 协议 `search(query, opts, cfg, signal?)` + `isAvailable(cfg)` 加 `cfg: WebSearchCfg = Record<string, unknown>` 入参（`web-search/types.ts`）。
- `web_search` tool `resolveProvider` 重写：读 `appConfig.get("web_search","default")` 取 `{type, credentials}` → 按 `type` 在 list EP 中精确匹配 `impl.id` → `cfg = credentials[type] ?? {}` 传 `impl.isAvailable/search`（不取首个、不静默回退，三错误分支均返 ToolError）。
- **协议契约 §2 仍写必传**（impl 必须接收 cfg）；zhipu impl `isAvailable(cfg = {})/search(..., cfg = {})` 加默认值是防御性实现，不改变协议（coder 汇报偏离 2，已确认非静默偏离）。

### 2.2 凭证迁 app_config（tech `config`）

- 新增 `app_config.web_search` group（单实例 `key="default"`，`data.{type, credentials}`，§3.6）；端点 `GET/PUT /config/app?group=web_search`。
- zhipu impl `plugin.json` 删 `configSchema.apiKey`（凭证不进 manifest）；删 `process.env.ZHIPU_SEARCH_API_KEY` 回退（凭证唯一源 = app_config）。
- `scopes/default.json` `_meta.secretPolicy` 文案对齐（apiKey 不再走 dev config / env）。

### 2.3 UI bugs（ui `chat-page`）

- **UIFix1**（ws-tab 换行）：`.ws-tabs` `overflow:hidden` + `.ws-tab` `white-space:nowrap; flex-shrink:0`（`component-ws-tab-bar.tsx`）。
- **UIFix2**（model 名宽度）：非 readOnly 分支 `ModelPicker` trigger `w-[180px]`（替换 `min-w-[160px]`）+ `white-space:nowrap; overflow:hidden; text-ellipsis` + `title` 含完整 modelId；readOnly 分支 `chat-model-tag` `max-w-[180px]` + 同款 nowrap/ellipsis + `title` 含 modelId（`section-chat-detail.tsx`）。
- **UIFix3**（path-bar 打开按钮）：`.ws-path` 改 flex 容器 + 右侧 hover 按钮 testid `ws-path-open`，`opacity:0` 默认 + `.ws-path:hover` `opacity:1` + `flex-shrink:0` 预留 22×22 空间（零布局位移），点击触发 `openWorkspaceItem(sessionId, {path:".", kind:"folder"})`（复用父级链路，不在 path-bar 内 fetch）。

## 3. 偏离项（coder/reviewer 汇报 → doc-modifier 已同步进 spec）

| # | 偏离 | 类型 | spec 同步位置 |
|---|------|------|--------------|
| 1 | `scopes/default.json` 删 `exclusivePicks.web_search_provider`（change_plan §A 未列，是 cardinality 改 list 强制下游） | change_plan 漏列 | `tech/agent/tools/log.md` v0.0.72 段 + `tech/config/[P0]ext_impl_scope.md §8.5` |
| 2 | zhipu `isAvailable(cfg={})`/`search(...,cfg={})` 加默认值 | 防御性，协议契约不变 | `tech/agent/tools/[P1]web_search_tool.md §2` 仍写必传 |
| 3 | `scopes/default.json` `_meta.secretPolicy` 文案「由 dev config / env 注入」已过时 | 文案过时 | `tech/config/log.md` v0.0.72 段标注 |
| 4 | `chat-model-tag.title = \`${modelTag} · ${model.modelId}\`` / `ModelPicker.trigger.title = \`${providerId} / ${modelId}\``（change_plan §C 写 `{modelTag}`/`{modelLabel}` 是笔误） | change_plan 笔误 | `change_plan §C` 加 doc-sync 注 + spec `_overview.md §4.4` 已写「title 显示完整 modelId」对齐 |
| 5 | 新增 i18n key `group.web_search.label`（zh-CN「网络搜索」/ en「Web Search」）+ `webSearch.{empty,typeLabel,apiKeyLabel,save,reset,saving}` 6 key 双语言（ns `app-dev-config`） | 新增 i18n key | `ui/components/app-dev-config-page/page-app-settings-merged.md §i18n key` + `section-web-search-config/_overview.md §6.1` |

## 4. 影响（下游 agent 须知）

- **web_search tool 调用方**：无需改 LLM 调用（tool schema 不变）；凭证配置入口从「插件配置 → zhipu configSchema」迁到「应用设置 → 网络搜索」section。
- **插件开发者**：贡献新 web_search provider（Tavily/Google/Bing）时，凭证字段需在 `app_config.web_search.credentials.<implId>` 注册（UI 按 type 硬编码字段集，YAGNI，非由 configSchema 驱动），plugin manifest 不再声明 secret 字段（对齐 v0.0.67 D1）。
- **e2e-test-designer**：新增「应用设置 → 网络搜索」section 的 testid 见 `section-web-search-config/_overview.md §6`（`web-search-section` / `web-search-type-{implId}` / `web-search-cred-{implId}-apiKey` / `web-search-save` / `web-search-reset` / `web-search-empty`）；chat-page 新增 testid `ws-path-open`（`component-workspace-panel.md §6`）。

## 5. 验收口径

- UT：`web-search.test.ts` 三路径（UC-1/2/3）+ `zhipu-provider.test.ts`（cfg 透传 + key 空抛错）+ `extension-point.test.ts` cardinality=`list` 断言 + `model-picker-width.test.tsx`（trigger `w-[180px]` + chat-model-tag `max-w-[180px]` + title 含 modelId）+ `section-web-search-config.test.tsx`（testid + PUT body）+ `component-ws-path-bar.test.tsx`（ws-path-open click）+ `component-ws-tab-bar.test.tsx`（nowrap）。
- AT：`web_search` 工具真服务路径（apiKey 配好/空/type 未知）。
- ET：应用设置 → 网络搜索 section 切换 type + 保存 + 持久化；chat topbar 长名 modelId 截断 + hover title；ws-path-bar hover 打开按钮。
