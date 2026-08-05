# v0.0.141.see_img 变更计划书 — see_image 视觉理解工具（双 vender）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> 权威 spec：`specs/tech/agent/tools/[P1]see_image_tool.md`（协议/EP/tool/2 impl 全落定）。范式蓝本：`[P1]web_search_tool.md`（see_image 与它同构）。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名或符号名 |
| 类型 | 新增 / 修改 / 删除 / 核对 |
| 变更内容 | 具体做什么 |
| 约束 | MUST / MUST NOT |
| 参考 | spec 位置 / 原则编号 |
| 预计影响行 | +N / -M |

## 变更清单

### A. 协议层（tool 契约）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| see-image/proto | app/server/src/tools/see-image/types.ts | `SeeImageProvider` interface | 新增 | 定义 vender 契约：`id`/`label`/`isAvailable(cfg)`/`understand(text, imagePaths, cfg, signal)→Promise\<SeeImageResult\>` | MUST 与 web_search `WebSearchProvider` 同构；MUST NOT 在协议放 apiKey 字段（凭证走 cfg 入参）；understand 收**绝对路径**（tool 已 resolve） | see_image_tool §2；web-search/types.ts | +30 |
| see-image/proto | app/server/src/tools/see-image/types.ts | `SeeImageResult` interface | 新增 | `{ provider:string; text:string; count:number; tookMs:number }` | MUST 只含文字理解 + 元数据；MUST NOT 含 base64/图片二进制 | see_image_tool §2；原则#10 | +6 |
| see-image/proto | app/server/src/tools/see-image/types.ts | `SeeImageCfg` type | 新增 | `Record<string, unknown>`（不透明 map，impl 期望 `{apiKey?}`） | MUST 与 WebSearchCfg 同形 | see_image_tool §2 | +2 |

### B. 工具层

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| see-image/tool | app/server/src/tools/see-image/tool.ts | `seeImageTool` const | 新增 | `Tool` 单例：definition(name='see_image', required=['text','imagePaths'], imagePaths=array\<string\>) + `defaultTimeoutMs=90000` + `run()`：resolveProvider→isAvailable→校验 imagePaths→resolveImagePaths→provider.understand(try/catch)→serializeResult+wrapExternalContent+truncate | MUST NOT 让 base64 进 arguments/结果；MUST 走 errorResult 不静默回退；run 内不读文件内容（stat/扩展名校验交 resolveImagePaths） | see_image_tool §4；原则#10；web-search/tool.ts | +80 |
| see-image/tool | app/server/src/tools/see-image/tool.ts | `resolveProvider(ctx)` | 新增 | 读 `ctx.config.appConfig.get('see_image','default')` → 取 `data.type` → `pm.getExtensionImpls(SeeImageProviderPoint).find(p=>p.id===type)` → `cfg=credentials[type]??{}`；type 未配置/impl 不存在→`{cfg:{}}` | MUST 精确路由不取首个、不回退；复用已注入的 ctx.config.appConfig + pluginManager（无新装配） | see_image_tool §4.1；web-search/tool.ts resolveProvider | +25 |
| see-image/tool | app/server/src/tools/see-image/tool.ts | `resolveImagePaths(imagePaths, workdir)` | 新增 | 逐路径：`path.isAbsolute(p)?p:path.resolve(workdir,p)`；`fs.promises.stat` 校验存在+是文件；扩展名 ∈ SUPPORTED_IMAGE_EXT；返 `{absPaths}` 或 `{error}` | MUST 只 stat + 扩展名判断，**MUST NOT 读文件内容→base64**（base64 归 provider）；错误消息含 path | see_image_tool §4.2/§4.3；原则#10；tools/types.ts ToolCtx.workdir | +35 |
| see-image/tool | app/server/src/tools/see-image/tool.ts | `serializeResult(res)` | 新增 | markdown：`## Understanding (provider, count, took)` + `res.text` | MUST 输出可 wrapExternalContent 的纯文本 | see_image_tool §4；08a §2.2 | +10 |
| see-image/tool | app/server/src/tools/see-image/tool.ts | `SUPPORTED_IMAGE_EXT` const | 新增 | `['.png','.jpg','.jpeg','.gif','.webp']`（小写扩展名集） | MUST 与 provider media_type 推断一致 | see_image_tool §4.2 | +2 |

