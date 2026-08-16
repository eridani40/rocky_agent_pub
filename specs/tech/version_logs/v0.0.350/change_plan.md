# v0.0.350 变更计划书 — 四渠道 coding plan native + 额度/余额查询

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
> PRD：`specs/prd/v0.0.350-native-coding-plans-and-balance-query.md`（P-A~P-D + §2.3 数据规则全消化）· 预研：`specs/research/v0.0.350-coding-plans-balance-query.md`（cc-switch 逐行核证）· 实测：`specs/research/v0.0.350-live-verify.md`（四渠道真调全通，形状 diff 三点已按 PRD §2.3 消化）。
> 基线：dev1@fb7fba33c（含 349）。

## 现状调研结论（源码实证，2026-08-15）

| # | 现状 | 实证位置 |
|---|------|---------|
| S1 | `llm_provider` EP = list cardinality，契约接口仅 `buildAuthHeaders`；**唯一已注册 impl = `anthropic_compatible`**（llm_anthropic plugin，plugin.json 双 EP：provider+protocol）。预研称「三种 impl」实为 spec 占位——`openai_compatible`/`glm` 仅 ProviderName 字面量占位，无实现 | `extension-point.ts` L39-44；`plugin.json`；`provider-types.ts` L15-18；`llm_provider_interface.md` §3.2 |
| S2 | impl 路由：`llm-client-factory` 按 `providerConfig.name === implId` 命中，**未命中回退 providers[0]**（default scope impls 首位 = anthropic_compatible，mock fixtures 不受影响——前提：default.yaml impls 顺序 anthropic_compatible 保持第一） | `llm-client-factory.ts` L74-80 |
| S3 | name 通道现状：`ProviderInstance.name` 是 `'anthropic_compatible'` 字面量；POST 硬校验 `body.name !== 'anthropic_compatible' → 400`；**PUT 无 name 字段**（已存 provider 改类型无通道）；前端 `createProvider` 固定写 `name:'anthropic_compatible'` | `handlers/provider.ts` L31/L129/L146；`api-client.ts` L352 |
| S4 | scope 激活：`getExtensionImpls(point)` 单参 ≡ default scope——**llm-client-factory/quota handler 都走 default**；default.yaml `provider` 组 llm_provider impls 目前仅 anthropic_compatible，+4 即全局生效，无需动其他 scope yaml | `plugin-manager.ts` L14；`scopes/default.yaml` L107-115 |
| S5 | 前端表单：`component-provider-fields` 已有 protocol KeyChoiceCards（`_conventions.md` §10 禁原生 select）；detail draft 无 name/类型字段；保存链 `saveProviderWithModels` 不传 name | `component-provider-fields.tsx` L82-94；`api-client.ts` L455-485 |
| S6 | GET /provider 路由 `/provider` + 正则 `/provider/:id`——**新端点 `/provider/quota` 必须在 providerMatch 正则之前注册**（否则 id='quota' 被吞） | `routes/misc-routes.ts` L136-146 |
| S7 | plugin i18n：manifest `__MSG_*__` → 前端 `plugin-config.json` `plugin.builtin.llm_anthropic.impl.<implId>.description`；新增 impl 需同步 zh/en 两份 | `plugin.json`；`zh-CN/plugin-config.json` |
| S8 | cc-switch 全套解析规则/单测可直接对照移植（coding_plan.rs:1573-1716）；LastGoodSnapshot 失败保留模式（subscription.ts:19-30） | 预研 §7 |

## 架构决策结论

