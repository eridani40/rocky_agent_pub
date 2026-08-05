# v0.0.123 变更计划书 — web search provider 拆分（zhipu_coding_plan / zhipu_api）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> **上游权威源**：PRD `specs/prd/version_logs/v0.0.123/{change_log.md,user-paths.md}`（已用户确认）+ task.json decisions（implId=`zhipu_coding_plan`/`zhipu_api`；迁移带 marker 幂等非破坏；UI 展示名带计费说明）。
>
> **核心事实（架构核对结论，落行前已 grep/读代码验证）**：
> - 现 `app/plugins/builtins/zhipu_web_search/` 单 plugin、单 extImpl（implId=`zhipu`），impl 文件 `zhipu-provider.ts` 是 **MCP 实现**（`ZHIPU_MCP_URL = open.bigmodel.cn/api/mcp/web_search_prime/mcp`，v0.0.121 改）。
> - 旧 REST 实现在 `git show 0b64ae54^:app/plugins/builtins/zhipu_web_search/zhipu-provider.ts`（端点 `/api/paas/v4/web_search`，`ZHIPU_URL`，父版本已是 v0.0.72 后契约：`isAvailable(cfg)`/`search(query,opts,cfg,signal?)` 凭证从入参 cfg 读，直接可用）。
> - **前端 `section-web-search-config.tsx` 已完全 implId-agnostic**（`impls.map` 动态生成 options、credentials 按 `draft.type` 渲染、testid 模板 `web-search-cred-${draft.type}-apiKey`）→ **零 `.tsx` 代码改动**，2 impl 自动出现。仅 i18n key + 注释/spec doc-sync。
> - `resolveProvider`（`tool.ts`）已按 `type` 精确匹配 `impl.id`，多 impl 天然枚举 → **零路由改动**（PRD §6.2 OUT）。
> - scope 文件是 **YAML**（`app/plugins/scopes/default.yaml`，非 task 提示的 json）；`web_search_provider → impls: [zhipu]`（L109-111）。
> - `build-plugins.ts` 按 `manifest.extImpls[].impl` 循环编译（L50-53）+ copyResources 按 plugin.json（L90-108）→ **加第二 extImpls entry 自动覆盖**，无脚本改动。EXTERNALS 已含 `@app/server`/`undici`（L30）；REST impl 仅用 `proxyFetch`（`@app/server/dist`）无新第三方依赖。
> - 迁移范式参考 `migrate-v0.0.55.ts`（bootstrap 调用、幂等、无阻塞）；本迁移 marker = `type` 字段本身（`type==='zhipu'` 才迁，迁后变 `zhipu_coding_plan` 不再命中，天然幂等非破坏）。

---

## 决策一览（每条在下表落行）

| # | 决策点 | 结论 | 理由 |
|---|---|---|---|
| D1 | plugin 组织 | **单 plugin `zhipu_web_search` 承载 2 个 extImpls**（2 条 entry + 2 个 impl 文件） | 直接沿用 `llm_anthropic`（1 plugin 2 extImpls）范式；同源智谱链路归一个 plugin 概念更清晰、scope 一处激活；拆两 plugin 无收益徒增 manifest/scope 冗余 |
| D2 | 旧 REST 恢复 | 从 `git show 0b64ae54^:...zhipu-provider.ts` 恢复为 `zhipu_api` 的 impl 文件（新文件名 `zhipu-api-provider.ts`）；父版本已 v0.0.72 后契约，直接可用；**须删旧文件里泄漏 key 后缀的 `console.log`**（`console.log('[zhipu-provider] key=...${apiKey.slice(-10)}')`——安全清理） | D5 用户裁决 |
| D3 | 一次性迁移机制 | bootstrap 调用的启动迁移 `migrateWebSearchProviderId(appConfig)`，marker=`type` 字段本身（`type==='zhipu' && credentials.zhipu` 存在才迁）；幂等、非破坏、无 marker 破坏性改写 | app_config 迁移惯例（migrate-v0.0.55）+ memory `runtime-no-ext-policy-write` |
| D4 | i18n | 2 impl 各自 `impl.<implId>.description` i18n（下拉 option label）中英文全补；impl `label` getter（后端 ToolError `{label}`）区分文案 | 项目铁律：缺 key 渲染成【资源X不存在】 |
| D5 | 前端 UI | **零 `.tsx` 代码改动**（组件已 implId-agnostic）；仅更新组件 spec `_overview.md` §4/§6（stale「当前仅 zhipu」）+ i18n | 核对代码实证（section-web-search-config.tsx 全动态） |
| D6 | 可打包护栏 | 无脚本改动（build-plugins 自动覆盖新 extImpls）；无新第三方依赖（REST 用 proxyFetch）；无新运行时 env 键；无路径问题 | CLAUDE.md 护栏自检通过 |

