# v0.0.179 变更计划书 — plugin scope 配置模型简化（废 selected/enabled/delta，统一 getImpls）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。
> coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 设计概览（架构权威 — 落地前必读）

### 1. 新模型契约（用户铁律）

**配置 = impl 列表。一个 EP 在某 scope 的 YAML：**
- **不出现 = 继承 default 全量**（per-EP 继承语义保留）
- **出现 = 用自己声明的完整列表**（全量替换，零 delta）

废除：
1. `selected` —— 选中项 = impl 列表第一个（exclusive 列表本来就 1 个）
2. `enabled` —— 在列表里 = 启用，不在 = 不启用
3. `order` 字段语义 —— 数组顺序即 order（YAML 写入顺序）
4. delta 合并 —— 不存在「在 default 同 point 上做修改」的中间态

**`impls: []`（空数组占位）= 显式声明该 EP 0 个启用 impl**（要继承 default 就**删整个 point 节点**，不要用空数组占位）。

**类型保留（用户铁律）**：point 的 cardinality（ordered/list/exclusive）是 intrinsic 属性，在 `extension-point.ts` 声明，**客观保留不动**。配置/读取类型无关；类型只被 validator（exclusive → 列表恰好 1 个）和 UI（按类型渲染 radio/checkbox/ordered）消费。inventory API 的 `type` 字段保留。

### 2. 新 ScopeConfig 内部形状

```typescript
interface ScopeImplConfig {
  /** YAML 数组序（1-based）；来自 loader 解析。list 类型 EP 不用但统一保留。 */
  order?: number;
  /** per-impl 配置覆盖 manifest 默认值；secret 不放这（D1） */
  configValues?: Record<string, unknown>;
  // 删 enabled：key 存在即 active（membership = enabled）
}

interface ScopeConfig {
  scopeId: string;
  name: string;
  description?: string;
  /** point 节点存在 = 该 scope 配置此 EP（per-EP 继承判定用） */
  activatedPoints: string[];
  /** key 存在 = active impl（全量列表，无 delta merge） */
  impls: Record<string, ScopeImplConfig>;
  // 删 exclusivePicks：exclusive EP 的选中 = impls 列表第一项（validator 保证恰好 1 个）
}
```

**核心语义变更（影响所有下游）**：
- `getImplConfig(sourceScope, implId) !== undefined` = active（不再 `cfg?.enabled ?? true`）
- `getImplConfig(sourceScope, implId) === undefined` = 不 active（不再 default true）
- 全量替换 vs delta：scope A 某 EP 节点不出现 → 走 default 的 impls 列表（per-EP 继承）；出现 → 用 A 自己的列表

### 3. 统一 getExtensionImpls（删 cardinality 分支）

```typescript
getExtensionImpls<T>(point: ExtensionPoint<T>, scopeId: string = 'default'): T[] {
  const entries = registry.getByPoint(point.id);
  const sourceScope = scopeConfigs.resolveSourceScope(scopeId, point.id);
  // membership active（无 cardinality 分支，无 ?? true delta 源头）
  const active = entries.filter(e =>
    this.scopeConfigs.getImplConfig(sourceScope, e.manifest.implId) !== undefined);
  // 统一按 YAML 数组序排序（list 不关心顺序但无害；ordered/exclusive 都按此序）
  const sorted = [...active].sort((a, b) =>
    (this.scopeConfigs.getImplConfig(sourceScope, a.manifest.implId)?.order ?? Infinity) -
    (this.scopeConfigs.getImplConfig(sourceScope, b.manifest.implId)?.order ?? Infinity));
  return sorted.map(e => this.instantiate<T>(e, sourceScope));
}
```

**删除**：`resolveByCardinality` switch、`exclusivePick` 函数、`isActive` 的 `?? true`。validator 保证 exclusive EP 恰好 1 active → 排序后取 [0] 等价取唯一 active。

### 4. forked.yaml 迁移规则（delta → 全量）