### C. builtin vender impl（plugin see_image）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| plugin/see_image | app/plugins/builtins/see_image/image-utils.ts | `readImageAsBase64(absPath)` + `inferMediaType(p)` | 新增 | 共享 helper：node fs 读绝对路径→裸 base64；扩展名→media_type（png/jpeg/gif/webp） | MUST 只在 provider 内被调（base64 不外泄）；仅 node fs/path，零第三方依赖 | see_image_tool §5.1；vision_check.py image_to_base64 | +25 |
| plugin/see_image | app/plugins/builtins/see_image/minimax-provider.ts | `default class MinimaxSeeImageProvider` | 新增 | 构造器`(implId,_cfg)`存 id；`label`getter；`isAvailable(cfg)=!!cfg.apiKey`；`understand`：读多图→base64 image block（按 imagePaths 顺序）+ text block→POST anthropic 端点→取 content[] text 拼接 | MUST 写死 model='MiniMax-M3'/temperature=1.0/endpoint='https://api.minimaxi.com/anthropic/v1/messages'/max_tokens=2048；MUST 出站走 `pickWebFetch(getRegistry())??proxyFetch`；MUST NOT 挂平台 LlmClient/provider/encodeAnthropicMessages；多图 MUST 按 imagePaths 顺序 | see_image_tool §5.1；vision_check.py；调研 §3.4；memory record-replay | +90 |
| plugin/see_image | app/plugins/builtins/see_image/zhipu-image-provider.ts | `default class ZhipuSeeImageProvider` | 新增 | 构造器`(implId,_cfg)`存 id；`label`getter；`isAvailable(cfg)=!!cfg.apiKey`；`understand`：`imagePaths.length!==1`→throw；读单图→base64 data URL→POST GLM 视觉 REST→取 choices[0].message.content | MUST 写死 model='glm-4.5v'/endpoint='https://open.bigmodel.cn/api/paas/v4/chat/completions'；图数≠1 MUST throw 含「智谱视觉 vender 仅支持 1 张图片，当前传入 N 张」；MUST 出站走 pickWebFetch??proxyFetch | see_image_tool §5.2；zhipu-api-provider.ts 骨架；PRD SI-2 | +80 |
| plugin/see_image | app/plugins/builtins/see_image/plugin.json | manifest | 新增 | `id='see_image'`, 2 extImpls（minimax_m3→./minimax-provider.ts, zhipu_image→./zhipu-image-provider.ts），均 `point='see_image_provider'` | MUST 目录名==id='see_image'（builtin-loader :92 校验）；MUST NOT 含 configSchema.apiKey | see_image_tool §5.3；zhipu_web_search/plugin.json；builtin-loader.ts | +15 |

### D. EP 注册 + scope + group

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| plugin/ep | app/server/src/plugin/extension-point.ts | `SeeImageProviderPoint` const | 新增 | `{ id:'see_image_provider', cardinality:'list', description:'__MSG_extpoint.see_image_provider.description__' }` | MUST cardinality='list'（单点路由，非融合）；EP 常量无 group 字段（group 归 groups.json） | see_image_tool §3；WebSearchProviderPoint :194 | +8 |
| plugin/ep | app/server/src/plugin/extension-point.ts | `BUILTIN_EXTENSION_POINTS` array | 修改 | append `SeeImageProviderPoint` | MUST append（不改现有顺序） | see_image_tool §3；extension-point.ts :224 | +1 |
| plugin/scope | app/plugins/scopes/default.yaml | `vision` group node | 新增 | 新 group `- id: vision` → `points: [{pointId: see_image_provider, impls: [minimax_m3, zhipu_image]}]` | MUST 两 impl 均 default 激活（在的就是 enabled）；仅改 default.yaml（forked 不需，subagent 用 default scope） | see_image_tool §3；default.yaml :106 web 节点 | +6 |
| plugin/groups | app/plugins/groups.json | `vision` group entry | 新增 | `{ id:'vision', label:'__MSG_group.vision.label__', description:'__MSG_group.vision.description__', extPoints:['see_image_provider'] }` | MUST 加入 groups[]（否则 inventory 不透传该 EP，section 找不到 impls） | see_image_tool §3；groups.json web 条目 | +6 |

