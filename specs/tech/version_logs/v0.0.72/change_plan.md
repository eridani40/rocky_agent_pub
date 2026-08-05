# v0.0.72.bugs 变更计划书（method 级 review 合同）

> 版本：v0.0.72.bugs · 测试范围：仅 UT（D3）· 无设计稿（D4 视觉保真 compare 跳过）
> PRD：`specs/prd/version_logs/v0.0.72.md`
> 编码前置硬阻断：本文件存在 + 表头 8 列齐全 + 行=函数/符号。
> 行粒度=符号（函数/class/interface/type/enum 各占一行）。8 列：模块/文件/函数·符号/类型/变更内容/约束/参考/影响行。

## A. web search 协议 / EP / config / tool / impl（Bug1.1–1.7）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| web_search / EP | `app/server/src/plugin/extension-point.ts` | `WebSearchProviderPoint.cardinality` | 修改 | `'exclusive'` → `'list'`（多 impl 共存，单点路由不融合） | MUST NOT 引入多 provider 并发融合；tool 按 `app_config.web_search.type` 精确选一个 | PRD §2.2；tech `[P1]web_search_tool.md §3`（list 修订） | +1/-1 |
| web_search / 协议 | `app/server/src/tools/web-search/types.ts` | `WebSearchProvider` | 修改 | `isAvailable(cfg)` 加 cfg 入参；`search(query, opts, cfg, signal)` 加 cfg 入参 | MUST 协议不定义 apiKey 字段（cfg 不透明 map）；impl 不得从 `this.cfg` 读凭证 | PRD §2.5 D1=A；tech §2 协议修订 | +6/-3 |
| web_search / 协议 | `app/server/src/tools/web-search/types.ts` | `WebSearchCfg` | 新增 | `type WebSearchCfg = Record<string, unknown>`（不透明 map，由 tool 从 app_config 构造传入） | MUST 仅类型声明，不含业务字段 | tech §2 | +2 |
| web_search / tool | `app/server/src/tools/web-search/tool.ts` | `resolveProvider` | 修改 | 改为：读 `ctx.config.appConfig.get("web_search","default")` → 按 `data.type` 在 `getExtensionImpls(WebSearchProviderPoint)` 中精确匹配 → 构造 `cfg = credentials[type] ?? {}` 返回 `{provider, cfg}`；type 未配置/impl 不存在 → 返 undefined | MUST NOT 静默回退其他 impl；MUST NOT 取 list EP 首个；返回 `{provider?, cfg}` 元组；`appConfig` 缺失/null/type 缺失 → undefined | PRD §2.4；tech §4 resolveProvider 修订；`ToolCtx.config.appConfig`（`app/server/src/tools/types.ts:141`，unknown 鸭子类型） | +25/-8 |
| web_search / tool | `app/server/src/tools/web-search/tool.ts` | `webSearchTool.run` | 修改 | 调 `resolveProvider` 拿 `{provider, cfg}` → `provider.isAvailable(cfg)` 校验 → `provider.search(query, opts, cfg, ctx.signal)` 传 cfg；错误分支文案对齐「未配置 provider type」/「impl 未激活」/「provider X 不可用（凭证未配置?）」 | MUST 三个错误分支均返 `errorResult` 不静默回退；cfg 透传给 search/isAvailable | PRD §2.4；tech §4 | +10/-6 |
| web_search / impl | `app/plugins/builtins/zhipu_web_search/plugin.json` | `extImpls[0].configSchema` | 删除 | 删 `configSchema` 整个字段（删 `apiKey` + `required`），保留 `implId/point/impl/description` | MUST NOT 保留 apiKey secret 在 manifest（D1 secret 不进代码声明延伸） | PRD §2.1；tech §7 plugin.json 修订 | +0/-9 |
| web_search / impl | `app/plugins/builtins/zhipu_web_search/zhipu-provider.ts` | `resolveApiKey` | 修改 | 改为只从入参 `cfg.apiKey` 读；删 `process.env.ZHIPU_SEARCH_API_KEY` 回退；返回 `string \| undefined` | MUST 凭证唯一源 = app_config（运行时入参）；删 env 回退 | PRD §2.6；tech §7 修订 | +3/-8 |
| web_search / impl | `app/plugins/builtins/zhipu_web_search/zhipu-provider.ts` | `ZhipuWebSearchProvider.isAvailable` | 修改 | 签名改 `isAvailable(cfg: WebSearchCfg)`；body 改为 `resolveApiKey(cfg) !== undefined`（不再读 `this.cfg`） | MUST 禁 I/O；只查 cfg.apiKey 非空 | PRD §2.6；tech §2/§7 | +1/-1 |
| web_search / impl | `app/plugins/builtins/zhipu_web_search/zhipu-provider.ts` | `ZhipuWebSearchProvider.search` | 修改 | 签名加 `cfg: WebSearchCfg` 参数（query, opts, cfg, signal）；body 改为 `apiKey = resolveApiKey(cfg)`；空抛 `Error('zhipu provider 未配置 apiKey')`；不再读 `this.cfg` 取凭证 | MUST 凭证从入参 cfg 读，禁从 `this.cfg`/env 读 | PRD §2.6；tech §7 | +3/-2 |
| web_search / impl | `app/plugins/builtins/zhipu_web_search/zhipu-provider.ts` | `ZhipuWebSearchProvider.constructor` | 修改 | `_cfg` 参数标记不用于凭证（保留签名兼容 PluginManager `(implId, cfg)` 实例化）；body 不再存 cfg 用于凭证读取（可保留 `this.id = implId`） | MUST 保留 `(implId, cfg)` 签名（PluginManager 统一实例化不破坏）；MUST NOT 构造器 cfg 用于取 apiKey | tech §2 末段「impl 构造器 cfg 与运行时 cfg 语义关系」 | +1/-2 |