| 现状（delta） | 新全量写法 | 决策依据 |
|--------------|-----------|---------|
| `context_ingest_handler` disable `system_reminder_injector` + `search_indexing`，继承其他 3 个 | `[query_truncate, tool_result_truncate, store_sink]` | forked 只要 `[query_truncate, tool_result_truncate, store_sink]`；default 是否含 `search_indexing` 是独立数据问题，不影响 forked 列表（本版本不修） |
| `system_reminder: impls: []` 占位 | **删 point 节点**继承 default | 空数组占位 = 0 active（错误）；继承 = 删节点 |
| `context_assemble_mapper: [transcript_reader]`（delta 未列 summary_reader → 默认 enabled） | **删 point 节点**继承 default | delta 实际有效 = `[transcript_reader, summary_reader]` = default 全量；新模型写 `[transcript_reader]` 会丢 summary_reader 改行为 |
| `context_assemble_reducer: [forked_builder]` | `[forked_builder]`（保留） | default 是 `[base_builder]`，forked 真换；与 default 不同 |
| `context_clean_view_reducer: [6 个 reducer 显式列]`（与 default 同） | **删 point 节点**继承 default | 显式列出仅因旧 forked scope 取源 = forked 需显式拿 order；新模型继承 default 即可 |
| `system_prompt_mapper: []` / `system_prompt_reducer: []` | **删 point 节点**继承 default | 空数组占位 |
| `context_should_compact` (exclusive) delta `selected: reject_should_compact` + disable threshold | `[reject_should_compact]` | exclusive → 恰好 1 |
| `context_do_compact` (exclusive) delta `selected: noop` + disable summary | `[noop_do_compact]` | exclusive → 恰好 1 |
| `context_post_compact` (ordered) disable memory_skill_consolidation | `[noop_post_compact]` | default = `[memory_skill_consolidation, noop_post_compact]`，forked 真减 |
| `session_store` (exclusive) delta `selected: in_memory` + disable persistent | `[in_memory_session_store]` | exclusive → 恰好 1 |

**最终 forked.yaml 激活的 EP**（6 个，删 5 个继承 default）：
`context_ingest_handler` / `context_assemble_reducer` / `context_should_compact` / `context_do_compact` / `context_post_compact` / `session_store`

### 5. default.yaml 迁移（废除 selected/enabled）

> **search_indexing 不在本版本范围（独立数据问题）—— 按现状转换 default.yaml，不顺手加。** 后果：新模型下 `search_indexing` 从旧 delta 习惯的 fallback-active（undefined→enabled=true 兜底）变 inactive（未列=不用），这是新模型的正确语义；若搜索索引功能依赖它，属独立决策不在本版本。

**迁移**（废除 selected/enabled）：
- 删 4 处 `selected:` 字段（context_should_compact / context_do_compact / session_store / skill_market_provider）
- exclusive EP 的 impls 列表只留选中项（其他候选不列 = 不启用）：
  - `context_should_compact: [threshold_should_compact]`（保留 configValues.compactRatio=0.6）
  - `context_do_compact: [summary_do_compact]`
  - `session_store: [persistent_session_store]`
  - `skill_market_provider: [skills_sh]`
- 注释头改写：废 selected/enabled，规则改「数组即 active 列表 + 数组序即 order」

### 6. 目标 forked.yaml 完整长这样

```yaml
scopeId: forked
name: forked
description: forked 旁路 run（summary/memory_extract）共用 scope：关 compact 防递归 + session_store 选 in_memory + forked_builder 复用固定 parentSnapshot
# 只列与 default 不同的 EP；未列 EP 继承 default 全量（per-EP fallback）
# exclusive EP 数组只 1 项；ordered/list EP 数组序即 order；空数组 = 0 个启用（慎用，一般应删节点继承）

groups:
  - id: context-ingest
    points:
      - pointId: context_ingest_handler
        # forked 关 system_reminder_injector + search_indexing（不进历史索引防污染）
        impls:
          - query_truncate
          - tool_result_truncate
          - store_sink

  - id: context-assemble
    points:
      - pointId: context_assemble_reducer
        # v0.0.178 forked 专用 forked_builder（复用固定 parentSnapshot + in_memory 增量）
        impls:
          - forked_builder

  - id: context-compact
    points:
      - pointId: context_should_compact
        impls:
          - reject_should_compact
      - pointId: context_do_compact
        impls:
          - noop_do_compact
      - pointId: context_post_compact
        impls:
          - noop_post_compact

  - id: context-engine
    points:
      - pointId: session_store
        impls:
          - in_memory_session_store
```