---

## 变更清单（行 = 一个函数/符号）

### 模块 A：plugin manifest + scope 注册（implId 更名 + 加第二 impl）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| web-search-plugin | app/plugins/builtins/zhipu_web_search/plugin.json | `extImpls[0]` (implId `zhipu`→`zhipu_coding_plan`) | 修改 | 第一条 extImpl 的 `implId` 改 `zhipu_coding_plan`、`impl` 指向 `./zhipu-coding-plan-provider.ts`、`description` 占位符改 `__MSG_plugin.builtin.zhipu_web_search.impl.zhipu_coding_plan.description__` | MUST 保持 `point:"web_search_provider"`；MUST NOT 改 plugin `id`（保持 `zhipu_web_search`，避免 policy/scope 连锁） | web_search_tool §7；D1 | +0/-0(改 3 值) |
| web-search-plugin | app/plugins/builtins/zhipu_web_search/plugin.json | `extImpls[1]` (新增 `zhipu_api`) | 新增 | 加第二条 extImpl entry：`implId:"zhipu_api"`、`point:"web_search_provider"`、`impl:"./zhipu-api-provider.ts"`、`description:"__MSG_plugin.builtin.zhipu_web_search.impl.zhipu_api.description__"` | MUST 同 EP `web_search_provider`（list EP 多 impl 共存）；参照 llm_anthropic 2-extImpls 结构 | web_search_tool §3；D1 | +6 |
| web-search-plugin | app/plugins/scopes/default.yaml | `web` group → `web_search_provider.impls` | 修改 | `impls` 数组由 `[zhipu]` 改 `[zhipu_coding_plan, zhipu_api]`（两 impl 均在 default scope 激活，随插件激活即在 EP 列表） | MUST 两 impl 都列（否则 EP 只枚举一个，缺失 impl 走 ToolError「impl 未激活」）；MUST NOT 引入 exclusivePicks（list EP 不适用） | ext_impl_scope §8.5；web_search_tool §5.4 | +2/-1 |

