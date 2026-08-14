---
type: log
title: Config KB 变更记录
updated: 2026-08-13
---

# Config KB 变更记录（ISO 倒序，最新在前）

> 本目录级变更日志（位置轴）。跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 一行一 feature；版本块尾指向该版本 change_log 详情。

## 2026-08-13 · v0.0.302（KvConfigService 读缓存）

- **`[P0]app_config.md §5.1`（新增）**：`KvConfigService` 内置二级读缓存 `cache: Map<group, Map<key, data>>`——lazy fill（首次访问 group 整组 query 一次，之后零 fs 取 Map；空 Map 区分「未缓存/已缓存但空」）+ write-through invalidate（set/setGroup/delete 写后整组失效，下次 lazy 重填）+ 纯进程内存不持久化；`findRecord()`（set/delete 内部需 id）不走缓存。
- 详情：`specs/tech/version_logs/v0.0.302/change_plan.md`（v0.0.302 编码期实现，此前的 spec 同步缺失，本次补记）。

## 2026-08-04 · v0.0.247 session 组 §3.15 补 4 分层 key + 存储硬上限同源说明

- **动机**：v0.0.238 注入配额改分层时未同步 `[P0]app_config.md` §3.15——spec 仍只列 `maxMemoryInject`/`maxSkillInject` 旧两 key（旧「三源总量」语义），漏列代码已用的 `maxMemoryInjectGroup`/`maxMemoryInjectSession`/`maxSkillInjectGroup`/`maxSkillInjectSession`（memory.ts `resolveMemoryQuotas` + skills.ts `resolveSkillQuotas`）。v0.0.247 存储侧 `resolveMemoryStoreQuotas`/`resolveSkillStoreQuotas` 又复用同组 key，spec 漂移叠加。
- **`[P0]app_config.md §3.15`**：JSON 示例 + key 表从 2 key 扩为 6 key（memory/skill × global/group/session 三层），默认值分层 50/30/20；新增「存储侧消费方」bullet（writeLocked `resolveMemoryStoreQuotas` + executeCreate `resolveSkillStoreQuotas` 复用同 key 同默认，独立 type 概念解耦）；标题语义从「注入总量上限」改为「注入配额 + 存储硬上限同 key 同源」；key 名契约 bullet 补 v0.0.238 分层说明。
- **`[P0]app_config.md §3.4`**：group 集合列表中 session 描述从「注入总量上限调参」订正为「注入分层配额调参 + v0.0.247 起存储硬上限同 key 同源」。
- 详情：`specs/tech/version_logs/v0.0.247/change_plan.md` + `../agent/memory/log.md` + `../agent/skills/log.md`（v0.0.247 块）。

## 2026-07-26 · v0.0.206（删 plugin scope D6 default 短路 — default 无特权，membership 即启用对 default 同效）

- **动机**：channel EP 接入 scope 激活模型需要「default.yaml 不配 = 关」语义成立；旧 D6（`isPointActivated('default',*)` 恒 true / `listActivatedPoints('default', allPointIds)` 返全集 / `resolveSourceScope('default',*)` 短路）让 default.yaml 不配也能用，绕过了 scope 解析。
- **`scope-config-provider.ts` 删 D6 三处**：`isPointActivated` 删 default 特判（同路径 = yaml 声明）；`listActivatedPoints` 删短路 + 签名删死参 `allPointIds`（返 `cfg?.activatedPoints.slice() ?? []`）；`resolveSourceScope` 删 default 短路（loop guard 对 'default' 自然落 return，行为不变）；extends 链 :146-153 与 unregistered throw 不动。16 个既有 EP 全在 default.yaml 声明 → 删 D6 后 default 行为逐点一致，零回归。
- **`[P0]ext_impl_scope.md`**：§1 核心模型 / §3（历史条款标注已删）/ §4.2（default 无特权段）/ §5.2（伪代码注释改 extends 链 + default 无特权段 + **channel 例外条款删除**——channel impl v0.0.206 起经 `getExtensionImpls(ChannelPoint,'default')` 统一 scope 解析）/ §6 / §7 / §9 边界同步。
- **`[P0]plugin_config_service.md`**：§2 inventory/listActivatedPoints jsdoc 两处 D6 表述改「default 无特权」。
- 关联：`default.yaml` 补 channel group/point/feishu impl（16→17 EP）；channel 无状态化重构见 `../channel/log.md`。
- 详情：`specs/tech/version_logs/v0.0.206/change_plan.md`（模块一/二）

## 2026-07-26 · v0.0.205.t2_cons（user_memory group 退役 — global memory 迁出 app_config）

- **`[P0]app_config.md §3.5`**：`user_memory` group 退役——global memory 介质迁出到 `<dataDir>/memory/<name>.md`（per-entry md dir store，与 session/group 同构，见 `../agent/memory/[P0]memory_definition.md §2`）；**不做数据迁移**（旧 record 物理保留可回滚但任何路径不再读取 = 全删重来）；`UserMemoryService` 删除。§3.4 group 集合 + §3.14 权威值组列表同步除名。

详情：`specs/tech/version_logs/v0.0.205.t2_cons/change_plan.md`（模块 A1/A4）

## 2026-07-24 · v0.0.204（scope extends 链式回退 — 取代未激活 EP 直接回退 default）