---

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统（yaml-config / loader / validator / provider / runtime / inventory / api-spec / frontend / test） |
| 文件路径 | 完整相对路径（worktree 根为准） |
| 函数/符号 | 函数名或符号名（行粒度 = 符号） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么、完成什么职责（禁"更新调用链"等模糊描述） |
| 约束 | MUST / MUST NOT，钉死边界 |
| 参考 | 该方法改动依赖/对齐的 spec 位置（路径+章节 / 项目原则编号） |
| 预计影响行 | +N / -M |

## 变更清单

### Block A — YAML 配置（default + forked + dist 副本）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| yaml-config | app/plugins/scopes/default.yaml | context_should_compact 节点 | 修改 | 删 `selected: threshold_should_compact` 行；impls 数组从 `[threshold_should_compact（带 configValues）, reject_should_compact]` 改为 `[threshold_should_compact（带 configValues）]`（保留 configValues.compactRatio=0.6） | MUST exclusive EP 恰好 1 项；configValues 不得丢；reject_should_compact 不列 = 不启用 | req.md；[P1]scopes_config_decl §2 | -2 |
| yaml-config | app/plugins/scopes/default.yaml | context_do_compact 节点 | 修改 | 删 `selected: summary_do_compact`；impls 从 `[summary_do_compact, noop_do_compact]` 改为 `[summary_do_compact]` | MUST exclusive EP 恰好 1 项 | req.md | -2 |
| yaml-config | app/plugins/scopes/default.yaml | session_store 节点 | 修改 | 删 `selected: persistent_session_store`；impls 从 `[persistent_session_store, in_memory_session_store]` 改为 `[persistent_session_store]` | MUST exclusive EP 恰好 1 项 | req.md | -2 |
| yaml-config | app/plugins/scopes/default.yaml | skill_market_provider 节点 | 修改 | 删 `selected: skills_sh`；impls 保持 `[skills_sh]`（本身就是 1 项） | MUST exclusive EP 恰好 1 项 | req.md | -1 |
| yaml-config | app/plugins/scopes/default.yaml | 文件顶部注释 | 修改 | 重写规则说明：废 selected/enabled；"在列表 = 启用，数组序即 order；EP 节点存在 = 该 scope 配置此 EP（per-EP 继承）" | MUST 与 [P1]scopes_config_decl §2 新 schema 对齐（doc-sync 待办） | req.md | +3/-3 |
| yaml-config | app/plugins/scopes/forked.yaml | 整文件 | 修改 | 按设计概览 §6 重写：删 5 个继承 default 的 point 节点（system_reminder / context_assemble_mapper / context_clean_view_reducer / system_prompt_mapper / system_prompt_reducer）；6 个保留 EP 改为全量列表；删所有 `selected:` / `enabled: false` | MUST 与 default 不同的 EP 才保留；MUST context_assemble_mapper 删节点（写 [transcript_reader] 会丢 summary_reader）；MUST exclusive EP 恰好 1 项 | 设计概览 §4/§6；[P1]scopes_config_decl | +18/-40 |
| yaml-config | app/plugins/dist/scopes/default.yaml | 文件 | 修改 | build-plugins 重生成（copy src → dist）；build 阶段重跑 `bun run scripts/build-plugins.ts` | MUST NOT 手改 dist；MUST 通过 build-plugins 生成 | scripts/build-plugins.ts:97-103 | 全量替换 |
| yaml-config | app/plugins/dist/scopes/forked.yaml | 文件 | 修改 | 同上（build-plugins 重生成） | 同上 | 同上 | 全量替换 |

