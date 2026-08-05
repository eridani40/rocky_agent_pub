# v0.0.143 change_plan — 删除 per-model `default` 字段

> 版本主题：彻底删除 `ProviderInstance.models[].default`（"设为默认模型"）字段——数据形状 + 后端读写 + 前端 UI + 透传链 + 测试 fixture + spec + i18n。
> 该字段已被 app config 模型 tab 的「playground 默认模型」（`app_config/default_models` record）取代，属过期死字段。
> 纯技术改动（无用户可感知的新行为；UI 上「设为默认模型」入口消失属预期），PRD 跳过。
> 测试范围：**仅 UT，无 AT/ET**（用户裁决 2026-07-14）。
>
> **不动的东西**（明确边界）：
> - 保留字 `modelId === 'default'` 的短路语义（落到 `default_models.chat`）—— 与本 per-model 字段无关，全部 `isReservedModelId`/`normalizeReservedModelId` 逻辑不碰。
> - `app_config/default_models` group（playground 默认模型 record）—— 这是替代方案本身。
> - `paramConstraints.temperature.default` 等 LLM 参数默认值 —— 同名不同物。

## 变更表（行=函数/符号）

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|------|------|-----------|------|----------|------|------|--------|
| server/handlers | app/server/src/handlers/provider.ts | `interface ModelInstance` | 删字段 | 删 `default?: boolean`（第46行） | MUST 不留字段 | §1 | -1 |
| server/handlers | app/server/src/handlers/provider.ts | `handleModelCollection`(POST) | 改逻辑 | 构造 model 时删 `default: body.default`（第245行）；忽略 body.default | MUST 不写字段 | §3 | -1 |
| server/handlers | app/server/src/handlers/provider.ts | `handleModelItem`(PUT) | 改逻辑 | 删 `default: typeof body.default...existing.default`（第285行）；忽略 body.default | MUST 不写字段 | §3 | -1 |
| server/handlers | app/server/src/handlers/session-provider-utils.ts | `resolveProviderModel` 兜底链 | 改逻辑 | 第107-109行 `find(m.default && enabled) ?? find(enabled) ?? [0]` → `find(enabled) ?? [0]`；注释同步 | MUST 不改其余选择优先级 | §2 | -2 |
| server/handlers | app/server/src/handlers/session-provider-utils.ts | `resolveProviderModel` 缺省分支 | 改逻辑 | 第116行 `find(m.default) ?? models[0]` → `models[0]`；注释同步 | MUST 保持「首个 model」语义 | §2 | -1 |
| server/llm | app/server/src/llm-client-factory.ts | `modelToLlmModelConfig` | 改逻辑 | 删 `default: m.default` 透传（第123行） | — | §5 | -1 |
| server/llm | app/server/src/llm/resolve-provider-config.ts | `resolveModelConfig` | 改逻辑 | 删 `default: merged.default` 透传（第74行） | — | §5 | -1 |
| server/llm | app/server/src/llm/provider-types.ts | `interface LlmModelConfig` | 删字段 | 删 `default?: boolean`（第153行，死字段无消费方） | MUST 确认无 caller | §5 | -1 |
| server/services | app/server/src/services/model-validation.ts | `ValidationModel` | 删字段 | 删 `default?: boolean`（第25行接口子集） | — | §1 | -1 |
| web/lib | app/web/src/lib/api-client.ts | `interface ModelInstance` | 删字段 | 删 `default?: boolean`（第44行） | — | §1 | -1 |
| web/lib | app/web/src/lib/api-client.ts | `createModel`/`updateModel` | 改逻辑 | 形参删 `default?: boolean`（第379、397行附近） | — | §4 | -2 |
| web/lib | app/web/src/lib/api-client.ts | `saveProviderWithModels` | 改逻辑 | 删 diff 判定 `Boolean(old.default)!==...`（第488行）+ PUT body `default: m.default`（第495行） | — | §4 | -2 |
| web/components | app/web/src/components/providers/component-provider-detail.tsx | `handleModelConfirm` | 改逻辑 | 第90-92行删「清除其他 default」，简化为 `idx>=0 ? map(i===idx?m:x) : [...models, m]` | MUST 保留新增/替换语义 | §4 | -2 |
| web/components | app/web/src/components/providers/component-provider-detail.tsx | `isDirty` | 改逻辑 | 删 `Boolean(o.default)!==Boolean(m.default)`（第238行） | MUST 其余 dirty 判定不变 | §4 | -1 |
| web/components | app/web/src/components/providers/component-model-edit-modal.tsx | `empty()` | 改逻辑 | 删 `default: false`（第31行） | — | §4 | -1 |
| web/components | app/web/src/components/providers/component-model-edit-modal.tsx | modal body | 改逻辑 | 删「设为默认模型」radio ToggleRow（第85行）+ 移除 `draft.default` 引用 | MUST 保留 enabled check 行 | §4 | -1 |
| web/components | app/web/src/components/providers/component-model-list-card.tsx | list card | 改逻辑 | 删 default Badge（第39-40行） | — | §4 | -2 |
| web/i18n | app/web/src/i18n/locales/zh-CN/providers.json | model/modelList | 删 key | 删 `model.defaultTitle`/`model.defaultHint`/`modelList.defaultBadge` | 与 en 同步 | §8 | -3 |
| web/i18n | app/web/src/i18n/locales/en/providers.json | model/modelList | 删 key | 同上 | 与 zh 同步 | §8 | -3 |
| web/i18n·test | app/web/src/i18n/__tests__/providers-ns.test.ts | leaf 断言 | 改测试 | leaf 列表移除 `defaultTitle`/`defaultHint`/`defaultBadge`（第121/122/132行） | — | §8 | -3 |
| server·test | app/server/src/handlers/__tests__/resolve-provider-model-fallback.test.ts | fallback describe | 改测试 | 删 9 处 fixture `default:true`；v0.0.36 兜底 case 断言降级为「首个 enabled model」 | MUST 断言符合新兜底 | §6.A | ~-15 |
| server·test | app/server/src/handlers/__tests__/resolve-provider-model-cross-search.test.ts | cross-search | 改测试 | 删 fixture `default:true`（27/31）；case3/5 expect 降级为「首个 enabled」 | MUST 断言符合新兜底 | §6.A | ~-6 |
| server·test | (21 个 fixture 噪声文件，见 §6.B) | fixture literal | 删字段 | 各删 `default: true`（断言不引用，不受影响） | — | §6.B | -21 |
| spec/api | specs/api/overall/02-llm-chat.md | ModelInstance/ModelCreateBody | 删文档 | 删 `default?` 字段声明（第245、300行） | doc-modifier 阶段 5 | §7 | -2 |
| spec/tech | specs/tech/agent/providers_and_models/[P0]llm_model_interface.md | LlmModelConfig | 删文档 | 删 `default?` 声明+注释（第42行） | doc-modifier 阶段 5 | §7 | -1 |
| spec/ui | specs/ui/components/providers/component-model-edit-modal.md | ModelInstance/交互 | 删文档 | 删 `default?` 字段 + 交互「default(radio)」（21、34行） | doc-modifier 阶段 5 | §7 | -2 |
| spec/ui | specs/ui/components/providers/_overview.md | ModelInstance 字段表 | 删文档 | 删 `default?`（第30行）+ 相关状态描述 | doc-modifier 阶段 5 | §7 | -1 |

