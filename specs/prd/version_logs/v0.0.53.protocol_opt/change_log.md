# v0.0.53 PRD Change Log — Protocol 归属迁移（model→provider）+ protocol 加 label + UI 拼接地址展示

> version: 1.0 · 2026-07-02
> 一句话定位：把 `protocolId` 字段从 `LlmModelConfig` **彻底迁到 `LlmProviderConfig`**（锁 1 provider : 1 protocol，单一事实源），protocol impl 加 `readonly label`（人类可读名，UI 下拉用），provider 配置 UI 加 protocol 下拉 + 拼接地址动态展示。
> 概念权威源：`specs/tech/agent/providers_and_models/`（index / `[P0]llm_protocol_interface.md` / `[P0]llm_provider_interface.md` / `[P0]llm_model_interface.md` / `anthropic_impl.md`）+ `specs/tech/config/[P0]app_config.md §3.2`（providers 组 schema 权威）+ `specs/api/overall/02-llm-chat.md §5`（provider/model CRUD 契约）+ `specs/ui/components/providers/_overview.md`（provider 配置 UI spec）。
> 设计稿：**无**（`reqs/[working] v0.0.53.protocol_opt/` 仅 req.md）→ 视觉保真度门禁**跳过**（E2E 仅做单图功能检查，无 `vision_check.py compare`）。

---

## 1. 背景与目标

### 1.1 背景

当前 `protocolId` 持有者是 **model**（`LlmModelConfig.protocolId`，见 `[P0]llm_model_interface.md §2`）。`LlmProviderConfig` 反而不持有 protocol——`llm-client-factory.ts:68-74` 因此**硬编码**取 `anthropic_messages` impl（与 provider/model 配置脱钩）。这与 spec `[P0]llm_provider_interface.md §3.4` 的「完整 URL = `providerConfig.baseUrl` + `protocol.path`」拼接模型存在张力：path 挂在 protocol impl、protocolId 却由 model 持有，**两份「请求去哪儿」的事实源跨了实体**。

用户论证（`req.md`）：protocol impl **挂着后缀 path**（如 `/v1/messages`），path 必须与 baseUrl 在一起才有意义；一个 provider 若支持多 protocol，每个 protocol 对应不同 baseUrl，**无法共享同一 provider 实例**——故 1 provider 应锁 1 protocol，protocolId 归 provider。

### 1.2 现状摸底（Explore 已完成，关键发现）

- **「抽象 protocol」现状已基本满足**（不是从零抽象）：
  - `ProtocolName` 枚举（4 值：`anthropic_messages` / `openai_chat_completions` / `openai_responses` / `gemini_generateContent`）
  - `LlmProtocol` interface（含 `readonly path` / `contentType` + `encode` / `parse` / `parseStream`）
  - `AnthropicMessagesProtocol` impl（`path="/v1/messages"`）
  - URL 拼接 `client.ts:286 url = baseUrl + protocol.path` 已有
- **真正工作量**：归属迁移 + protocol 加 label + UI（下拉 + 拼接地址展示）+ 数据迁移 + spec 同步更新。

### 1.3 目标

1. **归属迁移**：`protocolId` 从 `LlmModelConfig` 迁到 `LlmProviderConfig`，model 上**彻底删除**（不保留 per-model override；单一事实源）。
2. **protocol label**：protocol impl 加 `readonly label: string`（人类可读名，UI 下拉展示）；ProtocolName 只是 id。
3. **UI 展示**：provider 配置二级页加 protocol 下拉（选项 = 已注册 `llm_protocol` ext impl × {id, label}）+ 拼接地址动态展示（`baseUrl + protocol.path`，随 baseUrl/protocol 变化）。
4. **数据迁移**：dev/test 现有 4 provider（minimax / volcengine / glm / deepseek）填 `protocolId=anthropic_messages`；现有 model 上 protocolId 移除（本就全是 anthropic_messages，迁移无歧义）。

---

## 2. 三个已确认决策（用户对话定稿，PRD 直接落地）