## B. 应用配置「网络搜索」自渲染 section（前端）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui / app-config | `app/web/src/components/app-dev-config-page/section-web-search-config.tsx` | `SectionWebSearchConfig` | 新增 | 自渲染 section：GET `/config/app?group=web_search&key=default` → 草稿态 type choice-cards（来自 `/config/plugin` inventory `web_search_provider` impl 列表）+ 选中 impl 时动态 apiKey secret input → 整组 PUT 提交；saveMode='item'（自管 save/reset 按钮，无 `component-group-save-bar`） | MUST saveMode='item'；MUST testid `web-search-section` / `web-search-type-{implId}` / `web-search-cred-{implId}-apiKey` / `web-search-save` / `web-search-reset`；MUST NOT 复用 `component-group-save-bar`；候选 impl 来自 `GET /config/plugin` inventory（不扒 code，调 API） | PRD §8 ui 缺口 8；ui `specs/ui/components/app-dev-config-page/section-web-search-config/_overview.md`；范式参考 `observability-config/` | +120 |
| ui / app-config | `app/web/src/components/app-dev-config-page/page-app-settings-merged.tsx` | `groups` 组装 | 修改 | 在 `providers` 之后追加 `{ groupId: 'web_search', keys: [], saveMode: 'item' }` 条目（system-toggle 之前） | MUST 位于 providers 之后、system-toggle 之前（app config 常驻组） | PRD §8 ui 缺口 9；ui `page-app-settings-merged.md` | +1 |
| ui / app-config | `app/web/src/components/app-dev-config-page/page-app-settings-merged.tsx` | `renderGroupArea` | 修改 | 加分支 `if (group.groupId === 'web_search') return <SectionWebSearchConfig/>;` | MUST 注入 SectionWebSearchConfig（自渲染，不走 KV 网格） | ui `page-app-settings-merged.md` | +1 |
| ui / app-config | `app/web/src/components/app-dev-config-page/page-app-settings-merged.tsx` | `import` | 修改 | 新增 `import { SectionWebSearchConfig } from './section-web-search-config';` | MUST 与现有 SectionProviders/SectionObservability import 同范式 | — | +1 |
| ui / app-config | `app/web/src/components/app-dev-config-page/app-settings-config-defs.ts` | — | 不变 | web_search 是自渲染 group，**不进** `KV_GROUPS`（与 providers/observability 同：自渲染不进 KV group 定义） | MUST NOT 在 `KV_GROUPS` 加 web_search 条目（自渲染 hook 不消费） | ui `page-app-settings-merged.md` §group 组装 | +0 |