## 核心设计原则

1. **`default` 语义降级方案（session-provider-utils）**：删字段前，兜底选 model 优先级为「enabled default → 首个 enabled → 首个」；删后简化为「首个 enabled → 首个」。此函数 `@internal`（handler 不直调，统一走 `services/model-resolver.ts:resolveModel`；主路径 playground 走 `default_models.chat`、studio 走 squad 配置），降级安全。
2. **body 兼容忽略**：POST/PUT 若旧前端/存量请求仍带 `default` 字段，后端静默忽略（不写入、不报错），与 v0.0.53 删 `model.protocolId` 同范式。
3. **`LlmModelConfig.default` 确认为死字段**：`client.ts` 不读，透传链 end-to-nowhere，物理删除无需 caller 适配。
4. **测试分层**：21 个纯 fixture 文件删字段即可（断言不引用 `m.default`）；2 个 fallback 测试需改 expect 到新兜底语义。

## Task 切分建议（3 个 task）

- **T1 后端**：provider.ts + session-provider-utils.ts + llm-client-factory.ts + resolve-provider-config.ts + provider-types.ts + model-validation.ts + 2 个 fallback 测试改断言 + 21 个 fixture 删字段 + 相关 UT
- **T2 前端**：api-client.ts + provider-detail.tsx + model-edit-modal.tsx + model-list-card.tsx + i18n(zh/en) + providers-ns.test.ts + 相关 UT
- **T3 spec 同步**：doc-modifier 阶段 5 统一改 4 个 spec 文档（不单独切 task，走阶段 5）