### 模块 B：impl 文件（现 MCP 重命名 + REST 恢复）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| web-search-plugin | app/plugins/builtins/zhipu_web_search/zhipu-coding-plan-provider.ts | (文件 rename from `zhipu-provider.ts`) | 修改 | 现 MCP 实现文件重命名（`git mv zhipu-provider.ts → zhipu-coding-plan-provider.ts`），内容不改逻辑 | MUST `git mv` 保留 history；MUST NOT 改 MCP 端点/协议逻辑（仅 rename + 见下 label） | web_search_tool §7；D2 | rename |
| web-search-plugin | app/plugins/builtins/zhipu_web_search/zhipu-coding-plan-provider.ts | `ZhipuWebSearchProvider.label` getter | 修改 | label getter 返回值改为可区分文案（如 `'智谱 · Coding Plan（订阅额度）'`），供 ToolError `{label}` 区分两 provider | MUST 与另一 impl label 不同（否则错误提示无法区分）；label 是后端运行时字符串（非 i18n），中英混排可接受 | web_search_tool §4 错误分支；PRD §5 | +1/-1 |
| web-search-plugin | app/plugins/builtins/zhipu_web_search/zhipu-coding-plan-provider.ts | 文件头 doc-comment | 修改 | 头注释 implId 描述 `implId=zhipu` → `implId=zhipu_coding_plan`（对齐真实行为） | MUST 仅注释同步，不改行为 | web_search_tool §7 | +2/-2 |
| web-search-plugin | app/plugins/builtins/zhipu_web_search/zhipu-api-provider.ts | (新文件，从 git 恢复) | 新增 | 从 `git show 0b64ae54^:app/plugins/builtins/zhipu_web_search/zhipu-provider.ts` 恢复 REST 实现；`class ZhipuWebSearchProvider`（default export）+ `mapZhipuResults`（named export）+ `ZHIPU_URL`+`resolveApiKey`+`safeReadText` 等 helper | MUST 契约与现 impl 一致（`isAvailable(cfg)`/`search(query,opts,cfg,signal?)`，凭证从入参 cfg.apiKey）；MUST 走 `proxyFetch`+`pickWebFetch`（record/replay 兼容）；MUST NOT 引入新第三方依赖 | web_search_tool §7；v0.0.72 契约；D2 | +~215 |
| web-search-plugin | app/plugins/builtins/zhipu_web_search/zhipu-api-provider.ts | `console.log('[zhipu-provider] key=...')` | 删除 | **删除旧文件泄漏 key 后缀的 `console.log(\`[zhipu-provider] key=...${apiKey.slice(-10)}\`)`**（凭证不得进日志） | MUST 删除（安全）；恢复文件时不得保留此行 | 安全第一（架构原则）；debug 遗留 | -1 |
| web-search-plugin | app/plugins/builtins/zhipu_web_search/zhipu-api-provider.ts | `ZhipuWebSearchProvider.label` getter | 修改 | label getter 返回 `'智谱 · API（按量计费）'`（与 coding_plan impl 区分） | MUST 与另一 impl label 不同 | web_search_tool §4；PRD §5 | +1/-1 |
| web-search-plugin | app/plugins/builtins/zhipu_web_search/zhipu-api-provider.ts | 文件头 doc-comment | 修改 | 头注释标 `implId=zhipu_api`（REST /api/paas/v4/web_search 按量计费链路） | MUST 注释描述端点/计费与 impl 一致 | web_search_tool §7 | +3/-1 |

### 模块 C：一次性迁移（bootstrap 启动迁移）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| config-migration | app/server/src/config/migrate-web-search-provider.ts | `migrateWebSearchProviderId(appConfig)` | 新增 | 启动一次性迁移：读 `appConfig.get('web_search','default')`；若 `data.type==='zhipu'` 且 `data.credentials?.zhipu` 存在 → 写回 `{type:'zhipu_coding_plan', credentials:{...其余, zhipu_coding_plan: credentials.zhipu}}`（删 `credentials.zhipu` 旧 entry），经 `appConfig.set('web_search','default', newData)` 落库；否则 no-op。返回 `Promise<void>` | MUST 幂等（marker=type 字段：`type!=='zhipu'` 即跳过，迁后不再命中）；MUST 非破坏（apiKey 值原样保留、不清其他 credentials entry）；MUST NOT 在无旧 zhipu record 时写盘（no-op）；MUST NOT throw 阻塞 bootstrap（try/catch warn） | app_config §3.6；migrate-v0.0.55 范式；memory `runtime-no-ext-policy-write`；D3 | +~55 |
| config-migration | app/server/src/bootstrap.ts | boot 序列（AppConfigService init 后） | 修改 | 在 `const appConfig = new AppConfigService(...)` 之后、`migrateUserMemoryToAppConfig` 附近 `await migrateWebSearchProviderId(appConfig)` + import | MUST 位置在 appConfig 初始化后、handler 路由挂载前（启动一次性迁移范式，对齐 migrateUserMemoryToAppConfig 调用点 L328） | bootstrap.ts L322-329；D3 | +2 |