## C. UI bugs（UIFix1/2/3）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|| ui / ws-tab | `app/web/src/components/chat-page/component-ws-tab-bar.tsx` | `ComponentWsTabBar` 渲染（tabs className） | 修改 | `.ws-tabs` 加 `overflow-hidden`；`.ws-tab`（每 tab button）加 `whitespace-nowrap shrink-0`（tailwind class） | MUST tab 文案不换行；MUST NOT 改 tab 视觉基线（字号/颜色/border 不变） | PRD §3.1 UIFix1；ui `component-workspace-panel.md §6.3` 修订 | +2 |
| ui / ModelPicker | `app/web/src/components/chat/ModelPicker.tsx` | `ModelPicker` trigger className | 修改 | 非 readOnly trigger `min-w-[160px]` → `w-[180px]` + `whitespace-nowrap overflow-hidden text-ellipsis`；加 `title={modelLabel}` 显示完整 modelId | MUST 固定宽（替换 min-w，非叠加）；MUST hover title 显示完整 modelId；MUST NOT 改其他 ModelPicker 视觉 | PRD §3.2 UIFix2；ui `_overview.md §4.4` 修订 | +3/-1 |
| ui / model-tag | `app/web/src/components/chat-page/section-chat-detail.tsx` | `chat-model-tag` span className | 修改 | 加 `max-w-[180px] whitespace-nowrap overflow-hidden text-ellipsis` + `title={modelTag}` | MUST 仅 readOnly 分支渲染（非 readOnly 不动）；MUST hover title 显示完整 modelId | PRD §3.2 UIFix2；ui `_overview.md §4.4` 修订 | +2 |
| ui / path-bar | `app/web/src/components/chat-page/component-ws-path-bar.tsx` | `ComponentWsPathBar` Props | 修改 | 加 `sessionId: string` + `onOpenRoot: () => void`（或复用父级 handleOpen 闭包传 `(path, kind) => handleOpen({path:".",type:"dir"})`） | MUST 复用父级 openWorkspaceItem 链路（不新写 POST 调用）；MUST NOT 在 path-bar 内部 fetch | PRD §3.3 UIFix3；ui `component-workspace-panel.md §4.4.1` | +3 |
| ui / path-bar | `app/web/src/components/chat-page/component-ws-path-bar.tsx` | `ComponentWsPathBar` 渲染 | 修改 | `.ws-path` 改为 flex 容器（路径文本 + 右侧 hover 按钮）；按钮 testid `ws-path-open`，`opacity:0` 默认，`.ws-path:hover` 时 `opacity:1`，`flex-shrink:0`；点击触发 `onOpenRoot` | MUST 布局稳定性 MANDATORY（opacity 0/1 预留空间零位移，禁出现/消失导致文本位移）；MUST 按钮复用现有 external icon（同 ws-tree-item open icon 风格） | PRD §3.3 UIFix3；ui `component-workspace-panel.md §6.4` 修订 | +18 |
| ui / ws-panel | `app/web/src/components/chat-page/section-workspace-panel.tsx` | `<ComponentWsPathBar>` 调用处 | 修改 | 传 `sessionId` + `onOpenRoot={() => openWorkspaceItem(sessionId, {path:".", kind:"folder"})}` props；保留 `workspaceDir` prop | MUST 复用 `openWorkspaceItem`（已在 `lib/chat-api` 导入）；MUST path="." 对齐 §3.1（相对路径，根目录） | PRD §3.3 UIFix3；tech `component-workspace-panel.md §4.4.1` | +3 |

> **[doc-sync 注 — coder 汇报偏离 4 笔误]**：上表 ModelPicker 行 `title={modelLabel}` / model-tag 行 `title={modelTag}` 为笔误——实际代码 `chat-model-tag` 的 `title = \`${modelTag} · ${model.modelId}\``（含原始 modelId），`ModelPicker` trigger 的 `title = \`${value.providerId} / ${value.modelId}\``（含原始 modelId）。约束「MUST hover title 显示完整 modelId」是核心，具体绑定表达式以代码为准（已对齐 spec `_overview.md §4.4`「hover title 显示完整 modelId」）；本表不再改。

