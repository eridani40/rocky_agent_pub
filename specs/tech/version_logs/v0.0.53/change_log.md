---
type: change_log
title: v0.0.53 跨版本发布说明 — protocolId 归属迁移 + protocol label + UI 拼接地址
version: v0.0.53
updated: 2026-07-03
related_prd: specs/prd/version_logs/v0.0.53.protocol_opt/change_log.md
---

# v0.0.53 — protocolId 归属迁移（model→provider）+ protocol impl 加 label + UI 拼接地址展示

> 一句话：把 `protocolId` 字段从 `LlmModelConfig` **彻底迁到 `LlmProviderConfig`**（1 provider : 1 protocol 锁定，单一事实源），protocol impl 加 `readonly label`（UI 下拉展示名），provider 配置 UI 加 protocol 下拉 + 拼接地址动态展示。

权威 spec：
- tech KB：`specs/tech/agent/providers_and_models/`（index `[P0]llm_provider_interface` / `[P0]llm_model_interface` / `[P0]llm_protocol_interface` / `anthropic_impl`）
- config schema：`specs/tech/config/[P0]app_config.md §3.2`（providers 组 data 形状权威）
- API 契约：`specs/api/overall/02-llm-chat.md §5`
- UI 契约：`specs/ui/components/providers/_overview.md`

## 1. 数据模型变更

### 1.1 `LlmProviderConfig` += `protocolId`（必填，per-instance 数据）

```typescript
interface LlmProviderConfig {
  id: string;
  name: ProviderName;
  /** [v0.0.53] 1 provider : 1 protocol 锁定，必填。
   *  factory 按 this 字段查 PluginManager.getExtensionImpls(llm_protocol) 命中 implId 动态实例化。
   *  归属迁移自 LlmModelConfig.protocolId（旧字段已物理删除）。 */
  protocolId: ProtocolName;
  baseUrl: string;
  credentials: CredentialConfig;
  pluginId: string;
  enabled: boolean;
  models: LlmModelConfig[];
}
```

### 1.2 `LlmModelConfig` −= `protocolId`（物理删除，不保留 override）

```typescript
interface LlmModelConfig {
  modelId: string;
  // ... 其他字段不变
  providerId: string;
  // [v0.0.53] protocolId 已迁出 → LlmProviderConfig.protocolId
  default?: boolean;
}
```

### 1.3 `LlmProtocol` += `readonly label`（UI 展示名）

```typescript
interface LlmProtocol {
  readonly path: string;
  readonly contentType: string;
  /** [v0.0.53] 人类可读展示名（UI 下拉用）。与 ProtocolName id 正交：id 是 wire/持久化标识，label 是 UI 展示文本 */
  readonly label: string;
  encode / parse / parseStream 不变;
}
```

`AnthropicMessagesProtocol` impl 落 `label = "Anthropic Messages 风格"`（`anthropic_impl.md §2` 标准值表已加）。

## 2. `llm-client-factory` 动态取 impl（替代硬编码）

**旧**（`llm-client-factory.ts:68-74`）：

```typescript
const providerImpl = providers.find(p => p.implId === 'anthropic_compatible') ?? providers[0];
const protocolImpl = protocols.find(p => p.implId === 'anthropic_messages') ?? protocols[0];
```

**新**：

```typescript
const providerImpl = providers.find(p => p.implId === providerConfig.name) ?? providers[0];
const protocolImpl = protocols.find(p => p.implId === providerConfig.protocolId) ?? protocols[0];
if (!providerImpl || !protocolImpl) {
  throw new Error(`provider/protocol impl 未注册: name=${providerConfig.name}, protocolId=${providerConfig.protocolId}`);
}
```

**理由**：硬编码与 provider/model 配置脱钩（旧 bug：换 protocol 配置无效）；动态取 impl 让 `providerConfig.protocolId` 成为单一事实源。

`client.ts:286` `url = providerConfig.baseUrl + this.protocol.path` 不变（protocol impl 引用来源从 modelConfig 切到 providerConfig，但 impl 引用本身不变）。

## 3. 数据迁移（S4）

### 3.1 策略：启动一次性，幂等（PRD 推荐方案 A）

**位置**：`app/server/src/bootstrap.ts`（boot 序列），server 启动 → AppConfigService 初始化完成后、handler 路由挂载前调用一次（实际落点 `bootstrap.ts:228`）：

```typescript
migrateProvidersProtocolId(appConfigSvc);
```

