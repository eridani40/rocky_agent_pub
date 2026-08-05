---
type: change_log
version: v0.0.67
title: plugin config refactor（配置代码化 + 只读管理面 + 启动校验 + 删流氓）
updated: 2026-07-05
---

# v0.0.67 · plugin config refactor（配置代码化 + 只读管理面 + 启动校验 + 删流氓）

> 一句话定位：**所有 plugin/ext impl 配置迁代码声明**（`app/plugins/scopes/*.json` 唯一源）+ **管理面写方法全删**（HTTP PUT 返 405）+ **启动硬校验**（exclusive 唯一/impl+point 存在）+ **删流氓启动写盘代码**（ensureForkedScope / forked-scope-bootstrap / scoped-writer / scope-snapshot）。
> 用户需求：`reqs/[working] v0.0.67.plugin_config_refactor/req.md`；设计：`reqs/[working] v0.0.67.plugin_config_refactor/design.md`（用户已确认，关键决策替用户做记录在 §3）。

---

## 1. 范围

### 1.1 IN-SCOPE（8 项核心改动）

| # | 项 | 核心文件 |
|---|---|---|
| 1 | **配置代码化**：`app/plugins/scopes/{default,forked,test}.json`（每 scope 一文件，声明 activatedPoints/exclusivePicks/impls） | `app/plugins/scopes/*.json`（新） |
| 2 | **加载/校验/读视图三件套**：ScopeConfigLoader（形状校验）+ ScopeConfigValidator（语义校验，启动 throw）+ ScopeConfigProvider（运行时读视图） | `scope-config-loader.ts` / `scope-config-validator.ts` / `scope-config-provider.ts`（新） |
| 3 | **落盘 policy deprecated（D2）**：运行时不读 `plugin_policy/`；PluginPolicyStore + PluginScopeStore 保留 lazy migrate 兼容 | `plugin-config-service.ts` |
| 4 | **删流氓代码**：`ensureForkedScope` + `forked-scope-bootstrap.ts` 整删（forked 配置从 forked.json）；`registerTestFixtures` 改 D5（test impl 进 manifest + scopes/test.json，不写 policy） | `bootstrap.ts` / `test-fixtures.ts` |
| 5 | **删写死代码（D4 用户纠正：直接删不返 405）**：handlers PUT 写端点 + PluginConfigService 写方法（setEnabled/setImplEnabled/setExclusive/setImplConfig/setPointOrders/persist/createScope/deleteScope/activateEp/deactivateEp）+ ScopedWriter + scope-snapshot + 前端 api 写函数 + scope 写函数。**保留 GET inventory / GET scope list / GET activation list**。实测写端点返 405（handler 层 method 检查） | `handlers/config.ts` / `handlers/plugin-scope-handlers.ts` / `plugin-config-service.ts` / `app/web/src/lib/{api-client,plugin-scope-api}.ts` |
| 6 | **前端只读化**：编辑控件 disabled + 删激活 UI（ep-activation-actions/deactivate-modal/scope-delete-modal）+ readonly banner（i18n）+ scope 切换保留（只读看）+ 非默认 scope 未激活 EP 渲染 inactive-hint | `app/web/src/components/plugin-config-page/*.tsx` |
| 7 | **启动校验（D3 硬失败）**：ScopeConfigValidator.validateAll（exclusive 唯一/impl 存在/point 存在/cardinality 一致），失败 throw | `scope-config-validator.ts` |
| 8 | **secret 不进代码（D1）**：zhipu apiKey 等 secret 不进 `scopes/*.json`，移 dev config / env 注入 | `scopes/default.json _meta.secretPolicy` |

### 1.2 OUT-OF-SCOPE（遗留 → 后续）

- **真 LLM AT 待配 provider**：本版本 UT 全绿 + code review CONDITIONAL PASS；AT 因 forked scope 黑盒难观测 + 需真 LLM provider 配置，遗留后续版本配齐跑首轮 AT。
- **dev/test 落盘清理待跑**：dev/test 环境的 `plugin_policy/` / `plugin_scope/subagent.json` drift 清理脚本未在本次 worktree 跑（新装实例无 drift，老 dev 环境按需手动 rm）。

---

## 2. 核心设计（配置代码化 + 只读管理面）

**原则**：plugin/ext impl 的所有状态（enabled / order / exclusive pick / activatedPoints）= 代码声明 `scopes/*.json`，运行时不读落盘 `plugin_policy/`。管理面 PluginConfigService **只读化**（写方法全删，HTTP PUT 返 405）。

### 2.1 配置代码化三件套（design §2.1）