| # | 决策点 | 结论 |
|---|--------|------|
| ① | 4 impl 结构 | **挂既有 `llm_anthropic` plugin**（同 provider 组、同 anthropic 协议域）：plugin.json extImpls +4——`kimi_coding_plan` / `glm_coding_plan` / `minimax_coding_plan` / `deepseek_api`；每 impl 类 `extends AnthropicCompatibleProvider`（buildAuthHeaders 逐字节复用，实测四渠道 x-api-key 全通）+ 实现 `queryQuota`。每 impl 一个文件（类+解析器），共享 helper 单独文件。**MUST NOT** 动 protocol impl / 建新 plugin |
| ② | 额度查询能力接口形状（PRD 留给定） | **双层**：能力层 = `LlmProvider` 加**可选方法** `queryQuota?(config): Promise<QuotaSnapshot \| null>`（null = impl 无额度能力；anthropic_compatible 不实现）；HTTP 层 = **聚合端点** `GET /provider/quota`（一次返回全部 coding plan provider 快照，per-item 错误隔离不炸整体）。不放 per-provider HTTP 端点（前端 5min 轮询一次调用，N 端点 = N 次往返 + 各自错误处理） |
| ③ | 查询域 baseUrl 推导（R5） | 纯函数 `deriveQuotaBaseUrl(implId, baseUrl)`（共享 helper 文件），照抄 cc-switch detect_provider 子串匹配：kimi=baseUrl 原样拼 `/v1/usages`（保留 /coding 前缀语义）；glm=含 `bigmodel.cn`→`https://open.bigmodel.cn` 否则 `https://api.z.ai`；minimax=含 `minimax.io`→国际域否则 `api.minimaxi.com`；deepseek=取 baseUrl origin。**MUST** 用户改 baseUrl 后查询域随推导（PRD UC-2） |
| ④ | 类型选择器 + preset 归属 | **preset 表放前端**（`provider-type-presets.ts`：5 类型 id/labelKey/协议锁定/默认 baseUrl/默认模型/kimi contextWindow 262144/额度型别）；类型选择器 = detail 页新「类型」KeyChoiceCards（选项 5 项）；选 native 类型联动：protocolId 锁定 anthropic_messages（控件只读）+ baseUrl 填 preset 默认值（用户可再改）+ models 预填默认模型一条（仅新建空 models 时）。后端**不感知 preset**，只做 name 白名单校验 |
| ⑤ | name 通道 | `ProviderName` 联合 +4；POST name 白名单 5 值（缺省仍 anthropic_compatible 向后兼容）；**PUT 加可选 name 字段**（白名单内才写）——已存 provider 可切换类型；前端 createProvider/updateProvider 透传 name |
| ⑥ | 额度总览区组件结构 | **列表级新组件** `component-coding-plans-quota-footer`（list 视图底部、卡片外，仅 list 页渲染）：内部 = 渠道卡片行（紧凑两行/余额行 + 点击展开明细）× N + `use-quota-polling` hook（5min setInterval 首拉立即 + **LastGoodSnapshot 前端 state 持有**——失败保留上次成功值 + fetchedAt；30s 独立 tick 只重渲染倒计时不拉 API）。挂载点 `section-providers` list 分支底部（添加卡之后）。server **不缓存**（每次现拉，快照不落盘——「页面停留期间」是 UI 生命周期语义） |
| ⑦ | 聚合端点实现 | `handlers/provider-quota.ts`：listProviders 过滤 name ∈ 4 native → 并发（Promise.all）逐 provider 取对应 impl.queryQuota（15s AbortSignal.timeout；凭证 resolveKey）→ `{ items: QuotaSnapshot[] }`；单渠道失败 → item 带 `error: {kind:'auth'\|'business'\|'network'\|'timeout', message}`（401/403→auth 透「凭证已失效」语义；业务错误透原始文案），不影响其他渠道。路由注册**必须在 providerMatch 正则前** |
| ⑧ | QuotaSnapshot 统一形状 | `{providerId, providerLabel, implId, kind:'quota'\|'balance', tiers?:[{window:'five_hour'\|'weekly', usedPercent:number, resetsAt?:string}], membership?:string, balance?:{currency,total,granted?,toppedUp?}, isAvailable?:boolean, error?{kind,message}, fetchedAt:number}`——四渠道解析器全部归一到此形状（百分比已用口径、时间 ISO 本地化由前端做）；`raw` 字段不透传（展开明细所需的 membership/并发额度等进 membership/tiers，超集字段 v2 再加） |
| ⑨ | 解析规则（全部实测背书，实现 MUST 照此） | kimi：`limits[]`→5h 桶（多条逐条取首条）+ `usage`→周桶；数值字符串兼容；**已用优先直读 `usage.used`**，缺失 `limit-remaining` 兜底；resetTime ISO。glm：过滤 `type∈{TOKENS_LIMIT,CREDIT_LIMIT}`（大小写不敏感）；**分桶只锚 `unit`**（3→5h、6→周，number 不锚定）；`percentage` 直读已用%；`nextResetTime` 毫秒；**TIME_LIMIT 忽略**；**禁按重置时间排序**；`data.level`=套餐名。minimax：只取 `model_name=="general"`；已用%=**100−remaining%**；周桶**仅 `current_weekly_status==1`**；毫秒。deepseek：`balance_infos[]`（字符串金额）+`is_available`。**MUST** 逐条防御式解析（缺哪段降级哪段） |
| ⑩ | 测试边界 | 不新增持久 AT case（冒烟集纪律）；UT 覆盖解析全矩阵（对照 cc-switch 单测移植）+ handler 聚合/错误隔离 + 前端联动；ET 走 P-A~P-D 真实操作。响应 model 回显 ≠ 请求 model（glm 5.2→5.3）——**MUST NOT** 任何校验逻辑依赖响应 model |

