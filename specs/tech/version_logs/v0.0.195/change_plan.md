# v0.0.195 变更计划书 — 模型选择器统一过滤停用 provider（前端数据层 + 默认项反查）

> **method 级 review 合同**。架构期冻结：coder 按本表实现，code-reviewer 按本表查偏离。coder 不改本文件；事后偏差写进 `change_log.md`。

## 范围（用户拍板）

- **只修前端 + 同步 spec**。后端 resolve 链不动（`findProviderForModel` 走 `listEnabledProviders` 已过滤 disabled provider，default 不可用 → throw `MODEL_NOT_CONFIGURED` 是正确行为）。
- 错误体保持现状（不加 reason 增强）。
- bug 根因（context.md 已定位）：`lib/providers.ts` 的 `ProviderItem` 接口无 `enabled` 字段 → `useProviders()` 数据链路从一开始丢过滤信息 → `ModelPicker` / `InputModelPicker`（含 academy coach session）的 `flatMap` 无法过滤 + `findProviderIdByModelId` 默认项反查不判 enabled。样板 = `component-key-model-picker.tsx`（走 `listProviders` + 双层 `if(!p.enabled) continue`，已正确）。

## 列定义（8 列，行 = 一个函数/符号）

| 列 | 说明 |
|----|------|
| 所属模块 | 子系统名 |
| 文件路径 | 完整相对路径 |
| 函数/符号 | 函数名/符号名（新增 interface/字段各占一行） |
| 类型 | 新增 / 修改 / 删除 |
| 变更内容 | 具体做什么 |
| 约束 | MUST / MUST NOT |
| 参考 | spec 位置 / 原则编号 |
| 预计影响行 | +N / -M |

## 变更清单

### 前端数据层：providers.ts 扩 enabled 透传 + 默认项反查判 enabled

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| web_data | app/web/src/lib/providers.ts | ProviderItem (interface, L21-25) | 修改 | 接口扩两个字段：顶层加 `enabled?: boolean`；`models[]` 项加 `enabled?: boolean`。后端 `GET /provider` JSON 本就带这两字段（api-client.ts ProviderInstance/ModelInstance 已 typed），此处只是把窄化的类型补齐 → `fetchProviders`/`useProviders` 天然透传，无需改函数体 | MUST 用可选（`?:`）—— 运行时缺字段视为 enabled（与后端 `enabled !== false` 语义一致，后端默认 true）；MUST NOT 改 `fetchProviders`/`useProviders` 函数体（类型补齐后自动透传）；MUST NOT 给字段加运行时默认化（保持透传，不加 `?? true`） | api-client.ts L31 ProviderInstance.enabled / L44 ModelInstance.enabled；样板 component-key-model-picker.tsx L52-54 `if(!p.enabled) continue` 范式 | +2 |
| web_data | app/web/src/lib/providers.ts | findProviderIdByModelId (L60-68) | 修改 | 反查默认项时跳过 disabled provider：循环内补 `if (p.enabled === false) continue;`（在 `p.models.some(...)` 判定前）。防止「默认项」显示停用 provider 的模型（发消息却 400）。参数类型签名同步收窄为 `{ id: string; enabled?: boolean; models: { modelId: string }[] }[]` | MUST 仅加 `enabled === false` 跳过（严格 false，undefined/true 都通过——对齐后端 `enabled !== false` 语义）；MUST NOT 改函数签名返回类型（仍是 `string \| null`）；MUST NOT 判 model 层 enabled（此函数职责=反查 provider，model 层过滤在 picker flatMap 做） | specs/tech/agent/providers_and_models/[P0]model_resolve.md §3.3（findProviderForModel 走 listEnabledProviders 已过滤 disabled）；样板 KeyModelPicker 双层过滤范式 | +2/-1 |

### 前端 picker：flatMap 双层过滤 disabled provider/model

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| ui_chat | app/web/src/components/chat/ModelPicker.tsx | items flatMap (L73-81) | 修改 | `providers.flatMap(p => p.models.map(...))` 前置过滤：改为 `providers.filter(p => p.enabled !== false).flatMap(p => ...)`（或在 flatMap 回调里 early return）；同时模型层加 `m.enabled !== false` 过滤（disabled model 不进选项）。对齐样板 KeyModelPicker L51-54 `if(!p.enabled) continue; if(!m.enabled) continue;` | MUST 双层过滤（provider 层 + model 层，缺一不可——只过滤 provider 层会让 disabled model 仍可选）；MUST 用 `!== false`（undefined 视为 enabled，对齐后端语义）；MUST NOT 改 formatModelDisplay 调用（显示语义不变）；MUST NOT 动 inheritLabel/extraTopItems（「继承」占位项不是模型项，不过滤） | 样板 component-key-model-picker.tsx L51-64；specs/ui/overall/02-llm-chat.md §3.3 | +2 |
| ui_chat_input | app/web/src/components/chat-page/component-input-model-picker.tsx | items flatMap (L176-184) | 修改 | 同上：`providers.filter(p => p.enabled !== false).flatMap(...)` + 模型层 `m.enabled !== false` 过滤。academy coach session 用的就是本组件，修本处 = 修 academy | MUST 双层过滤；MUST 用 `!== false`；MUST NOT 改 handleSelect/preview 逻辑；MUST NOT 改默认项 4 源优先级框架（仅下面 defaultModelProviderId 反查一行配套过滤） | 样板 component-key-model-picker.tsx L51-64；specs/ui/components/chat-page/component-input-model-picker.md §7 | +2 |
| ui_chat_input | app/web/src/components/chat-page/component-input-model-picker.tsx | effectiveDefault defaultModelProviderId 反查 (L137) | 修改 | 默认项 4 源优先级第一源：`providers.find((it) => it.id === defaultModelProviderId)` 补 enabled 判定 → `providers.find((it) => it.id === defaultModelProviderId && it.enabled !== false)`。让「默认项指向停用 provider」时第一源失败 → 落到 `findProviderIdByModelId`（本版已改，也跳过 disabled）→ 全 fail 则 `effectiveDefault = null`（trigger 显「未配置」而非显示停用 provider 的模型） | MUST 只加 `&& it.enabled !== false`（不改 4 源框架结构）；MUST NOT 改 L149 的 `defaultModel`（外部传入明确 ModelSelection）路径——caller 显式给的，前端不二次过滤；MUST NOT 改 `internalDefault` 路径 | specs/ui/components/chat-page/component-input-model-picker.md §7 默认项 4 源优先级 | +1/-1 |

