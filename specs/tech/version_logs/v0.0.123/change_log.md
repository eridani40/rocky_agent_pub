# v0.0.123 变更发布说明 — web search provider 拆分（zhipu_coding_plan / zhipu_api）

> 版本轴发布说明（method 级契约见同目录 `change_plan.md`）。本版把 web_search 内置 Zhipu provider 从 1 个拆成 2 个独立 ext impl，无新概念——仅在已有 `web_search_provider` list EP 上多一个 impl + implId 更名 + 一次性配置迁移。
> 决策锁定（用户 2026-07-12 裁决）：implId=`zhipu_coding_plan`（现 MCP 实现改名）/ `zhipu_api`（从 git `0b64ae54^` 恢复的 REST 实现）；迁移方向 `credentials.zhipu` → `credentials.zhipu_coding_plan`（现有 key 实为 coding plan key）；UI 展示名带计费说明；spec 以两 impl 真实行为为准。

## 一句话

web_search 智谱链路拆两条：`zhipu_coding_plan`（MCP `open.bigmodel.cn/api/mcp/web_search_prime/mcp`，两步 initialize→tools/call，Coding Plan 订阅额度）+ `zhipu_api`（REST `/api/paas/v4/web_search`，按量计费），各 key 隔离、各一个 apiKey，type 下拉 1→2 项。老用户旧 `zhipu` 配置启动时一次性迁到 `zhipu_coding_plan`。**前端 `.tsx` 零改动**（组件已 implId-agnostic），`WebSearchProvider` 协议 / list EP / `resolveProvider` 路由零改动。

## 核心设计原则（跨文件不变量）

- **INV-1（同 EP 多 impl 共存，单点路由）**：两 impl 都注册在 `web_search_provider` list EP（scope `default.yaml` 列 `[zhipu_coding_plan, zhipu_api]`），tool 按 `app_config.web_search.type` 精确路由一个，不并发融合。
- **INV-2（凭证按 implId 隔离）**：凭证唯一源 = `app_config.web_search.credentials.<implId>.apiKey`；两 impl 各读自己的 entry，key 不共享。
- **INV-3（label 必区分）**：两 impl `label` getter 返回不同文案（`智谱 · Coding Plan（订阅额度）` / `智谱 · API（按量计费）`），供 ToolError `{label}` 区分是哪条链路失败。
- **INV-4（迁移幂等非破坏，marker=type）**：`type==='zhipu' && credentials.zhipu` 存在才迁；迁后 `type='zhipu_coding_plan'` 不再命中 → 幂等；apiKey 值原样保留、不清其他 credentials entry、无旧 record 不写盘、catch 不 throw 阻塞 bootstrap。
- **INV-5（i18n 键精确对应 implId）**：下拉 option label 走 `resolveI18nField(impl.description)`，i18n 键 `plugin.builtin.zhipu_web_search.impl.<implId>.description` 必须与 extImpls implId 精确一致，否则渲染成【资源X不存在】。

## 变更文件（tech spec）

- **`agent/tools/[P1]web_search_tool.md` §1/§7/§8**：§1 概述补「内置 provider [v0.0.123] 拆 2 个独立 impl」；§7 从单 provider 记成 2 个（表格：implId/本质/端点协议/计费/impl 文件 + 拆分动机 + 共性契约 + plugin.json 2 extImpls + 两 API 块）；收口 §7 余下架构期历史内容（删旧单 impl `get label(){return 'Zhipu 智谱'}` 示例、单 `credentials.zhipu.apiKey`，改两 impl 并列骨架 + `<implId>` 占位）；§8 边界表 Zhipu provider → 两 impl。frontmatter `updated` → 2026-07-12。
- **`config/[P0]app_config.md` §3.6**（architect 已更新，doc-modifier 复核确认）：`data.type` 示例 `zhipu`→`zhipu_coding_plan`；credentials map 示例含 2 键；补一次性迁移机制记录（`migrateWebSearchProviderId`，marker=type，幂等非破坏，落点 bootstrap）。
- **`config/[P0]ext_impl_scope.md` §8.5**：scope 激活行补「[v0.0.123] `[zhipu]`→`[zhipu_coding_plan, zhipu_api]` 两 impl 均 default 激活」。

## 变更文件（api / ui / prd overall）