### Block B — Loader（YAML → ScopeConfig 转换）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| loader | app/server/src/plugin/scope-config-loader.ts | ScopeImplConfig | 修改 | 删 `enabled?: boolean` 字段；保留 `order?` + `configValues?`；注释改为「key 存在即 active，无 enabled 字段」 | MUST NOT 保留 enabled（membership 即 active） | 设计概览 §2 | -2 |
| loader | app/server/src/plugin/scope-config-loader.ts | ScopeConfig | 修改 | 删 `exclusivePicks: Record<string, string>` 字段；保留 scopeId/name/description/activatedPoints/impls；注释改为「key 存在即 active impl；全量列表」 | MUST NOT 保留 exclusivePicks | 设计概览 §2 | -3 |
| loader | app/server/src/plugin/scope-config-loader.ts | YamlImplEntry | 修改 | 联合类型仅留 `{implId, configValues?}`（删 `enabled?`）；纯字符串形态保留 | MUST NOT 解析 enabled（直接删分支，不报错不 warn） | req.md | -2 |
| loader | app/server/src/plugin/scope-config-loader.ts | YamlPoint | 修改 | 删 `selected?: string` 字段 | MUST NOT 解析 selected | req.md | -1 |
| loader | app/server/src/plugin/scope-config-loader.ts | validateAndConvertYamlScope | 修改 | 删 selected → exclusivePicks 解析块（行 250-257）；删 enabled:false 分支（行 287-295, 324-325）；impls 字典填充逻辑改为「所有 YAML 列出的 impl 一律写入 `{ order: idx+1, configValues? }`」；返回对象删 exclusivePicks 字段 | MUST 原有形状校验（scopeId/name/groups 非空、implId 非空、configValues 是对象）保留；MUST 直接删 selected/enabled 解析分支——这些字段不读、不 throw、不 warn（用户裁决：旧字段是垃圾，YAML+代码同步改干净，无需代码兜底） | req.md；[P1]scopes_config_decl §3.1 | -25/+5 |
| loader | app/server/src/plugin/scope-config-loader.ts | 文件顶部注释块 | 修改 | 反映新模型：废 selected/enabled；数组即 active + 数组序即 order；YAML 不再有 selected/enabled 字段（loader 不读不报错） | MUST 与代码行为一致 | 设计概览 §1/§2 | +6/-6 |

### Block C — Validator（启动校验）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| validator | app/server/src/plugin/scope-config-validator.ts | validateOne（校验 2） | 修改 | 删「exclusivePicks.keys 必须在 registry 且 cardinality=exclusive」整段（行 130-143） | MUST 彻底删（字段已不存在） | req.md | -14 |
| validator | app/server/src/plugin/scope-config-validator.ts | validateOne（校验 3） | 修改 | 删「exclusivePicks.values 必须在 registry」段（行 152-158）；impls.keys 在 registry 校验保留 | MUST 保留 impls.keys registry 校验 | [P1]scopes_config_decl §3.2 | -7 |
| validator | app/server/src/plugin/scope-config-validator.ts | validateOne（校验 4） | 修改 | 整段（行 159-187）替换为「exclusive EP 在 activatedPoints 中 → 该 EP 在 impls 中恰好 1 个 active impl（impls.keys ∩ registry.getByPoint(ep) 长度 = 1）；0 个或多于 1 throw」；删 pick 归属 point 校验（已无 pick）；新增「impls 中某 implId 实际归属的 point（manifest.point）必须在该 scope 的 activatedPoints 中（防跨 point 误列）」 | MUST 错误消息含 scopeId + pointId + 实际 active count；MUST NOT 引用 cfg.exclusivePicks / cfg.impls[id].enabled（字段已删） | req.md；[P1]scopes_config_decl §3.2 规则 3 | -29/+22 |
| validator | app/server/src/plugin/scope-config-validator.ts | 文件顶部 docstring | 修改 | 第 9-12 行不变量列表改：删 exclusivePicks 4 处提及；新增「exclusive EP active 数恰好 1」 | MUST 与新校验逻辑一致 | req.md | +3/-3 |