### E. 工具注册 + policy

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| tools/registry | app/server/src/tools/registry.ts | `defaultTools()` | 修改 | import `seeImageTool` from './see-image/tool'；push 进返回数组 | MUST 加入默认集（按 name 路由）；不改其他工具顺序 | see_image_tool §6；registry.ts :78 | +3 |
| agent/policy | app/server/src/agent/tool-policy.ts | `TOOL_POLICY` const | 修改 | `'see_image'` 加进 `playground-rocky`/`studio-leader`/`studio-mate`/`subagent` 四 bound 数组 | MUST NOT 加进 `studio-squad`（群聊哑路由 bound 仅 send_message）；与 web_search 完全同款分布 | see_image_tool §6；tool-policy.ts :63-124；调研 §5.2 | +4 |

### F. 前端（凭证配置 section）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui/config | app/web/src/components/app-dev-config-page/section-see-image-config.tsx | `SectionSeeImageConfig` component | 新增 | 照 section-web-search-config 复刻：GET `/config/app?group=see_image&key=default` + GET inventory 取 `see_image_provider` impls → type 下拉(ComponentChannelTypeDropdown) + SecretInput(apiKey)；saveMode='item' 自管 GET/PUT | MUST group='see_image'、pointId='see_image_provider'；testid 前缀 `see-image-*`；MUST NOT 复用 web_search 的 testid | see_image_tool §7；section-web-search-config.tsx | +130 |
| ui/config | app/web/src/components/app-dev-config-page/section-tab-panel.tsx | `SectionTabPanel`（tools case） | 修改 | import `SectionSeeImageConfig`；`tools` case 加 `<div data-testid="group-item-see_image">` + `<h3 group.see_image.label>` + `<SectionSeeImageConfig/>`（紧邻 web_fetch 下方，mt-8） | MUST 只改 tools case；文件 ≤220 行现状勿超 300 | see_image_tool §7；section-tab-panel.tsx :90-104 | +8 |
| ui/config | app/web/src/components/app-dev-config-page/app-settings-config-defs.ts | `APP_SETTINGS_TABS`（tools tab groups） | 修改 | tools tab `groups` 数组加 `'see_image'`（描述性元数据，与渲染一致；注：web_fetch 现缺失=既有 drift，一并补 `'web_fetch'`） | MUST 只改 tools 条目 groups 数组 | app-settings-config-defs.ts :92 | +1 |

### G. i18n（MUST 全语言齐全，防【资源X不存在】）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| i18n/app-dev | app/web/src/i18n/locales/zh-CN/app-dev-config.json | `group.see_image` + `seeImage.*` | 新增 | `group.see_image.label`=「看图理解」；`seeImage.{sectionDesc,empty,typeLabel,apiKeyLabel,save,reset,saving}`（镜像 webSearch.*） | MUST key 集与 en 完全一致；渲染走 t() | memory i18n-key-add-checklist；app-dev-config.json webSearch :54 | +12 |
| i18n/app-dev | app/web/src/i18n/locales/en/app-dev-config.json | `group.see_image` + `seeImage.*` | 新增 | 同上英文 | MUST 与 zh key 集一致 | 同上 | +12 |
| i18n/plugin | app/web/src/i18n/locales/zh-CN/plugin-config.json | `group.vision` + `extpoint.see_image_provider` + `plugin.builtin.see_image.*` | 新增 | `group.vision.label`=「视觉」；`extpoint.see_image_provider.description`；`plugin.builtin.see_image.{label,description}` + `.impl.{minimax_m3,zhipu_image}.description` | MUST key 集与 en 一致；占位符 `__MSG_*__` 能解析到这些 key | memory i18n-key-add-checklist；plugin-config.json :12/:149 | +12 |
| i18n/plugin | app/web/src/i18n/locales/en/plugin-config.json | 同上 en | 新增 | 同上英文 | MUST 与 zh key 集一致 | 同上 | +12 |