- **`[P0]ext_impl_scope.md §5`**：运行时 per-EP 回退算法从「未激活 → 直接 default」改为「未激活 → 沿 extends 链回退」（链递归 + 环检测 + 父存在校验）；scope yaml 加 `extends` 字段（单父），`resolveSourceScope(scopeId, pointId)` 在 `scope-config-provider.ts` 沿链走（inventory-builder.ts:137 是包装）。
- **scopeId = SessionKind.canonicalId 纯拼接**：v0.0.204 起 scopeId 4 段命名（`${biz}-${role}:${derivation}:${runKind}`），零路由表零决策逻辑（AgentScopeRouter 删除）；每组合一文件（空文件 = 沿 extends 链继承）。
- **base cases**：default（主链 root 回退终点）+ summary（旁路 run summary 共性：summary_builder/in_memory_session_store/reject_should_compact/noop_*/关 reminder+search_indexing）+ consolidate（同 summary 共性但 toolBound=[skill_manage, memory_manage]）三个基座；原 forked.yaml 拆为 summary.yaml + consolidate.yaml 两个基座。
- **spec↔code 对齐**：`scope-config-{loader,provider,validator}.ts` 改造完成（loader 295 行 + validator 64 行，各自 ≤300）；loader.profile(id) 做缓存 + extends 链递归；SessionTypePolicyImpl.resolveToolSet 保 allTools 注册序 + 剔幽灵名。
- 详情：`specs/tech/version_logs/v0.0.204/change_plan.md`

## 2026-07-19 · v0.0.179.plugin_config（scope 配置模型简化 — impl 列表模型）

- **新模型**：配置 = impl 列表；EP 节点不出现 = 继承 default 全量、出现 = 全量替换（零 delta）。废 `selected`/`enabled`/`exclusivePicks`/`?? true` 兜底；membership = active，数组序 = order；exclusive EP 恰好 1 active（validator 启动校验）。运行时 `getExtensionImpls` 统一 filter+sort+instantiate，无 cardinality 分支（`resolveByCardinality`/`exclusivePick` 删）；cardinality 仅 validator + UI 消费。
- **`[P0]ext_impl_scope.md`**：§4.2 代码声明机制改 YAML 树→扁平 ScopeConfig（删 exclusivePicks/enabled，membership 全量列表）；§4.3 exclusivePicks 节改写「exclusive 恰好 1 active」；§5.2 伪代码改 membership filter + 数组序统一排序（删 `?? true`）；§5.3 改写「运行时不分支，cardinality 仅 validator + UI 消费」+ 补 channel impl 例外（`ChannelManager` 用 `registry.getImplById` per-instance 直取，不经 getExtensionImpls）；§1 概念表 + §7 inventory + §9 边界同步。
- **`[P0]plugin_config.md`**：§2 `ExtImplConfigRecord.enabled`/`order` 补运行时值源注释（= scopes yaml 列表 membership + 数组序）；§6 字段总表同步。
- **`[P0]plugin_config_service.md`**：§2.1 `ExtImplNode.enabled` 注释改 membership 派生、`selected` 注释改「exclusive active 中 order 最小者」；§3 overlay 模型改「全量列表零 delta」+ 默认表 impl 级 enabled 改 membership（无默认 true 兜底）；§3.2 exclusive 选中项重写；§4.2 校验三类不变量重写（删 exclusivePicks 校验，加 exclusive 恰好 1 + 防跨 point 误列）。
- **default.yaml 满基线（spec 已注明）**：新模型无「注册未声明 → 默认 active」兜底——default 必须显式列出全部默认 active impl（含 search_indexing / squad_workspace / squad_team_status，旧靠 `?? true` 兜底 active）。
- **index.md**：① PluginConfig/inventory 行 + ④ 原则 5/8 同步新模型。

详情：`specs/tech/version_logs/v0.0.179/change_plan.md` + `specs/api/version_logs/v0.0.179.md`

## 2026-07-16 · v0.0.166.skill_market（新增 skill_market group）

- **`[P0]app_config.md §3.17`**：新增 `skill_market` group（`{credentials?:{[implId]:{token?}}}`，单实例 key='default'），skill 市场源（`skill_market_provider` exclusive EP）的可选凭证唯一介质。**只放 credentials 无 type**——exclusive EP 靠 scope `selected` 选源（对照 §3.6 web_search list EP 靠 `data.type` 路由）；token 全可选（skills.sh 全端点匿名 200 可用）。缺失语义 = cfg 传空 `{}` 不报错（凭证型组，对照 web_search type 缺失报错）。
- **§3** group 集合枚举同步加入 `skill_market`。
- 消费方：`resolveSkillMarketProvider`（tool/handler 共用）读 `credentials[provider.id] ?? {}`。详见 `../agent/skills/[P1]skill_market.md §5/§10`。

详情：`specs/tech/version_logs/v0.0.166.skill_market/change_plan.md`

## 2026-07-15 · v0.0.151.t2_consolidate（新增 consolidation group）

- **`[P0]app_config.md §3.16`**：新增 `consolidation` group（`{enabled, dailyTime, modelId?}`，单实例 key='default'），二级整理天级任务的用户配置；执行状态（`lastFiredAt`/摘要）刻意分离到独立 `ConsolidationPersistenceAdapter`，不进本组（防 UI 保存覆盖系统状态）。`enabled`/`dailyTime`/`modelId` 改动不热重载（对齐 §3.9 observability 既定"重启生效"语义）。
- **§3** group 集合枚举 + **§3.14** 权威值组清单同步加入 `consolidation`。
- 详见 `../agent/memory/[P0]consolidation_tier2.md` + `../scheduling/[P1]consolidation_job.md`。

