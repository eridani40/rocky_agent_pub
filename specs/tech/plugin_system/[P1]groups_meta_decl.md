---
type: spec
title: Groups 元数据声明（app/plugins/groups.json）
priority: P1
status: active
updated: 2026-07-19
since: v0.0.71
---

# Groups 元数据声明（app/plugins/groups.json）

## 1. 概述

**管什么**：plugin ext 配置界面的**功能分区元数据**（group）—— `app/plugins/groups.json` 文件 schema、加载链路（GroupMetaLoader → LoadedGroupMetaProvider）、字段语义、启动校验规则（D6 第 5 条不变量）、「新增 EP 必须在此登记」强约定。
**不管什么**：scope 配置（→ `[P1]scopes_config_decl.md`）、PluginConfigService 管理面（→ `../config/[P0]plugin_config_service.md`）、运行时 enabled 门 / cardinality / scope 回退算法（均不读 groups.json）。
总览见 `[index.md`](index.md)。

**v0.0.71 重构（D1）**：group meta 从 `ExtensionPoint.group` 字段（per-EP 散落 string）迁出，集中到 `groups.json` 唯一源。理由：
1. **显式声明 group 内容**（label/description/含哪些 EP），便于 UI 渲染 + i18n。
2. **group 拆分数据驱动**（D5 七组），UI 形式零改动（D4）。
3. **消除冗余**：原 EP.group 是 string 标签，缺 label/description，UI 无 meta 可读；新 groups.json 是 group 元数据全集。

## 2. 文件 schema（GroupMetaFile）

```typescript
/** groups.json 顶层结构 */
interface GroupMetaFile {
  /** group 元数据列表（按声明序 = UI 显示序） */
  groups: GroupMeta[];
}

/** 单个 group 的元数据 */
interface GroupMeta {
  /** group 业务 id（snake_case，如 "context-ingest" / "provider" / "web"） */
  id: string;
  /** 显示名（必填，i18n 占位符 `__MSG_group.<id>.label__`，前端 resolveI18nField 翻译） */
  label: string;
  /** 说明（必填，i18n 占位符 `__MSG_group.<id>.description__`，UI group sidebar 副文本） */
  description: string;
  /** 该 group 包含的 EP id 列表（subset of registry.listPoints()） */
  extPoints: string[];
}
```

### 2.1 文件位置

- 单文件 `app/plugins/groups.json`（与 `scopes/` 平级，与 `builtins/` 平级）。
- **单文件**（不像 scopes 一 scope 一文件）—— groups 是元数据全集，无 per-scope 切片需求。
- 文件不存在或不可读 → 启动 throw（D6 硬失败，与 scopes 一致）。

### 2.2 现有 group（v0.0.71 起 7 组，按 D5）

| group id | label i18n key | 含 EP |
|---|---|---|
| `context-ingest` | `__MSG_group.context_ingest.label__` | context_ingest_handler, system_reminder |
| `context-assemble` | `__MSG_group.context_assemble.label__` | context_assemble_mapper, context_assemble_reducer |
| `context-compact` | `__MSG_group.context_compact.label__` | context_should_compact, context_do_compact, context_post_compact |
| `context-engine` | `__MSG_group.context_engine.label__` | session_store |
| `system-prompt` | `__MSG_group.system_prompt.label__` | system_prompt_mapper, system_prompt_reducer |
| `provider` | `__MSG_group.provider.label__` | llm_provider, llm_protocol |
| `web` | `__MSG_group.web.label__` | web_search_provider |

合计 13 EP（覆盖 `BUILTIN_EXTENSION_POINTS` 全集，每个 EP 出现且仅出现一次 — D6 不变量）。

## 3. 加载 / 校验 / 包装链路

### 3.1 加载（GroupMetaLoader.load）

```
读 app/plugins/groups.json 单文件 → JSON.parse + 形状校验 → GroupMetaFile
形状校验：groups 必填数组 + 每项 id/label/description/extPoints 必填 + extPoints 项非空字符串
（不做语义校验：EP 在 registry 注册 / pointId 唯一 / group id 唯一 — 那是 Validator 的事）
```

**bootstrap 包装（`loadGroupMetas` helper，在 bootstrap.ts 内）**：
- 启动期 builtin-loader 完成 registry 登记后调用。
- groups.json 不存在或形状错 → throw（D6 硬失败）。
- 加载完后立即跑 ScopeConfigValidator.validateGroups（依赖 registry + groups，§3.2）。

### 3.2 校验（ScopeConfigValidator.validateGroups）

bootstrap 加载 groups.json 后立即调，校验第 5 条不变量，任一失败 throw（**D6 硬失败**）：

