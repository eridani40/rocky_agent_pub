---
type: change_log
title: v0.0.71 — plugin ext 配置重构（层级清晰 + config 不丢 + group 细分）
version: v0.0.71
date: 2026-07-05
related_prd: specs/prd/version_logs/v0.0.71.md
related_research:
  - specs/research/v0.0.71-plugin-config-current-state.md
  - specs/research/v0.0.71-bug-plugin-004-config-merge.md
related_change_plan: specs/tech/version_logs/v0.0.71/change_plan.md
related_api_log: specs/api/version_logs/v0.0.71.md
grounded: 锁定决策 D1-D8 + bug-A（states/user_query.md v0.0.71 节 + states/v0.0.71/task-board.md）
---

# v0.0.71 — plugin ext 配置重构

> 一句话：**展示层对齐 spec + config 全链路打通 + group 细分**。无用户可见运行时行为变更（两级 enabled 门 / cardinality / scope 回退算法不变）；管理页 v0.0.67 起只读化保留，本版仅恢复「查看只读配置」入口。

## 1. config 子系统

### 1.1 动机
v0.0.67 把 plugin/ext 配置代码化后暴露三个展示层痛点 + 一个潜在 instantiate bug：
1. **层级乱**：enabled 是隐式推导（"未列 = true"），UI 看到的"启用项"与运行时实际启用项信息对不上。
2. **config 丢**（bug-A + bug-B 双因）：`threshold_should_compact.compactRatio=0.6` 配置页完全看不到（inventory 不 JOIN manifest default + v0.0.67 全页 disabled 把齿轮按钮一起藏了）。
3. **group 太大**：14 EP 里 10 个 `group="context"` 堆一个 tab = 42 impl，用户找不到东西。

### 1.2 改了什么
- **D1 信息分层**：新增 `app/plugins/groups.json`（group meta 唯一源），删 `ExtensionPoint.group` 字段（消除与 groups.json 冗余）。GroupMetaLoader + LoadedGroupMetaProvider（仿 scope-config-* 模式）。inventory `buildGroups` JOIN GroupMetaProvider 取 groupId，group 顺序按 groups.json 声明序（D5 七组固定排序）。
- **D3 inventory 形状重构**：`groups[].extImpls[]`（扁平）→ `groups[].points[].impls[]`（**嵌套**），对齐用户 demo 数据格式；inventory 节点新增 `configSchema` 透传（让前端 modal 可读 JSON Schema 形状）。
- **bug-A JOIN manifest default**：`buildExtImplNode` 改 `config: { ...extractConfigDefaults(impl.configSchema), ...(implCfg?.configValues ?? {}) }`，对齐 spec per-domain 默认表（之前代码静默偏离 spec，教训 v0.0.49 类型）。
- **D2 scopes 增量覆盖**：`default.json` 改满基线（13 EP × 每 EP 显式列 enabled impl + configValues，含 `threshold_should_compact.compactRatio=0.6` 双保险文档化）；`forked.json`/`test.json` 删 `_meta.disabledImplsReason`（disabled 不带 reason）。ScopeConfig 类型不动（research §3 确认字段足够）。

### 1.3 不变量保留
- overlay 模型（树枝=代码 registry，叶子=稀疏 delta）—— D2 仅改叶子内容来源（声明 vs 默认），不变 overlay 本质。
- 三域分立（app/dev/plugin）—— 不动。
- 配置代码化（v0.0.67 D2）—— 唯一源仍是 `scopes/*.json`，落盘 policy 仅 lazy migrate 兼容。
- 启动校验 throw（v0.0.67 D3）—— D6 加第 5 条不变量沿用同款硬失败风格。

## 2. plugin_system 子系统

### 2.1 动机
spec `[P0]ext_impl_and_manifest_interface.md §3.5/§3.7` 当前详述「configSchema（plugin 级 + impl 级两层）+ schemaConfig（per-key UI 简化）并存」+ 「plugin 级 configSchema 0 使用」。BUG-PLUGIN-004 调研（`states/v0.0.35/bugs/...`）证实：plugin 级 configSchema/config 是死字段，schemaConfig 与 configSchema 双源漂移风险高，instantiate 浅 merge 与 spec deepMerge 偏差。