详情：`specs/tech/version_logs/v0.0.151.t2_consolidate/change_plan.md`

## 2026-07-15 · v0.0.150（旧 ad-hoc 迁移全删 — A 决策）

- **背景**：v0.0.150 引入 `MigrationManager`（见 `../migration/`）统一管启动期迁移；同时 A 决策下旧 ad-hoc 迁移**全删不重建**（无真实用户，仅自用）。本 KB 内受影响的引用全部清理：
  - **`[P0]app_config.md §3.1`**：删 `scripts/migrate-dev-to-app.v0.0.89.sh` 引用（文件已删；language 迁移历史叙述保留，无文件依赖）。
  - **`[P0]app_config.md §3.3`**：删同上脚本引用。
  - **`[P0]app_config.md §3.5 user_memory`**：删 `migrate-memory-intro.ts` 引用（文件已删；兼容读 `intro ?? description` 已覆盖存量）。
  - **`[P0]app_config.md §3.6 web_search`**：`migrateWebSearchProviderId` 一次性迁移段改历史叙述（v0.0.150 起文件已删，旧格式按现状读不再迁）。
  - **`[P0]ext_impl_scope.md §4.4`**：lazy migrate 段（`migrateLegacyImplKeys` + `migrateLegacyExclusiveRecords`）改历史叙述（v0.0.150 起方法+文件+调用点全删）。
  - **`[P0]plugin_config_service.md §1/§3/§4.4`**：三处 lazy migrate 描述改历史叙述（PluginPolicyStore/PluginScopeStore 实例化保留但 migrate 方法删，运行时读路径本就不读落盘 record，删除零行为影响）。
  - **`[P0]plugin_config.md §5`**：lazy migrate 引用同上更新。
- **新增子系统 `../migration/`**：MigrationManager 架构权威（KB：index + log + `[P0]migration_manager.md`）；`../tech/index.md` ⑤ 导航加 migration 行。
- **[merge 备注]**：合并 dev1(v0.0.149) 后，v0.0.149 新增的 `migrate-memory-intro.ts`（手动 CLI 脚本）+ `migrate-memory-source-updated.ts`（bootstrap ad-hoc 调用）临时回归共存，待步骤2收编进 MigrationManager 后再清理本条引用。

详情：`specs/tech/version_logs/v0.0.150/change_log.md`

## 2026-07-15 · v0.0.149.memory_opt（新增 session group + default_models/llm_request UI tab 迁移）

- **`[P0]app_config.md §3`**：新增 group `session`（key=default，data={maxSkillInject?, maxMemoryInject?}，默认50，缺失回退50，属「可选覆盖调参组」§3.14 语义）；group 集合声明追加 session。纯数据，AppConfigService 通用 KV 直读，无 service 代码。
- **`[P0]app_config.md §3.4/§3.7`**：default_models / llm_request 文档注 UI tab 归属变更（group 名/契约/保存语义不变，仅渲染从模型 tab 迁到新「会话」tab）。

详情：`specs/tech/version_logs/v0.0.149.memory_opt/change_plan.md`

## 2026-07-14 · v0.0.144（llm_request config 装配接线现状说明 + logs group 计数订正）

- **`[P0]app_config.md §3.4`**：补 llm_request「装配接线」现状说明——`LlmRequestConfigService.get()` 返回值经 `buildSessionConfigFromDeps` 落 `SessionConfig.llmRequestConfig`+`allProviders`、两个 stage-llm 透传到 `llmCaller.invoke` 才生效（v0.0.25 起曾断链恒回退 DEFAULT，v0.0.144 修）；链路详情指向 `../agent/llm_caller/[P0]llm_caller.md §4.1`。
- **`[P0]app_config.md §3.8` 计数订正（spec↔code 对齐）**：logs group 标题/正文「4 boolean」→「6 boolean」——早在 v0.0.130.hang 已加 `enableAgentLog`+`enableErrorLog`（json 示例已列 6 键），但描述文字仍写 4，本次订正。

详情：`specs/tech/version_logs/v0.0.144/change_plan.md`

## 2026-07-12 · v0.0.123（web_search provider 拆分：implId 更名 + 一次性迁移）

- **`[P0]app_config.md` §3.6**（architect 已更新，doc-modifier 复核确认与代码一致）：`data.type` implId 示例 `zhipu`→`zhipu_coding_plan`；credentials map 含 2 键 `zhipu_coding_plan` / `zhipu_api`（各一 apiKey）；补一次性迁移记录——启动迁移 `migrateWebSearchProviderId(appConfig)`（bootstrap 调用，AppConfigService init 后、路由挂载前），旧 `{type:"zhipu", credentials:{zhipu:{apiKey}}}` → `{type:"zhipu_coding_plan", credentials:{zhipu_coding_plan:{apiKey}}}`（apiKey 原样保留）。**marker=type 字段本身**：仅 `type==='zhipu' && credentials.zhipu` 存在才迁 → 幂等；非破坏（不清其他 entry、no-op 不写盘、catch 不 throw 阻塞 bootstrap）；对齐 migrate-v0.0.55 范式 + memory `runtime-no-ext-policy-write`。
- **`[P0]ext_impl_scope.md` §8.5**：scope 激活行补「[v0.0.123] `[zhipu]`→`[zhipu_coding_plan, zhipu_api]` 两 impl 均 default 激活」（configSchema 删 apiKey 的 scope 影响核对结论不变）。
- 详见 `specs/tech/version_logs/v0.0.123/change_log.md`。