### Block D — Provider（运行时读视图）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| provider | app/server/src/plugin/scope-config-provider.ts | ScopeConfigProvider.getImplConfig | 修改 | 接口注释改：返 undefined = 该 impl 不在 sourceScope active 列表（不再 default true）；返 ScopeImplConfig = active；ScopeImplConfig 形状（删 enabled） | MUST NOT 语义含糊；MUST 留接口签名不变（其他模块无需改） | 设计概览 §2 | +3/-3 |
| provider | app/server/src/plugin/scope-config-provider.ts | LoadedScopeConfigProvider.getImplConfig | 修改 | 实现不变（仍 `cfg.impls[implId]`）；注释改反映新语义 | MUST 保持返 cfg.impls[implId]；语义变更不影响实现 | 设计概览 §2 | +2/-2 |
| provider | app/server/src/plugin/scope-config-provider.ts | resolveSourceScope | 修改 | 注释更新：「per-EP 继承保留；scope EP 节点不出现 → 'default'；scope EP 节点出现 → scopeId（取该 scope 自己的 impls 全量列表）」 | MUST NOT 改算法（仍是 isPointActivated 判定） | [P0]ext_impl_scope §5.2 | +2/-2 |
| provider | app/server/src/plugin/scope-config-provider.ts | isPointActivated / listActivatedPoints | 修改 | 仅注释更新（point 节点存在 = 配置了该 EP）；实现不变 | MUST NOT 改实现 | [P0]ext_impl_scope §4.2 | +2/-2 |
| provider | app/server/src/plugin/scope-config-provider.ts | ImplConfigRead / 文件顶部 docstring | 修改 | 删 `exclusivePicks` 在 docstring 的提及（行 17-18）；ImplConfigRead = ScopeImplConfig（已删 enabled） | MUST NOT 引用已删字段 | 设计概览 §2 | +2/-2 |

### Block E — 运行时（plugin-manager 统一 getImpls）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| runtime | app/server/src/plugin/plugin-manager.ts | PluginManager.getExtensionImpls | 修改 | 重写实现体（行 82-92）：删 `resolveByCardinality` switch 调用；改为「filter membership active + 按 cfg.order 升序排序 + map instantiate」统一路径（见设计概览 §3 伪代码） | MUST 单参 + scopeId 双重载签名保留（向后兼容，不动 caller）；MUST NOT switch on cardinality；MUST 排序稳定（同 order 按 registry 登记序） | 设计概览 §3；req.md | +12/-6 |
| runtime | app/server/src/plugin/plugin-manager.ts | PluginManager.isActive（private） | 修改 | 改为 `return this.scopeConfigs.getImplConfig(sourceScope, entry.manifest.implId) !== undefined`（删 `?? true`，删 cfg?.enabled 读取） | MUST NOT 保留 `?? true`（delta merge 源头）；MUST 注释说明「membership-based active」 | 设计概览 §3；[P0]ext_impl_scope §5.2 | +2/-3 |
| runtime | app/server/src/plugin/plugin-manager.ts | PluginManager.resolveByCardinality（private） | 删除 | 整段（行 122-149）删；cardinality 分支合并进 getExtensionImpls 统一路径 | MUST 彻底删；MUST NOT 留死代码或 @deprecated | 设计概览 §3 | -28 |
| runtime | app/server/src/plugin/plugin-manager.ts | exclusivePick（module-level fn） | 删除 | 整段（行 186-197）删；validator 保证 exclusive EP 恰好 1 active → 统一 filter+sort 后自然取到唯一项 | MUST 彻底删 | 设计概览 §3 | -12 |
| runtime | app/server/src/plugin/plugin-manager.ts | PluginManager.instantiate（private） | 修改 | 注释更新「configValues 源 = ScopeConfig.impls[implId].configValues；impl 必为 active 才进此函数」；实现逻辑（deepMerge extractConfigDefaults + configValues）不变 | MUST NOT 改实现；MUST 仅注释同步 | [P0]ext_impl_scope §5.2 | +1/-2 |
| runtime | app/server/src/plugin/plugin-manager.ts | PluginManager.resolveScopeSource | 修改 | 仅注释微调（保留 per-EP 继承语义说明）；实现不动 | MUST NOT 改实现 | [P0]ext_impl_scope §5.2 | +1/-1 |
| runtime | app/server/src/plugin/plugin-manager.ts | 文件顶部 docstring | 修改 | v0.0.67 重构说明改为 v0.0.179 模型简化说明：废 selected/enabled/delta；统一 getExtensionImpls；per-EP 继承保留；cardinality 仅 validator + UI 消费 | MUST 与代码行为一致 | 设计概览 | +6/-6 |