1. **registry ↔ groups.json 双向一致**：
   - 每个 registry 已登记 EP（`BUILTIN_EXTENSION_POINTS` + test fixtures）必须**在某 group 出现且仅一次**。
   - groups.json 引用的每个 pointId 必须**在 registry 已登记**。
2. **group id 唯一**：groups.json 中 group id 不重复。
3. **extPoints 项唯一**：同一 pointId 不能在多个 group 出现（包括同 group 内重复）。

**实现位置**：`app/server/src/plugin/scope-config-validator.ts`（v0.0.71 加 `validateGroups` 方法，constructor 接受 `groups: GroupMeta[]` 注入）。

### 3.3 包装（LoadedGroupMetaProvider）

bootstrap 包装 `GroupMeta[]` 为 `LoadedGroupMetaProvider`（实现 `GroupMetaProvider` interface），注入 `PluginConfigService`，由 inventory-builder JOIN 用。

`GroupMetaProvider` interface（运行时读视图）：
- `listGroups(): GroupMeta[]` — 全部 group（按 groups.json 声明序）。
- `getGroupByPoint(pointId: string): GroupMeta | undefined` — pointId → 所属 group（构建期 Map 索引）。
- `getGroupById(groupId: string): GroupMeta | undefined` — groupId → 元数据。

## 4. 强约定：新增 EP 必须在 groups.json 登记且仅一次（MANDATORY）

**约定**：开发 / 修改 / 删除任何 plugin ext point（`extension-point.ts` 的 `BUILTIN_EXTENSION_POINTS`）后，**必须**同步检查并修改 `app/plugins/groups.json`，否则：

| 漏改场景 | 后果 |
|---|---|
| 新增 EP 但未在 groups.json 任何 group 登记 | 启动校验失败（D6 硬失败，§3.2 规则 1a） |
| 新增 EP 但在多个 group 登记 | 启动校验失败（§3.2 规则 3） |
| 删除 EP 但 groups.json 仍引用 | 启动校验失败（§3.2 规则 1b） |
| 新增 group 但 group id 已存在 | 启动校验失败（§3.2 规则 2） |

**操作清单（开发 plugin ext 时 MANDATORY）**：
1. **新增 EP** → 决定归哪个 group → 在该 group 的 `extPoints[]` 加 EP id；若需新 group → 末尾追加 group 元数据（含 i18n key + EP 列表）。
2. **修改 EP id** → 全 groups.json 同步改（find/replace）。
3. **删除 EP** → 从所属 group 的 `extPoints[]` 删；若 group 空 → 决定保留空 group 还是删 group（删 group 须确认 UI 不依赖）。
4. **拆分 group**（如本版 D5 把 context 拆 4 组）→ 同步改 i18n locale 表（`__MSG_group.<new_id>.{label,description}__`）。

**强制执行**：启动校验（D6 硬失败）是最后防线。开发 PR 通不过启动 = 漏改 groups.json。

## 5. 设计决策

### 5.1 group 元数据外置 vs 内置 EP

**结论**：group 元数据（label/description/extPoints）外置 `groups.json`，**不在 EP 定义常量上**（v0.0.71 删 `ExtensionPoint.group` 字段）。
**理由**：
1. **group 是 UI 概念**（分区 + 显示序 + i18n 标签），不是 EP 固有属性；放 EP 上是错位（`group: "provider"` 字面量无 label/description）。
2. **可演化**：拆 group（D5 把 context 拆 4 组）只改 groups.json，EP 代码零改动。
3. **唯一源**：避免 EP.group 字面量 + groups.json 双源漂移。
**反例**：v0.0.4-v0.0.70 EP.group 字段（散落 string）+ 配置界面隐式按字面量聚合，缺 label/description 让 UI 无 meta 可读；本版反转。

### 5.2 单文件 vs per-group 一文件

**结论**：单文件 `groups.json`（不像 scopes 一 scope 一文件）。
**理由**：groups 是元数据全集（7 组一次性加载），无 per-scope 切片需求；单文件易维护、易 diff、易审核。
**反例**：若 per-group 一文件，则目录扫描 + 文件名约定 + 加载顺序都需 spec，过度工程化。

### 5.3 group 顺序 = groups.json 声明序

**结论**：UI 显示 group 顺序按 groups.json `groups[]` 数组声明序（不按 registry 注册序、不按字母序）。
**理由**：声明序 = 设计意图（D5 七组按用户认知「ingest → assemble → compact → engine → system-prompt → provider → web」），可演化（PR 改 groups.json 即可重排）；registry 注册序受 import 顺序影响不稳定。
**反例**：v0.0.4-v0.0.70 inventory 按 registry 注册序聚合（首见序），不稳定且不可控；本版改声明序。