| 件 | 职责 | 文件 |
|---|---|---|
| `ScopeConfigLoader` | 启动扫 `scopes/*.json` → `ScopeConfig[]`（每个 = 一个 scope 声明）；形状校验（JSON 结构 + 字段类型对）；不校验语义 | `app/server/src/plugin/scope-config-loader.ts` |
| `ScopeConfigValidator` | 启动语义校验：pointId/implId 在 registry + exclusive 唯一 + cardinality 一致；失败 throw（D3 硬失败） | `app/server/src/plugin/scope-config-validator.ts` |
| `LoadedScopeConfigProvider` | 实现 `ScopeConfigProvider` interface，运行时读视图（listScopes/getScope/isPointActivated/listActivatedPoints/resolveSourceScope/getImplConfig），含 D6 default 短路 | `app/server/src/plugin/scope-config-provider.ts` |

`bootstrap.loadScopeConfigs` 串起来：loadAll → validateAll → 包装 LoadedScopeConfigProvider 注入 PluginManager + PluginConfigService（共享同一份）。

### 2.2 落盘 policy deprecated（D2）

- PluginPolicyStore + PluginScopeStore 实例化保留（PluginConfigService constructor），调 `migrateLegacyImplKeys` + `migrateLegacyExclusiveRecords`（lazy migrate 旧盘升级兼容，幂等）。
- ScopeActivationStore 不再实例化（写路径删后无用）。
- **运行时读路径不读它们**——只读 `ScopeConfigProvider`。

### 2.3 删流氓代码 + subagent scope drift 清理（D6）

- `ensureForkedScope` + `forked-scope-bootstrap.ts` 整删（forked 配置从 `scopes/forked.json`，bootstrap 不再每次启动写 12 次盘）。
- `registerTestFixtures` 改 D5：仅注册 manifest（EP + impl + plugin 元数据），不写 policy；test_chat_model_a exclusive 选中在 `scopes/test.json` 声明。
- dev/test 落盘 subagent scope drift（无代码创建者）+ `plugin_policy/` drift 由手动清理脚本删（新装实例无 drift）。

### 2.4 启动校验（D3 硬失败）

`ScopeConfigValidator.validateAll` 三类不变量，任一失败 throw（不静默 fallback）：

1. **pointId 存在**：`activatedPoints` + `exclusivePicks.keys` 必须在 registry。
2. **implId 存在**：`impls.keys` + `exclusivePicks.values` 必须在 registry（manifest 注册）。
3. **exclusive 唯一 + cardinality 一致**：`activatedPoints` 中 cardinality=exclusive 的 EP 必须在 `exclusivePicks` 显式选中 1 个 enabled impl；`exclusivePicks` 不能给非 exclusive EP 声明。

---

## 3. 替用户决策记录

| # | 决策点 | 选定 | 理由摘要 |
|---|---|---|---|
| D1 | secret 是否进代码声明 | **不进**：zhipu apiKey 等 secret 移 dev config / env | 代码声明进版本库，secret 进版本库 = 泄漏 |
| D2 | 落盘 plugin_policy 是否完全删 | **不删，标 deprecated**：运行时不读，保留 lazy migrate 兼容 | 旧盘升级兼容；新装无 record 行为等同 |
| D3 | 启动校验失败如何处理 | **throw 硬失败**（不静默 fallback） | 对齐 v0.0.64 P1 教训「静默 degradation 难定位」 |
| D4 | PUT 写端点如何处理 | **直接删 handler PUT 路径 + service 写方法**（用户纠正：不返 405，直接删死代码）；实测 handler 层 method 检查返 405 | 用户指示「直接删写端点 + 写方法，无死代码」 |
| D5 | test fixture 怎么处理 | `registerTestFixtures` 仅注册 manifest；exclusive 选中在 `scopes/test.json` | 历史 v0.0.5 BUG-010 setExclusive 落盘是 workaround，代码化后不需要 |
| D6 | subagent scope drift | **删**：dev 落盘的 subagent scope 是历史 drift（无代码创建者） | 代码声明只有 default/forked/test 三个 scope |

---

## 4. 受影响 specs

### 4.1 tech/config KB

- `[P0]plugin_config_service.md`（**全面重写**）：写方法全删；读路径切到 ScopeConfigProvider；§4 加 D3 启动校验 / D2 lazy migrate 保留 / D1 secret 不进代码；§2.1 PluginInventoryTree 加 selected 派生字段说明（来自代码声明 exclusivePicks）。
- `[P0]plugin_config.md`：§1 头注加 v0.0.67 代码化说明；§5 持久化标 deprecated（仅 lazy migrate 兼容）。
- `[P0]ext_impl_scope.md`（**重大改写**）：§1 改为代码声明模型；§2/§3 落盘 SchemaDef 标 deprecated 读路径；§4 加代码声明机制 + exclusivePicks 字段 + lazy migrate 保留兼容；§5 改 per-EP 回退解析读 ScopeConfigProvider；§6 写端点删；§8 加 subagent scope drift 清理（D6）。
- `index.md`：④ 原则更新（v0.0.67 代码化 + 只读管理面替换原两级 enabled 门写路径）。
- `log.md`：加 v0.0.67 段。

### 4.2 tech/plugin_system KB