## 2026-07-12 · dev_config 文档删除 + 有效内容迁移对齐（v0.0.89 债清偿）

- **删除 `[P0]dev_config.md`**（`git rm`）：v0.0.89 起 dev_config entity + `DevConfigService` + `/config/dev` 路由整段已删（命中返 404），所有 group 迁入 app_config；DEPRECATED spec 文件长期滞留是文档债，本次清偿。
- **有效内容迁入 `[P0]app_config.md`**（原 dev_config 独有、app_config 尚缺者救出，不再跨文件指向已删文件）：
  - §3.9 runtime：内联完整 `ObservabilityConfigItem` schema 表（含 v0.0.50 `logPhysical`）+ secretKey 处理（v0.0.119.bugs2 GET 明文 + mask 收敛前端 + PUT 哨兵 merge）+ 无 ENV 兜底 + data 恒列表语义（原 dev_config §3.4.1）。
  - §3.10 web：内联 jina 三 key 表（jinaApiKey secret / jinaEnabled / jinaTimeoutMs + 默认值 + 后端 GET redact 契约，与 observability GET 明文对照）+ 消费方链（原 dev_config §3.5）。
  - §3.12 agent / §3.13 context：补 key 默认值表 + 消费链（session_store/compact/usage）；新增 **§3.14 权威值 vs 可选覆盖调参**——把原 dev_config §4「可选覆盖而非权威（缺失回退 `?? CODE_DEFAULT`）」契约落到 app_config（agent/context/logs 是可选覆盖调参组，其余权威组缺失即未配置）。
- **`[P0]app_config.md` 自相矛盾修正**：§213「web_fetch 的 jinaApiKey 仍在 `dev_config.web`（不动）」→ 「在 app_config `web` group（v0.0.89 迁入，见 §3.10）」，对齐 §3.10 + 代码实际（tool.ts 读 app_config web 组）。§5 服务层去 `DevConfigService` 对照，改指 §3.14 两类语义。
- **`index.md`**：② 概念表删 DevConfig 行、AppConfig 行补两类语义；③ 系统关系图删 DevConfigService 节点；④ 原则 3（KV-sharded 去 dev 域，改指 §3.14）+ 原则 10（改「dev_config 已废弃 — 无独立 dev 域」，删指向已删文件的链接）；⑤ 导航删 dev_config.md 行、app_config.md 行更新 group 列表；frontmatter → 2026-07-12。
- **下游 spec 引用修复**（现行口吻/指向已删文件的链接改指 app_config，历史迁移记录保留）：`../agent/observability/*`（manager/interface/langfuse_adapter/index，observability schema 指针 `[P0]dev_config.md §3.4` → `[P0]app_config.md §3.9`，「写 dev_config」现行口吻 → app_config runtime 组）；`../agent/tools/[P1]web_fetch_tool.md`（读 dev_config web group → app_config web group）；`../dev-logs/[P0]overall.md`（`[P0]dev_config.md §3.6` 权威指针 → `[P0]app_config.md §3.8`；DevConfigService 通用 KV 现行口吻 → app_config）+ `index.md`；`../multi_agent/*`（模板存储现行口吻 → app_config，历史迁移注保留）；`specs/api/overall/*` + `specs/ui/overall/03-config-center.md` + `specs/prd/overall/*` 中指向 `[P0]dev_config.md` 的现行契约链接改指 app_config，DEPRECATED entity 名残留清理（历史 `[v0.0.xx]` 迁移标注保留）。
- **代码注释指针修复**（纯注释，不碰逻辑）：`observability-manager.ts` / `observability-redact.ts` / `web-config-redact.ts` + 对应 `__tests__/*` + `dev-logs/__tests__/config-group.test.ts` 头注参考路径 `specs/tech/config/[P0]dev_config.md §X` → `[P0]app_config.md §Y`。

## 2026-07-11 · v0.0.119.bugs2（observability secretKey GET 明文返回，mask 收敛前端）

- **`[P0]dev_config.md §3.4.1` + `[P0]app_config.md §3.9`**：observability `secretKey` 处理改为「GET 返回明文（走通用 KV 透传，后端不脱敏）+ mask 收敛前端 `SecretInput` 展示层」；PUT `secretKey === '***'` 哨兵回填落盘原值保留（兼容旧前端）。同 provider `apiKey`（v0.0.119.bugs / BUG-002）模式。旧 `redactObservabilityList`（GET 脱敏）函数已删；`mergeObservabilityPlaceholderSecrets`（PUT 哨兵 merge）保留。**jina / channel redact 契约不变**（jina 仍后端 GET redact，见 `03-config-center.md §3.6` / `08-web-tools.md §5.1`）。

## 2026-07-11 · v0.0.114.opts（user_memory record 落盘键 `description` → `intro`）