- **`api/overall/08-web-tools.md` §2/§5**（→ v1.2.2）：内置 Zhipu 单 implId → 两 impl；§2.2 `resolveProvider` 从过时 exclusive `getExclusiveExtension` 补账为 v0.0.72 list 单点路由三态；inventory 透传 impls 两 impl + choice-cards→下拉（v0.0.121）。HTTP 契约不变。
- **`api/overall/03-config-center.md` §2.1**（→ v1.8.2）：web_search group data schema 样例 implId `zhipu`→两 impl。端点/schema/redact 全不变，仅样例值。
- **`prd/overall/07-web-tools.md`**（→ v1.4）：§7.1 能力表 / §7.1.3 / §7.2.1 内置 provider 段（两 impl 表 + 迁移说明）/ §7.5.2 设计决策。
- **`ui/overall/03-config-center.md` §2.3b**（→ v1.7）：web_search section type 下拉 1→2 option，testid 示例 `-opt-{implId}` 更新。控件/组件形态不变。
- **`ui/components/app-dev-config-page/section-web-search-config/_overview.md`**（coder 编码前置更新，doc-modifier 复核确认与实现一致）：§4 credentials 2 impl、§6 testid 契约、§6.1 i18n 键随 implId、§4 组件零改动说明。

## 实现落点

- plugin：`app/plugins/builtins/zhipu_web_search/plugin.json`（2 extImpls，plugin id 不变）；`zhipu-coding-plan-provider.ts`（现 MCP 实现 `git mv` 自 `zhipu-provider.ts`，label + 头注释改）；`zhipu-api-provider.ts`（从 git `0b64ae54^` 恢复 REST 实现，删泄漏 key 后缀的 `console.log`，label + 头注释）；`app/plugins/scopes/default.yaml`（`web_search_provider.impls: [zhipu_coding_plan, zhipu_api]`）。
- i18n：`app/web/src/i18n/locales/{zh-CN,en}/plugin-config.json`（`impl.zhipu` 拆 `impl.zhipu_coding_plan` + 新增 `impl.zhipu_api`，中英文全补，description 含端点+计费）。
- 迁移：`app/server/src/config/migrate-web-search-provider.ts`（新，`migrateWebSearchProviderId`）；`app/server/src/bootstrap.ts`（AppConfigService init 后、路由挂载前 `await migrateWebSearchProviderId(appConfig)`，对齐 `migrateUserMemoryToAppConfig` 调用点）。
- 前端：`section-web-search-config.tsx` **零代码改动**（已 implId-agnostic，2 impl 自动出现在下拉）。

## 事后偏差（doc-sync 记录 — orchestrator 已裁决接受，仅测试层，不触发 spec 同步）

- **偏差 1（UT mock 层）**：`zhipu-api-provider.test.ts` mock 层由 change_plan 提示的 `undici` fetch 改为 `proxyFetch`（provider 实际经 `pickWebFetch(registry) ?? proxyFetch` 出站，mock undici 拦不住；且 vitest live binding + 绝对路径 gotcha）。断言语义不变（凭证透传 / 空 key 抛错 / 映射）。
- **偏差 2（rename 测试断言对齐 MCP）**：`zhipu-coding-plan-provider.test.ts`（rename 自 `zhipu-provider.test.ts`）的 search 断言由旧 REST 契约更新为 MCP 两步协议（旧断言基于 v0.0.121 前 REST 实现，与现 MCP impl 不符）。

## 测试模式变化 + 遗留债

- **web_search 3 个 AT case 改 `llm:off`**（`ws_zhipu_tc1` / `ws_no_key_tc1` / `ws_degrade_tc1`）：record/replay 框架对 forked-agent 的 `session_hint` 有基线债（录制无法稳定命中），本版本绕过走真 LLM smoke（`off`，白名单）。AT 门禁 3/3 pass。**遗留债**：forked-agent session_hint record/replay 基线债未修（非本版本引入、非本版本改动范围），另立调查，不进本版本门禁。
- **`zhipu_api` REST 真调用不测**（用户 2026-07-12 裁决，无可用 REST key，本 key 走 REST 报 1113 余额不足）：`ws_zhipu_api_tc1` 移出白名单但保留文件。路径 2 覆盖 = provider UT + ET 配置保存。
- **ET 放弃**（用户 2026-07-12 裁决「放弃et」）：`web_search_provider_switch` 移出门禁、不再修复（文件保留，step1-5 pass 证据留存）；版本门禁白名单 = 仅 AT 3。PRD 路径 2 前半 / 路径 3 的 UI 保存链路无自动化覆盖。