**两个加固约束（code-review Critical 修复引入，spec 同步）**：
1. **name 守卫**——只迁移 `p.name === 'anthropic_compatible'` 的 record。理由：`protocolId` 仅对真实 anthropic provider 有意义；providers 组可能落非 provider 记录（测试 mock fixture `name='mock'`），给它们盖 `protocolId` 是语义错误。非目标 record `continue` 跳过。
2. **逐条 try/catch**——每条 record 处理包 try/catch，单条失败（如外层 id 非 ULID 的 test fixture、schema 校验不过的脏数据）不阻塞 bootstrap。迁移是 best-effort 一次性整理：真实生产 record（handler 经 `ulid()` 创建）必过校验；失败 = 非 migration 目标，跳过。

**新增函数**（建议落 `app/server/src/llm/migrate-protocol-id.ts`，< 60 行）：

```typescript
/** [v0.0.53] 一次性迁移：providers 组 record 顶层 += protocolId（从 models[0] 抄），
 *  models[].protocolId 物理删除。幂等：顶层已有 protocolId 则跳过。
 *  name 守卫 + 逐条 try/catch（见 §3.1 加固约束 + §3.2 要点 5/6）。 */
export function migrateProvidersProtocolId(svc: AppConfigService): void {
  const records = svc.listGroup('providers');
  for (const r of records) {
    try {                                            // §3.2 要点 6：逐条 try/catch，失败跳过不阻塞 bootstrap
      const p = r.data as ProviderInstance & { protocolId?: string } | null;
      if (!p || p._deleted) continue;
      if (p.name !== 'anthropic_compatible') continue; // §3.2 要点 5：name 守卫，只迁真实 anthropic provider
      if (typeof p.protocolId === 'string' && p.protocolId.length > 0) continue; // 幂等：已迁移跳过
      // 顶层无 protocolId → 从 models[0].protocolId 抄（本就同值 anthropic_messages）
      const fromModel = p.models?.find(m => typeof m.protocolId === 'string');
      const protocolId = fromModel?.protocolId ?? 'anthropic_messages'; // models[] 空 → 默认
      // 旧 model.protocolId 物理删除（避免 dead code，原则 12）
      const models = (p.models ?? []).map(m => {
        const { protocolId: _drop, ...rest } = m;
        return rest;
      });
      svc.set('providers', p.id, { ...p, protocolId, models });
    } catch {
      // 记录无法重写（非 ULID id / schema 不合）→ 非 migration 目标，跳过不阻塞 bootstrap
    }
  }
}
```

### 3.2 幂等要点

1. **顶层已有 `protocolId`** → 跳过（不重复写，幂等）。
2. **顶层无、`models[]` 非空** → 从 `models[0].protocolId` 抄（dev/test 4 provider 的所有 model 本就 `anthropic_messages`，无歧义）。
3. **顶层无、`models[]` 为空** → 默认 `anthropic_messages`（与 anthropic_compatible 当前唯一 protocol impl 对齐）。
4. **旧 `models[].protocolId` 物理删除**：用对象解构 drop 字段后落盘，不留 dead code（原则 12）。
5. **name 守卫（code-review Critical 修复）**：只处理 `p.name === 'anthropic_compatible'` 的 record。providers 组可能混入非 provider 记录（测试 mock fixture `name='mock'`），`protocolId` 仅对真实 anthropic provider 有语义，给 mock 盖 `protocolId` 是错误。非目标 `continue` 跳过。
6. **逐条 try/catch（code-review Critical 修复）**：每条 record 处理包 try/catch，单条失败（外层 id 非 ULID 的 test fixture / schema 脏数据）不阻塞 bootstrap。迁移是 best-effort 一次性整理——真实生产 record（handler 经 `ulid()` 创建）必过校验；失败即非目标，跳过。

### 3.3 旧字段处理：物理删除（不保留 alias）

PRD §2 决策 D1：model 上 `protocolId` **彻底删除**（不保留 per-model override）。理由：单一事实源；保留 override 会留下「model 可覆盖 provider」的双源张力。迁移后 `modelToLlmModelConfig`（factory 内）读 model 时**不再读 protocolId**；client.ts `protocol` 来源从 modelConfig 切换到 providerConfig。

## 4. 拼接地址 path 来源（PRD §8 开放问题 1 定案）

### 4.1 方案：C 增强版 — `GET /provider` 响应扩 `protocols: [{ id, label, path }]`

**API 形状**（详见 `specs/api/overall/02-llm-chat.md §5.2`）：