### Block F — Inventory（前端消费的派生树）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| inventory | app/server/src/plugin/inventory-builder.ts | ExtImplNode.enabled 字段 | 修改 | 派生规则改：`enabled = scopeConfigs.getImplConfig(sourceScope, implId) !== undefined`（membership）；删 `?? true` | MUST 与 isActive 同口径 | 设计概览 §2 | +2/-2 |
| inventory | app/server/src/plugin/inventory-builder.ts | ExtImplNode.selected 字段语义 | 修改 | 注释改：`selected = (point.cardinality === 'exclusive') && enabled && （active 中 order 最小者）`；派生算法改读 membership（不读 enabled 字段，cfg !== undefined 即 active） | MUST exclusive EP 数组首项 = selected；list/ordered 永远 false | [P0]ext_impl_scope §7；specs/api/overall/03-config-center.md §3.1 | +3/-3 |
| inventory | app/server/src/plugin/inventory-builder.ts | buildExtImplNode | 修改 | enabled 派生改为 `implCfg !== undefined`（删 `implCfg?.enabled ?? true`）；config 仍 JOIN manifest default ⊕ cfg.configValues；order 取 `implCfg?.order`（保持） | MUST NOT 改 config JOIN 算法；MUST enabled 派生与 isActive 同口径 | 设计概览 §2 | +2/-2 |
| inventory | app/server/src/plugin/inventory-builder.ts | computeExclusiveSelected | 修改 | 算法改：active = `entries.filter(e => scopeConfigs.getImplConfig(sourceScope, e.implId) !== undefined)`；多 active 取 order 最小；注释改为「与运行时 plugin-manager 统一 getExtensionImpls 同口径」 | MUST NOT 引用 cfg.enabled；MUST 与 plugin-manager 排序逻辑一致 | 设计概览 §3 | +3/-3 |
| inventory | app/server/src/plugin/inventory-builder.ts | buildGroups（computeEffectiveOrders 调用） | 修改 | 注释改：「per-point effective order 按 YAML 数组序跑（list EP 不关心顺序但 unified 跑）」；调用点不变 | MUST NOT 改 computeEffectiveOrders 算法（保留 1..n 连续化） | order-utils.ts | +2/-2 |
| inventory | app/server/src/plugin/inventory-builder.ts | 文件顶部 docstring | 修改 | 反映新模型：enabled/selected 都从 membership 派生 | MUST 与代码一致 | 设计概览 | +3/-3 |

### Block G — 测试 fixture

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| test | app/server/src/plugin/test-fixtures.ts | buildTestScopeConfig | 修改 | 删 `exclusivePicks: { test_chat_model: 'test_chat_model_a' }`；impls 改为 `{ test_chat_model_a: { order: 1 }, test_retriever_a: { order: 1 }, test_retriever_b: { order: 2 }, test_retriever_c: { order: 3 } }`（全量声明 test scope 激活的 impl） | MUST test_chat_model exclusive 恰好 1 active（test_chat_model_a）；MUST test_retriever 3 impl 全 active（registry 登记 a/b/c）；MUST 与新 ScopeConfig 形状一致（无 exclusivePicks） | 设计概览 §2 | +6/-2 |
| test | app/server/src/plugin/test-fixtures.ts | docstring | 修改 | 反映新模型（test impl 全列在 impls 字典；exclusive EP 恰好 1） | MUST 与代码一致 | 设计概览 | +2/-2 |

### Block H — 前端（数据源切换，类型渲染不动）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| frontend | app/web/src/lib/api-client.ts | PluginExtImpl | 修改 | 注释改：`enabled` 字段语义 = membership（在列表里）；`selected` 字段语义不变（exclusive 选中项 = 列表第一项）；`order` 字段语义不变；字段都保留（前端按 inventory 派生值消费，不重算） | MUST NOT 删字段（前端读 inventory 派生值）；MUST 仅注释同步 | specs/api/overall/03-config-center.md §3.1 | +3/-3 |
| frontend | app/web/src/components/plugin-config-page/component-ext-impl-router.tsx | ComponentExtImplRouter | 修改 | 仅注释微调（数据源仍来自 inventory：selected/enabled/order 派生字段）；实现零改动（router 仍按 type 选 radio/checkbox/ordered） | MUST NOT 改实现（数据源在 inventory 派生，前端无感）；MUST 类型渲染（radio/checkbox/ordered）不动（用户铁律） | req.md；specs/ui/components/plugin-config-page/component-ext-impl-router.md | +1/-1 |
| frontend | app/web/src/components/plugin-config-page/__tests__/exclusive-selected.test.tsx | 测试用例 | 修改 | 测试场景不变（仍验证 selected 字段驱动 radio 渲染）；新增 1 case：`enabled=false` 的 exclusive impl（default 未选中项）selected=false 且非 checked（验证 inventory 派生正确） | MUST NOT 删既有 case；MUST 加新 case 覆盖 membership 派生语义 | specs/ui/components/plugin-config-page/component-ext-impl-radio.md | +15/-0 |