### UT：随编码覆盖纯函数 + 透传

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---|---|---|---|---|---|---|---|
| web_test | app/web/src/lib/providers.test.ts | (test suite) | 新增 | 覆盖：① `findProviderIdByModelId` 判 enabled——disabled provider 的 model 不命中（返 null 或命中 enabled provider）；② `fetchProviders` 透传 enabled——通过 `__setProvidersCacheForTest` 注入带 enabled 的桩，验证返回项 enabled 字段可达；③ `ModelPicker`/`InputModelPicker` flatMap 过滤——disabled provider/model 不进 items（用 `__setProvidersCacheForTest` 桩 + render 组件 assert menu items，若项目有组件测试惯例；否则用纯函数等价抽取验证，coder 定位） | MUST 用 vitest（`bun run test`）；MUST mock 走 `__setProvidersCacheForTest`（已提供的测试 seam，L110）—— 禁硬编码绝对路径 mock（memory `test-vitest-mock-absolute-path`）；MUST 每用例后 `__resetProvidersCacheForTest()` 清污染；MUST 至少覆盖 findProviderIdByModelId 判 enabled + fetchProviders 透传两 case；组件层过滤 case 为加分项（coder 视项目惯例决定） | providers.ts L110/L115 测试 seam；memory test-vitest-mock-absolute-path / vitest-must-run-under-bun | +45 |

### spec 同步项（doc-modifier 阶段 5 处理，不属 coding task，此处仅登记）

> coder 不改这些 spec；doc-modifier 阶段 5 按「代码已对齐」修 spec 滞后/漂移。

| spec 文件 | 章节 | 现状 → 目标 |
|---|---|---|
| specs/tech/agent/providers_and_models/[P0]model_resolve.md | §3.3 | 文字「hint 非空精确匹配该 provider」暗示不过滤 enabled → 对齐代码（findProviderForModel 走 `listEnabledProviders` 已过滤 disabled provider，hint 精确匹配是在 enabled 集合里做） |
| specs/ui/components/chat-page/component-input-model-picker.md | §7 | 已写「enabled provider × enabled model」但代码原本未实现 → 本版补齐实现，spec 同步为「已实现」（去漂移注记） |
| specs/ui/components/common/component-key-model-picker.md | §菜单数据来源 | 核对现状描述与代码一致（应已对齐样板，doc-modifier 确认即可，预计无改动） |

## 影响面评估

- **跨模块**：纯前端 + UT + spec 同步。后端 resolve 链不动（已正确）。文件集：`lib/providers.ts`（数据层）→ `chat/ModelPicker.tsx` + `chat-page/component-input-model-picker.tsx`（picker 消费方）+ `lib/providers.test.ts`（UT）。无跨文件类型连锁（ProviderItem 扩可选字段，旧消费方不读 enabled 不受影响）。
- **无破坏性变更**：`ProviderItem` 加可选字段（`?:`）—— 旧读 `id/label/models` 的代码不受影响；`findProviderIdByModelId` 只新增「跳过 disabled provider」分支，原命中逻辑不变；picker flatMap 只前置 filter，已选 value 回显路径（formatModelDisplay）不动。
- **依赖顺序**：ProviderItem 扩字段 → findProviderIdByModelId 判 enabled → 两处 picker flatMap 过滤 + InputModelPicker L137 默认项反查过滤 → UT。类型层一处改，下游 picker 自动获得 enabled 字段。
- **风险点**：
  1. **过滤语义一致性**：所有过滤点统一用 `!== false`（undefined 视为 enabled）——与后端 `enabled !== false` + 样板 KeyModelPicker `if(!p.enabled) continue` 语义一致（`!undefined === true` 也跳过，但后端实际总下发布尔值，边界等价）。coder 须保证 4 处过滤点（ProviderItem 透传后下游 3 处 picker/find）语义统一。
  2. **默认项显示「未配置」而非空选**：InputModelPicker L137 改后，default 指向 disabled provider → effectiveDefault=null → trigger 显「未配置」。这是期望行为（对齐后端「default 不可用 = 无 default」），非回归。
  3. **组件层 UT 可选**：项目 web 组件测试惯例 coder 定位（是否已有 .tsx 组件测试先例）。若无惯例，UT 聚焦纯函数（findProviderIdByModelId）+ fetchProviders 透传即可，组件层过滤靠样板对齐 + code review 保证（过滤范式与 KeyModelPicker 一致，低风险）。
- **打包护栏**：纯前端 lib/组件改动，无 plugin/backend/runtime-config/路径变更，无需 packaged 专项验证。

## 反馈回路

- 实现/codereview 严重违反本表（改表外文件、动未声明符号、破约束列、影响行严重偏离）→ 退 coder
- 同一 task 退回 2 次仍违反 → 升级退 architect 重新设计
- coder 发现 spec（model_resolve §3.3 / input-model-picker §7）与代码实际不符 → 按代码实际调整 + 向 orchestrator 汇报偏离 → doc-modifier 阶段 5 统一修 spec
