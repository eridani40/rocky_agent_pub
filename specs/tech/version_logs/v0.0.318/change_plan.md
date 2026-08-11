# v0.0.318 变更计划书 — 配置同步（导入导出）

> **method 级 review 合同**。架构期冻结：planner 按本表切 task，coder 按本表实现，code-reviewer 按本表查偏离。coder/doc-modifier 不改本文件；事后偏差写进 `change_log.md`。

## 架构判断（已核实源码）

| 判断项 | 结论 | 核实依据 |
|--------|------|----------|
| 后端改动 | **零改动** | POST /provider 只校验 label/baseUrl/credentials.key/protocolId 必填，无 label 唯一性限制（handler.ts L128-135）。GET/PUT /config/app 已有 |
| 加密位置 | **纯前端** | Web Crypto API（crypto.subtle）原生支持 AES-256-CBC；下载用 Blob URL 触发，无需后端 export 接口 |
| 现有 API 复用 | 全部够用 | `loadProvidersAndProtocols`（导出读 provider）、`createProvider`+`createModel`（导入注入）、`getConfigGroup`（导出读工具）、`putConfigGroup`（导入写工具） |
| 树组件 | **需新建** | 现有 `component-file-tree.tsx` 是选择语义（非 checkbox 勾选 + indeterminate），不可复用。需新建 checkbox tree |
| provider 导入 | 逐条 POST | API 无批量创建端点。createProvider 建 provider → createModel 逐个加 model（同 saveProviderWithModels diff-save 范式） |
| credentials 明文 | 已确认 | handler.ts L6 注释：「credentials.key 返回明文」；PUT 时 key==='***' 视为不修改 |

## 设计决策（D 编号）

### D1: 新增 TabId 'config_sync' — 用户设置区 memory tab 下方

**文件**：`app/web/src/components/app-dev-config-page/app-settings-config-defs.ts`

**变更**：
- `TabId` union 加 `'config_sync'`
- `APP_SETTINGS_TABS` 数组在 `memory` 后插入 `{ id: 'config_sync', labelKey: 'tab.config_sync.label', groups: ['config_sync'], inSystemArea: false }`
- `TAB_KV_GROUPS` 加 `config_sync: []`（自渲染，不进 KV dirty）
- `SYSTEM_TABS` 不含 config_sync（用户设置区，非系统收起区）

**约束**：MUST 在 memory 之后插入（PRD §2.1「全局长期记忆 tab 下方」）；MUST NOT 进系统收起区。

### D2: 加密工具模块 — lib/config-crypto.ts（纯前端 Web Crypto）

**文件**：`app/web/src/lib/config-crypto.ts`（新建）

**功能**：
- `encryptConfig(data: ConfigExportData): Promise<string>` — AES-256-CBC 加密 → base64
- `decryptConfig(payload: string): Promise<ConfigExportData>` — base64 解密 → 原始对象
- `wrapExport(data): Promise<{v:1, payload:string}>` — 加密 + 包 `{v, payload}` 壳
- `unwrapExport(file: {v:number, payload:string}): Promise<ConfigExportData>` — 壳校验 + 解密
- 密钥生成：`rocky_agent_` + md5(固定盐值) → SHA-256 → 32 字节 AES key
- IV：每次加密随机生成 16 字节，拼在密文前（IV + ciphertext → base64）

**类型定义**：
```ts
interface ConfigExportData {
  v: 1;
  exportedAt: string;       // ISO
  providers: ProviderExportItem[];
  tools: Record<string, unknown>;  // group → data
}
interface ProviderExportItem {
  // 剥离 id（导入时后端生成新 ULID）
  label: string; name: 'anthropic_compatible'; protocolId: string;
  baseUrl: string; credentials: { key: string }; enabled: boolean;
  models: ModelInstance[];
}
```

**约束**：MUST 用 `crypto.subtle`（非第三方库）；MUST 在 decrypt 前校验 `v` 版本号；MUST NOT 明文存储 key。

> ⚠️ 实现偏离（coder 汇报 + leader 裁决接受）：crypto.subtle 不提供 MD5，密钥派生用 SHA-256(SALT) 截 32 hex 替代 md5(SALT)。功能等价（固定盐→固定串→固定 key），非安全场景可接受。

### D3: 导出数据采集模块 — lib/config-sync-export.ts

**文件**：`app/web/src/lib/config-sync-export.ts`（新建）

