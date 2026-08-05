---
type: log
title: Plugin System KB 变更记录
updated: 2026-07-28
---

# Plugin System KB 变更记录（ISO 倒序，最新在前）

## 2026-07-28 · v0.0.208 academy 板块整体删除（影响：academy scope yaml 全删 + scopes 矩阵收窄）

- **`[P1]scopes_config_decl.md §1/§3`**：删 academy-coach.parent.{main,summary,consolidate} / academy-trainer.parent.main / academy-coach.subagent.main 等 scope yaml 示例行；per-type 文件矩阵收窄为 playground + studio 两 biz 的组合（parent.main/subagent.main + .summary/.consolidate）；典型 extends 链示例改用 studio-squad 替代 academy-coach。

> 本目录级变更日志（位置轴）。跨版本发布说明（版本轴）见 `specs/tech/version_logs/vX.Y/change_log.md`。
> 一行一 feature；版本块尾指向该版本 change_log 详情。

## 2026-07-26 · v0.0.206（删 plugin scope D6 default 短路 + channel EP 进 default.yaml）

- **删 D6 三处**（`scope-config-provider.ts`）：`isPointActivated` 删 `default→true` 特判；`listActivatedPoints` 删短路 + 签名删死参 `allPointIds`；`resolveSourceScope` 删 default 短路（extends 链 loop guard 自然落 'default'，行为不变）。16 个既有 EP 全在 default.yaml 声明 → 零行为回归（migration-equivalence 真实配置护栏 UT 守住）。
- **`[P0]plugin_manager_interface.md §3.6`**：重写为「extends 链 + default 无特权」四步解析（入口 throw / 激活 / 沿链回退 / default 无特权）；§2 jsdoc + §5 边界 channel 行同步（channel impl v0.0.206 起经 getExtensionImpls 统一 scope 解析，原「registry.getImplById 直取例外」删除）。
- **`[P1]scopes_config_decl.md §3.3`**：`isPointActivated`/`listActivatedPoints` 接口描述改「default 无特权同路径」。
- **`index.md`**：④ 新增原则 10（default 无特权，membership 即启用）。
- **`default.yaml`**：补 channel group/point/feishu impl（16→17 EP）——channel 接入 scope 模型详见 `../channel/log.md`；config KB 侧 D6 条款修订见 `../config/log.md`。
- 详情：`specs/tech/version_logs/v0.0.206/change_plan.md`（模块一/二）

## 2026-07-25 · v0.0.204 收尾（scope 矩阵启动校验 + resolveSourceScope 未注册 throw）

- **`[P1]scopes_config_decl.md §3.2`**：校验加第 4 条 `validateMainScopeMatrix`——每个 `<prefix>:main` scope 必须有对应 `:summary`+`:consolidate` scope 文件（main extends default 继承 compact 链，缺旁路 scope 文件则首次 compact 才在 resolveSourceScope 运行时 throw 暴露；启动硬失败提前暴露漏配；与 profile 侧 validateMainMatrix 对称）。
- **`[P1]scopes_config_decl.md §2.2/§2.3/§3.1/§3.3`**：现有 scopes 表更新——forked.yaml 拆分为 summary.yaml + consolidate.yaml 两基座 + 27 个 per-type canonicalId 文件；bootstrap 三基座始终加载；`resolveSourceScope` 入口 scopeId 未注册 → throw（runtime defense，不再静默兜底 default——静默落 default 对旁路 run = 真 compact 递归爆炸）。

## 2026-07-24 · v0.0.204（scope yaml 加 extends 链式回退 — 取代未激活 EP 直接回退 default 的二级模型）

- **`[P1]scopes_config_decl.md §1/§2.0`**：scope yaml 加 `extends` 字段（单父链式回退，取代原「未激活 EP 直接回退 default」的二级模型）；`resolveSourceScope(scopeId, pointId)` 沿 extends 链递归（环检测 + 父存在校验）；典型链 `academy-coach.parent.main → default` / `academy-coach.parent.summary → summary → default` / `academy-coach.parent.consolidate → consolidate → default`；base cases = default + summary + consolidate 三个基座。
- **scopeId 命名 = SessionKind.canonicalId 4 段**：v0.0.204 起 scopeId = `${biz}-${role}:${derivation}:${runKind}`（纯拼接，零路由表，AgentScopeRouter 删除）；每组合一文件（空文件 = 沿 extends 链继承）。
- **Loader/Validator/Provider 改造**：ScopeConfigLoader 加 extends 链递归 + 环检测 + 父存在校验；ScopeConfigValidator 加 extends 链闭合校验；LoadedScopeConfigProvider 加 `resolveSourceScope` 沿 extends 链（替原「未激活 → 直接 default」分支）。
- 详情：`specs/tech/version_logs/v0.0.204/change_plan.md`