- **`[P0]app_config.md §3.5 user_memory`**：entry 一句话摘要落盘键 `description` → `intro`（消歧 JSON-schema 关键字，语义不变）。`UserMemoryService` 写侧只落 `intro`，读侧兼容旧 `description`（`readIntro(e)=e.intro ?? e.description`）；存量 record 由一次性脚本 `migrate-memory-intro.ts`（幂等非破坏）迁移。详见 `../agent/memory/[P0]memory_definition.md §3`。

## 2026-07-10 · v0.0.105（computer 连接器回退 — pivot 后 browser-only）

- **`[P1]connectors.md`**：v1.3 → v1.4，**回退 computer 连接器**。v0.0.105 曾扩 computer 作第 2 连接器（toggle + owner 锁 + lazy connect + spawn Swift helper），真机 dogfood 发现裸 spawn 子进程拿不到 macOS TCC 权限，**架构 pivot 到「主进程注入 `ComputerNativePort`」**——computer 去连接器语义。本文回退 browser-only：删 §1 computer 行、§3.1 `id` 类型回 `'browser'` + 删 `permissions` 字段、删 §3.2.2 computer 迁移规则、删 §5.2 ComputerConnectorManager、§5 shared type `ConnectorId` 回 `'browser'` + 删 `permission_missing` kind。
- **共享类型抽取保留（browser-only）**：`app/server/src/connector/types.ts`（v0.0.105 从 `tools/browser/connector-types.ts` 提取的连接器共享概念类型）**保留**——干净重构、future connector #3 trivial 扩，但回退到 browser-only（无 computer 特化）。`handlers/connector.ts VALID_CONNECTOR_IDS=['browser']`。
- computer 现状 → `specs/tech/agent/platform/[P1]computer_native_capability.md`（原生能力）+ `tools/[P1]computer_use_tool.md`（单 computer tool）；UI 权限引导卡片 → `specs/ui/overall/05-connectors.md §3.2`（走 Electron IPC）。

详情：`specs/tech/version_logs/v0.0.105/change_log.md` + `change_plan_v2.md`（§0 pivot 结论）

## 2026-07-08 · v0.0.89（dev_config 废弃 + app_config 扩组 + default_models 新增 + appearance 合并 locale）

- **`[P0]app_config.md`**：§3 group 集合大改——`{ appearance(含 language), providers, llm_request, user_memory, web_search, default_models(new), logs, runtime(observability), web, sub_agent_templates, agent, context }`；新增 §3.7 `default_models`（playground 专属全局默认模型 group，单 record key=default data={chat?, summary?}）；§3.8-§3.13 迁移自 dev_config 各 group（logs/runtime/web/sub_agent_templates/agent/context，group/key 名零变更，secret redact 路径不变）；§3.1 appearance 组增 `language` key（合并自 locale group）+ §3.3 locale 标 deprecated。
- **`[P0]dev_config.md`**：顶部加 `⚠️ DEPRECATED（v0.0.89 起）`——entity + service 文件已删，所有 group 迁入 `app_config`；正文保留作历史 spec；index.md 导航标 deprecated。
- **`index.md`**：① 概念表 AppConfig/DevConfig 行改（DevConfig 标 v0.0.89 deprecated）；③ 系统关系图 AppConfigService 行注释「吸收 DevConfig 全部 group」+ DevConfigService 行标 DELETED；④ 核心设计原则加 10「dev_config 废弃（v0.0.89）」；⑤ 导航 app_config.md 行扩 group 列表 + dev_config.md 行标 DEPRECATED；frontmatter `updated` → 2026-07-08。
- **代码落点（T1 已 verified）**：`config/schema_defs/dev_config.ts` + `config/dev-config-service.ts` + `config/index.ts` re-export 全删；13 处消费方改读 `AppConfigService`（bootstrap/context-engine/context-usage-calc/context-types/agent-manager/session-deps/tools/types/web-fetch/tool+race-runner+jina-fetcher/observability/log-writer）；`handlers/dev-config-template-handlers.ts` 改名 `app-config-template-handlers.ts`（svc 切 AppConfigService，builtin 保护/group_not_deletable/secret redact 逻辑保留）；`router.ts` `/config/dev` 删 + `/config/app/sub_agent_templates` 新增（在 `/config/app` 之前注册防前缀覆盖）；`kv-config-handlers` service union 去 DevConfigService。
- **保留名偏离（已 verified reasonable，spec 同步实际）**：① `loadTemplateFromDevConfig` 函数名保留（实现已切 app_config，避免下游 import 大规模改名，参数已改名 devConfig→appConfig）；② `JinaDevConfig` 类型名 + `JinaContentFetcherCtor.devConfig` 字段名保留（race-runner.ts:84 桥接 devConfig: options.appConfig 过渡桥，仅注释级文档语义切换）；③ `SessionConfig.devConfig` 字段删除（合并入既有 appConfig 字段，比原计划「字段改名 appConfig」更 DRY）。
- **迁移脚本（T6）**：`scripts/migrate-dev-to-app.v0.0.89.sh`——遍历 `dev_config/{group}/*.json` → 拷到 `app_config/{group}/`（保 id+key）；显式 skip 死数据 `llm_request/stall_timeout_s` + `llm_request/max_retry_times`（v0.0.25 前遗留，代码零引用）；backup dev_config 到 `dev_config.backup-<ts>/`；失败 rollback（set -Eeuo pipefail + ERR trap）；默认删 dev_config，`--keep-dev-config` 反向开关；merge 后用户手动执行。