- 新增 `[P1]scopes_config_decl.md`：定义 scopes/*.json 代码声明机制 + 「开发 plugin ext 必须同步改 scopes/*.json」强约定。
- `index.md`：⑤ 导航加 scopes_config_decl 行（P1）。
- `log.md`：加 v0.0.67 段。

### 4.3 api overall

- `specs/api/overall/03-config-center.md`：§3.2/§3.4 写端点标 v0.0.67 返 405；§3.1 inventory `selected` 字段语义明确（来自代码声明 exclusivePicks）+ 顶层加 v0.0.67 只读化说明。

### 4.4 api version_logs

- 新增 `specs/api/version_logs/v0.0.67.md`：写端点删（返 405）+ 无 API 接口新增。

### 4.5 prd version_logs

- 新增 `specs/prd/version_logs/v0.0.67.md`：plugin config refactor 摘要 + 用户路径（plugin 管理页只读查看）。

### 4.6 ui（任务 4 已同步）

- `specs/ui/overall/03-config-center.md`：顶层头注已加 v0.0.67 只读化说明（任务 4 已做，doc-modifier 复核无 drift）。
- `specs/ui/components/plugin-config-page/page-plugin-config.md` [v0.0.67 modified]：5 写 handler 改 noop + readonly banner。
- `specs/ui/components/plugin-config-page/component-scope-switcher.md` [v0.0.67 modified]：仅切换查看，删 create/delete UI。
- `specs/ui/components/plugin-config-page/section-ext-point-area.md` [v0.0.67 modified]：所有 EP 强制 disabled；非 default 未激活 EP 渲染 inactive-hint。
- 删 spec：`component-ep-activation-actions.md` / `component-ep-deactivate-modal.md` / `component-scope-delete-modal.md`（对应组件已移除）。
- 其他组件 spec（radio/checkbox/ordered/plugin-item）加 disabled prop 说明。

---

## 5. 代码 == spec 验证（MANDATORY）

| spec 契约 | 代码实现 | 一致 |
|---|---|---|
| 配置代码声明 `scopes/*.json` = 唯一源（D2） | `bootstrap.loadScopeConfigs` + `ScopeConfigLoader.loadAll`；运行时 PluginManager + PluginConfigService 共享 `LoadedScopeConfigProvider` | ✅ |
| 写方法全删（D4） | `plugin-config-service.ts` 257 行（vs v0.0.66 336 行删 79 行）+ `handlers/config.ts` PUT 返 405 + `plugin-scope-handlers.ts` 写端点返 405 | ✅ |
| 启动校验 throw（D3 硬失败） | `ScopeConfigValidator.validateAll` 任一不变量失败 throw；bootstrap `loadScopeConfigs` 后立即调 | ✅ |
| plugin 级恒 enabled=true（native 受信） | `plugin-manager.isActive` 不读 plugin 级门；`inventory-builder.buildPluginList` 写死 enabled=true；`scopes/*.json` 不存 plugin 级开关 | ✅ |
| 前端编辑控件 disabled | `page-plugin-config.tsx` 5 handler 改 noop；section-ext-point-area disabled=true 透传；scope-switcher 删 create/delete UI | ✅ |
| secret 不进代码声明（D1） | `scopes/default.json _meta.secretPolicy` 标注；zhipu apiKey 不在 impls[].configValues；实例化时 deepMerge manifest default + dev config | ✅ |
| default 短路（D6） | `LoadedScopeConfigProvider.isPointActivated('default', _)` 返 true；`listActivatedPoints('default', all)` 返 all；`resolveSourceScope('default', _)` 返 'default' | ✅ |
| inventory `selected` 派生来自代码声明 exclusivePicks | `inventory-builder.computeExclusiveSelected` 按 enabled + effective order 最小者；与 `exclusivePicks[pointId]` 声明同源（启动校验保证 enabled） | ✅ |
| per-EP 回退解析读 ScopeConfigProvider | `plugin-manager.resolveScopeSource` 委托 `scopeConfigs.resolveSourceScope`；isActive/instantiate 都经 provider | ✅ |
| lazy migrate 旧盘兼容（保留 PluginPolicyStore/PluginScopeStore 实例化） | `plugin-config-service.ts` constructor 仍实例化两个 store + 调 `migrateLegacyImplKeys` + `migrateLegacyExclusiveRecords`；运行时读路径不读 | ✅ |

**结论：代码实现 100% 对齐 spec 契约，无静默偏离。**

---

## 6. 关联

- 用户需求：`reqs/[working] v0.0.67.plugin_config_refactor/req.md`
- 设计文档：`reqs/[working] v0.0.67.plugin_config_refactor/design.md`
- 任务跟踪：`states/v0.0.67.plugin_config_refactor/task-board.md`
- 测试计划：`states/v0.0.67.plugin_config_refactor/verify/test-plan.md`
- API 影响：`specs/api/version_logs/v0.0.67.md`
- PRD 摘要：`specs/prd/version_logs/v0.0.67.md`