## 2026-07-23 · v0.0.191（llm_anthropic impl 物理迁入 plugin 目录 — 目录结构示例补完）

- **`[P0]builtin_plugins_directory.md §2`**：目录结构示例 `llm_anthropic/` 子树补完——v0.0.191 起 anthropic impl 从主干 `app/server/src/llm/` 物理迁入 plugin 目录，新增 3 个 impl 内部模块（`protocol-encode.ts` + `protocol-encode-helpers.ts` + `protocol-parse-stream.ts`）+ `__tests__/` UT 子目录。§2 末尾补一段「impl 模块拆分自由」说明：manifest `ExtImpl.impl` 只指向 entry 模块（provider/protocol），entry 可自由 import 同目录内部模块（不在 manifest 登记、不参与扫描，只是 entry 的代码组织）；`__tests__/` 是 UT 跟随被测代码迁入位置。
- **未改契约**：扫描流程、manifest schema、impl 模块 default export 类约定全部不动（纯目录结构示例补完 + 一段语义澄清）。
- 详情：`specs/tech/version_logs/v0.0.191/change_log.md`（§B-1 impl 模块拆分范式 + 主条目归 providers_and_models KB）

## 2026-07-19 · v0.0.179.plugin_config（scope 配置模型简化 — impl 列表模型）

- **`[P1]scopes_config_decl.md`**：全面同步新模型——§2 文件 schema 对齐实际 YAML 三层树（groups→points→impls；spec 原写扁平 json，属 spec 落后修正）+ 扁平 ScopeConfig 转换产物（删 `exclusivePicks`/`enabled`，membership = active，数组序 = order，全量替换零 delta，`impls: []` = 显式 0 active）；§3.1 加载改 `*.yaml`；§3.2 校验三类不变量重写（删 exclusivePicks 校验 → exclusive EP 恰好 1 active + impl 归属 point 防跨 point 误列）；§4 强约定操作清单改「改选中 = 改 impls 数组项、禁用 = 从数组移除、新增 impl 必须加进 default.yaml（无 `?? true` 兜底）」；§5.2 新增设计决策「impl 列表模型」；test scope 无 yaml 文件（`buildTestScopeConfig()` 代码构造）。
- **`[P0]plugin_manager_interface.md`**：§1/§3.4 「直读 CrudStore/PluginPolicyStore」陈旧描述修正为「经 ScopeConfigProvider 读代码声明 membership」（v0.0.67 起即如此，spec 滞后本次清偿）；§2 解析规则表 + §3.5 exclusive 解析重写（validator 恰好 1 active + 统一 filter+sort 取 [0]；`exclusivePick`/`resolveByCardinality` 已删）；§3.6 per-EP 回退改 membership 取源；§5 边界补 channel impl 例外（per-instance `registry.getImplById`，不经 getExtensionImpls）。
- **`[P0]extension_point_interface.md`**：§2 cardinality 三态表重写——配置/读取类型无关，cardinality 仅 validator（exclusive 恰好 1）+ UI（按 type 渲染）消费；删「setExclusive 标记」「ExtImplPolicyData.order record」陈旧引用。
- **index.md**：① 概念表 PluginManager/effective order 行 + ⑤ 导航 scopes yaml 同步。

详情：`specs/tech/version_logs/v0.0.179/change_plan.md` + `specs/api/version_logs/v0.0.179.md`

## 2026-07-10 · v0.0.108（packaged 内置 plugin 编译/打包/加载，BUG-003）

- **新增 `[P0]packaged_plugin_loading.md`**：dev `.ts`（bun import）/ packaged `.cjs`（bun build 自包含 bundle + `require`）双模式；server import 外置成 `@app/server/dist/X` 共享 server 运行时（防 `session-store-ep-delegate` 等模块级单例断裂）；产物放 asar `node_modules/@app/plugins`（server→plugins 偏移 `../../` dev/packaged 一致 → bootstrap/skills 路径零改动）；Electron 42 实证 asar 内 require/import 均可行 + 单例跨边界共享。
- **`index.md`**：④ 增原则 9（packaged 编译加载 + server 外置共享）；⑤ 增 `packaged_plugin_loading.md` 导航行。
- **`[P0]builtin_plugins_directory.md`**：§3 补 packaged 加载注（impl 模块 dev `.ts` / packaged `.cjs`，loader 后缀双模式）。→ 详情 `version_logs/v0.0.108/change_log.md`

## 2026-07-05 · v0.0.72（web_search_provider EP cardinality exclusive → list）