## 变更清单

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| provider-core | `app/server/src/llm/provider-types.ts` | `ProviderName` | 修改 | 联合 +`'kimi_coding_plan' \| 'glm_coding_plan' \| 'minimax_coding_plan' \| 'deepseek_api'`（注释标 v0.0.350 起 4 native） | MUST：纯类型改动 | 决策⑤ | +6 |
| provider-core | 同上 | `QuotaTier` / `QuotaSnapshot` / `QuotaError` | 新增 | 决策⑧统一形状类型（tiers/membership/balance/isAvailable/error/fetchedAt） | MUST：形状归一（四渠道解析器唯一输出契约）；MUST NOT：透传渠道原始 JSON | 决策⑧ | +28 |
| provider-core | `app/server/src/llm/provider.ts` | `LlmProvider.queryQuota?` | 修改 | 接口加可选方法 `queryQuota?(config: LlmProviderConfig): Promise<QuotaSnapshot \| null>`（null=无额度能力） | MUST：可选成员（anthropic_compatible 不实现=undefined 天然兼容）；MUST：无状态（config 入参） | 决策② | +8 |
| plugin-impl | `app/plugins/builtins/llm_anthropic/plugin.json` | `extImpls[2-5]` | 修改 | +4 条 `{implId, point:'llm_provider', impl:'./provider-<x>.ts', description:__MSG_...}` | MUST：implId 与 ProviderName 新成员一致 | 决策① | +20 |
| plugin-impl | `app/plugins/builtins/llm_anthropic/quota-shared.ts` | `deriveQuotaBaseUrl` / `parseNum` / `parseResetTime` / `fetchQuotaRaw` | 新增 | 共享 helper：查询域推导（决策③子串表）+ 数值字符串兼容 + ISO/秒/毫秒时间归一 + 统一 fetch（15s AbortSignal.timeout + Bearer/裸 key 两种鉴权模式 + 401/403→auth 错误分类） | MUST：纯函数除 fetchQuotaRaw；MUST：cc-switch extract_reset_time 同款秒/毫秒判定（<1e12 判秒） | 决策③⑨；预研 §1-4 | +95 |
| plugin-impl | `app/plugins/builtins/llm_anthropic/provider-kimi.ts` | `KimiCodingPlanProvider`（default export）+ `parseKimiQuota` | 新增 | extends AnthropicCompatibleProvider + queryQuota：GET `{推导}/v1/usages`（Bearer）→ limits[0]→5h 桶 + usage→周桶；used 直读优先/换算兜底；membership.level 透出 | MUST：解析规则决策⑨ kimi 行；MUST：解析器与 HTTP 分离（可单测） | 决策①⑨；live-verify §1 | +80 |
| plugin-impl | `app/plugins/builtins/llm_anthropic/provider-glm.ts` | `GlmCodingPlanProvider` + `parseGlmQuota` | 新增 | extends 同上 + queryQuota：GET `{推导}/api/monitor/usage/quota/limit`（**裸 api_key 无 Bearer**）→ 过滤 TOKENS/CREDIT_LIMIT、unit 分桶、percentage 直读、TIME_LIMIT 忽略、data.level 透出；success==false→business 错误透 msg | MUST：只锚 unit 禁排序（issue #3036）；MUST：裸 key（实测） | 决策⑨；live-verify §2 | +85 |
| plugin-impl | `app/plugins/builtins/llm_anthropic/provider-minimax.ts` | `MinimaxCodingPlanProvider` + `parseMinimaxQuota` | 新增 | extends 同上 + queryQuota：GET `{推导}/v1/api/openplatform/coding_plan/remains`（Bearer）→ general 条目 + 100−remaining 反转 + 周桶 status==1 门控；base_resp.status_code!=0→business 透 status_msg | MUST：status=3 无周桶不展示 | 决策⑨；live-verify §3 | +80 |
| plugin-impl | `app/plugins/builtins/llm_anthropic/provider-deepseek.ts` | `DeepSeekApiProvider` + `parseDeepseekBalance` | 新增 | extends 同上 + queryQuota：GET `{origin}/user/balance`（Bearer）→ balance_infos[]（字符串金额 parse）+ is_available；kind='balance' | MUST：余额型无 tiers | 决策⑨；live-verify §4 | +70 |
| scope | `app/plugins/scopes/default.yaml` | provider 组 llm_provider.impls | 修改 | +4 implId（anthropic_compatible 保持首位——S2 mock 回退依赖） | MUST：顺序 anthropic_compatible 第一 | 决策①；S4 | +4 |
| api-handler | `app/server/src/handlers/provider.ts` | `handleProviderCollection`（POST 分支） | 修改 | name 白名单 5 值（缺省 anthropic_compatible 兼容旧 client）；`ProviderInstance.name` 类型放宽 ProviderName | MUST：白名单外 400；MUST：旧 client 不传 name 不 400 | 决策⑤ | +10 |
| api-handler | 同上 | `handleProviderItem`（PUT 分支） | 修改 | 加可选 name 字段：传且在白名单 → 写入（已存 provider 切换类型通道） | MUST：白名单外 400；MUST NOT：PUT 强制传 name | 决策⑤ | +8 |
| api-handler | `app/server/src/handlers/provider-quota.ts` | `handleProviderQuota`（新文件） | 新增 | `GET /provider/quota`：listProviders 过滤 name∈4 native → Promise.all 并发调对应 impl.queryQuota（getExtensionImpls find implId===name）→ `{items: QuotaSnapshot[]}`（providerLabel 取实例 label；fetchedAt=Date.now()）；单渠道 throw → item.error 不炸整体；零 coding plan provider → items:[] | MUST：路由注册在 providerMatch 正则前；MUST：15s timeout；MUST：错误隔离 | 决策②⑥⑦；S6 | +85 |
| api-route | `app/server/src/routes/misc-routes.ts` | misc 路由表 | 修改 | `path === '/provider/quota'` 分支（**置于 providerMatch 之前**） | MUST NOT：被 :id 正则吞掉 | S6 | +5 |
| i18n-plugin | `app/web/src/i18n/locales/{zh-CN,en}/plugin-config.json` | `plugin.builtin.llm_anthropic.impl.{kimi_coding_plan,g...}.description` | 修改 | 4 新 impl 描述（zh/en 同 key） | MUST：双语 | S7 | +8 |
| ui-preset | `app/web/src/components/providers/provider-type-presets.ts` | `PROVIDER_TYPE_PRESETS`（新文件） | 新增 | 5 类型 preset 表：`{id: ProviderName, labelKey, protocolId:'anthropic_messages', defaultBaseUrl?, defaultModel?, contextWindow?}`（anthropic_compatible 无 preset=通用；kimi 262144）+ `isNativeCodingPlan(name)` 判定 + 查询参与判定 | MUST：类型 id 与后端 ProviderName 一致；MUST NOT：后端反向依赖此表 | 决策④；PRD §2.1 表 | +55 |
| ui-form | `app/web/src/components/providers/component-provider-fields.tsx` | `ComponentProviderFields` | 修改 | 顶部加「类型」KeyChoiceCards（options=5 preset；testid provider-field-type）；选 native → protocol 控件只读（锁定 anthropic_messages）+ baseUrl 联动填充由 detail 层做（fields 只读展示协议） | MUST：KeyChoiceCards（禁原生 select）；MUST：native 类型 protocol 禁点；MUST NOT：改既有 protocol 控件通用形态 | 决策④；S5 | +35 |
| ui-form | `app/web/src/components/providers/component-provider-detail.tsx` | `ProviderDraft`（+name）/ `toDraft` / `handleTypeChange` | 修改 | draft 加 name（缺省 anthropic_compatible）；类型变更回调：native → baseUrl 填 preset 默认值（用户可改）+ protocolId 锁定 + 新建且 models 空时预填默认模型一条（enabled true，contextWindow=kimi 262144）；切回通用不回填 | MUST：已存 provider 改类型不重置 baseUrl（用户已自定义值保留，仅从通用→native 且值空时填充） | 决策④ | +40 |
| ui-form | `app/web/src/components/providers/section-providers.tsx` | `handleSaved` 透传 + list 底部挂载 | 修改 | save 链 draft.name 透传 saveProviderWithModels；list 视图底部（添加卡后）渲染 `<CodingPlansQuotaFooter providers={nativeProviders}>`（过滤 name∈4 native；空则不渲染） | MUST：仅 list 页渲染（detail 页无）；MUST：无 native provider 不渲染空区块 | 决策⑥ | +18 |
| web-api | `app/web/src/lib/api-client.ts` | `createProvider` / `updateProvider` / `fetchProviderQuota` | 修改/新增 | create/update 透传 body.name（anthropic_compatible 缺省兼容）；新增 `fetchProviderQuota(): Promise<{items: QuotaSnapshot[]}>`（GET /provider/quota）；ProviderInstance.name 类型放宽 | MUST：name 缺省不传（旧后端兼容期短，直接传亦可——以白名单为准） | 决策⑤② | +20 |
| web-lib | `app/web/src/lib/providers.ts` | `ProviderItem` | 修改 | +`name?: string` 透传（额度区过滤与类型显示用） | MUST：可选（旧响应兼容） | 决策⑥ | +2 |
| ui-quota | `app/web/src/components/providers/use-quota-polling.ts` | `useQuotaPolling`（新文件） | 新增 | hook：入参 providers（native 子集）→ 立即首拉 + 5min setInterval 调 fetchProviderQuota；state=`{byProvider: Map<pid, QuotaSnapshot>, lastGood: Map<pid, QuotaSnapshot>, lastFetchedAt}`；失败→该渠道沿用 lastGood 值；独立 30s tick 计数（倒计时重渲染不拉 API）；卸载清 interval | MUST：LastGoodSnapshot 前端持有（server 无缓存）；MUST：30s tick 零网络请求 | 决策⑥；S8 | +85 |
| ui-quota | `app/web/src/components/providers/component-coding-plans-quota-footer.tsx` | `CodingPlansQuotaFooter` + 行卡（新文件） | 新增 | 额度总览列表级区块：标题「额度总览」+ 渠道卡列表（额度型两行「5 小时额度 已用 X%（HH:mm 重置）/ 本周额度 已用 Y%」+ membership/套餐名徽标；余额型「余额 ¥9122.69」+ is_available=false→「余额不足」）+ 点击展开明细（纯文本+百分比徽标：完整重置时间/两桶明细/分币种余额）+ 每卡「上次更新 HH:mm」+ error 态（凭证失效/原始错误文案/重试中沿用旧值）| MUST：视觉照抄既有卡片+danger token 语言（老板铁律不自创）；MUST：百分比整数/金额两位小数/本地时间；MUST NOT：markdown/富文本渲染 | 决策⑥⑧；PRD §2.2 | +170 |
| i18n-web | `app/web/src/i18n/locales/{zh-CN,en}/providers.json` | `type.*` / `quota.*` 命名空间 | 修改 | 5 类型友好名（Kimi Coding Plan/智谱 GLM Coding Plan/MiniMax Coding Plan/DeepSeek（按量付费））+ 额度文案（5 小时额度/本周额度/余额/余额不足/上次更新/约 N 小时后重置/凭证已失效/额度总览） | MUST：zh/en 同 key；MUST：全友好词（无 unit/base_resp 内部术语） | PRD §4.9 | +30 |
| tests | `app/plugins/builtins/llm_anthropic/__tests__/quota-parsers.test.ts` | describe ×4（新文件） | 新增 | 解析全矩阵（对照 cc-switch coding_plan.rs:1573-1716 移植）：kimi 字符串值/used 直读/换算兜底/ISO 时间；glm unit:3/6 分桶/number:1 变体/TIME_LIMIT 忽略/percentage 直读/毫秒/success=false；minimax general 过滤/100−反转/status=1 门控/status=3 跳过；deepseek 字符串金额/is_available；deriveQuotaBaseUrl 推导表（bigmodel.cn/z.ai/minimaxi/minimax.io/自定义代理） | MUST：live-verify 实测响应原文作 fixture 逐一断言 | 决策⑨⑩ | +160 |
| tests | `app/server/src/handlers/__tests__/provider-quota.test.ts` | describe（聚合） | 新增 | 聚合：多 native provider 并发聚合/单渠道失败错误隔离不炸整体/零 native→items[]/15s timeout 分类/label+fetchedAt 填充 | MUST：错误隔离逐 item 断言 | 决策⑦ | +65 |
| tests | `app/server/src/handlers/__tests__/provider.test.ts`（既有追加） | describe（name 白名单） | 新增 | POST name 5 值白名单/白名单外 400/缺省兼容；PUT name 可选写入/白名单外 400/不传不变 | MUST：向后兼容断言（旧 client 无 name） | 决策⑤ | +35 |
| tests | `app/web/src/components/providers/__tests__/`（新文件 ×2） | 类型联动 + quota footer | 新增 | ①detail：选 native 类型→baseUrl 填充+protocol 锁定+默认模型预填；切回通用不回填；已存 provider 改类型 baseUrl 保留 ②footer：额度型两行模板/余额型/展开明细/LastGood 失败保留/上次更新/凭证失效态；hook 5min 间隔+30s tick（fake timers） | MUST：fake timers 控制 interval；MUST：P-A~P-D 关键路径映射 | 决策④⑥ | +150 |
| spec-sync | `specs/api/overall/02-llm-chat.md` | §5 扩展 | 修改 | §5.1 表 +GET /provider/quota 行；§5.2 ProviderInstance.name 放宽+QuotaSnapshot 形状；§5.6 新端点契约（请求/响应/错误隔离语义）；版本头 +v0.0.350 段 | MUST：§7 版本历史同步 | 决策②⑤⑦ | +60 |
| spec-sync | `specs/tech/agent/providers_and_models/[P0]llm_provider_interface.md` | §2/§3 | 修改 | §2 接口加 queryQuota 可选方法+统一形状；§2 实现表 +4 impl 行（含 glm 裸 key 特例）；§3.2 补「preset/额度查询归 per-type impl（native 类型）」 | MUST：与代码同步 | 决策①② | +35 |
| spec-sync | `specs/ui/components/providers/component-coding-plans-quota-footer.md` | 新 spec | 新增 | 新组件 spec（职责/props/状态/消费方 section-providers）+ component-provider-fields.md 补类型选择器段 + section-providers.md 补挂载点段 | MUST：记录消费方（团队原则 10） | 决策⑥ | +55 |
| spec-sync | `specs/tech/version_logs/v0.0.350/change_log.md` + `specs/api/version_logs/v0.0.350/change_log.md` | 变更记录 | 新增 | 按惯例记录 | MUST：两处均落 | 惯例 | +2 文件 |