| # | 决策 | 理由 |
|---|------|------|
| **D1** | model 上 `protocolId` **彻底删除**（不保留 per-model override） | 单一事实源；保留 override 会留下「model 可覆盖 provider」的双源张力；用户已论证 1:1 锁定 |
| **D2** | protocol impl **加 readonly label 字段**（UI 下拉展示人类可读名） | `ProtocolName` 只是 id（`"anthropic_messages"`），不适合直接展示给用户；label 是「Anthropic Messages 风格」之类的人类可读名 |
| **D3** | **跳过 researcher**（不需要竞品调研） | 内部架构调整，refs/ 无相关竞品；现状摸底已由 Explore 完成 |

---

## 3. Scope

### 3.1 IN-SCOPE

| 编号 | 项 | 摘要 |
|---|---|---|
| **S1** | `protocolId` 归属迁移（model → provider，锁 1:1） | `LlmProviderConfig` += `protocolId: ProtocolName`（必填）；`LlmModelConfig` −= `protocolId`。`LlmClient` 拼接逻辑 `protocol.path` 来源从 modelConfig 改为 providerConfig；`llm-client-factory.ts:68-74` 硬编码改为按 `providerConfig.protocolId` 动态取 impl。 |
| **S2** | protocol impl 加 `readonly label` | `LlmProtocol` interface += `readonly label: string`；`AnthropicMessagesProtocol` impl 落具体文案（候选「Anthropic Messages 风格」）；`ProtocolName` 保留为 id enum 不变。 |
| **S3** | provider 配置 UI 加 protocol 下拉 + 拼接地址动态展示 | `component-provider-fields` 加 `protocol` 下拉（testid `provider-field-protocol`）+ 拼接地址 mono 展示区（`baseUrl + protocol.path`，随两字段实时变化）；下拉选项 = `PluginManager.getExtensionImpls("llm_protocol")` × `{id, label}`。 |
| **S4** | 数据迁移（dev/test） | 现有 4 个 provider 实例补 `protocolId=anthropic_messages`（从其任一 model 抄过来，本就同值）；models[] 中每条移除 `protocolId` 字段。迁移策略（启动一次性 vs 懒加载）由 architect 定。 |
| **S5** | API 契约更新 | `ProviderInstance` += `protocolId`；`ProviderCreateBody` += `protocolId`（必填）；`ProviderUpdateBody` += `protocolId?`；`ModelInstance` / `ModelCreateBody` / `ModelUpdateBody` -= `protocolId`；POST/PUT 校验放宽/收窄对齐。 |
| **S6** | model 弹层移除 protocolId 字段 | `component-model-edit-modal` 字段列表去 protocolId（v0.0.7 spec 中 protocolId 是「固定不可编辑」，v0.0.53 起该字段不存在于 model）。 |

### 3.2 OUT-OF-SCOPE（Non-goals，明确排除）

- **新增 protocol impl**（如 `openai_chat_completions` / `openai_responses` / `gemini_generateContent` 的具体实现）—— 当前仍只有 `anthropic_messages` 一个 impl，本版只迁移归属不新增实现。
- **新增 provider impl**（如 `openai_compatible` / `glm` 的具体 buildAuthHeaders 实现完善）—— provider type 枚举不变。
- **provider 内 model 列表 UI 重做** —— model 列表/弹层交互沿用 v0.0.7（仅移除 protocolId 字段）。
- **视觉保真度比对** —— 无设计稿，门禁跳过。
- **修改 `LlmProtocol` 其他契约**（`encode` / `parse` / `parseStream` / `path` / `contentType`）—— 仅加 label 一个 readonly 字段，不动其他。
- **修改 cache_control 策略 / protocol encode 内部行为** —— 归属迁移对 protocol encode 透明（encode 不读 protocolId）。

---

## 4. 功能需求

### 4.1 S1 — `protocolId` 归属迁移（model → provider，锁 1:1） `[v0.0.53]`

**描述**：把 `protocolId` 字段从 `LlmModelConfig` 移到 `LlmProviderConfig`，作为 provider 的必填属性；锁定 1 provider : 1 protocol 关系，model 不再持有 protocol 选择权。

**优先级**：P0