- **`[P0]plugin_manager_interface.md`**：§3.5 末段 `exclusivePick()` 实现注——「`web_search_provider` 是首个 exclusive 落地用例」改「v0.0.72 起 `web_search_provider` 改 list，不再走 `exclusivePick`，改由 tool 按 `app_config.web_search.type` 在 list EP 中精确匹配 impl.id」；§3.6 代码示例 `web_search_provider` 通用 exclusive 段改为通用 `SomeExclusivePoint` 示例 + 新增 list EP 按 type 精确匹配 impl 示例（不取首个、不静默回退）。
- **`[P0]extension_point_interface.md`**：`WebSearchProviderPoint.cardinality` 由 `'exclusive'` 改 `'list'`（代码层 `app/server/src/plugin/extension-point.ts:194-199` 同步）。
- 实现层（task T1）：`extension-point.ts` `WebSearchProviderPoint.cardinality` 改 `'list'`；`scopes/default.json` 删 `exclusivePicks.web_search_provider`（list EP 不再有 exclusivePicks 项）；UT 同步改 cardinality 断言。
- 关联消费：web_search tool `resolveProvider` 改按 `app_config.web_search.type` 在 list EP 中精确路由（详 `specs/tech/agent/tools/log.md` v0.0.72 段 + `[P1]web_search_tool.md`）。

详情：`specs/tech/version_logs/v0.0.72/change_log.md`

## 2026-07-05 · v0.0.71（groups.json 唯一源 + configSchema 单一源 + 删 EP.group/plugin 级死字段）

- **新增 `[P1]groups_meta_decl.md`**：定义 `app/plugins/groups.json` 元数据唯一源 schema（GroupMeta id/label/description/extPoints）+ GroupMetaLoader/LoadedGroupMetaProvider 加载链路 + 「新增 EP 必须在 groups.json 登记且仅一次」强约定（D6 第 5 条不变量，启动校验硬失败）。
- **`[P0]extension_point_interface.md`**：§2 删 `ExtensionPoint.group` 必填字段（D1）；§3.6 重写为「group 元数据外置 groups.json」+ EP 自身只保留 id/cardinality/description；§3.8/§3.9 同步删 group 引用；§4 示例删 `group:` 行。
- **`[P0]ext_impl_and_manifest_interface.md`**：§2 删 `PluginManifest.configSchema?`/`config?`（D8 死字段）+ 删 `ExtImpl.schemaConfig?`/`SchemaConfigEntry`（D7）+ PluginManifest 加 `label?`；§3.5 重写为「configSchema 仅在 ext impl 级（单一源），deepMerge 合并」+ 删 BUG-PLUGIN-004 偏差注（v0.0.71 instantiate 已改 deepMerge）；§3.7 重写为「configSchema 单一源：校验+UI 控件路由+default 底座同源」。
- `index.md`：① 概念表更新（删 schemaConfig/configSchema/config，加 groups.json）；② 边界加 groups.json 行；④ 新增原则 7（groups.json 唯一源）+ 原则 8（configSchema 单一源）；⑤ 导航文字更新。
- 实现层（task 1-6）：新建 `app/plugins/groups.json`（D5 7 group）+ `group-meta-loader.ts`/`group-meta-provider.ts`；`extension-point.ts` 删 13 EP group 字段；`registry.ts` 删 group 校验分支；`manifest.ts` 删 schemaConfig/SchemaConfigEntry/plugin 级 configSchema+config；7 builtin plugin.json schemaConfig 块并入 configSchema.properties；`inventory-builder.ts` JOIN GroupMetaProvider + 嵌套 `groups[].points[].impls[]`（D3）+ bug-A JOIN manifest default；`plugin-config-service.ts` interface 嵌套化 + D7 字段；`scope-config-validator.ts` 加 `validateGroups`（D6 第 5 条）；`bootstrap.ts` 加载顺序；`plugin-manager.ts` instantiate spread → deepMerge（BUG-PLUGIN-004 修复）。

详情：`specs/tech/version_logs/v0.0.71/change_log.md`

## 2026-07-05 · v0.0.67（scopes 代码声明 + plugin ext 配置强约定）