### H. 组件 spec（coder 编码前置产出）+ UT + 打包核对

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui/spec | specs/ui/components/app-dev-config-page/section-see-image-config/_overview.md | 组件 spec | 新增 | coder 编码前置：section 契约 + testid 表（see-image-section / see-image-type-select / see-image-cred-{implId}-apiKey / see-image-save / see-image-reset / see-image-empty / see-image-section-desc）+ 视觉基线（照 web_search section） | MUST 先 spec 后实现（_conventions.md）；testid 与 tsx 一致 | _conventions.md；section-web-search-config/_overview.md | +60 |
| test/ut | app/server/src/tools/see-image/__tests__/see-image-tool.test.ts | UT | 新增 | SI-2（zhipu 图数≠1 报错）+ SI-3（未配置三分支）+ 路径校验（不存在/非图片格式）+ imagePaths 空；mock provider/appConfig/pluginManager，断言 isError + 消息 | MUST 覆盖确定性契约（SI-2/SI-3 走 UT，不占 AT 名额）；`bun run test` | PRD SI-2/SI-3；see_image_tool §4.3 | +120 |
| packaging | scripts/build-plugins.ts | （无代码改动） | 核对 | 自动扫描 builtins/see_image 编译 .cjs（server import external `@app/server`，undici/fs 已 external/builtin）+ copyResources 自动带 scopes/groups.json | MUST NOT 改 build-plugins.ts；coder MUST 跑 `bun run scripts/build-plugins.ts` 验证 dist 含 `see_image/minimax-provider.cjs`+`zhipu-image-provider.cjs`+groups.json 有 vision | CLAUDE.md 护栏 2；see_image_tool §9；build-plugins.ts EXTERNALS :30 | 0 |

## 影响面评估

- **跨模块**：协议(A) + 工具(B) + plugin impl(C) + EP/scope/group(D) + 注册/policy(E) + 前端(F) + i18n(G) + spec/UT/打包(H)。约 27 行/符号，~15 文件（含 4 i18n JSON）。
- **依赖顺序**：A(协议) → B(tool) / C(impl) 并行 → D(EP/scope/group) → E(注册/policy) → F/G(前端+i18n)。tool(B) 依赖协议(A) + EP 常量(D 的 SeeImageProviderPoint)；impl(C) 依赖协议(A)。
- **无破坏性变更**：纯新增工具 + 新 EP + 新 app_config group；不改任何现有工具/EP/端点契约。web_search/web_fetch/browser 零影响。
- **零新第三方依赖**：仅 node fs/path + 复用 server proxyFetch/undici → packaged 安全（护栏 2）。**无需改 build-plugins EXTERNALS / runtime-config / package.json deps**。
- **无 session-config 装配变更**：see_image tool 复用 web_search 已注入的 `ctx.config.appConfig` + `ctx.config.pluginManager`（4 bound 角色一致，泛型注入）。
- **风险点**：① zhipu model 名 `glm-4.5v` 写死——真 key 若拒绝需换 GLM 视觉系模型名（用户自测，coder 保留可改常量）；② i18n 漏 key → 【资源X不存在】（G 组 MUST 全语言齐全）；③ 出站不走 pickWebFetch → AT 录不了（C 组 MUST 约束）；④ base64 泄漏进 arguments/结果 → 违反硬约束（A/B/C MUST NOT）。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列如 base64 进入入参/出参、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计

## spec↔code 漂移记录（architect 核对发现，供 doc-modifier 阶段 5）

- **drift-1（本版顺带修）**：`app-settings-config-defs.ts APP_SETTINGS_TABS` tools tab `groups:['web_search']` 缺 `web_fetch`（v0.0.121 已渲染），证明该 `groups` 数组为描述性元数据、非渲染依据。F 组顺带补 `web_fetch`+`see_image`。
- **drift-2（不修，超范围，记待办）**：`plugin-config.json extpoint.web_search_provider.description` 文案仍写「exclusive≤1」，v0.0.72 已改 list 单点路由——过时文案。doc-modifier 可顺手订正。
- **drift-3（不修）**：`index.md ③` 「26 个工具」计数已滞后（v0.0.126 +2 history + presence + 本版 +see_image）；非精确计数，本版仅加 see_image 提及。