**用户故事**：作为框架，我希望「请求去哪儿」（baseUrl + path）的事实源统一在 provider 一个实体上——protocol 挂 path、provider 挂 baseUrl 与 protocolId，二者在一起才有意义；同一 provider 若支持多 protocol，每个 protocol 对应不同 baseUrl，无法共享同一 provider 实例，故 1:1 锁定。

**期望行为（用户可见 / 系统可见）**：

- **API 层**：
  - `POST /provider` 必须带 `protocolId`（缺省 400）；`PUT /provider/:id` 接受可选 `protocolId`（修改 protocol = 换接入点风格）。
  - `POST /provider/:id/model` / `PUT /provider/:id/model/:modelId` **不再接受 `protocolId` 字段**（请求体含该字段行为：忽略 vs 400，由 architect 定）。
  - `GET /provider` / `GET /provider/:id` 响应中 `ProviderInstance` 含 `protocolId`，`ModelInstance` 不含 `protocolId`。
- **client 层**：`LlmClient` 拼接 url 时 `protocol.path` 来源从 `modelConfig.protocolId` 改为 `providerConfig.protocolId`（解析为 `LlmProtocol` impl 后取 path）；`llm-client-factory.ts:68-74` 硬编码 `anthropic_messages` 改为按 `providerConfig.protocolId` 动态取 impl。
- **chat 行为不变**：用户在 chat 调 LLM 的体验与之前完全一致（同一 provider+model 仍然命中同一 url + path），只是事实源迁移。

**关键机制（待 architect 落 tech spec）**：

- `provider-types.ts`（或对应文件）：`LlmProviderConfig` += `protocolId: ProtocolName`（必填）；`LlmModelConfig` −= `protocolId`。
- `llm-client-factory.ts`：动态取 protocol impl（按 `providerConfig.protocolId` 查 `PluginManager.getExtensionImpls("llm_protocol")`）。
- `client.ts`：`protocol` 来源从 model 切换到 provider config（impl 引用本身不变）。
- `handlers/provider.ts`：`ProviderInstance` += `protocolId`；`ModelInstance` −= `protocolId`；POST/PUT 校验放宽/收窄。

**E2E Use Cases**（API CRUD 字段校验用例见 §4.5；本节只列 chat 行为验证）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-4.1.1 | 用现有 provider + model 发 chat → 后端实际请求 url = `baseUrl + /v1/messages` | url 拼接正确（path 来自 providerConfig.protocolId 解析的 impl，非硬编码），LLM 正常响应 |

---

### 4.2 S2 — protocol impl 加 `readonly label` 字段 `[v0.0.53]`

**描述**：`LlmProtocol` interface 加 `readonly label: string` 字段，作为 UI 下拉展示用的人类可读名；`ProtocolName` 保留为 id enum 不变。

**优先级**：P0

**用户故事**：作为用户在 provider 配置页选 protocol，我希望下拉看到的是「Anthropic Messages 风格」之类的人类可读名，而不是 `anthropic_messages` 这种 id 字符串。

**期望行为（用户可见）**：

- provider 二级页的 protocol 下拉，选项展示文本为 impl 的 `label` 字段。
- 选项 value（即 `ProtocolName` id）用于持久化到 `providerConfig.protocolId`。

**关键机制（待 architect 落 tech spec）**：

- `LlmProtocol` interface += `readonly label: string`（与 `path` / `contentType` 同级）。
- `AnthropicMessagesProtocol` impl 落具体文案（候选 `"Anthropic Messages 风格"`，最终文案由 architect 定）。
- 下拉选项来源 = `PluginManager.getExtensionImpls("llm_protocol")` → `[{ id: ProtocolName, label: string }]`。

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-4.2.1 | 打开 provider 二级页 → 看 protocol 下拉 | 选项文本为人类可读 label（如「Anthropic Messages 风格」），非 id 字符串 |
| UC-4.2.2 | `PluginManager.getExtensionImpls("llm_protocol")` | 返回的 impl 含 `label` 字段（readonly） |

---

