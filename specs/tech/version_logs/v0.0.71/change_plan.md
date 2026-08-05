# v0.0.71 变更计划书 — plugin ext 配置重构（层级清晰 + config 不丢 + group 细分）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。
>
> 锁定决策 D1-D8 + bug-A（详见 `states/user_query.md` v0.0.71 节 + `states/v0.0.71/task-board.md`）。**不擅自偏离**；冲突或 spec 不可调和点已汇总在文末「冲突 / 风险」节，由 orchestrator 裁决。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统（groups_meta / scopes / inventory / validator / manifest / plugin-manager / ui-chat / api / tests） |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名 / 类型名 / 接口字段（行 = 一个符号） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责 |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | spec/原则引用（路径+章节 / 原则编号） |
| 影响行 | 现状行号 / +N / -M（现状码基 = dev1@56b8f7b5，行号见 research 报告） |

## 变更清单

### 模块 1：groups.json 新概念 + 加载链路（D1+D5）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| groups_meta | `app/plugins/groups.json` | （新文件） | 新增 | D5 7 个 group 元数据（id/label/description/extPoints[]，label/description i18n 占位符 `__MSG_group.<id>.{label,description}__`）。EP 归属见各模块 5：context-ingest(context_ingest_handler, system_reminder) / context-assemble(context_assemble_mapper, context_assemble_reducer) / context-compact(context_should_compact, context_do_compact, context_post_compact) / context-engine(session_store) / system-prompt(system_prompt_mapper, system_prompt_reducer) / provider(llm_provider, llm_protocol) / web(web_search_provider) | MUST 含全部 13 EP 各一次（D6 不变量）；MUST NOT 在此声明不存在的 EP | D5；新建 spec `[P1]groups_meta_decl.md` | +60 |
| groups_meta | `app/server/src/plugin/group-meta-loader.ts` | `GroupMeta` interface | 新增 | `{ id: string; label: string; description: string; extPoints: string[] }`（groups.json 单条结构） | MUST 字段 4 个全必填 | `[P1]groups_meta_decl.md` §2 | +8 |
| groups_meta | `app/server/src/plugin/group-meta-loader.ts` | `GroupMetaFile` interface | 新增 | `{ groups: GroupMeta[] }`（groups.json 顶层结构） | MUST 单文件单根（不分片，无 `_meta`） | `[P1]groups_meta_decl.md` §2 | +3 |
| groups_meta | `app/server/src/plugin/group-meta-loader.ts` | `GroupMetaLoader` class | 新增 | 仿 `ScopeConfigLoader`：构造接 `{ root }` 或路径；`load(): GroupMetaFile` 读 `groups.json` 单文件 + JSON.parse + 形状校验（groups 必填数组，每项 id/label/description/extPoints 必填 + extPoints 项非空字符串）。校验失败 throw | MUST 单文件读取（不扫目录，groups 是元数据全集）；MUST NOT 做语义校验（EP 存在/唯一——那是 Validator 第 5 条不变量的事）；MUST 文件不存在或 root 不可读 → throw（D6 硬失败） | `[P1]scopes_config_decl.md` §3.1（同型 Loader 范式）；research §7 | +50 |
| groups_meta | `app/server/src/plugin/group-meta-provider.ts` | `GroupMetaProvider` interface | 新增 | `{ listGroups(): GroupMeta[]; getGroupByPoint(pointId: string): GroupMeta \| undefined; getGroupById(groupId: string): GroupMeta \| undefined }` | MUST 接口纯读视图，无副作用 | `[P1]groups_meta_decl.md` §3 | +10 |
| groups_meta | `app/server/src/plugin/group-meta-provider.ts` | `LoadedGroupMetaProvider` class | 新增 | 仿 `LoadedScopeConfigProvider`：构造接 `GroupMeta[]`（来自 Loader.load().groups）；实现 `GroupMetaProvider`。维护 `pointToGroup: Map<pointId, GroupMeta>` 内部索引便于 `getGroupByPoint` O(1)；构建时若有重复 pointId → throw（D6 唯一性校验前置） | MUST 不读 fs（纯内存封装 Loader 数据）；MUST 构建期检查重复 pointId 并 throw | `[P1]scopes_config_decl.md` §3.3（同型 Provider 范式） | +35 |