详情：`specs/tech/version_logs/v0.0.89/change_log.md`

## 2026-07-05 · v0.0.72（app_config 新增 web_search group + ext_impl_scope §8.5 zhipu configSchema 删 apiKey 影响）

- **`[P0]app_config.md`**：§3 group 集合追加 `web_search`（PRD §2.3 / D2）；新增 §3.6「web_search 组」——单实例（key 固定 `"default"`）+ `data.{type, credentials}` schema + 缺失语义（type 缺失 = tool 返 ToolError「未配置 provider type」，不回退默认）+ 消费方 `web_search` tool 经 `AppConfigService.get("web_search","default")` 读 → 按 `type` 路由 → `cfg = credentials[type] ?? {}` 传入 impl。
- **`[P0]ext_impl_scope.md`**：新增 §8.5「zhipu configSchema 删 apiKey 的 scope 影响」——核对结论：对 scope 配置层**无影响**（`scopes/default.json` `impls.zhipu` 仍 `{}` 空对象 + `exclusivePicks` 删 `web_search_provider` 项；运行时凭证改从 `app_config.web_search.credentials[type]` 经 tool 入参传入，impl 不再从构造器 cfg 读）。
- 实现层（task T2）：`app_config` schema 加 `web_search` group（`GET/PUT /config/app?group=web_search` 端点复用现有 `/config/app`）；前端 `SectionWebSearchConfig` 自渲染（type choice-cards + 动态 credentials + saveMode='item'，详 `specs/ui/components/app-dev-config-page/section-web-search-config/_overview.md`）。
- **coder 汇报偏离（已同步 spec）**：`scopes/default.json` `_meta.secretPolicy` 文案「由 dev config / env 注入」已过时（apiKey 不再走 scope config/env，迁 app_config）；T1 顺带删 `exclusivePicks.web_search_provider`。

详情：`specs/tech/version_logs/v0.0.72/change_log.md`

## 2026-07-05 · v0.0.71（inventory 嵌套化 + configSchema 单一源 + D2 满基线）

- **`[P0]plugin_config_service.md`**：§2.1 `PluginInventoryTree` 重构——`groups[].extImpls[]`（扁平）→ `groups[].points[].impls[]`（**嵌套**，D3 破坏性 schema 变更）；`ExtImplNode` 删 `schemaConfig?`（D7）+ 新增 `configSchema?`（D7 透传 manifest）+ 删 `pointActivated`（信息上提到 `points[].activated`）+ `config` 始终 = JOIN(manifest default ⊕ scope configValues)（bug-A 修复，对齐 §3 per-domain 默认表）；§2 inventory() 注释 + group-centric 注释更新（group 来源改 groups.json，不再读已删的 EP.group 字段）。
- **`[P0]ext_impl_scope.md`**：§1 概念表 `ExtensionPoint.group` 行改「v0.0.71 起迁 groups.json」；§4.2 加 v0.0.71 D2 满基线 + 删 `_meta.disabledImplsReason` + test-env fallback 注。
- `index.md`：④ 原则 9 已加（v0.0.71 groups.json 唯一源）。
- 实现层（task）：`inventory-builder.ts` buildGroups 嵌套化 + JOIN GroupMetaProvider + bug-A JOIN default + 删 schemaConfig 透传 + 加 configSchema 透传；`plugin-config-service.ts` interface 嵌套化 + constructor 注入 groupMeta；`scopes/{default,forked,test}.json` D2 满基线（default 13 EP × 每 EP 列 enabled impl，exclusive 未选中者 enabled:true）+ 删 _meta.disabledImplsReason。

详情：`specs/tech/version_logs/v0.0.71/change_log.md`

## 2026-07-05 · v0.0.67（配置代码化 + 只读管理面 + 启动校验 + 删流氓）

- `[P0]plugin_config_service.md`：**全面重写**——写方法全删（D4：setEnabled/setImplEnabled/setExclusive/setPointOrders/setImplConfig/setConfig/setOrder/createScope/deleteScope/activateEp/deactivateEp/persist）；读路径切到 `ScopeConfigProvider`（inventory/listScopes/listActivatedPoints/getScope）；§4 加启动校验（D3 硬失败 throw）/ lazy migrate（保留兼容，运行时不读）/ secret 不进代码（D1）。
- `[P0]plugin_config.md`：§1 头注加 v0.0.67 代码化说明；§5 持久化标 deprecated（仅 lazy migrate 兼容）+ 加 D1 secret 政策。
- `[P0]ext_impl_scope.md`：**重大改写**——§1 改为代码声明模型（scope 元信息 + activatedPoints 由 `scopes/*.json` 声明，不依赖落盘 plugin_scope/activation entity）；§2/§3 落盘 SchemaDef 标 deprecated 读路径；§4 加代码声明机制（ScopeConfig 字段 + Loader/Provider）+ exclusivePicks 字段 + lazy migrate 保留兼容；§5 改 per-EP 回退解析读 ScopeConfigProvider；§6 写端点删；§8 加 subagent scope drift 清理（D6）。
- `index.md`：④ 原则更新（v0.0.67 代码化 + 只读管理面替换原两级 enabled 门写路径）。
- 实现层（task 1-4）：新建 `app/plugins/scopes/{default,forked,test}.json` + `scope-config-loader.ts` + `scope-config-validator.ts` + `scope-config-provider.ts`；`plugin-config-service.ts` 删写方法（257 行）；`plugin-manager.ts` 读路径切到 provider；`handlers/config.ts` PUT 返 405；`plugin-scope-handlers.ts` 写端点返 405；`test-fixtures.ts` 不写 policy（D5）；删 `ensureForkedScope` + `forked-scope-bootstrap.ts` + `scoped-write.ts` + `scope-snapshot.ts`。