### 模块 D：i18n（impl 描述 — 下拉 option label；中英文全补）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| i18n | app/web/src/i18n/locales/zh-CN/plugin-config.json | `plugin.builtin.zhipu_web_search.impl` | 修改 | `impl.zhipu` 键改名/拆为 `impl.zhipu_coding_plan`（description=`智谱 · Coding Plan（订阅额度）· web_search_prime MCP 端点`）+ 新增 `impl.zhipu_api`（description=`智谱 · API（按量计费）· /api/paas/v4/web_search REST 端点`）；各保留 `config.apiKey.description` | MUST 键名与 extImpls `implId` 精确对应（下拉 label 走 `resolveI18nField(impl.description)`）；MUST 中英文两 locale 同步补齐 | UI spec §3/§6.1；i18n 铁律；D4 | +6/-3 |
| i18n | app/web/src/i18n/locales/en/plugin-config.json | `plugin.builtin.zhipu_web_search.impl` | 修改 | 同上 en 版：`impl.zhipu_coding_plan.description=Zhipu · Coding Plan (subscription) · web_search_prime MCP endpoint`、`impl.zhipu_api.description=Zhipu · API (pay-as-you-go) · /api/paas/v4/web_search REST endpoint` | MUST 与 zh-CN 键结构一致（同键名不同文案） | 同上；D4 | +6/-3 |

### 模块 E：spec 更新（以真实行为为准 — D4 用户裁决；tech + UI 组件 spec）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tech-spec | specs/tech/agent/tools/[P1]web_search_tool.md | §7 内置 Zhipu provider | 修改 | §7 从 1 个 provider 记成 2 个：`zhipu_coding_plan`（MCP `open.bigmodel.cn/api/mcp/web_search_prime/mcp`，Streamable HTTP+JSON-RPC 2.0 两步 initialize→tools/call，订阅额度）+ `zhipu_api`（REST `/api/paas/v4/web_search`，按量计费）；plugin.json 示例更新为 2 extImpls；两 impl 文件名标注 | MUST 记真实端点/协议（MCP 两步握手细节从现 impl 抄）；MUST 标注 D4「spec 以真实行为为准」出处 | web_search_tool 现状；D4 | +~40/-~20 |
| tech-spec | specs/tech/config/[P0]app_config.md | §3.6 web_search 组 | 修改 | §3.6 implId 示例 `zhipu`→`zhipu_coding_plan`；credentials map 示例含 2 键；补一次性迁移机制记录（`type==='zhipu'`→`zhipu_coding_plan`，marker=type，幂等非破坏，落点 bootstrap） | MUST 记迁移方向 + 幂等约束 | app_config 现状；D3 | +~10/-~4 |
| ui-spec | specs/ui/components/app-dev-config-page/section-web-search-config/_overview.md | §4 credentials 字段 + §6 testid | 修改 | §4「当前仅 zhipu」stale 描述改为「2 个 impl：zhipu_coding_plan / zhipu_api，字段集相同（各一 apiKey）」；§6 testid 表 `{implId}` 示例补 `zhipu_coding_plan`/`zhipu_api`；§6.1 i18n 说明 impl.description 键随 implId | MUST 标注组件 `.tsx` 无代码改动（已 implId-agnostic）；测试锚点 testid 契约 = `web-search-type-select-opt-{implId}` / `web-search-cred-{implId}-apiKey` | UI spec 现状；D5 | +~8/-~4 |

### 模块 F：单测（provider 白盒 UT + 迁移 UT）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| test-unit | app/plugins/builtins/zhipu_web_search/__tests__/zhipu-coding-plan-provider.test.ts | (rename from zhipu-provider.test.ts) | 修改 | 现测试文件重命名 + import 路径改指 `../zhipu-coding-plan-provider`（现 MCP impl 白盒测试内容不变） | MUST import 路径对齐 rename 后文件 | 现有测试 | rename+2 |
| test-unit | app/plugins/builtins/zhipu_web_search/__tests__/zhipu-api-provider.test.ts | (新文件) | 新增 | REST impl 白盒 UT：`mapZhipuResults` 映射（title/url/snippet/publishedDate）；`isAvailable(cfg)` cfg.apiKey 非空→true；`search` cfg.apiKey 透传 Authorization + REST body（`search_query/search_engine/count`）+ 空 key 抛错。mock undici fetch，不调真 API | MUST 不调真 API（mock fetch）；MUST 断言无 key 泄漏 log | 现有 zhipu-provider.test 范式；D2 | +~90 |
| test-unit | app/server/src/config/__tests__/migrate-web-search-provider.test.ts | (新文件) | 新增 | 迁移 UT：旧 `{type:zhipu,credentials:{zhipu:{apiKey}}}`→`{type:zhipu_coding_plan,credentials:{zhipu_coding_plan:{apiKey}}}`；幂等（已 zhipu_coding_plan 再跑 no-op）；无 record no-op；其他 credentials entry 不受影响 | MUST 覆盖幂等 + 非破坏 + no-op 三分支 | migrate-v0.0.55.test 范式；D3 | +~70 |