### 模块 2：删 ExtensionPoint.group（D1，消除冗余）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| groups_meta | `app/server/src/plugin/extension-point.ts:21-38` | `ExtensionPoint.group` 字段 | 删除 | interface 字段删除（line 31）。注释（line 26-30）同步删 | MUST 同步删 13 个 EP 常量的 `group:` 行（line 47-48/58-59/74/83/92/101/110/119/141/153/172/194/211）；MUST NOT 影响其他字段（id/cardinality/description 不变） | research §2；`[P0]extension_point_interface.md §2/§3.6` | -50 |
| groups_meta | `app/server/src/plugin/registry.ts:152-156` | `validateExtensionPointShape` (group 检查分支) | 修改 | 删 group 必填非空校验分支（line 152-156）。保留 id/cardinality/description 校验 | MUST 不删 cardinality 校验；MUST 注释「v0.0.4 group 必填」段删除 | research §2 | -8 |
| groups_meta | `app/server/src/plugin/inventory-builder.ts:130-146` | `buildGroups` group 收集 | 修改 | 删 `const groupId = point.group`（line 133）；改 `const group = deps.groupMeta.getGroupByPoint(pointId)`（JOIN GroupMetaProvider）；group 顺序按 `groupMeta.listGroups()` 声明序（D5 七组固定排序，不再按 registry 注册序）；throw on missing group（D6 启动期 + 此处防御） | MUST groups 顺序 = groups.json 声明序（D5）；MUST 缺 group 视为 misconfig 不静默 fallback；MUST `InventoryBuilderDeps` 加 `groupMeta: GroupMetaProvider` 字段 | `[P0]plugin_config_service.md §2` (group-centric 不变)；research §2/§7 | +15/-5 |

### 模块 3：bootstrap 加载顺序（D1+D6）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| groups_meta | `app/server/src/bootstrap.ts:240-264` | `bootstrapBuiltinPlugins` (加载链路) | 修改 | 调整顺序：(1) builtin-loader → registry；(2) **新增**：GroupMetaLoader.load → LoadedGroupMetaProvider；(3) ScopeConfigValidator 扩 groups 上下文校验（见模块 5）；(4) PluginConfigService 构造增加 groupMeta 注入 | MUST 顺序：builtin → groups → validator → service/manager；MUST NOT 改变 ScopeConfigLoader 调用位置；MUST groups.json 不存在 → throw（D6 硬失败，与 scopes 一致） | `[P1]scopes_config_decl.md` §3；research §7 | +20 |

### 模块 4：D6 启动校验第 5 条不变量（groups ↔ registry 双向一致）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| validator | `app/server/src/plugin/scope-config-validator.ts:21-43` | `ScopeConfigValidatorOptions` interface | 修改 | 新增字段 `groups: GroupMeta[]`（必填） | MUST 必填；MUST NOT 让旧 caller 编译过（breaking change） | research §6 | +2 |
| validator | `app/server/src/plugin/scope-config-validator.ts:29-43` | `ScopeConfigValidator` constructor | 修改 | 接收 `groups`，存 `this.groups`；构建 `pointToGroup: Map<pointId, GroupMeta>` 内部索引 | MUST 构建期校验 group id 唯一 + extPoints 项唯一（同 pointId 出现多次 → throw） | research §6 | +12 |
| validator | `app/server/src/plugin/scope-config-validator.ts:39-43` | `validateAll` | 修改 | 入参不变（ScopeConfig[]），但首次调用前先跑新增的 `validateGroups()`（独立校验，与 scope 配置无关） | MUST validateGroups 失败先于 scope 校验暴露 | `[P1]scopes_config_decl.md` §3.2；D6 | +3 |
| validator | `app/server/src/plugin/scope-config-validator.ts` (新方法) | `validateGroups` | 新增 | 第 5 条不变量：(a) registry 每个 EP（`BUILTIN_EXTENSION_POINTS` + test fixtures）必须在某 group 出现且仅一次（`Map<pointId, count>`）；(b) groups.json 引用的 pointId 必须在 registry；(c) groups.json group id 唯一。任一失败 throw 带定位信息 | MUST 严格「registry ↔ groups.json」双向一致（既防漏登记也防漂移）；MUST 不静默 fallback；MUST NOT 重复实现（构建期 Map 已检唯一性，本方法仅做覆盖率比对） | D6；`[P1]scopes_config_decl.md` §3.2 第 5 条 | +35 |