```typescript
// GET /provider 200 响应
{
  items: ProviderInstance[],
  /** [v0.0.53] 已注册 llm_protocol ext impl 元数据（前端拼接地址 + 下拉展示用） */
  protocols: ProtocolMeta[]
}

interface ProtocolMeta {
  id: ProtocolName;       // "anthropic_messages"（implId / 持久化标识）
  label: string;          // "Anthropic Messages 风格"（UI 下拉展示文本）
  path: string;           // "/v1/messages"（拼接地址用，readonly impl 字段投影）
}
```

**handler 实现**（`handlers/provider.ts handleProviderCollection`，< 15 行）：

```typescript
function buildProtocolMeta(pluginManager: PluginManager): ProtocolMeta[] {
  const protocols = pluginManager.getExtensionImpls<LlmProtocol>(LlmProtocolPoint);
  return protocols.map(p => ({
    id: (p as { implId: string }).implId as ProtocolName,
    label: p.label,
    path: p.path,
  }));
}
```

### 4.2 理由（架构权衡）

| 候选 | 评估 | 结论 |
|------|------|------|
| **A. 扩 PluginManager.inventory()** | inventory 是 plugin 管理面（plugin manifest 层），`protocol.path` 是 impl 类实例属性（readonly 常量），manifest 不持有；塞进去 = 让 plugin 层承载 LLM 域 path 语义，**违反单一职责**。 | 拒绝 |
| **B. 新增 `GET /protocol` 端点** | 简单职责单一，但 PRD 明确倾向「避免新端点」（provider 配置 UI 本就在 `/provider` 域内，多调一个端点增加前端协调）。 | 不选 |
| **C 增强（本次定案）** | `GET /provider` 一次性返回 `items + protocols`；前端零知识（不实例化 impl、不查 inventory）；拼接逻辑单点（handler）；不污染 plugin inventory；对旧 caller 向后兼容（新字段 `protocols` 旧 caller 忽略）。 | **采纳** |
| C 原版（仅 ProviderInstance += resolvedPath） | 仅解决当前 provider 已选 protocol 的展示；前端「切换下拉预览」无 path 数据源（要切到另一个 protocol 看预览，前端必须知道所有 protocol 的 path）。 | 不足，升级为 C 增强版 |

## 5. API 契约（S5，详见 `specs/api/overall/02-llm-chat.md §5`）

| 类型 | 变更 | 必填 |
|---|---|---|
| `ProviderInstance` | += `protocolId: ProtocolName` | 必填（响应必含） |
| `ProviderCreateBody` | += `protocolId: ProtocolName` | 必填（缺省 400） |
| `ProviderUpdateBody` | += `protocolId?: ProtocolName` | 可选 |
| `ModelInstance` | −= `protocolId` | — |
| `ModelCreateBody` / `ModelUpdateBody` | −= `protocolId` | 含则**忽略**（201，不写 ModelInstance） |
| `GET /provider` 响应 | += `protocols: ProtocolMeta[]`（顶层与 `items` 并列） | 必含 |

**POST/PUT 校验**：
- `POST /provider` 缺 `protocolId` → 400 `{error:"body requires ..., protocolId"}`
- `POST /provider { protocolId: "unknown" }` → 400（不在已注册 `llm_protocol` ext impl 的 implId 集合内）
- `POST /provider/:id/model` body 含 `protocolId` → **忽略**（理由：前端容错友好；旧 client/脚本仍可工作；model 字段彻底删除意味着新 client 不会带）