---

## 影响面评估

- **跨模块**：plugin manifest/scope（A）+ impl 文件（B）+ config 迁移（C，含 bootstrap wiring）+ i18n（D）+ spec（E）+ UT（F）。无跨包破坏性变更——`WebSearchProvider` 协议、`WebSearchCfg`/`WebSearchResult` 类型、`resolveProvider` 路由、tool 层截断/序列化链路**全部零改动**（PRD §6.2 OUT 清单）。
- **依赖顺序**：无底层 SDK/protocol 改动。task 间弱耦合——(A+B) plugin/impl 可与 (C) 迁移、(D) i18n 并行；(E) spec 由 doc-modifier 阶段 5 统一（本表 E 行是 architect 期以真实行为为准的更新预告，coder 编码时可细化，doc-modifier 收口）。
- **前端零代码改动**（D5 已核实）：section-web-search-config.tsx 完全 implId-agnostic，2 impl 更新 plugin.json+scope+i18n 后自动出现在下拉。**这是本版本最关键的省力结论**——UI 变更全在数据/配置层，非组件代码层。
- **可打包护栏（D6）**：build-plugins.ts 按 extImpls 循环自动编译第二 impl 文件、copyResources 按 plugin.json 自动覆盖；REST impl 复用 `proxyFetch`（`@app/server/dist` external），无新第三方依赖、无新运行时 env 键、无字面路径。**无 packaged 专属风险**——但 impl 文件新增/更名属 plugin 结构改动，建议做一轮 packaged 版 smoke（解 asar 起后端 curl web_search，非强制但推荐）。
- **风险点**：
  1. **迁移幂等边界**：marker=type 字段本身而非独立 marker 文件——须确保 `type==='zhipu'` 是唯一触发条件，迁后 `zhipu_coding_plan` 不再命中（UT 覆盖）。
  2. **key 泄漏 log**：旧 REST 文件带 `console.log(key.slice(-10))`——恢复时**必须删**（B 模块已显式列删除行）。
  3. **label 区分**：两 impl 的 label getter 必须不同值，否则 ToolError `{label}` 无法区分（B 模块两行已钉）。
  4. **i18n 键对应**：impl.description 键名必须与 extImpls implId 精确一致（`zhipu_coding_plan`/`zhipu_api`），否则下拉 label 走 missing-key 渲染成【资源X不存在】。
- **doc-modifier 备注**：`specs/api/` HTTP 契约本版本不变（GET/PUT /config/app 端点/schema 不变），仅样例 implId 值从 `zhipu` 变（`08-web-tools.md` §2.2 + `03-config-center.md` §2.1 的 web_search 样例）——doc-modifier 阶段统一更新样例值即可，无契约变更。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号如碰 `resolveProvider`/协议/tool 层、破约束列如保留 key 泄漏 log、影响行严重偏离）→ 退 coder。
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计。
- **coder 决策权**：impl 文件命名（`zhipu-coding-plan-provider.ts`/`zhipu-api-provider.ts` 为建议名，coder 可定）、迁移函数内部实现细节、UT 具体断言——可合理偏离，但**核心约束不可擅改**（协议/路由零改动、迁移幂等非破坏、key 不进日志、label 区分、implId 精确对应 i18n 键）。任何偏离须汇报 orchestrator。