## 影响面评估

- **后端**：类型层（provider-types/provider 接口）+ plugin impl 层（4 文件 + helper + manifest + scope）+ handler 层（POST/PUT name + 聚合端点 + 路由）。零破坏：可选接口成员 + 白名单含旧值 + impls 首位不变（S2 mock 回退）。
- **前端**：表单加类型选择器（fields/detail/section）+ 保存链透传 name + 新额度总览组件组（footer+hook）+ i18n。既有 protocol/baseUrl 控件形态不变。
- **并行性**：T1（后端，文件 1-14+测试）与 T2（前端，文件 15-24）**文件零交集可并行**；T2 额度区联调依赖 T1 端点（T2 先按 QuotaSnapshot 形状 mock 开发，契约以本表为准）。
- **风险**：①三渠道查询端点无官方文档（形状漂移防御解析+原始错误透出，R3）；②glm 裸 key（实测已证，实现勿加 Bearer）；③mock 回退依赖 impls 首位（default.yaml 顺序钉死）；④`/provider/quota` 路由顺序（正则前注册，UT 断言路径分发）；⑤kimi limits[] 多条实测只见 1 条（取首条，多条降级不猜）。

## 反馈回路

- UT：quota-parsers 全矩阵 + handler 聚合 + name 白名单 + 前端联动/footer（fake timers）全绿。
- AT：不新增持久 case（纪律）；既有冒烟回归（provider/model-routing 用例确认 POST/PUT 放宽无回归）。
- ET：P-A 类型选择自动填充/锁定 → P-B 额度两模板实测数值 → P-C 5min 刷新+断网保留 → P-D 四渠道发消息 200。

## 与 349/351 边界

- 349（provider 删除+dangling）已合并本基线，无交集。
- volc/glm 团队版/TIME_LIMIT 展示/手动刷新按钮——PRD §6 非目标，零涉及。