**功能**：
- `collectExportData(selected: SelectionState): Promise<ConfigExportData>`
  - 模型：`loadProvidersAndProtocols()` → 过滤选中 provider → 剥离 `id` 字段 → 取 models 全量
  - 工具：对选中的 tab 调 `getConfigGroup('app', group)` → 取对应 key 的 data
  - 工具 group 映射：`web_search`→group=web_search&key=default | `web_fetch`→group=web&keys=[jinaApiKey,jinaEnabled,jinaTimeoutMs] | `see_image`→group=see_image&key=default | `bash`→group=runtime&key=bash_seatbelt
- `triggerDownload(data: ConfigExportData): Promise<void>`
  - `wrapExport(data)` → `JSON.stringify` → Blob → URL.createObjectURL → `<a>` click → revokeURL
  - 文件名：`rocky_agent_config_YYYYMMDD_HHmmss.json`

**工具 group 映射表**（常量）：
```ts
const TOOL_TAB_MAP = {
  web_search: { group: 'web_search', keys: ['default'] },
  web_fetch:  { group: 'web', keys: ['jinaApiKey', 'jinaEnabled', 'jinaTimeoutMs'] },
  see_image:  { group: 'see_image', keys: ['default'] },
  bash:       { group: 'runtime', keys: ['bash_seatbelt'] },
} as const;
```

**约束**：MUST 剥离 provider.id（导入时后端生成新 ULID）；MUST 按 PRD §3.2 数据来源映射表读。

### D4: 导入执行模块 — lib/config-sync-import.ts

**文件**：`app/web/src/lib/config-sync-import.ts`（新建）

**功能**：
- `parseImportFile(file: File): Promise<ConfigExportData>`
  - `JSON.parse(file)` → `unwrapExport` → 解密 → 校验 schema
  - 失败 → throw 带用户可读 message 的 Error
- `checkDuplicateLabels(providers: ProviderExportItem[], localProviders: ProviderInstance[]): Set<string>`
  - 返回与本地 label 重复的 label 集合（用于树形页显示「存在重名」标签）
- `executeImport(data: ConfigExportData, selected: SelectionState): Promise<ImportResult>`
  - 模型注入：对选中 provider → `createProvider({label, baseUrl, apiKey: credentials.key, protocolId})` → 逐个 `createModel(providerId, model)`
  - 工具覆盖：对选中 tab → `putConfigGroup('app', group, [{key, data}, ...])`
  - 返回 `{ providersImported: number, toolsImported: number }`

**约束**：MUST NOT 传 id 给 POST /provider（后端自动生成）；MUST 逐条 createProvider + createModel（API 无批量端点）；MUST 整 tab 覆盖（PUT items[]）。

### D5: Checkbox Tree 组件 — component-config-tree.tsx

**文件**：`app/web/src/components/app-dev-config-page/component-config-tree.tsx`（新建）

**功能**：
- 两棵固定结构的树（非递归文件树，是 config 专用两层树）
- 树结构：根 folder（模型配置 / 工具配置）→ 叶子节点（provider label / 工具 tab 名）
- **导出树**：`mode='export'`，数据传入，所有节点默认全选
- **导入树**：`mode='import'`，数据传入，所有节点默认全选，provider 叶子可显示「存在重名」标签
- Checkbox 交互：folder 联动子节点全选/取消；叶子独立；folder indeterminate 半选态
- Props：
```ts
interface ConfigTreeProps {
  mode: 'export' | 'import';
  providers: { label: string; protocolId?: string }[];  // 导出=全量，导入=文件解析的
  tools: string[];                                        // 选中的工具 tab id 列表
  duplicateLabels?: Set<string>;                          // 仅 import 模式：重名 label 集合
  selected: SelectionState;
  onSelectionChange: (next: SelectionState) => void;
}
interface SelectionState {
  providers: Set<string>;  // 选中的 provider label（导出用 label 作 key，因为导出时还没有 id）
  tools: Set<string>;      // 选中的工具 tab id
}
```

**约束**：MUST 用 checkbox + indeterminate 三态；MUST 用 label（非 id）作为 provider 选择 key（导出时 id 被剥离，导入时 id 还未生成）；MUST NOT 复用 component-file-tree（语义不同）。

### D6: 配置同步页组件 — section-config-sync.tsx

**文件**：`app/web/src/components/app-dev-config-page/section-config-sync.tsx`（新建）

**功能**：
- 配置同步 tab 的内容区根组件（替代 SectionTabPanel 里 memory case 的位置）
- 三态视图：`landing`（入口页）→ `export`（导出树形选择）→ `import`（文件选择 → 导入树形选择）
- **landing 态**：两个大按钮「导出配置」「导入配置」
- **export 态**：挂载时 GET /provider + GET 4 个工具 group → 渲染 ConfigTree(mode='export') → 底部「导出」按钮 → collectExportData + triggerDownload
- **import 态**：
  1. 文件选择（`<input type="file">`）→ parseImportFile → 失败显示错误
  2. 成功 → GET /provider 取本地列表 → checkDuplicateLabels → 渲染 ConfigTree(mode='import', duplicateLabels) → 底部「导入」按钮
  3. 点导入 → ConfirmModal → executeImport → toast → 刷新