### 模块 5：PluginInventoryTree 形状重构（D3）+ inventory-builder JOIN

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| inventory | `app/server/src/plugin/inventory-builder.ts:130-182` | `buildGroups` 返回结构 | 修改 | 由扁平 `groups[].extImpls[]`（impl 跨 point 聚合）改为**嵌套** `groups[].points[]: { pointId, activated, impls[]: [...] }`。每个 point 节点下挂该 point 的 impl 节点数组（对齐用户 demo 数据格式 D3） | MUST 嵌套层：group → point → impl；MUST groups 顺序 = groups.json 声明序；MUST point 内 impl 排序保留 effective order + (pluginId, implId) 稳定尾序；MUST NOT 保留顶层 `groups[].extImpls[]`（破坏性 schema 变更，UI 同步改） | D3；`[P0]plugin_config_service.md §2.1` 重构；research §1 | +30/-15 |
| inventory | `app/server/src/plugin/inventory-builder.ts:195-226` | `buildExtImplNode` (configSchema 透传 + bug-A JOIN) | 修改 | (1) **bug-A**：`config: { ...extractConfigDefaults(entry.manifest.configSchema), ...(implCfg?.configValues ?? {}) }`（JOIN manifest default 进 config 字段，对齐 spec per-domain 默认表）；(2) **D7**：删 `schemaConfig` 透传字段（line 216 删）；(3) **D7**：新增 `configSchema: entry.manifest.configSchema` 字段透传（让前端 modal 可读 JSON Schema 形状） | MUST bug-A JOIN 必做（`threshold_should_compact.compactRatio=0.6` 在 default.json 未声明时也要可见）；MUST extractConfigDefaults 复用（不重新实现）；MUST 显式 `configSchema` 透传 + 显式删 `schemaConfig`；MUST NOT 改 pluginEnabled 恒 true | bug-A；D3+D7；`[P0]plugin_config_service.md §2.1 + §3 per-domain 默认表`；research §1/§5 | +12/-3 |
| inventory | `app/server/src/plugin/plugin-config-service.ts` (interface) | `PluginInventoryTree.groups[]` 类型 | 修改 | `groups[].extImpls[]` 改为 `groups[].points[]: { pointId, activated, impls: ExtImplNode[] }`；删 `groups[].points[]` 旧平铺位置（迁进嵌套结构内）；`ExtImplNode` 加 `configSchema?: JsonSchema`、删 `schemaConfig?` | MUST interface 与 buildGroups 返回对齐；MUST 显式删 `schemaConfig` 字段（TS 类型驱动 UI 清理） | D3+D7；`[P0]plugin_config_service.md §2.1` | +15/-8 |
| inventory | `app/server/src/plugin/plugin-config-service.ts` (constructor) | `PluginConfigService` constructor | 修改 | 接受 `groupMeta: GroupMetaProvider`（注入 LoadedGroupMetaProvider），透传给 inventory-builder deps | MUST 单一 source（同一 provider 实例给 service + builder） | `[P0]plugin_config_service.md §1` | +5 |