## D. UT（coder 白盒，`app/**/__tests__/`）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| web_search / UT | `app/server/src/tools/web-search/__tests__/web-search.test.ts` | `resolveProvider` / `run` 用例 | 修改 | 加 UC-1（type=zhipu + cfg.apiKey 非空 → 断言 zhipu.search 被调且 cfg.apiKey 非空）/ UC-2（apiKey 空 → isError + 文案「不可用 / 凭证未配置」）/ UC-3（mock 2 impl zhipu+fake，config.type=fake → 断言 fake.search 被调；type=unknown → ToolError）；mock `ctx.config.appConfig` 为 `{get:(g,k)=> g==="web_search"&&k==="default"?{type:"zhipu",credentials:{zhipu:{apiKey:"x"}}}:undefined}` + `ctx.config.pluginManager.getExtensionImpls` 返回 mock impl[] | MUST mock PluginManager + AppConfigService + impl（白盒）；MUST 覆盖 PRD UC-1/2/3 三路径；MUST NOT 调真实 HTTP / 真实 plugin manager | PRD §4 UC-1/2/3；tech §4 | +60 |
| web_search / UT | `app/plugins/builtins/zhipu_web_search/__tests__/zhipu-provider.test.ts` | `isAvailable` / `search` 用例 | 修改 | 加：`isAvailable({apiKey:"x"})===true` / `isAvailable({})===false`；`search` cfg.apiKey 空 → 抛 `Error('zhipu provider 未配置 apiKey')`；mock fetch 断言 `Authorization: Bearer <cfg.apiKey>` 透传；删 env 回退用例（如存在） | MUST mock proxyFetch（不调真实 zhipu API）；MUST 断言 cfg.apiKey 透传到 header；MUST NOT 测 process.env 回退（已删） | PRD §4 UC-1/2；tech §7 | +30/-10 |
| web_search / UT | `app/server/src/plugin/__tests__/extension-point.test.ts`（如存在） | `WebSearchProviderPoint` cardinality 用例 | 修改 | 断言 `cardinality === 'list'`（如原断言 `'exclusive'` 则改） | MUST 同步改断言；MUST NOT 跳过 | tech §3 | +1/-1 |
| ui / UT | `app/web/src/components/chat-page/__tests__/component-ws-tab-bar.test.tsx`（新建或扩） | ws-tab nowrap 用例 | 新增/修改 | 渲染 `<ComponentWsTabBar>`，断言 `.ws-tab` 元素 computed style `whiteSpace==='nowrap'` + `flexShrink` 非默认；`.ws-tabs` `overflow` hidden | MUST 用 jsdom computed style（@testing-library/react）；MUST 覆盖 PRD UC-4 ws-tab 部分 | PRD §4 UC-4；ui §6.3 | +25 |
| ui / UT | `app/web/src/components/chat-page/__tests__/component-ws-path-bar.test.tsx`（新建） | `ws-path-open` 按钮 + click 用例 | 新增 | 渲染 `<ComponentWsPathBar workspaceDir sessionId onOpenRoot={mock}>`；hover → 按钮 visible（opacity 1）+ `getByTestId('ws-path-open')` 存在；click → 断言 `mock` 被调 1 次（即 onOpenRoot 触发） | MUST 覆盖 PRD UC-5；MUST 验证布局稳定性（按钮存在但 opacity 0，不位移文本——可断言按钮在 DOM 中始终存在） | PRD §4 UC-5；ui §4.4.1/§6.4 | +35 |
| ui / UT | `app/web/src/components/chat-page/__tests__/model-picker-width.test.tsx`（如 `model-picker-and-input.test.tsx` 已存在则扩，否则新建） | ModelPicker 固定宽 + chat-model-tag max-w 用例 | 新增/修改 | 渲染 `<ModelPicker>` trigger，断言 className 含 `w-[180px]`（非 `min-w-[160px]`）+ `whitespace-nowrap`；渲染 `<section-chat-detail readOnly>` 断言 `chat-model-tag` 含 `max-w-[180px]` + hover title 含 modelId | MUST 覆盖 PRD UC-4 ModelPicker/model-tag 部分；MUST NOT 改 ModelPicker 业务逻辑 | PRD §4 UC-4；ui `_overview.md §4.4` | +30 |
| ui / UT | `app/web/src/components/app-dev-config-page/__tests__/section-web-search-config.test.tsx`（新建） | `SectionWebSearchConfig` 用例 | 新增 | mock `/config/app?group=web_search` 返回 `{type:"zhipu",credentials:{zhipu:{apiKey:"x"}}}` + `/config/plugin` inventory 返 zhipu impl；渲染 section，断言 `web-search-type-zhipu` 卡 active + `web-search-cred-zhipu-apiKey` input 显示 + save 按钮 dirty 启用 + PUT 调用 body 形状 | MUST mock fetch（不调真实 API）；MUST 断言 testid + PUT body；MUST 覆盖 type 未配置 → save 禁用分支 | PRD §4 UC-1；ui `section-web-search-config/_overview.md` | +80 |
| ui / UT | `app/web/src/components/app-dev-config-page/__tests__/page-app-settings-merged.test.tsx` | sidebar 含 web_search 项 | 修改 | 断言 `group-item-web_search` 存在 + 选中时 `web-search-section` 渲染 | MUST NOT 删既有用例 | ui `page-app-settings-merged.md` | +5 |

