---
type: spec
title: Scopes 代码声明（app/plugins/scopes/*.yaml）
priority: P1
status: active
updated: 2026-07-26
since: v0.0.67
---

# Scopes 代码声明（app/plugins/scopes/*.yaml）

## 1. 概述

**管什么**：scope 配置的**代码声明机制**——`app/plugins/scopes/*.yaml` 文件 schema（groups→points→impls 树）、加载链路（ScopeConfigLoader → ScopeConfigValidator → ScopeConfigProvider）、字段语义、启动校验规则、「开发 plugin ext 要一起改配置」强约定。
**不管什么**：scope 元信息落盘 SchemaDef（v0.0.67 起 deprecated 读路径，详 `config/[P0]ext_impl_scope.md §2`）、PluginConfigService 管理面接口契约（→ `config/[P0]plugin_config_service.md`）、运行时 per-EP 回退算法（→ `config/[P0]ext_impl_scope.md §5`）、HTTP 端点（→ `specs/api/overall/03-config-center.md`）、**[v0.0.204] scopeId = SessionKind.canonicalId 纯拼接（→ `../agent/session/[P0]session_type_profile.md §2/§5`）**。
总览见 `[index.md`](index.md)。

所有 scope 配置（元信息 + 激活 EP + impl 列表）全部代码声明在 `scopes/*.yaml`。运行时不读落盘 `plugin_scope` / `ext_impl_scope_activation` / `plugin_policy`（落盘 entity 保留实例化仅 lazy migrate 兼容）。**代码声明 = 唯一源**。

**配置模型（impl 列表模型 + v0.0.204 extends 链式回退）**：配置 = impl 列表。一个 EP 在某 scope 的 YAML：**不出现 = 沿 `extends` 链回退（per-EP 继承）；出现 = 用自己声明的完整列表（全量替换，零 delta merge）**。在 impls 数组里 = active，不在 = inactive（membership 即启用，无 `enabled` 字段）；数组序即 order（无 `order` 字段）；exclusive EP 的选中 = 数组唯一项（无 `selected` 字段，validator 保证恰好 1）。`impls: []`（空数组）= 显式声明该 EP 0 个 active impl（要继承父级就删整个 point 节点，不要用空数组占位）。

**[v0.0.204] scope yaml `extends` 字段**：取代原「未激活 EP 直接回退 default」的二级模型；每个 scope 显式声明单父，`resolveSourceScope(scopeId, pointId)` 沿 extends 链递归（环检测 + 父存在校验）；典型链：`studio-squad.parent.main → default` / `studio-squad.parent.summary → summary → default` / `studio-squad.parent.consolidate → consolidate → default`。**v0.0.204 前**：未激活 EP 直接回退 default；**v0.0.204 后**：未激活 EP 沿 extends 链回退（base cases = default / summary / consolidate 三个基座）。

**cardinality（类型）保留**：EP 的 cardinality（ordered/list/exclusive）是 intrinsic 属性，在 `extension-point.ts` 声明。配置与运行时读取都**类型无关**（统一 filter membership + 按数组序排序，无 cardinality 分支）；cardinality 仅被 **validator**（exclusive → 列表恰好 1）和 **UI**（按 type 渲染 radio/checkbox/ordered）消费，inventory API 的 `type` 字段保留。

| 件 | 角色 | 入口 |
|---|---|---|
| `app/plugins/scopes/<scopeId 文件名>.yaml` | 一个 scope 的代码声明（每 scope 一文件，scopeId = SessionKind.canonicalId 4 段命名） | 人工编辑（开发 plugin ext 时同步改，§4） |
| `ScopeConfigLoader` | 启动扫目录 + 形状校验（YAML 解析 + 字段类型对 + 树→扁平转换 + **[v0.0.204] extends 链递归 + 环检测 + 父存在校验**） | `app/server/src/plugin/scope-config-loader.ts` |
| `ScopeConfigValidator` | 启动语义校验（pointId/implId 在 registry + exclusive 恰好 1 + **[v0.0.204] extends 链闭合**） | `app/server/src/plugin/scope-config-validator.ts` |
| `LoadedScopeConfigProvider` | 运行时读视图（实现 `ScopeConfigProvider` interface；**[v0.0.204] resolveSourceScope 沿 extends 链**） | `app/server/src/plugin/scope-config-provider.ts` |
| `bootstrap.loadScopeConfigs` | 加载 + 校验 + 包装 provider，注入 PluginManager + PluginConfigService | `app/server/src/bootstrap.ts` |

---

## 2. 文件 schema（YAML 树 → 扁平 ScopeConfig）

### 2.0 YAML 文件形状（groups → points → impls 三层树，人工编辑面）

```yaml
scopeId: default            # scope 业务 id（snake_case，default 常驻；v0.0.204 起 = SessionKind.canonicalId 4 段：${biz}-${role}.${derivation}.${runKind}）
name: Default               # 显示名（必填非空）
description: 默认基线 scope  # 可选
extends: default            # [v0.0.204] 可选——单父链式回退（default 自身为 root 无 extends）；validator 校验父存在 + 无环

groups:                      # 必填数组；group 与 groups.json 的分区对应（loader 只要求 id 非空）
  - id: context-compact
    points:                  # point 节点存在 = 该 scope 配置此 EP（per-EP 继承判定用）
      - pointId: context_should_compact
        impls:               # 数组 = 该 EP 在本 scope 的完整 active 列表（全量替换，零 delta）
          - implId: threshold_should_compact   # 对象形态：带 configValues 覆盖
            configValues:
              compactRatio: 0.6
      - pointId: context_do_compact
        impls:
          - summary_do_compact                  # 纯字符串形态：active + 无 configValues
```

**规则**：
- **在 impls 数组里 = active；不在 = inactive**（membership 即启用，无 `enabled` 字段）。
- **数组顺序即 order**（无 `order` 字段；list 类型 EP 不关心顺序但统一保留）。
- **exclusive EP：impls 数组恰好 1 项**（validator 启动期校验，§3.2）。
- **`impls: []` 或缺省 `impls` 字段 = 该 EP 显式 0 个 active impl**（不是继承占位；要继承父级就**删整个 point 节点**）。
- **configValues 只在非默认值时写**（默认走 manifest `configSchema.default`）；secret 不放这（D1）。
- **[v0.0.204] 一个 EP 在某 scope 不出现 = 沿 `extends` 链回退（per-EP 链式继承）；出现 = 用自己声明的完整列表**（全量替换，零 delta merge）。**v0.0.204 前**：未激活 EP 直接回退 default；**v0.0.204 后**：未激活 EP 沿 extends 链回退。
- **default scope 必须显式列出全部期望 active 的 impl**——新模型无「注册未声明 → 默认 active」兜底（旧 `?? true` fallback 已废），注册但未在任何 EP 列表出现的 impl = inactive。

### 2.1 内部 ScopeConfig（loader 转换产物，下游消费面）

Loader 把 YAML 树转成扁平 `ScopeConfig`（`scope-config-loader.ts`），下游（Validator/Provider/PluginManager/inventory）只消费扁平形状：

```typescript
interface ScopeConfig {
  /** scope 业务 id（default 常驻；summary/consolidate 基座 + canonicalId per-type 文件 + test 等非默认） */
  scopeId: string;
  /** 显示名（必填非空） */
  name: string;
  /** 说明（可选，缺省视为空串） */
  description?: string;
  /** point 节点存在 = 该 scope 配置此 EP（per-EP 继承判定用；subset of registry.listPoints()） */
  activatedPoints: string[];
  /** implId → 配置；key 存在 = active impl（membership，全量列表，无 delta merge） */
  impls: Record<string, ScopeImplConfig>;
}