- 自管 state，不走 SaveBar（导入导出是即时操作，不是配置编辑）

**约束**：MUST 在 SectionTabPanel switch 加 `case 'config_sync'`；MUST NOT 进 page-tab dirty（非配置编辑，是即时操作）；MUST 显示导入确认 modal（PRD §2.3 步骤 6）。

---

## 文件级变更清单

| # | 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 预计影响行 |
|---|---------|---------|----------|------|---------|------|------|-----------|
| 1 | app-settings-config-defs | `app-settings-config-defs.ts` | `TabId` | 修改 | union 加 `'config_sync'` | MUST | PRD §2.1 | 1 |
| 2 | app-settings-config-defs | `app-settings-config-defs.ts` | `APP_SETTINGS_TABS` | 修改 | memory 后插入 config_sync tab def | MUST 在 memory 之后 | PRD §2.1 | 1 |
| 3 | app-settings-config-defs | `app-settings-config-defs.ts` | `TAB_KV_GROUPS` | 修改 | 加 `config_sync: []` | MUST 为空数组（自渲染） | D1 | 1 |
| 4 | section-tab-panel | `section-tab-panel.tsx` | `SectionTabPanel` switch | 修改 | 加 `case 'config_sync': return <SectionConfigSync />` | MUST NOT 进 dirty/saveBar | D6 | 3 |
| 5 | config-crypto | `app/web/src/lib/config-crypto.ts` | `encryptConfig` | 新增 | AES-256-CBC 加密 → base64 | MUST 用 crypto.subtle | D2 | ~25 |
| 6 | config-crypto | `app/web/src/lib/config-crypto.ts` | `decryptConfig` | 新增 | base64 → AES-256-CBC 解密 | MUST 校验 v 版本 | D2 | ~25 |
| 7 | config-crypto | `app/web/src/lib/config-crypto.ts` | `wrapExport` | 新增 | 加密 + 包 `{v:1, payload}` | MUST | D2 | ~8 |
| 8 | config-crypto | `app/web/src/lib/config-crypto.ts` | `unwrapExport` | 新增 | 壳校验 + 解密 | MUST 校验 v + 容错 | D2 | ~15 |
| 9 | config-crypto | `app/web/src/lib/config-crypto.ts` | `ConfigExportData` / `ProviderExportItem` | 新增 | 类型定义 | MUST 剥离 id | D2 | ~15 |
| 10 | config-sync-export | `app/web/src/lib/config-sync-export.ts` | `TOOL_TAB_MAP` | 新增 | 工具 tab → group/key 映射常量 | MUST 对齐 PRD §3.2 | D3 | ~10 |
| 11 | config-sync-export | `app/web/src/lib/config-sync-export.ts` | `collectExportData` | 新增 | 按选中项读 provider + 工具 group | MUST 剥离 provider.id | D3 | ~40 |
| 12 | config-sync-export | `app/web/src/lib/config-sync-export.ts` | `triggerDownload` | 新增 | Blob + `<a>` click 下载 | MUST 文件名格式 YYYYMMDD_HHmmss | D3 | ~15 |
| 13 | config-sync-import | `app/web/src/lib/config-sync-import.ts` | `parseImportFile` | 新增 | 文件 → 解密 → 校验 → ConfigExportData | MUST 失败 throw 可读 message | D4 | ~20 |
| 14 | config-sync-import | `app/web/src/lib/config-sync-import.ts` | `checkDuplicateLabels` | 新增 | 比对 label 返回重名 Set | MUST 按 label 精确匹配 | D4 | ~10 |
| 15 | config-sync-import | `app/web/src/lib/config-sync-import.ts` | `executeImport` | 新增 | 逐条 createProvider+createModel + putConfigGroup | MUST NOT 传 id | D4 | ~45 |
| 16 | component-config-tree | `component-config-tree.tsx` | `ConfigTree` | 新增 | checkbox 勾选树组件（export/import 双模式） | MUST 支持 indeterminate | D5 | ~120 |
| 17 | component-config-tree | `component-config-tree.tsx` | `SelectionState` | 新增 | 选择状态类型 | MUST 用 label 作 key | D5 | ~5 |
| 18 | section-config-sync | `section-config-sync.tsx` | `SectionConfigSync` | 新增 | 配置同步页根组件（landing/export/import 三态） | MUST 自管 state | D6 | ~150 |
| 19 | i18n | `app/web/src/i18n/locales/*/app-dev-config.json` | `tab.config_sync.label` + 文案 | 新增 | 各语言 locale 加 config_sync tab + 导入导出文案 | MUST 至少 zh-CN + en | PRD | ~15×N |