详情：`specs/tech/version_logs/v0.0.67/change_log.md`

## 2026-07-03 · v0.0.55（exclusive EP 字段统一 — enabled + order）

- `[P0]plugin_config_service.md §2/§4.2`：废弃 `exclusive?: boolean` 字段；`setExclusive` 改 enabled 互斥（目标 enabled=true + 同 point 其他 enabled=false）；inventory 加 `selected` 派生字段（exclusive point：`selected = enabled && point 内 order 最小的 enabled 者`）；§4.2 重写 + 加迁移策略（启动 lazy migrate 清旧 `{exclusive:true}` record，参照 ext_impl_scope §4.3 范式）。
- `[P0]ext_impl_scope.md §5.3 + §8 注记`：exclusive cardinality 解析改读 enabled（删 `implPolicy.exclusive===true` 那套）；snapshot 不含 exclusive 字段。
- `index.md`：④ 新增「exclusive 统一 enabled+order」原则。
- 实现层（task）：`plugin-policy-store.ts` 删 exclusive 字段 + 新增 `migrateLegacyExclusiveRecords`；`plugin-config-service.ts`（**336 行已超 300，需拆 scoped-write.ts**）setExclusive 改语义；`plugin-manager.ts` exclusivePick 重写（删 `getImplPolicy.exclusive`）；`inventory-builder.ts` 加 selected 派生计算；`schema_defs/plugin_policy.ts` 删 exclusive field；`page-plugin-config.tsx` radio 改用 inventory selected。

详情：`specs/tech/version_logs/v0.0.55.memory_ui_session_lock/change_log.md`

## 2026-07-02 · v0.0.50（observability logPhysical 字段）

- `[P0]dev_config.md §3.4.1` `ObservabilityConfigItem` 加字段 `logPhysical?: boolean`（默认 false）。开启后该 backend 启用 physical generation（与 logical 并列记，不带 usage，不污染 token/cost）；manager fan-out 按 child.logPhysical 过滤 physical kind。
- 改动**不热更新**（与 observability 列表本身的热更新语义一致）：用户改 logPhysical → 写 dev_config → 重启进程或下 session 生效（manager 持有的 Langfuse client 不能在 run 中途替换）。
- 前端 `section-observability-detail` 编辑对话框加 logPhysical 开关（label「双重记录」+ hover tooltip 说明；testid `obs-field-logphysical`）。

详情：`specs/tech/version_logs/v0.0.50.sender_data_format/change_log.md`

## 2026-07-15 · v0.0.46.connector_opt（连接器 lazy connect 时机重构）

- `connectors.md` 1.1 → 1.2：**connect 时机重构**——`bootstrap()`/`enable()` 均不再 connect，改由 tool.run 首次调 `browser({mode:'attach'})` 时通过新 `connectForToolRun(sessionId)` lazy 触发；LLM 可显式 `browser({mode:'attach', action:'disconnect'})` 释放；session DELETE 兜底 `disconnect(id, sid)`。§2 switch 语义与 connection 完全解耦（feature flag，不再实时反映连上）。§3.2 迁移表全表更新。§5 ConnectorManager 接口新增 `connectForToolRun` + `disconnect(sessionId?)`（idempotent）+ owner sessionId 粒度；门禁分层三态 `not_enabled` / `in_use_by_other` / `connect_failed`。根治 v0.0.34 「app 启动弹『有应用要调试』系统 prompt」的 chrome-devtools-mcp `--autoConnect` 副作用。详见 `states/v0.0.46.connector_opt/design.md`。

## 2026-07-03 · v0.0.53（providers 组 data ±protocolId 归属迁移）

- `app_config.md §3.2` 同步：providers组 `data` 顶层 += `protocolId`（必填，1 provider : 1 protocol 锁定，→ `llm_protocol` ext impl）；`models[]` 每条 −= `protocolId`（迁到外层，单一事实源）。runtime `ModelInstance`（handler 简化子集）同步删 `protocolId`；PUT `/provider/:id` 可改字段 += `protocolId`。
- 详情：`specs/tech/version_logs/v0.0.53/change_log.md`（§1 数据模型 / §3 迁移 / §5 API）。

## 2026-06-30 · v0.0.35

- OKF KB 化：建 `index.md`（5 章总起）+ 本 `log.md`；`[P0]overview.md` 内容按类拆流并入 index 后归档到 `soft_deleted/`。
- 全部 6 文件加 YAML frontmatter（`type`/`title`/`priority`/`status`/`updated`/`since`）。
- 正文清理 `> version:` blockquote + 尾部 `## 版本` 段 + inline `[vX.Y]`/`[vX.Y modified]` 噪声，迁移到 frontmatter `since` 或本 log。
- 修正：index ③ ConnectorConfigService 落 `entity=connector_config`（非 `connector`）。

## 2026-06-XX · v0.0.34.1（connectors 治理 1 撤回）