- 新增 `[P1]scopes_config_decl.md`：定义 `app/plugins/scopes/*.json` 代码声明机制（ScopeConfig schema + Loader/Validator/Provider 加载链路 + 三类启动校验不变量）+ **「开发 plugin ext 必须同步改 scopes/*.json」强约定**（新增/修改/删除 ext impl 都要同步改 scopes 文件，否则启动校验失败）。
- `index.md`：⑤ 导航加 scopes_config_decl 行（P1）+ 配置管理面注释更新（v0.0.67 起只读）。
- 配套改 config KB（详 `specs/tech/config/log.md` v0.0.67 段）。

详情：`specs/tech/version_logs/v0.0.67/change_log.md`

## 2026-06-30 · v0.0.35

- OKF KB 化：建 `index.md`（5 章总起，88 行）+ 本 `log.md`；`[P0]overview.md` 内容按类拆流并入 index 后移 `soft_deleted/specs/tech/plugin_system/overview.md`（不 git rm）。
- 全部 7 个 spec 文件加 YAML frontmatter（`type`/`title`/`priority`/`status`/`updated`/`since`）。
- 正文清理 inline `[vX.Y]` / `[vX.Y modified]` 噪声 + 顶部 `> version:` / `> [vX.Y modified]:` blockquote + 尾部 `## 版本` 段 → 现状/log 分离；代码注释里的 `[vX.Y]` 保留。
- 直接修 spec：`extension_point_interface.md` §4 删「8 个内置 EP」「无 exclusive 内置 EP」错误断言（实际 9 个 EP 且 `web_search_provider` 是 exclusive + 有 builtin impl）；`builtin_plugins_directory.md` §2.3 rocky_context impl 计数订正（spec 旧述 26，manifest 自述 31，实际 33）；`overview.md` 并入 index 时订正 §6「5 个 ordered EP」缺 `system_reminder`（应为 6）。
- 已记 BUG-PLUGIN-001/002/003/004 待裁决。

## 2026-06-19 · v0.0.26（scope 维度 + per-EP 回退）

- `plugin_manager_interface.md` v2.2：`getExtensionImpls(point, scopeId)` 双接口重载（保留单参 100% 向后兼容）；§3.6 新增 per-EP 回退解析（D6 default 短路 + `resolveScopeSource` helper）；cardinality 算法不变仅源按 scope 取。
- 权威 scope spec 落 config 模块：`config/[P0]ext_impl_scope.md`（D1-D6 决策）。
- `PluginPolicyStore` impl 级 key 由单 implId 改复合 `${scopeId}::${implId}`（D2 编码 + D3 lazy migrate）；schema 字段不变。

详情：`specs/tech/version_logs/v0.0.26/change_log.md`

## 2026-06-XX · v0.0.23（web_search EP + 第一个 exclusive 内置）

- 新增 `WebSearchProviderPoint`（cardinality=`exclusive`, group=`web`）+ `zhipu_web_search` builtin plugin（implId=zhipu）。
- plugin_system specs 未同步：仍宣称「8 个内置 EP 无 exclusive」。→ 已于 v0.0.35 订正 + 记 BUG-PLUGIN-001。

## 2026-06-XX · v0.0.18（删 priority + 三级 description + effective order 统一）

- `extension_point_interface.md` v2.5：EP 加 `description?`（ext point 级三级 description 之一）；cardinality 三态默认规则改读 effective order。
- `ext_impl_and_manifest_interface.md` v3.0：**删 `ExtImpl.priority`**；ExtImpl 加 `description?`（impl 级三级 description）；ordered 排序 + exclusive 解析统一读 effective order。
- `plugin_manager_interface.md` v2.1：ordered 由「priority 降序」改「effective order 升序」；exclusive 由「priority 最高者胜」改「显式 setExclusive 标记 + effective order 最小者 fallback」（§3.5 新增决策）。

详情：`specs/tech/version_logs/v0.0.18/change_log.md`

## 2026-06-XX · v0.0.13（context 子系统 plugin 化）

- context 引擎全套迁到 rocky_context builtin plugin：6 个 ordered EP（group="context"）。
- `extension-point.ts` 加 6 个 context EP 进 `BUILTIN_EXTENSION_POINTS`（之前只有 llm_provider / llm_protocol）。

## 2026-06-XX · v0.0.5（schemaConfig + group-centric inventory）

- `ext_impl_and_manifest_interface.md`：ExtImpl 加 `schemaConfig?`（per-key UI 渲染 schema，与 configSchema 校验并存）。
- inventory 序列化 ext impl 节点字段名 `cardinality` → `type`（值不变；与 UI 组件 type 路由术语对齐）。

## 2026-06-XX · v0.0.4（group 必填）

- `extension_point_interface.md`：`ExtensionPoint.group` 由可选改必填 string（inventory 改 group-centric 聚合）。

## 2026-06-XX · v0.0.3（plugin 静态内核落地）

- 首版落地：`extension_point_interface.md` / `ext_impl_and_manifest_interface.md` / `plugin_manager_interface.md` / `builtin_plugins_directory.md` / `overview.md`（P0 静态内核）+ P1 占位（`plugin_lifecycle.md` / `discovery_and_install_interface.md` / `isolation_and_threat_model.md`）。
- Registry + BuiltinLoader + PluginManager + PluginPolicyStore 落 `app/server/src/plugin/`。
- 内置 plugin 落 `app/plugins/builtins/<pluginId>/plugin.json`。