---

## 导入 provider 完整流程（method 级）

```
executeImport(data, selected):
  result = { providersImported: 0, toolsImported: 0 }
  
  // 1. 模型注入（逐条）
  for (provider of data.providers):
    if (!selected.providers.has(provider.label)) continue
    
    // 1a. POST /provider（不传 id，后端生成新 ULID）
    created = await createProvider({
      label: provider.label,
      baseUrl: provider.baseUrl,
      apiKey: provider.credentials.key,
      protocolId: provider.protocolId,
    })
    
    // 1b. 逐个 POST /provider/:id/model
    for (model of provider.models ?? []):
      await createModel(created.id, {
        modelId: model.modelId,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        label: model.label,
        enabled: model.enabled,
      })
    
    result.providersImported++
  
  // 2. 工具覆盖（整 tab PUT）
  for (tabId of ['web_search', 'web_fetch', 'see_image', 'bash']):
    if (!selected.tools.has(tabId)) continue
    
    const { group, keys } = TOOL_TAB_MAP[tabId]
    const items = keys.map(key => ({
      key,
      data: resolveToolData(data.tools, tabId, key),
    }))
    await putConfigGroup('app', group, items)
    result.toolsImported++
  
  return result
```

## 导出 provider 完整流程（method 级）

```
collectExportData(selected):
  // 1. 模型：GET /provider → 过滤选中 → 剥离 id
  const { items } = await loadProvidersAndProtocols()
  const providers = items
    .filter(p => selected.providers.has(p.label))
    .map(p => ({
      label: p.label,
      name: p.name,
      protocolId: p.protocolId,
      baseUrl: p.baseUrl,
      credentials: { key: p.credentials.key },
      enabled: p.enabled,
      models: p.models,  // 全量 models（含 modelId/contextWindow/maxOutputTokens/label/enabled）
    }))
  
  // 2. 工具：逐 tab GET config → 提取选中项
  const tools = {}
  for (tabId of ['web_search', 'web_fetch', 'see_image', 'bash']):
    if (!selected.tools.has(tabId)) continue
    const { group } = TOOL_TAB_MAP[tabId]
    const records = await getConfigGroup('app', group)
    // 提取该 tab 相关的 key data
    tools[tabId] = extractToolData(records, tabId)
  
  return { v: 1, exportedAt: new Date().toISOString(), providers, tools }
```

## 范式归属

| 控件/操作 | 范式 | 理由 |
|-----------|------|------|
| 配置同步 tab 整体 | **独立操作页**（非 A/B/C 配置范式） | 导入导出是即时操作（类似「下载文件」「上传文件」），不走 SaveBar/dirty |
| 导出树形勾选 | 临时选择态 | 勾选 → 点导出 → 下载 → 完成。无 dirty/save/cancel |
| 导入树形勾选 | 临时选择态 | 勾选 → 点导入 → 确认 modal → 执行。无 dirty/save/cancel |
| 重名提醒标签 | 只读展示 | 不阻止勾选，纯信息提示 |

## 风险点

1. **crypto.subtle 仅在 secure context（https/localhost）可用**：生产环境走 https，dev 走 localhost，均满足。如遇 file:// 协议需 fallback。
2. **provider 导入逐条 POST 慢**：大量 provider（>20）时网络延迟可见。可加进度提示（「正在导入 3/15...」），但本版本不要求。
3. **MD5 固定盐值**：非安全级加密（PRD §2.6 明确「防肉眼读取，仅做信息整体编解码」）。密钥可从源码提取，不应用于敏感数据保护。
4. **工具 group 映射精确性**：web_fetch 用 group=web 但只取 3 个 jina key，不覆盖 web group 全部 key。导入时也只 PUT 这 3 个 key。需确保 `TOOL_TAB_MAP` 精确对齐 `section-web-fetch-config.tsx` 的 GET 逻辑。

## 后端改动

**零改动**。所有 API 端点已存在且满足需求：
- `GET /provider` — 返回 items + protocols（含 credentials.key 明文）
- `POST /provider` — 创建 provider（校验 label/baseUrl/credentials.key/protocolId 必填，无唯一性限制）
- `POST /provider/:id/model` — 给 provider 加 model
- `GET /config/app?group=<g>` — 读配置 group
- `PUT /config/app` — 写配置 group（items[] 整组提交）