### 5.4 i18n 占位符必填（label/description）

**结论**：`label` / `description` 必填 i18n 占位符 `__MSG_group.<id>.{label,description}__`（不允许字面中文）。
**理由**：v0.0.62 i18n 迁移已把 builtin plugin/EP/impl description 全占位符化（`[P1]manifest_i18n.md`），groups.json 同步对齐；前端 `resolveI18nField` helper 已统一处理。
**反例**：第三方 plugin 的 group（P1 discovery/install 引入后）可保留字面文案，但 v0.0.71 builtin 必须占位符化。

#### 5.4.1 locale 覆盖契约（v0.0.99.ext_ui 教训，MANDATORY）

**背景**：v0.0.99.ext_ui 用户报「插件配置→扩展点，group sidebar 名字是 `group.context-ingest.xxx` 看不见」。根因：plugin-config ns 的 group/extPoint locale 文案是**手维护**的，groups.json 是 group/extPoint id 的**权威源**，二者无机制绑定 → 5/7 group 的 locale label 漏配（locale 停留在过期 3 组），前端查不到 key 走 `parseMissingKeyHandler` 渲染「【资源 group.xxx 不存在】」长串被 `truncate` 截断。

**渲染路径（snake_id 约定，三方统一）**：
- EP group sidebar（`section-ext-point-area.tsx`）用 inventory 的 `groupId`（kebab，如 `context-ingest`）派生 **snake_id**（`-` 转 `_` → `context_ingest`），拼 key `plugin-config:group.${snakeId}.label` 调 `t()`。
- 该 key 与 groups.json `label` 占位符 `__MSG_group.<snake_id>.label__` 的 dotted key **完全一致**（声明 / 查询 / locale 实现 三方统一下划线 snake_id，与 GroupMetaLoader 文档同款 `snake_id = id 的 - 转 _` 约定）。
- 说明：inventory 只透传 `{ groupId, points }`（label/description 仅做 GroupMetaLoader 形状校验、不进 UI）；sidebar 无 API 直读占位符，靠 **snake_id 约定**对接——护栏 UT 断言占位符遵循该约定来闭环。

**契约（MANDATORY，护栏 UT 强制）**：
- `app/web/src/i18n/locales/{zh-CN,en}/plugin-config.json` 的 `group.<snake_id>.label` 必须**覆盖 groups.json 全部 group**（snake_id = group id 的 `-` 转 `_`）。
- 同文件 `extpoint.<id>.description` 必须**覆盖 groups.json 全部 extPoint id**（`groups[].extPoints[]` 去重；EP id 本身即 snake）。
- 双语（zh-CN + en）都必须有；`keys-aligned.test.ts` 只保证 zh↔en 两边 key 集合**一致**（一起漏也算"对齐"，堵不住此类 drift）。
- **护栏**：`app/web/src/i18n/__tests__/groups-locale-coverage.test.ts` 读 groups.json → 抽每个 group `label` 占位符 dotted key → 断言①占位符遵循 `group.<snake_id>.label` 约定 ②双 locale 都有该 key；并断言每个 extPoint id 双 locale 有 `extpoint.<id>.description`。缺任一即 fail-fast。**新增/改名 group 或 EP 时，必须同步双 locale + 占位符约定，否则 CI 红。**

**改 group id 的连锁影响**：group id 是 sidebar locale key（经 snake_id 派生）+ groups.json 占位符的一部分，改 id 须同步改 locale key（zh+en）+ 占位符；护栏 UT 会拦漏改。

## 6. 边界

| 零件 | 归属 |
|---|---|
| groups.json 文件 schema（GroupMeta 字段语义） | 本文件 §2 ✅ |
| 加载链路（GroupMetaLoader / LoadedGroupMetaProvider / GroupMetaProvider interface） | 本文件 §3 ✅ |
| 启动校验第 5 条不变量（registry ↔ groups.json 双向一致） | 本文件 §3.2 + `[P1]scopes_config_decl.md §3.2` ✅ |
| 「新增 EP 必须在 groups.json 登记」强约定 | 本文件 §4 ✅ |
| EP 定义本身（id/cardinality/description） | `[P0]extension_point_interface.md`（v0.0.71 删 group 字段） |
| PluginConfigService 管理面（inventory JOIN 用 GroupMetaProvider） | `../config/[P0]plugin_config_service.md §2` |
| scopes/*.yaml 代码声明 | `[P1]scopes_config_decl.md` |
| HTTP 端点契约（GET inventory 嵌套形状） | `specs/api/overall/03-config-center.md` |

> 变更历史见 `log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