### 4.3 S3 — provider 配置 UI 加 protocol 下拉 + 拼接地址动态展示 `[v0.0.53]`

**描述**：provider 二级页 `component-provider-fields` 加 `protocol` 下拉字段；在 baseUrl 与 protocol 字段下方加「实际请求地址」mono 展示区，实时展示 `baseUrl + protocol.path` 的拼接结果。

**优先级**：P0

**用户故事**：作为用户配置 provider，我希望填 baseUrl + 选 protocol 后立刻看到「这个 provider 实际会访问什么 URL」（如 `https://api.anthropic.com/v1/messages`），不要等保存后才发现拼错了。

**期望行为（用户可见）**：

- **下拉**：provider 二级页表单新增 `protocol` 字段（select），选项来自已注册 `llm_protocol` ext impl（当前仅 `anthropic_messages` 一项）；新建 provider 默认选中第一项。
- **拼接地址展示**：baseUrl 输入框 + protocol 下拉**下方**展示一行 mono 文本「实际请求地址：`{baseUrl}{protocol.path}`」，随 baseUrl 输入与 protocol 选择**实时变化**（无需保存）。
  - 示例 1：`https://api.anthropic.com` + `/v1/messages` → `https://api.anthropic.com/v1/messages`
  - 示例 2：`https://api.openai.com/v1` + `/chat/completions`（仅当 protocol 含此 path 时；当前 impl 不含）→ `https://api.openai.com/v1/chat/completions`
- **空态**：baseUrl 为空时拼接地址仅展示 `protocol.path`（或空字符串，由 architect/UI 设计师定）；protocol 未选时展示 `baseUrl`（或空字符串）。
- **样式约束**：拼接地址用 mono 字体 + read-only（不可编辑）；下拉与 baseUrl 沿用 `f-input` 规格（见 `_conventions.md`）。

**关键机制（待 architect / coder 落 ui spec + 实现）**：

- `component-provider-fields` Props 加 `protocolOptions: { id, label }[]`（父级 `section-providers` 从 `PluginManager` 拉取一次共享）；draft 加 `protocolId: ProtocolName` 字段。
- 拼接地址计算：`protocolOptions.find(o => o.id === draft.protocolId)?.path` 与 `draft.baseUrl` 拼接；path 来源对前端透明（前端不直接知道 path，需要后端额外端点返回 path 或 ext impl 元数据下沉到前端）—— **开放问题**：是否需要新端点 `/protocol` 或扩展 `PluginManager.inventory()` 返回 path？由 architect 决定（候选方案见 §8 开放问题）。
- UI spec 同步更新：`specs/ui/components/providers/_overview.md`（component-provider-fields 字段表 + 拼接地址展示规则 + testid 命名）。

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-4.3.1 | 进 provider 二级页 → 看 protocol 下拉 + baseUrl 输入 + 下方拼接地址展示 | 三元素均存在；拼接地址初始 = 当前 baseUrl + 当前 protocol.path |
| UC-4.3.2 | 改 baseUrl（拼接地址实时变） | 输入 `https://api.anthropic.com` → 拼接展示 `https://api.anthropic.com/v1/messages`；改为 `https://api.minimaxi.com/anthropic` → 拼接展示 `https://api.minimaxi.com/anthropic/v1/messages` |
| UC-4.3.3 | 切换 protocol 下拉（即使当前只有一项，验证机制） | 拼接地址按新 protocol.path 变化（机制对多项 protocol 通用） |
| UC-4.3.4 | baseUrl 为空 | 拼接地址展示 path 前缀或空态（由 UI spec 定） |

---

### 4.4 S4 — 数据迁移（dev/test 现有 provider 补 protocolId） `[v0.0.53]`

**描述**：dev/test 现有 4 个 provider 实例（minimax / volcengine / glm / deepseek）补 `protocolId=anthropic_messages`；models[] 每条移除 `protocolId` 字段。

**优先级**：P0

**用户故事**：作为用户升级到 v0.0.53，我希望现有 provider 配置自动迁移、不需重配；现有 session 仍能正常 chat（无回归）。

**期望行为（用户可见 = 透明）**：