## E. 文档同步（doc-modifier 阶段 5，本表仅标注，非 coder 任务）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| doc-sync | `specs/tech/config/log.md` | — | 修改 | 追加 v0.0.72 web_search group 新增条目 | doc-modifier | tech `app_config.md §3.6` | +5 |
| doc-sync | `specs/tech/agent/tools/log.md` | — | 修改 | 追加 v0.0.72 EP 改 list + 协议加 cfg + Zhipu 改 + 删 apiKey configSchema 条目 | doc-modifier | tech `web_search_tool.md` | +8 |
| doc-sync | `specs/prd/overall/07-web-tools.md` §7.2 | — | 修改 | web_search 段：协议加 cfg / EP list / app_config 归属 / tool 路由 / Zhipu impl 改 | doc-modifier | PRD §2 | +10/-5 |
| doc-sync | `specs/prd/overall/04-config-center-ui.md` §3.9 | — | 修改 | app config group 集合追加 `web_search`；应用设置合并页 sidebar 增 `web_search` 项 + 自渲染 section | doc-modifier | PRD §8 ui 缺口 9 | +8 |
| doc-sync | `specs/ui/components/chat-page/_overview.md` §4.4 | — | 修改 | ModelPicker 固定宽 + chat-model-tag max-w + nowrap（已在 B 阶段 architect 落，doc-modifier 复核代码实现一致） | doc-modifier | — | +0 |
| doc-sync | `specs/ui/components/chat-page/component-workspace-panel.md` §6.3/§4.4.1/§6.4/testid | — | 修改 | ws-tab nowrap + path-bar hover 按钮 + testid `ws-path-open`（已在 B 阶段 architect 落，doc-modifier 复核代码实现一致） | doc-modifier | — | +0 |

## 与「文件级变更清单」的关系

本表（version 级符号级汇总契约）= tech spec 内每 feature 章节的「文件级变更清单」（设计粒度）的冻结 roll-up。二者数据一致。spec 已在 architect 阶段 B 步骤全部落地（13 项 spec 缺口，见回报）。

## architect 决策点（本表冻结）

1. **web_search group 在 sidebar 的位置**：位于 `providers` 之后、`system-toggle` 之前（app config 常驻组，不进 system-toggle 收起区）。
2. **saveMode 取值**：`'item'`（参考 providers/observability/user_memory 范式：自渲染 section 不走 `component-group-save-bar`，自管 save/reset 按钮）。
3. **impl 构造器 cfg 与运行时 cfg 的语义关系**：构造器 `(implId, cfg)` 签名保留（PluginManager 统一实例化链路不破坏），但 impl **不再依赖构造器 cfg 取凭证**——`isAvailable`/`search` 统一从运行时入参 cfg 读。构造器 cfg 仅用于非凭证初始化（zhipu 当前无此类需求，可空）。运行时 cfg 始终由 tool 从 `app_config.web_search.credentials[type]` 构造并覆盖/取代构造器 cfg。
4. **web_search group 不进 `app-settings-config-defs.ts` 的 `KV_GROUPS`**（自渲染，与 providers/observability 同：自渲染 hook 不消费 KV_GROUPS）。
5. **UT 覆盖**：PRD UC-1/2/3（web search 后端）+ UC-4/5（UI bugs）全部由白盒 UT 覆盖；不跑 AT/ET（D3）。