### 模块 6：D2 scopes 内容重写（满基线 + 删 _meta.disabledImplsReason）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| scopes | `app/plugins/scopes/default.json` | （文件内容重写） | 修改 | 改满基线：13 activatedPoints 全列；exclusivePicks 不变（4 项）；impls 块改每 EP 显式列 enabled impl + configValues（含 `threshold_should_compact` `configValues: { compactRatio: 0.6 }`；其他 ordered EP impl 各带 order + 非默认 configValues） | MUST 满 13 EP；MUST `threshold_should_compact.compactRatio=0.6` 显式声明（双保险 + 文档化）；MUST secret（apiKey）不写（D1）；MUST exclusive 候选未选中者列 `enabled: true` 显式标（D2 满基线口径：未选中 ≠ disabled，selected 派生自 exclusivePicks；forked 才用 enabled:false 真禁用防递归） | D2；`[P1]scopes_config_decl.md` §2；research §3 | +120/-50 |
| scopes | `app/plugins/scopes/forked.json` | （文件内容修改） | 修改 | 删 `_meta.disabledImplsReason`（disabled 不带 reason，D2）；保留 activatedPoints 子集（context-only）+ exclusivePicks + impls（含 enabled:false 项） | MUST 删 `_meta`；MUST NOT 改 activatedPoints 集合（运行时行为不变） | D2；research §3 | -10 |
| scopes | `app/plugins/scopes/test.json` | （文件内容修改） | 修改 | 若有 `_meta.disabledImplsReason` 同删；其他保持 | MUST 只删 `_meta`（fixture 不动） | D2 | -3 |
| scopes | `app/server/src/plugin/scope-config-loader.ts` | `ScopeImplConfig` interface | 不动 | research §3 确认：字段 `{ enabled?, order?, configValues? }` 足够支撑 D2，**不改类型** | MUST NOT 改类型（YAGNI，避免触发下游迁移） | research §3；`[P1]scopes_config_decl.md` §2 | 0 |

### 模块 7：D7 删 schemaConfig（统一 configSchema 单一源）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| manifest | `app/server/src/plugin/manifest.ts:32-49` | `SchemaConfigEntry` interface | 删除 | 整个 type 删除（schemaConfig 简化形态不再存在） | MUST 同步删 inventory-builder.ts:216 透传；MUST 同步删 `api-client.ts:175-181` 类型 + `PluginExtImpl.schemaConfig`（line 203） | D7；`[P0]ext_impl_and_manifest_interface.md §3.7`（spec 同步） | -18 |
| manifest | `app/server/src/plugin/manifest.ts:67-68` | `ExtImpl.schemaConfig` field | 删除 | 字段删除 | MUST 全 builtin plugin.json 同步删 schemaConfig 块（见下行） | D7 | -2 |
| manifest | `app/plugins/builtins/rocky_context/plugin.json` | 各 impl 的 `schemaConfig` 块 | 修改 | 7 个 impl（query_truncate / tool_result_truncate / budget_truncate / transcript_reader / base_builder / threshold_should_compact / 等）的 `schemaConfig` 块删除；其 `description`/`options`/`enum` 信息**手动并入** `configSchema.properties.<key>` 的 `description`/`enum`（JSON Schema 标准）；configSchema default 已存在不动 | MUST 7 impl 全覆盖；MUST 合并 schemaConfig.description/options → configSchema 不丢字段（防止丢失 i18n 占位符 + enum 候选值）；MUST NOT 改 configSchema.default（已在实例化用） | D7；research §5；`[P0]ext_impl_and_manifest_interface.md §3.7` | -60/+30 |
| manifest | `app/plugins/builtins/zhipu_web_search/plugin.json` | impl `zhipu` 的 `schemaConfig` | 修改 | 同上：删 schemaConfig + 合并 description 进 configSchema | MUST 同上 | D7 | -5/+2 |