- 升级后首次启动 app（dev/test）→ 4 个 provider 实例自动补 `protocolId=anthropic_messages`（从其任一 model 抄过来，本就同值）；models[] 中每条移除 `protocolId`。
- 现有 session 用旧 provider+model 发 chat 仍正常（url 拼接正确，LLM 正常响应）。
- **无歧义**：当前所有 model 的 `protocolId` 都是 `anthropic_messages`（spec 强制单一值），迁移不会冲突。

**关键机制（待 architect 落 tech spec）**：迁移策略两选一（architect 定）：**A. 启动一次性迁移**（app 启动扫 providers group，顶层无 protocolId 则从 `models[0].protocolId` 抄 + 清 model 字段，幂等，推荐方向，一致性更好）；**B. 懒加载迁移**（handler 读取时补全 + 写入时强制新形状）。

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-4.4.1 | 升级前用旧 provider 发 chat 正常 → 升级后启动 app → 同 provider 发 chat | 仍正常响应（url 拼接正确） |
| UC-4.4.2 | 升级后 `GET /provider` | 每个 provider 实例含 `protocolId=anthropic_messages`；其 models[] 不含 protocolId |
| UC-4.4.3 | 升级前已有 session transcript → 升级后继续该 session | session 继续可用，无回归 |

---

### 4.5 S5 — API 契约更新（`/provider` CRUD） `[v0.0.53]`

**描述**：`/provider` + `/provider/:id/model` 端点契约按 S1/S6 更新字段归属。详细 schema + 错误码（400 文案）由 architect 落 `specs/api/overall/02-llm-chat.md §5` + `specs/api/version_logs/v0.0.53/change_log.md`。

**优先级**：P0

**字段变更矩阵**：

| 类型 | 变更 | 必填 |
|---|---|---|
| `ProviderInstance` | += `protocolId: ProtocolName` | 必填（响应必含） |
| `ProviderCreateBody` | += `protocolId: ProtocolName` | 必填（缺省 400） |
| `ProviderUpdateBody` | += `protocolId?: ProtocolName` | 可选 |
| `ModelInstance` | −= `protocolId` | —（响应不再含） |
| `ModelCreateBody` / `ModelUpdateBody` | −= `protocolId` | —（含则忽略或 400，由 architect 定） |

POST `/provider` 校验：`protocolId` 必须在已注册 `llm_protocol` ext impl 的 id 集合内，否则 400。

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-4.5.1 | `POST /provider { label, baseUrl, credentials, protocolId:"anthropic_messages" }` | 201，响应含 protocolId |
| UC-4.5.2 | `POST /provider` 缺 protocolId | 400 |
| UC-4.5.3 | `POST /provider { ..., protocolId:"unknown" }` | 400（不在已注册列表） |
| UC-4.5.4 | `PUT /provider/:id { protocolId:"anthropic_messages" }` | 200，响应更新 |
| UC-4.5.5 | `POST /provider/:id/model { modelId, ... }`（无 protocolId） | 201，正常创建 |
| UC-4.5.6 | `POST /provider/:id/model` 带 protocolId | 按 architect 决策：忽略 201 / 拒绝 400 |
| UC-4.5.7 | `GET /provider/:id` 响应中 model | 不含 protocolId 字段 |

---

### 4.6 S6 — model 编辑弹层移除 protocolId 字段 `[v0.0.53]`

**描述**：`component-model-edit-modal`（v0.0.7 spec）字段列表中移除 protocolId；protocol 选择改在 provider 二级页（§4.3）。弹层保留字段（v0.0.7 既有）：label / modelId / contextWindow / maxOutputTokens / default / enabled。

**优先级**：P0

**E2E Use Cases**

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-4.6.1 | 进 provider 二级页 → 添加模型 → 看 model 弹层 | 弹层字段：label / modelId / contextWindow / maxOutputTokens / default / enabled；无 protocolId |
| UC-4.6.2 | provider 字段区选 protocol → 添加模型（弹层与 protocol 无关） | protocol 选择只在 provider 二级页，model 弹层不涉及 |

---

## 5. 关键用户路径（MANDATORY — 测试最低覆盖）