### 2.2 改了什么
- **D7 删 schemaConfig 统一 configSchema**：`ExtImpl.schemaConfig` 字段、`SchemaConfigEntry` type、7 builtin manifest 的 schemaConfig 块全删；description/options 信息并入 configSchema.properties.<key>（JSON Schema 标准）；UI modal 改读 configSchema 推导控件。**全系统只剩一个 config 概念 = `ExtImpl.configSchema`（JSON Schema，校验+UI+default 同源）**。
- **D8 删 plugin 级死字段 + BUG-PLUGIN-004 deepMerge**：`PluginManifest.configSchema?` + `config?` 删除（0 plugin 声明 + 0 代码读）；`plugin-manager.ts:155-165` instantiate `merged = {...defaults, ...(cfg?.configValues ?? {})}` → `merged = deepMerge(defaults, cfg?.configValues ?? {})`（复用 `@app/server/llm` 的 deepMerge）。
- **D1 EP.group 字段删除**：13 个 builtin EP 常量的 `group:` 行删除；`registry.ts` group 必填校验分支删除（line 152-156）。前端零消费（research §2 已确认）。
- **D6 第 5 条不变量**：`ScopeConfigValidator` 接受 `groups: GroupMeta[]` 注入，新增 `validateGroups()` 校验 (a) registry 每个 EP 必须在某 group 出现且仅一次 (b) groups.json 引用的 pointId 必须在 registry (c) group id 唯一。bootstrap 加载顺序：builtin-loader → GroupMetaLoader → ScopeConfigValidator（带 groups）→ service/manager。

### 2.3 不变量保留
- 两级 enabled 门 `plugin.enabled ∧ impl.enabled`（v0.0.67 起 plugin 级恒 true）—— 不动。
- effective order 单一排序原语 + 末尾补位算法 —— 不动。
- cardinality 三态 + cardinality 驱动 UI 控件形态 —— 不动。
- 声明 vs 运行分离（manifest 纯静态）—— 不动。
- BUG-003 修复（`extractConfigDefaults` 取 `properties.<key>.default` 而非顶层）—— 不动，instantiate 仅改 spread→deepMerge 一行。

## 3. api 子系统（GET inventory 响应形状）

### 3.1 动机
`specs/api/overall/03-config-center.md §3.1` 当前 GET inventory 响应形状为扁平 `groups[].extImpls[]`（impl 跨 point 聚合），EP 在 group 内不显式成节点。D3 嵌套化让 point 在 group 内显式成节点 `{ pointId, activated, impls[] }`，更符合「scope → group → point → impl」用户心智。

### 3.2 改了什么
- GET `/config/plugin` 响应 `tree.groups[]` 改为 `{ groupId, points[]: { pointId, activated, impls[]: PluginExtImpl[] } }`。
- `PluginExtImpl` 新增 `configSchema?: JsonSchema`（透传 manifest configSchema）；删除 `schemaConfig?`（D7 同步）。
- `PluginExtImpl.config` 字段语义不变但值变化：现在始终是 manifest default + scope configValues 的合并结果（bug-A 修复后；之前是裸 configValues，未声明时为 undefined）。
- PUT 仍 405（v0.0.67 只读化保留，不变）。

### 3.3 不变量保留
- group/enabled 正交（group 决定展示分区，enabled 决定行为门）。
- per-EP 回退（非 default scope 未激活 EP → 取 default 视图，UI 灰显 + `ext-point-{pointId}-inactive-hint`）—— 不动。
- `selected` 派生字段（exclusive EP 选中项）语义不变。
- `pointActivated` 字段（impl 所属 EP 在当前 scope 的激活态）—— 嵌套化后从平铺迁进 `points[].activated`，语义不变。

## 4. UI 子系统（plugin-config-page）