### 模块 8：D8 删 plugin 级 configSchema/config 死字段 + BUG-PLUGIN-004 deepMerge

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| manifest | `app/server/src/plugin/manifest.ts:23-25` | `PluginManifest.configSchema?` field | 删除 | 字段删除（plugin 级 configSchema 死字段，0 plugin 声明 + 0 代码读） | MUST 同步删 `config?`（line 25，同死字段）；MUST NOT 改 `label/description`（仍 UI 用） | D8；research §3 of bug-PLUGIN-004 report | -5 |
| manifest | `app/server/src/plugin/manifest.ts:23-25` | `PluginManifest.config?` field | 删除 | 同上 | MUST 与 configSchema 一起删（plugin 级 config 块同样 0 使用） | D8 | -2 |
| plugin-manager | `app/server/src/plugin/plugin-manager.ts:25` (import 段) | `import { deepMerge }` | 新增 | 从 `../llm` import deepMerge（已 re-export 自 `app/server/src/llm/index.ts:59-63`，定义在 `resolve-provider-config.ts:86-104`） | MUST 复用，MUST NOT 新建 util（YAGNI，research §5）；MUST 不循环依赖（grep 确认 llm 不依赖 plugin） | D8；research §5；BUG-PLUGIN-004 spec §9 | +1 |
| plugin-manager | `app/server/src/plugin/plugin-manager.ts:155-165` | `instantiate` (merge 改写) | 修改 | `merged = { ...defaults, ...(cfg?.configValues ?? {}) }` → `merged = deepMerge(defaults, cfg?.configValues ?? {})`。注释更新为「BUG-003 + BUG-PLUGIN-004」；extractConfigDefaults 不动 | MUST 当前 7 configSchema 全扁平（research §4），改完跑现有 4 UT 应全绿（行为等价）；MUST 风险点：deepMerge 的 `undefined 不覆盖`语义 vs spread 显式 undefined 有差，UT 必须覆盖（见模块 11） | D8；BUG-PLUGIN-004 spec §9；`[P0]ext_impl_and_manifest_interface.md §3.5`（spec 偏差注删除） | +1/-1 |
| plugin-manager | `app/server/src/plugin/__tests__/plugin-manager.test.ts` (新 describe 块) | `describe('BUG-PLUGIN-004: deepMerge 嵌套 object 不丢字段')` | 新增 | 2 case：(1) 嵌套 object：configSchema.default=`{credentials:{key:'a',header:'b'}}` + configValues=`{credentials:{key:'x'}}` → merged=`{credentials:{key:'x',header:'b'}}`；(2) configValues 显式 `{x:undefined}` 不覆盖 default | MUST 覆盖 deepMerge 嵌套语义 + undefined 不覆盖（与原 spread 行为差异点）；MUST 现有 4 case 全绿（扁平数据下 spread/deepMerge 等价） | D8；research §6 of bug-PLUGIN-004；BUG-PLUGIN-004 spec §9 | +60 |