每条路径 ≥ 1 个 AT/ET case。设计稿无 → 视觉保真 compare 跳过。

| ID | 路径 | 涉及功能 | 测试类型 |
|----|------|---------|---------|
| **P1** | **新建 provider（带 protocol）**：app 设置 → providers group → 添加提供商 → 填 label/baseUrl/apiKey → **选 protocol 下拉** → 看「实际请求地址」动态展示（baseUrl+path）→ 添加 model（弹层无 protocolId）→ 保存 → 后端 `POST /provider` 含 protocolId + `POST /provider/:id/model`（无 protocolId）→ 实际 chat 验证 url 正确 | S1 + S3 + S5 + S6 | AT（curl POST 链 + GET 校验 + 真 LLM chat 验证 url）+ ET（UI 全链路） |
| **P2** | **编辑现有 provider，改 baseUrl**：进已存 provider 二级页 → 改 baseUrl（拼接地址实时变）→ 保存 → 实际 chat 走新 url | S3 + S5 | AT（PUT /provider/:id + chat 验证）+ ET（UI 改 baseUrl 看拼接变化） |
| **P3** | **旧数据迁移兼容**：升级前 dev/test 现有 provider+model 配置 → 升级后启动 → `GET /provider` 每个 provider 含 protocolId，model 无 protocolId → 现有 session 继续可 chat（无回归） | S1 + S4 + S5 | AT（迁移后 GET 校验 + chat 真 LLM 验证） |
| **P4** | **model 弹层移除 protocolId**：进 model 编辑弹层 → 字段中无 protocolId；protocol 选择在 provider 二级页 | S6 | ET（DOM 断言 model 弹层无 protocolId 字段；provider 二级页有 protocol 下拉） |

---

## 6. 验收口径

- **功能**：S1-S6 全实现；P1-P4 关键路径 case 全 pass。
- **API 测试**：通过率 ≥ 90%（无 5xx / schema 不合规 / 契约 hard fail）；新增 protocolId 必填校验 case 覆盖。
- **E2E 测试**：通过率 ≥ 70%（dom 断言无 hard_fail；vision 单图功能判定照常；无设计稿 compare 跳过）。
- **回归**：现有 4 provider（minimax/volcengine/glm/deepseek）升级后 chat 正常；现有 session transcript 可继续；chat url 拼接无偏差。
- **数据迁移**：dev/test 启动后 `GET /provider` 每个 provider 实例含 `protocolId=anthropic_messages`，其 models[] 中无 protocolId 字段。

---

## 7. 与现有 spec 的张力清单（需 architect 同步更新）

PRD 不发明概念，下列 spec 章节 architect 阶段同步更新（设计意图由本 PRD 提供，具体字段命名/位置归 architect）：