- `connectors.md` 1.1→1.2：治理 1「默认 `--browserUrl`」撤回——chrome 144+ `chrome://inspect` 不暴露 `/json/version`，hotfix 回退到 `--autoConnect`；§3.3 失败即停 + 判据真实化仍生效。

## 2026-06-XX · v0.0.34（connectors 失败即停文档化）

- `connectors.md` 1.0→1.1：**失败即停语义文档化 + 判据真实化对齐**（BUG-009）。§3.3 重连策略：connect 失败（含 `list_pages` round-trip 探测）→ `error`、`switch=off`、`intent` 保持 `on` 但**不自动重连**（无 setInterval/周期探测/重试循环），根治「失败却反复 spawn chrome-devtools-mcp 孤儿」。

## 2026-06-XX · v0.0.30（dev logs group）

- `dev_config.md` 2.4→2.5：§3.6 新增 `logs` group——4 boolean key（`enableLlmRequestLog`/`enableToolResultLog`/`enableAppApiLog`/`enableEventLog`，默认 false，可选覆盖语义），控制 LogWriter 写 `<DATA_DIR>/logs/{llm,tool,api,event}.log`；§3.6.1 标注 `llm_request` 实际归属 app_config；§1/§5 修正「group 集合由前端 `DEV_GROUPS` 决定、后端 service 无白名单」；§7 DevConfigService 补 `listGroup`/`delete`。
- `overview.md` §2/§5.1 同步补 logs group。

## 2026-06-XX · v0.0.26（ext impl scope 维度）

- 新增 `ext_impl_scope.md` v1.0：F1 scope 一等实体 + F2 ExtImplConfigRecord 加 scopeId + F3 per-EP 继承激活模型 + F4 双接口（PluginManager + PluginConfigService）+ F5 inventory 适配；D1 独立 activation entity / D2 复合 key 编码 / D3 lazy migrate / D4 自动激活。
- `plugin_config.md` 3.0→3.1：§5 持久化按实现修正——单 entity `plugin_policy` 按 `kind` 分片（`{root}/plugin_policy/{kind}/<id>.json`），非原描述「两张 entity / `plugins.policy.json`」。
- `plugin_config_service.md` 3.0→3.1：§4.4 持久化同上订正。
- `plugin_manager_interface.md`（plugin_system）2.1→2.2：§2 接口加 `getExtensionImpls(point, scopeId)` 双接口重载。

## 2026-06-XX · v0.0.25（llm_request + web group）

- `app_config.md` 2.3→2.4：新增 §3.4 `llm_request` group（timeout/retry/degradation/length/fallback_chain）；group 集合扩为 {appearance, providers, locale, llm_request}；llm_request record 缺省回退默认值（语义不同于 providers 权威值）。
- `dev_config.md` 2.3→2.4：新增 `web` group——`jinaApiKey`(secret)/`jinaEnabled`/`jinaTimeoutMs`，web_fetch 内置 jina 管线用。

## 2026-06-XX · v0.0.23（connectors 首版）

- 新增 `connectors.md` v1.0：连接器概念（仅 browser）+ switch/connection 双状态机 + 持久化 intent + 重启自动重连 + ConnectorManager + browser attach 门禁。

## 2026-06-XX · v0.0.18（ordered 单一排序原语）

- `plugin_config.md` 2.0→3.0：`ExtImplConfigRecord.order` 语义改 per-point 连续 1..n（从 1 开始）；单一排序字段，删 `ExtImpl.priority` 连带。
- `plugin_config_service.md` 2.2→3.0：新增 `setPointOrders` 批量 op；`setOrder` deprecated；inventory 默认 order 改末尾补位；ext impl 节点加三级 description 透传；§4.2 exclusive 改 enabled 门 + effective order fallback。

## 2026-06-XX · v0.0.11（observability 列表化）

- `dev_config.md` 2.2→2.3：§3.4.1 observability 配置**单对象 → 列表**；移除 ENV 兜底；secretKey API 出参 redact；§5 消费链补 `runtime.observability → ObservabilityManager` 注入。

## 2026-06-XX · v0.0.5（setGroup + inventory plugins[]）

- `app_config.md` 2.2→2.3 / `dev_config.md` 2.1→2.2：AppConfigService/DevConfigService 新增 `setGroup(group, items[])`（整组原子提交）。
- `overview.md` 2.1→2.2：PluginConfigService.inventory 新增顶层 `plugins[]`（plugin-centric 平面）+ ext impl 节点 `cardinality`→`type` + `schemaConfig?`；provider/model 统一为普通 app config group（数据归属不变，UI 三栏化，`/provider` 端点契约不动）。
- `ext_impl_and_manifest_interface.md`（plugin_system）：ExtImpl 新增可选 `schemaConfig?`。

## 2026-06-XX · v0.0.4（inventory group-centric）

- `overview.md` 2.0→2.1：`PluginConfigService.inventory` 改 group-centric（按 `ExtensionPoint.group` 聚合 ext impl）；`ExtensionPoint.group` 由可选改必填（plugin_system）。

## 2026-06-19 · v0.0.2（config 三域 P0）

- 三个域 P0 spec 首版：app_config / dev_config / plugin_config / plugin_config_service / overview。
- 决策：通用 KV `(group,key)→data`（app/dev 同构）；PluginConfig 两级 config 值（plugin + ext impl）+ 两级 enabled 门；overlay 增量模型（树来自 registry，叶子稀疏 delta）。