### Block I — API spec 同步（doc-modifier 阶段 5 处理，架构期不写）

详 doc-sync 待办章节。

---

## 影响面评估

**跨模块**（按依赖顺序）：
1. 底层：YAML（default/forked） → Loader → ScopeConfig 形状
2. 中层：Validator（校验规则） + Provider（语义注释）
3. 上层：PluginManager（运行时统一 getImpls） + InventoryBuilder（派生字段）
4. 消费：API inventory（形状不变，仅字段语义变） → 前端（数据源切换，类型渲染不动）

**破坏性变更**：
- ScopeConfig 接口字段（删 enabled / 删 exclusivePicks）→ 影响所有 UT（test-helpers / 多个 *.test.ts 直接构造 ScopeConfig）
- YAML 不再支持 `selected` / `enabled` 字段（loader 直接删解析分支，不读不报错）
- forked.yaml 重写（5 个 EP 节点删除）

**依赖顺序约束**：YAML → Loader → Validator → Provider 注释 → plugin-manager/inventory → test-fixtures → 前端测试

**风险点**：
1. `search_indexing` 在 default 未声明 → 新模型下从 fallback-active（旧 delta 兜底）变 inactive（未列=不用的正确语义）；若搜索索引功能依赖它，属独立决策不在本版本
2. forked.yaml 删 `context_assemble_mapper` 节点继承 default：之前 forked delta 下 effective = `[transcript_reader, summary_reader]` = default 全量，删节点继承等价；新模型下若误写 `[transcript_reader]` 会丢 summary_reader（已在迁移规则强调）
3. 全量 UT 影响：scope-config-validator.test.ts / plugin-manager-scope.test.ts / plugin-config-service-v0.0.5.test.ts 等多文件直接构造 ScopeConfig，需改测试 fixtures（属 coder 实现细节，不单列 change_plan 行）

**packaged 影响评估**：本版本仅改 plugin 子系统配置层 + 运行时取 impl 逻辑，无新依赖、无新运行时 env 键、无新 native addon、无新文件系统路径。dist/scopes 由 build-plugins 重生成（既有机制）。**packaged 验证可豁免**（dev AT 全绿即可，无需解包 asar 验）。

## 反馈回路

- 实现 / codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- YAML 字段误删（如 default 的 `configValues.compactRatio=0.6` 丢失）→ 退 coder
- forked.yaml 的 `context_assemble_mapper` 误写成 `[transcript_reader]` 而非删节点 → 退 coder（违反设计概览 §4 迁移规则）

---

## doc-sync 待办（doc-modifier 阶段 5 处理）