| spec 文件 | 章节 | 张力 / 更新方向 |
|---|---|---|
| `specs/tech/agent/providers_and_models/[P0]llm_provider_interface.md` | §1 概述末句 / §2 接口 / §3.4 / §5 边界 | 「一个 provider 可对接多种 protocol」→ 改为「1 provider : 1 protocol 锁定」；`LlmProviderConfig` 加 `protocolId: ProtocolName`（必填）；§5 边界表补「protocolId（数据）」归 provider |
| `specs/tech/agent/providers_and_models/[P0]llm_model_interface.md` | §2 接口 / §3.4 标题 + 正文 / §4 示例 / §5 边界 | `LlmModelConfig` 移除 `protocolId`；§3.4 标题「引用 provider 实例 + protocol impl」→ 改为「引用 provider 实例」（不再引用 protocol）；§4 示例 JSON 删 protocolId |
| `specs/tech/agent/providers_and_models/[P0]llm_protocol_interface.md` | §2 接口 | `LlmProtocol` interface += `readonly label: string`；`ProtocolName` 保留为 id enum（注释说明 label 是 UI 展示名，与 id 正交） |
| `specs/tech/agent/providers_and_models/anthropic_impl.md` | §2 标准值表 | 加一行 `label | "Anthropic Messages 风格"`（具体文案 architect 定） |
| `specs/tech/agent/providers_and_models/index.md` | ③ 关系图 / ④ 核心设计原则 | 关系图说明 protocolId 来源 = provider；④ 原则 1「零件唯一归属」补「protocolId 选择归 provider」 |
| `specs/tech/agent/providers_and_models/log.md` | （位置轴） | 追加 v0.0.53 归属迁移条目（ISO 倒序） |
| `specs/tech/config/[P0]app_config.md` | §3.2 providers 组 | `data` 顶层 += `protocolId`（与 label/pluginId/enabled/baseUrl/credentials 并列）；`models[]` 每条 −= `protocolId`；示例 JSON 同步 |
| `specs/api/overall/02-llm-chat.md` | §5.1 / §5.2 / §5.3 类型表 + 错误码 | `ProviderInstance` += `protocolId`；`ProviderCreateBody` += `protocolId`（必填）；`ProviderUpdateBody` += `protocolId?`；`ModelInstance` −= `protocolId`；`ModelCreateBody` / `ModelUpdateBody` −= `protocolId`；§5.4 错误码 400 校验更新（缺 protocolId / protocolId 非法 → 400；model 含 protocolId 行为标注） |
| `specs/ui/components/providers/_overview.md` | §2 数据模型 / §3 组件树 / §5 组件契约 | ProviderInstance += `protocolId`；ModelInstance −= `protocolId`；`component-provider-fields` 字段表加 `protocol`（select）+ 拼接地址展示规则；`component-model-edit-modal` 字段表删 protocolId；新增 testid `provider-field-protocol` |

> `specs/tech/version_logs/v0.0.53/change_log.md` 由 architect 创建（跨版本发布说明）；`specs/api/version_logs/v0.0.53/change_log.md` 由 coder 编码阶段细化。

---

## 8. 待 architect 落 tech spec 的概念清单（PRD 不发明，仅枚举）

下列概念 PRD 只描述行为，**具体字段/位置/命名由 architect 落 tech spec**：

1. **`LlmProviderConfig.protocolId`** — 类型 `ProtocolName`；必填；放在 `provider-types.ts` 哪个位置。
2. **`LlmProtocol.label`** — `readonly label: string`；`AnthropicMessagesProtocol` 文案最终值。
3. **`llm-client-factory.ts` 动态取 impl** — 替代硬编码 `anthropic_messages` 的签名（按 `providerConfig.protocolId` 查 `PluginManager.getExtensionImpls("llm_protocol")`）。
4. **数据迁移策略** — 启动一次性（A，推荐）vs 懒加载（B）；幂等实现；旧 model.protocolId 迁移后是否保留为 dead code 还是物理删除。
5. **`POST /provider/:id/model` 含 `protocolId` 字段行为** — 忽略（推荐，前端容错友好）vs 400。
6. **拼接地址展示的 path 来源（前端如何拿 protocol.path）** — 候选：A. 扩展 `PluginManager.inventory()` / `GET /config/plugin` 返回每个 protocol ext impl 的 path 元数据；B. 新增 `GET /protocol` 端点；C. `ProviderInstance` 响应加只读 `resolvedPath` 后端拼接好返回。推荐 A 或 C（避免新端点）。
7. **UI 组件归属** — 拼接地址展示并入 `component-provider-fields` 内嵌（推荐，避免组件膨胀）vs 新建 `component-url-preview` 子组件。

---

## 9. 与现有 overall PRD 的关系

- `specs/prd/overall/04-config-center-ui.md` §3.9.7（providers group 三级流 + diff-save）→ 本版**修订**：在 §3.9.7 追加 `[v0.0.53 modified]` 标注 + 新增 4.3/4.6 子节描述（provider 字段加 protocol 下拉 + 拼接地址展示；model 弹层去 protocolId）。数据归属不变（app_config providers group record），端点路径不变（`/provider` + `/provider/:id/model`，仅字段更新）。
- 其他 overall 文档（03-llm-chat / 08-squad-studio 等）不受本版影响。
- 04-config-center-ui.md 末尾版本元信息追加 v0.0.53 modified 标注。