### 模块 9：D4 UI 组件最小改（恢复入口 + 嵌套数据消费 + 只读 modal）

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui-chat | `app/web/src/lib/api-client.ts:191-230` | `PluginExtImpl` / `PluginGroup` 类型 | 修改 | (1) `PluginExtImpl` 加 `configSchema?: JsonSchema`（透传 manifest configSchema）；删 `schemaConfig?`（line 203）；(2) `PluginGroup` 改：删 `extImpls: PluginExtImpl[]`、删 `points?: { pointId; activated }[]`，新增 `points: { pointId: string; activated: boolean; impls: PluginExtImpl[] }[]`（嵌套对齐 D3） | MUST TS 类型驱动 UI 编译期检查；MUST 嵌套结构与后端 buildGroups 返回对齐 | D3+D7；research §1/§5 | +15/-5 |
| ui-chat | `app/web/src/components/plugin-config-page/component-ext-impl-checkbox.tsx:97` | `!disabled` 守卫 + 触发条件 | 修改 | 删 `&& !disabled`（齿轮按钮在 disabled 也渲染）；触发条件 `impl.hasSchemaConfig` → `impl.configSchema`（齿轮出现 = impl 有 configSchema 即可，无关 disabled） | MUST 按钮 disabled=false（v0.0.67 整页 disabled 是父级 pointer-events-none 层级，按钮本身不再 disabled）；MUST 触发条件只看 configSchema（D7 删 schemaConfig 后只有这一个 schema 源） | D3+D4+D7；research §4 | +2/-2 |
| ui-chat | `app/web/src/components/plugin-config-page/component-ext-impl-radio.tsx` | 同上 | 修改 | 同 checkbox：删 `!disabled` 守卫 + 改触发条件为 `configSchema` | MUST 同 checkbox | D4 | +2/-2 |
| ui-chat | `app/web/src/components/plugin-config-page/component-ext-impl-ordered.tsx` | 同上 | 修改 | 同 checkbox：删 `!disabled` 守卫 + 改触发条件为 `configSchema` | MUST 同 checkbox | D4 | +2/-2 |
| ui-chat | `app/web/src/components/plugin-config-page/component-schema-config-modal.tsx` | `ComponentSchemaConfigModalProps` | 修改 | 加 `readOnly?: boolean` prop（默认 false）；改 `schemaConfig: Record<string, SchemaConfigEntry>` → `configSchema?: JsonSchema`（读 JSON Schema properties 推导控件：type/description/enum/default/minimum/maximum） | MUST 控件路由保 string/number/boolean/enum/object 五态（复用现有 router 分支）；MUST readOnly=true 时所有 input/select/checkbox `disabled` 或 `readOnly` 属性 + 隐藏保存按钮；MUST JSON Schema → UI 控件路由复用现有 schemaConfig 同型逻辑（type 字面量映射） | D4+D7；research §4/§5 | +60/-30 |
| ui-chat | `app/web/src/components/plugin-config-page/component-schema-config-modal.tsx` | `onSave` prop | 修改 | readOnly 模式下不渲染保存按钮（onSave 可选）；非 readOnly 保留原行为（兼容未来恢复写入） | MUST onSave 在 readOnly 时不被调用 | D4 | +5/-2 |
| ui-chat | `app/web/src/components/plugin-config-page/section-ext-point-area.tsx:108-150` | group 迭代 + group impl 平铺 | 修改 | 嵌套迭代：`groups[].points[].impls[]`（不再跨 point 平铺到 extImpls[]）；触发条件 `if (impl?.schemaConfig)` → `if (impl?.configSchema)`；modalImpl state 改存 `{ implId, configSchema, config }` | MUST 嵌套循环外层 group → point → impl；MUST 保留 disabled prop（v0.0.67 整页 disabled 不变，只是齿轮按钮在 disabled 下也渲染）；MUST scope-switcher 不动 | D3+D4；research §4 | +20/-15 |
| ui-chat | `app/web/src/components/plugin-config-page/section-ext-point-area.tsx:242` | modal 触发 props | 修改 | `<ComponentSchemaConfigModal schemaConfig={modalImpl.schemaConfig}` → `<ComponentSchemaConfigModal configSchema={modalImpl.configSchema} readOnly />` | MUST 传 readOnly=true（v0.0.67 整页只读化保留） | D4 | +2/-1 |

### 模块 10：API + AT 测试