| 文件 | 章节 | 变更要点 |
|------|------|---------|
| specs/tech/config/[P0]ext_impl_scope.md | §4.2 代码声明机制 | ScopeConfig 接口字段：删 `exclusivePicks`；ScopeImplConfig 删 `enabled`；改述「impls key 存在即 active；全量列表，无 delta merge」 |
| specs/tech/config/[P0]ext_impl_scope.md | §4.3 exclusivePicks 字段 | 整节删除（字段已废）；改写为「exclusive EP 在 activatedPoints → impls 列表恰好 1 项」 |
| specs/tech/config/[P0]ext_impl_scope.md | §5.2 per-EP 回退解析 | 伪代码 `active = entries.filter(e => scopeConfigs.getImplConfig(sourceScope, e.implId) !== undefined)`；删 `?? true`；删 cardinality switch；改述「统一 filter + 按 order 排序」 |
| specs/tech/config/[P0]ext_impl_scope.md | §5.3 cardinality 解析复用 | 整节改写：运行时不再分支（统一）；cardinality 仅 validator（exclusive 恰好 1）+ inventory UI（按 type 渲染）消费 |
| specs/tech/plugin_system/[P1]scopes_config_decl.md | §2 文件 schema | ScopeConfig 字段：删 `exclusivePicks`；ScopeImplConfig 删 `enabled`；YAML 形状：废 `selected` / `enabled` 字段；改述「数组即 active 列表 + 数组序即 order」 |
| specs/tech/plugin_system/[P1]scopes_config_decl.md | §3.2 校验三类不变量 | 校验 3 改：「exclusive EP 在 activatedPoints → impls 列表恰好 1 active impl」；删 exclusivePicks 相关校验 |
| specs/tech/plugin_system/[P1]scopes_config_decl.md | §4 强约定 | 操作清单改：「exclusive EP 改选中 → 直接改 impls 数组项（不再 exclusivePicks）」；「禁用 impl → 从 impls 数组移除（不再 enabled: false）」 |
| specs/tech/config/[P0]plugin_config.md | §2 ExtImplConfigRecord | enabled/order 字段语义注释：运行时值源 = `scopes/*.yaml` 列表 membership + 数组序（不再 enabled 字段） |
| specs/api/overall/03-config-center.md | §3.1 inventory 字段 | enabled 派生规则改：membership（在列表）；selected 派生规则改：exclusive EP 列表首项；新增「YAML 配置层模型 = 全量列表，无 delta merge」段 |
| specs/api/version_logs/v0.0.71.md | 不动（历史 change_log） | 仅参考，不改（已是历史版本日志） |
| specs/api/version_logs/v0.0.179.md | 新增 | 本次 inventory 字段语义变更：enabled/selected 派生规则改；YAML 配置模型变更；PUT 仍 405；向后兼容性分析 |

**架构期不写 specs/，由 doc-modifier 阶段 5 统一同步**。coder 实现时若发现 spec 与代码冲突，按代码实际调整 + 汇报偏离 → orchestrator 记 doc-sync 待办（已纳入本表）。

---

## 开放设计问题（需 architect 确认拍板）

**Q1：loader 是否对 YAML 中出现的 `selected` / `enabled` 字段 throw？**
- 选项 A：throw，fail-fast 防漂移（旧 yaml 误改回会立即报错）
- 选项 B：warn + 忽略（宽松）
- 选项 C：不 throw、不 warn，直接删解析分支
- **architect 决定：C（不 throw、不 warn，直接删解析分支）**——用户裁决：旧字段是垃圾代码，配置在代码里同步改，不写防御性检查。YAML 转换时已把 `selected`/`enabled` 全删干净，无残留需要代码兜底。

**Q2：`computeEffectiveOrders` 是否保留？**
- 选项 A（推荐）：保留（inventory 仍需 1..n 连续化输出给前端；plugin-manager 内部直接用 cfg?.order 简单排序）
- 选项 B：删，inventory 也用简单 sort
- **architect 决定：A（保留）**——inventory 输出 1..n 连续序对 UI 友好；改 inventory 用 cfg?.order 直接显示也能工作但破坏既有 UI 契约。order-utils.ts 不动。

**Q3：forked.yaml 的 `context_assemble_mapper` 节点处理**
- 现状（delta）：`impls: [transcript_reader]`（仅 override order，summary_reader 默认 enabled）
- 新模型选项 A（推荐）：删整个 point 节点（继承 default，行为等价）
- 选项 B：写 `impls: [transcript_reader, summary_reader]`（显式全量，行为等价但冗余）
- **architect 决定：A（删节点继承）**——符合用户铁律「与 default 全同的 EP 删节点继承，不留冗余」。

**Q4：默认 YAML 注释头是否更新到 [P1]scopes_config_decl.md 同步规则？**
- **architect 决定：是**——YAML 注释头与 spec §2 字段定义对齐，doc-modifier 阶段 5 统一处理（已纳入 doc-sync 待办）。