## 6. 文件变更清单（planner/coder 依据）

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/llm/provider-types.ts` | 修改 | `LlmProviderConfig` += `protocolId: ProtocolName`（必填）；`LlmModelConfig` −= `protocolId` 字段 |
| `app/server/src/llm/protocol.ts` | 修改 | `LlmProtocol` interface += `readonly label: string`；`AnthropicMessagesProtocol` += `readonly label = 'Anthropic Messages 风格'` |
| `app/server/src/llm-client-factory.ts` | 修改 | `providerImpl` / `protocolImpl` 取值改为按 `providerConfig.name` / `providerConfig.protocolId` 动态查（替代硬编码 `anthropic_compatible` / `anthropic_messages`）；`modelToLlmModelConfig` 去掉 `protocolId: m.protocolId` 赋值 |
| `app/server/src/handlers/provider.ts` | 修改 | `ProviderInstance` += `protocolId`；`ModelInstance` −= `protocolId`；`handleProviderCollection` GET 响应加 `protocols: ProtocolMeta[]`（调 `pluginManager.getExtensionImpls`）；POST 校验加 `protocolId` 必填 + 合法性；`handleProviderItem` PUT 接受可选 `protocolId`；`handleModelCollection` POST body 含 `protocolId` 忽略（不写入 ModelInstance）；新增 `ProtocolMeta` 类型 + `buildProtocolMeta` helper |
| `app/server/src/llm/migrate-protocol-id.ts` | 新增 | `migrateProvidersProtocolId(svc)` 启动一次性幂等迁移函数（详见 §3.1） |
| `app/server/src/index.ts`（或 boot 序列） | 修改 | AppConfigService 初始化后、路由挂载前调 `migrateProvidersProtocolId(svc)` |
| `app/web/src/lib/api/providers.ts`（或对应 api-client） | 修改 | `ProviderInstance` 类型 += `protocolId`；`ModelInstance` −= `protocolId`；`ProtocolMeta` 类型 + `loadProtocols()` helper（从 `GET /provider` 响应取 `protocols` 字段 cache 给二级页用） |
| `app/web/src/components/providers/` | 修改 | `component-provider-fields` 加 `protocol` 下拉（testid `provider-field-protocol`）+ 拼接地址 mono 展示区；`component-model-edit-modal` 字段表删 protocolId；`section-providers` 加载 protocols metadata + 传给 fields |

> 前端组件级 spec（`specs/ui/components/providers/component-provider-fields.md` 等 6 个组件 .md）由 coder 编码前置产出/更新（先 spec 后实现，标准见 `specs/ui/components/_conventions.md`）。本架构 spec 只定总纲 + 字段契约 + testid。

## 7. 给 coder 的关键契约要点

1. **动态取 impl 签名**：`pluginManager.getExtensionImpls<LlmProtocol>(LlmProtocolPoint).find(p => (p as { implId?: string }).implId === providerConfig.protocolId)`，命中后直接用 impl 实例（已实例化，无需再 new）。
2. **迁移函数幂等三件**：(a) 顶层已有 `protocolId` 跳过；(b) 顶层无从 `models[0].protocolId` 抄；(c) 旧 `models[].protocolId` 物理删除（对象解构 drop）。
3. **POST/PUT 校验规则**：POST `/provider` 必填 `protocolId` + 合法性（在 `pluginManager.getExtensionImpls(LlmProtocolPoint)` 的 implId 集合内）；POST `/provider/:id/model` body 含 `protocolId` 忽略（201，不写入）。
4. **testid 命名**：`provider-field-protocol`（select 元素）+ `provider-url-preview`（拼接地址 mono 展示区）。
5. **label 文案**：`AnthropicMessagesProtocol.label = 'Anthropic Messages 风格'`（中文，UI 展示）。
6. **不破坏现有调用方**：`GET /provider` 响应新增 `protocols` 字段（旧 caller 忽略）；其他端点形状不变（除 model 字段去除）。

## 8. 与现有 spec 一致性核查（原则 12-13）

- `index.md §④` 原则 6 已加（protocolId 选择归 provider，1:1 锁定）。
- `[P0]llm_provider_interface.md §3.4` 标题 + 正文已改（base URL + protocolId 同归 provider）。
- `[P0]llm_model_interface.md §3.4` 标题改为「引用 provider 实例」（删 protocol 引用）。
- `[P0]llm_protocol_interface.md §2` `LlmProtocol` interface += `readonly label`。
- `anthropic_impl.md §2` 标准值表加 label 行。
- `app_config.md §3.2` data 顶层 += `protocolId`；models[] 每条 −=。
- `log.md` 追加 v0.0.53 条目（ISO 倒序）。

> 代码层 PRD §1.2 已摸底「抽象 protocol 现状已基本满足」：`ProtocolName` 枚举 4 值 / `LlmProtocol` interface / `AnthropicMessagesProtocol` impl / `client.ts:286 url = baseUrl + protocol.path` 已有，本次只迁移归属 + 加 label + UI + 迁移 + spec 同步。

---

〔v0.0.73〕`migrateProvidersProtocolId` 迁移代码已移除（一次性迁移完成，幂等死代码清理；迁移语义已固化在数据里）。涉及文件：`app/server/src/llm/migrate-protocol-id.ts`、`app/server/src/llm/__tests__/migrate-protocol-id.test.ts`、`app/server/src/bootstrap.ts`（import + 调用 + 注释块）。