| 所属模块 | 文件路径 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| api | `specs/api/version_logs/v0.0.71.md` | （doc 文件） | 新增 | GET inventory 响应形状变更说明（嵌套 groups[].points[].impls[] + 新增 configSchema 透传 + config JOIN default + 删 schemaConfig/plugin 级字段）；PUT 仍 405 不变 | MUST 仅 GET 响应形状变更；MUST PUT 行为不变 | PRD 路径 P1-P4 | +60 |
| tests | `tests/api/plugin/inventory_nested_tc1/` | checkpoint.json + run.sh + test_case.md | 新增 | AT 覆盖 PRD P1（GET default → 7 groups 出现 + 顺序按 groups.json 声明序）+ P2（每 group points[].impls[] 嵌套结构 + EP group 归属正确）+ P3（impl `threshold_should_compact` 节点带 `configSchema` + `config.compactRatio=0.6`）+ P4（GET ?scopeId=forked → 只激活 context 子集 EP，未激活 EP 走 default 回退，pointActivated=false） | MUST 真服务（`ROCKY_TEST_MOCK_LLM=0` 不适用，本 case 不调 LLM）；MUST 断言基于 specs/api 契约（不扒代码）；MUST 通过率 ≥90%（PRD 关键路径硬阻塞门槛） | PRD P1-P4；D1+D3+bug-A | +80 |
| tests | `tests/api/plugin/inventory_schema_tc2/` | （可选第 2 个 AT case） | 新增 | 若 tc1 太大可拆：tc1 专注嵌套结构 + 7 group；tc2 专注 configSchema 透传 + config JOIN default + forked 增量 | MUST 两个 case 总通过率 ≥90% | PRD P1-P4 | +60 |
| tests | `app/server/src/plugin/__tests__/group-meta-loader.test.ts` | (新 UT 文件) | 新增 | GroupMetaLoader 形状校验 + LoadedGroupMetaProvider 唯一性检查（pointId 重复 throw / group id 重复 throw） | MUST 覆盖 D6 第 5 条不变量前置分支 | D6 | +60 |
| tests | `app/server/src/plugin/__tests__/scope-config-validator.test.ts` | `validateGroups` 测试 | 新增 | 覆盖 D6：(a) registry EP 缺登记 → throw；(b) groups.json 引用未知 EP → throw；(c) group id 重复 → throw；(d) pointId 重复 → throw | MUST 4 个 fail case + 1 个 happy case | D6 | +60 |

## 影响面评估

**跨模块**：config（PluginConfigService 接口形状）/ plugin_system（manifest/registry/extension-point/inventory-builder/plugin-manager/bootstrap/scope-config-validator）/ api（GET inventory 响应形状）/ ui（api-client 类型 + 6 个 plugin-config-page 组件）/ tests（UT + AT）。

**破坏性变更（schema 级）**：
1. `ExtensionPoint.group` 字段删 → 任何外部声明 EP 的代码编译失败（v0.0.71 内部可控，第三方暂无）
2. `PluginManifest.configSchema?/config?` 删 → 同上（0 使用，0 影响）
3. `SchemaConfigEntry`/`ExtImpl.schemaConfig` 删 → 7 builtin manifest + inventory + UI 同步清
4. `PluginInventoryTree.groups[]` 嵌套化 → UI 嵌套迭代（不再平铺）；AT case 重写
5. `ScopeConfigValidator constructor` 加必填 `groups` → bootstrap 同步改

**依赖顺序**（底层先）：
1. 新建 `groups.json` + `group-meta-loader/provider.ts`（独立，无下游依赖）
2. 删 `extension-point.ts:group` + `registry.ts` 校验 + `manifest.ts` 死字段（独立改 type）
3. `manifest.ts:SchemaConfigEntry` 删 + builtin plugin.json schemaConfig→configSchema 合并（依赖 2）
4. `inventory-builder.ts` 重构（JOIN GroupMetaProvider + 嵌套结构 + JOIN config defaults；依赖 1+3）
5. `plugin-config-service.ts` interface + constructor（依赖 4）
6. `scope-config-validator.ts` 加 `groups` 注入 + `validateGroups`（依赖 1）
7. `bootstrap.ts` 加载顺序（依赖 1+6）
8. `plugin-manager.ts:instantiate` deepMerge（独立）
9. UI `api-client.ts` 类型 + 6 个组件（依赖 5 的接口形状）
10. UT + AT case（依赖全部）