### 4.1 动机
v0.0.67 全页 disabled 把齿轮按钮也藏了，导致用户看不到 config（bug-B）。本版恢复入口 + 改只读 modal。

### 4.2 改了什么
- 3 个 `component-ext-impl-{checkbox,radio,ordered}.tsx`：删 `!disabled` 守卫（齿轮按钮在 disabled 也渲染）；触发条件 `impl.hasSchemaConfig` → `impl.configSchema`（D7 后只有 configSchema 一个源）。
- `component-schema-config-modal.tsx`：加 `readOnly?: boolean` prop；改读 `configSchema`（不再读 schemaConfig）；控件路由复用现有 string/number/boolean/enum/object 五态（JSON Schema 推导）；readOnly=true 时所有字段 disabled + 隐藏保存按钮。
- `section-ext-point-area.tsx`：嵌套迭代 `groups[].points[].impls[]`（不再跨 point 平铺）；modal state 改存 `{ implId, configSchema, config }`；modal 触发统一传 `readOnly` prop。
- 布局/组件不动（D4 形式不变），仅数据流改嵌套。

### 4.3 不变量保留
- 整页只读（v0.0.67）—— 不动（齿轮按钮恢复但 modal 只读）。
- scope-switcher + EP header 副文本 + 三级 description 透传 —— 不动。
- radio/checkbox/ordered 控件形态（cardinality 驱动）—— 不动。

## 5. 测试

- **UT**：`plugin-manager.test.ts` 加 2 case（嵌套 deepMerge + undefined 不覆盖）；新 `group-meta-loader.test.ts` 覆盖 Loader/Provider 形状校验；`scope-config-validator.test.ts` 加 `validateGroups` 4 fail + 1 happy。
- **AT**：`tests/api/plugin/inventory_nested_tc1` 覆盖 PRD P1-P4（嵌套树 + configSchema 透传 + compactRatio=0.6 可见 + forked 增量）。真服务（不走 LLM）。
- **ET**：本版无设计稿（req 仅 req.md），视觉保真度 compare 关跳过；D4 UI 形式不变，ET 必要性低（待 test-plan 阶段评估）。

## 6. 风险

- **D2 default.json 重写量大**（13 EP × 多 impl × configValues）：coder 需对照 groups.json + manifest 仔细生成，启动校验防漏。
- **D7 modal 控件路由迁移**：schemaConfig 的 type 字面量（string/number/boolean/enum/object）→ JSON Schema properties.type 推导，需保留 5 态控件路由不丢。
- **嵌套 inventory 改动触现有 AT 重写**（如有）：test-plan 阶段必须扫 `tests/api/plugin/` + `tests/e2e/plugin/` 识别旧 case。
- **EP.group 删除连锁 spec sync**（5 份）：架构期不重写，doc-modifier 阶段统一 sync。

## 7. 文件清单汇总

新增：`app/plugins/groups.json` + `group-meta-loader.ts` + `group-meta-provider.ts` + `[P1]groups_meta_decl.md` + UT + AT case。
修改：`extension-point.ts` / `registry.ts` / `manifest.ts` / `inventory-builder.ts` / `plugin-config-service.ts` / `scope-config-validator.ts` / `bootstrap.ts` / `plugin-manager.ts` / `scopes/{default,forked,test}.json` / 7 builtin `plugin.json` / `api-client.ts` / 6 个 plugin-config-page 组件 / `specs/api/overall/03-config-center.md`。
删除字段：`ExtensionPoint.group` / `PluginManifest.configSchema?/config?` / `ExtImpl.schemaConfig?` / `SchemaConfigEntry` / `_meta.disabledImplsReason`。

> 单文件 ≤300 行约束：`group-meta-loader.ts` + `group-meta-provider.ts` 各预计 <150 行；`inventory-builder.ts` 改后约 230 行（仍合规）；`bootstrap.ts` 已超 800 行（架构期不重构，本版仅插入 ~20 行，doc-modifier 阶段记 known-issue）。