interface ScopeImplConfig {
  /** YAML 数组序（1-based）；loader 解析时填充；list 类型 EP 不用但统一保留 */
  order?: number;
  /** per-impl 配置覆盖 manifest 默认值；secret 不放这（D1） */
  configValues?: Record<string, unknown>;
}
```

YAML impl 数组元素两种形态（loader 一律视作 active 写入 impls 字典）：
- 纯字符串 `"implId"` → `impls[id] = { order: 数组序 }`
- 对象 `{implId, configValues?}` → `impls[id] = { order: 数组序, configValues? }`

YAML 中即使误写旧字段 `selected` / `enabled`，loader **不读、不 throw、不 warn**（解析分支已删；YAML 与代码同步改干净，无防御性兜底）。

### 2.2 文件命名

- 一个 scope 一个文件，文件名约定 `<scopeId>.yaml`（`default.yaml` / `summary.yaml` / `playground-rocky.parent.main.yaml`；canonicalId 中 `:` 换 `.`）。
- Loader 不强校验文件名与 scopeId 一致——以 yaml 内 `scopeId` 字段为准（避免双重 source of truth）。
- 同 scopeId 多文件：后者覆盖前者，Loader 打 warning。

### 2.3 现有 scopes

| scopeId | 文件 | 作用 |
|---|---|---|
| `default` | `default.yaml` | 默认基线 scope（全 EP 激活，显式列全量 active impl + 非默认 configValues，如 `threshold_should_compact.compactRatio=0.6`） |
| `summary` / `consolidate` | `summary.yaml` / `consolidate.yaml` | 旁路 run 两基座（原 forked.yaml 拆分）：关 compact 防递归（reject/noop compact 三件套）+ session_store 选 in_memory + side_run_builder 复用固定 parentSnapshot；consolidate 额外选 noop_post_compact 防整理递归。toolBound 差异（summary=[] / consolidate=[skill_manage,memory_manage]）由 profile yaml 表达，scope 层无差异 |
| `<biz>-<role>.<derivation>.<runKind>` | per-type 文件 | 每 SessionKind 组合一份（canonicalId 命名，extends 单父；空文件 = 全继承）：4 类 parent.main（playground-rocky/studio-squad/studio-leader/studio-mate）+ 各自 .summary/.consolidate + 2 类 subagent.main（playground-rocky/studio-mate）+ 各自 .summary/.consolidate。矩阵对称由启动校验强制（§3.2 规则 4） |
| `test` | （无文件，代码构造） | test 环境 fixture scope，由 `test-fixtures.ts` 的 `buildTestScopeConfig()` 直接构造扁平 ScopeConfig（test_chat_model exclusive 恰好 1 active / test_retriever ordered 3 impl）；仅 APP_ENV=test 由 bootstrap 加载 |

> secret（zhipu apiKey 等）**不进代码声明**（D1）——由 dev config / env 注入，实例化时 deepMerge（详 `config/[P0]plugin_config_service.md §4.5`）。

---

## 3. 加载 / 校验 / 包装链路

### 3.1 加载（ScopeConfigLoader.loadAll）

```
扫 app/plugins/scopes/*.yaml（按字母序）→ 每个文件 YAML.parse + 形状校验 + 树→扁平转换 → ScopeConfig[]
形状校验：scopeId/name/groups 必填 + 类型对（pointId 非空、impls 数组元素为字符串或 {implId, configValues?}），错则 throw
（不做语义校验：impl 在 manifest 注册 / point 在 registry / exclusive 恰好 1 — 那是 Validator 的事）
```

**bootstrap 包装（`loadScopeConfigs` helper）**：
- `default.yaml` + `summary.yaml` + `consolidate.yaml` 三基座始终加载（prod/dev/test 都用；旁路 run scope 沿 extends 链回退到基座）。
- test scope 由 `buildTestScopeConfig()` 代码构造（无 yaml 文件），仅 `APP_ENV=test` 注入（其引用的 test_chat_model EP 由 `registerTestFixtures` 注册，非 test env 不存在 → validator 失败）。
- `scopes/` 目录不存在 → throw（D3 硬失败：scopes 目录必须存在）。

### 3.2 校验（ScopeConfigValidator.validateAll）

bootstrap 加载后立即调。先跑 `validateGroups`（registry ↔ groups.json 双向一致，详 `[P1]groups_meta_decl.md`），再对每个 ScopeConfig 校验三类不变量，最后跑 scope 矩阵对称校验；任一失败 throw（**D3 硬失败**，不静默 fallback）：

1. **pointId 存在**：`activatedPoints` 中每个 pointId 必须在 registry 已登记。
2. **implId 存在 + 归属 point 已激活**：`impls.keys` 必须在 registry 已登记（manifest 注册）；且某 implId 实际归属的 point（`manifest.point`）必须在该 scope 的 `activatedPoints` 中（防跨 point 误列——impl 列在 impls 字典但其 point 节点没配，配置失效且语义错）。
3. **exclusive EP active 数恰好 1**：`activatedPoints` 中每个 cardinality=exclusive 的 EP，其注册 impl 在 `impls` 字典中 active（key 存在）的数量必须恰好 1（0 个或多于 1 都 throw，错误消息含 scopeId + pointId + 实际 active count）。
4. **scope 矩阵对称（`validateMainScopeMatrix`）**：每个 `<prefix>:main` scope 必须有对应 `<prefix>:summary` + `<prefix>:consolidate` scope 文件，缺失启动硬失败。**理由**：main 类型 extends default（继承 `threshold_should_compact` 0.6 + post_compact memory_skill_consolidation），run 跑长触发 compact 必产 `<prefix>:summary|consolidate` 旁路 run；scope 文件缺失仅靠 `resolveSourceScope` 运行时 throw（首次 compact 才在 fire-and-forget `.catch` 里暴露）——启动期硬失败提前暴露漏配。与 profile 侧 `SessionTypeProfileValidator.validateMainMatrix` 对称（profile 侧查 profile 文件，本侧查 scope 文件）。

**实现位置**：`app/server/src/plugin/scope-config-validator.ts`。

### 3.3 包装（LoadedScopeConfigProvider）

bootstrap 包装 `ScopeConfig[]` 为 `LoadedScopeConfigProvider`（实现 `ScopeConfigProvider` interface），注入 `PluginManager` + `PluginConfigService` 共享同一份。

`ScopeConfigProvider` interface（运行时读视图，详 `config/[P0]ext_impl_scope.md §4.2`）：
- `listScopes(): ScopeMeta[]` — 全部 scope（default 首位）。
- `getScope(scopeId): ScopeMeta | undefined` — 单 scope 元信息。
- `isPointActivated(scopeId, pointId): boolean` — 激活 = 该 scope yaml 声明此 point；**default 无特权**（v0.0.206 删 plugin scope D6 短路，default 同路径——不配 = 关）。
- `listActivatedPoints(scopeId): string[]` — 返该 scope yaml 声明集（default 返 default.yaml 声明集；签名无 `allPointIds` 参，v0.0.206 删）。
- `resolveSourceScope(scopeId, pointId): string` — **入口 scopeId 未注册 → throw**（v0.0.204 runtime defense：不再静默兜底 default——缺 scope 文件时静默落 default 对 summary/consolidate run = default 的真 compact → 递归爆炸）；已注册但该 pointId 未激活 → **沿 `extends` 链逐级回退**（链终点 default）；default → 'default'。
- `getImplConfig(sourceScope, implId): ImplConfigRead | undefined` — 取该 scope 该 impl 的 `{order?, configValues?}`；**返 undefined = 不在 active 列表（membership 判定，无默认 true 兜底）**。

---

## 4. 强约定：开发 plugin ext 必须同步改 scopes/*.yaml（MANDATORY）

**约定**：开发 / 修改 / 删除任何 plugin ext impl（manifest 内 `extImpls[]`）后，**必须**同步检查并修改 `app/plugins/scopes/*.yaml`，否则：

| 漏改场景 | 后果 |
|---|---|
| 新增 impl 但未加进 `default.yaml` 对应 EP 的 impls 数组 | 新 impl 恒 inactive（membership 模型无「未声明默认 active」兜底——这是最常见漏改，功能静默不生效） |
| 新增 impl 给 exclusive EP 且数组变成 2 项 | 启动校验失败（§3.2 规则 3：exclusive 恰好 1） |
| 删除 impl 但 `scopes/*.yaml` 仍引用它 | 启动校验失败（§3.2 规则 2） |
| 新增 EP 但 `default.yaml` 未加 point 节点 | 该 EP 在 default scope 不激活（运行时该 EP 取到空列表；且 groups.json 未登记也会撞 validateGroups） |
| 某 impl 列在 impls 数组但其 point 节点未配 | 启动校验失败（§3.2 规则 2，防跨 point 误列） |

**操作清单（开发 plugin ext 时 MANDATORY）**：
1. **新增 plugin ext impl** → 在 `default.yaml` 对应 EP 的 impls 数组加项（位置即 order）；若 EP 是 exclusive，数组只留这 1 个目标项（改选中 = 直接改数组项）。
2. **禁用某 impl** → 从对应 EP 的 impls 数组移除该项（不是写 `enabled: false`——字段已废）。
3. **修改 plugin ext impl 的 implId** → 全 `scopes/*.yaml` 中所有引用旧 implId 的数组项同步改。
4. **删除 plugin ext impl** → 全 `scopes/*.yaml` 中所有引用清掉（否则启动校验失败）。
5. **新增 EP** → 在 `default.yaml` 加 point 节点（配 impls 数组）+ groups.json 登记（D6 第 5 条）；其他 scope 按需加（不加 = 继承 default 全量）。
6. **改 EP cardinality（如 list→exclusive）** → 所有 `scopes/*.yaml` 该 EP 的 impls 数组收敛到恰好 1 项（启动校验保证）。

**强制执行**：启动校验（D3 硬失败）是最后防线。开发 PR 通不过启动 = 漏改 `scopes/*.yaml`。

---

## 5. 设计决策

### 5.1 代码声明 vs 落盘 record（v0.0.67 D2）

**结论**：scope 配置代码声明 `scopes/*.yaml` = 唯一源；落盘 `plugin_scope` / `ext_impl_scope_activation` / `plugin_policy` 仅 lazy migrate 兼容，运行时不读。
**理由**：
1. **可审计可版本化**：代码声明进 git，每次改动有 commit 历史；落盘 record 是运行时 drift。
2. **消除流氓代码**：原 `ensureForkedScope`（bootstrap 每次启动写 12 次盘）+ dev 落盘 drift（v0.0.66 注释说写 true 实测落盘 false）+ subagent scope drift（无代码创建者）全部消失。
3. **fail-fast**：misconfig 启动崩（D3），vs 落盘 drift 静默 degradation 难定位（v0.0.64 P1 教训）。

### 5.2 impl 列表模型（membership = active，全量替换零 delta）

**结论**：配置 = impl 列表。废 `selected`（exclusive 选中 = 数组唯一项）/ 废 `enabled`（在数组 = active）/ 废 `order` 字段（数组序即 order）/ 废 delta 合并（EP 节点不出现 = 继承 default 全量；出现 = 全量替换）。运行时 `getExtensionImpls` 统一「filter membership + 按数组序排序 + instantiate」，无 cardinality 分支。
**理由**：
1. **一处真相**：旧模型同一语义三处表达（selected/enabled/exclusivePicks + `?? true` 兜底）互相漂移——「delta merge」实际从未真 merge（未列 impl 走 `?? true` 默认 active，不是真取 default 配置），语义反直觉。
2. **读配置即读行为**：YAML 列表一眼看清「哪些 active、什么顺序」，无需脑内 merge。
3. **类型无关化**：cardinality 是 EP intrinsic 属性（保留），但配置/读取不该按类型分支——validator（exclusive 恰好 1）+ UI（按 type 渲染）已足够消费类型。
**不这样会怎样**：保留 delta 模型则「某 scope 未列 impl」语义永远含糊（是继承 default 还是默认 active？两者答案不同），scope 迁移/新增 impl 时行为静默漂移。

### 5.3 secret 不进代码声明（D1）

**结论**：zhipu apiKey 等 secret 移 dev config / env，不放 `scopes/*.yaml`。
**理由**：代码声明进版本库，secret 进版本库 = 泄漏。非 secret configValues 走 manifest schema 默认；secret 由 dev config / env 注入，实例化时 deepMerge。

### 5.4 test fixture 不写 policy（D5）

**结论**：`registerTestFixtures` 仅注册 manifest（EP + impl + plugin 元数据），不写 policy；test scope 由 `buildTestScopeConfig()` 代码构造扁平 ScopeConfig（无 yaml 文件），仅 APP_ENV=test 注入。
**理由**：原版（v0.0.5 BUG-010）`setExclusive('test_chat_model_a')` 写落盘 policy 是历史 workaround；配置代码化后 test env 直接构造内存 ScopeConfig 即可生效，无需写盘也无需单独 yaml 文件。

---

## 6. 边界

| 零件 | 归属 |
|---|---|
| scopes/*.yaml 文件 schema（YAML 树 + 扁平 ScopeConfig 字段语义） | 本文件 §2 ✅ |
| 加载链路（Loader / Validator / Provider） | 本文件 §3 ✅ |
| 启动校验三类不变量 | 本文件 §3.2 ✅ |
| 「开发 plugin ext 同步改 scopes/*.yaml」强约定 | 本文件 §4 ✅ |
| scope 元信息落盘 SchemaDef（v0.0.67 起 deprecated 读路径） | `config/[P0]ext_impl_scope.md §2` |
| ExtImplConfigRecord 数据形状 | `config/[P0]plugin_config.md §2` |
| PluginConfigService 管理面接口（v0.0.67 只读） | `config/[P0]plugin_config_service.md` |
| per-EP 回退算法 | `config/[P0]ext_impl_scope.md §5` |
| HTTP 端点契约 | `specs/api/overall/03-config-center.md` |

> 变更历史见 [`log.md`](log.md)；跨版本发布说明见 [`specs/tech/version_logs/vX.Y/change_log.md`](../version_logs/)。