**风险点**（已 grounded）：
- bug-PLUGIN-004 deepMerge 改完后 7 个 configSchema 全扁平，行为等价但 UT 必跑防边界（research §4）
- D2 default.json 重写量大，需 coder 仔细按 group-EP-impl 三层声明（启动校验防漏）
- UI 嵌套迭代改动表面看不大但数据流变形，需 vision-check 不破布局（D4 形式不变）
- AT 真服务跑需 ROCKY_TEST_MOCK_LLM 不影响（inventory 不走 LLM），但 SERVER_PORT 必须对齐（memory 教训）

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- **coder 实现细节决策权保留**（research 标「architect 不规定实现细节」处可合理偏离），但偏离必须向 orchestrator 汇报

## 冲突 / 风险（架构期已识别，未自行发明）

**1. Spec 不可调和点 — `[P0]plugin_config_service.md §2.1` PluginInventoryTree 类型已声明 `points?` + `extImpls[]` 并存（顶层）；本版改嵌套 `points[].impls[]` 后顶层 `extImpls[]` 字段删除。** spec 现状 `points?` 与新嵌套结构 `points[]: { impls[] }` 字段名相同但语义不同（旧 = 平铺激活状态，新 = 嵌套包含 impls）。doc-modifier 阶段须明确标注这是破坏性 schema 变更（v0.0.71 modified 头注）。**对 orchestrator**：建议 doc-modifier 同步时给 `[P0]plugin_config_service.md §2.1` 整段重写，不是增量补充。

**2. D7 + D8 spec 描述深度联动 — `[P0]ext_impl_and_manifest_interface.md §3.5/§3.7`** 当前 spec 详细论证「configSchema 与 schemaConfig 并存」「plugin 级 + impl 级两层并存」。D7+D8 把这两个并存都打破了（删 schemaConfig、删 plugin 级 configSchema/config）。doc-modifier 须重写这两节为「单一 configSchema（impl 级）」+ 删除 BUG-PLUGIN-004 偏差注（line 148）。**对 orchestrator**：architect 阶段不重写 spec，仅产出新概念 spec `[P1]groups_meta_decl.md`；现有 spec 的「删字段」同步由 doc-modifier 阶段 5 完成。

**3. 测试覆盖风险 — 嵌套 inventory 改动触现有 AT case 重写**：`tests/api/plugin/inventory_*` 现有 case（如有）基于扁平 extImpls[]，本版改嵌套后旧 case 必失败，designer 阶段需重写。**对 orchestrator**：test-plan 阶段必须扫现有 `tests/api/plugin/` + `tests/e2e/plugin/` 目录、识别需重写的旧 case（不在本 change_plan 行内）。

**4. EP.group 删除连锁**：5 份 spec 文件引用 `EP.group`（research §2 列出），架构期不重写；doc-modifier 阶段须一次性 sync：`extension_point_interface.md §2/§3.6` + `config/index.md §④5` + `[P0]plugin_config.md §3` + `[P0]plugin_config_service.md §2 注` + `specs/api/version_logs/v0.0.67.md`。

**5. SchemaConfigEntry 删除对前端影响**：`api-client.ts:175-181` 类型 + `component-schema-config-modal.tsx` 当前用 SchemaConfigEntry 控件路由。删后 modal 改读 configSchema JSON Schema properties 推导控件。控件路由映射 string→input / number→input / boolean→switch / enum→select（JSON Schema 的 enum keyword）/ object→分组。**这是 D7 的 UI 半边，工作量集中在 modal.tsx**（research §5）。

未发现决策间相互冲突；D1-D8 + bug-A 互相正交（research 报告 §8 of bug-PLUGIN-004 已明确 D7 与 BUG-PLUGIN-004 正交；同理论证 D1-D6 间无相互冲突）。
