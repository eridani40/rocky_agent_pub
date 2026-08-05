# v0.0.154 change_plan — studio member-chat 模型 picker 格式对齐（纯 modelId）

> 架构期冻结的 method 级契约。planner 按本表切 task（`coversModules/coversFiles/coversMethods`）；coder 按本表实现；code-reviewer 按本表查偏离。coder 不改本文件；偏离写进 `change_log.md`。
>
> **范围纪律**：本版本只修 member-chat picker（用户症状）。squad-chat per-call override「黏住上次选择」是另一条链路（`bootstrap.ts:650` bodyOverride 硬编码 + `session-messages.ts:240` 持久化改写），**另案处理，不在本版本**。

## 0. 背景 / 根因（诊断已确认）

studio member-chat 模型 picker 选完无效：前端把 `member.model` 以 `providerId/modelId` 斜杠格式 PATCH 给后端，后端 `validateModelId` 只认**纯 modelId**（`m.modelId === modelId` 精确匹配）→ throw → handler 返 400 → 前端 `.catch(console.warn)` 静默吞错 → `member.model` 维持原值（空/inherit）→ resolver 回退链命中 `squad.modelDefault` → 永远用默认模型。

**根上的病 = spec 自相矛盾**：
- 后端权威 `[P0]model_resolve.md §4 原则 3`（line 112）：`ModelRef = 纯 modelId string——不含 providerId 拼接`。
- 前端 `specs/ui/components/chat-page/component-input-model-picker.md §11`（line 178-184）+ `specs/api/overall/11-squad.md §128`：`member.model` 写成 `providerId/modelId` 斜杠格式。
- 各端按各自 spec 实现，单测都过，集成挂掉。

## 1. 修复策略（与 orchestrator 锁定 — 三链路对比后确认）

**复用层无问题，修调用点序列化偏离。** 三链路对比（playground / squad-chat / member-chat）证实：**组件 `InputModelPicker` 三链路共用同一个**（onChange 只上抛结构化 `{providerId, modelId}`，从不序列化成字符串）；**后端三接口（PATCH member / PUT session / POST messages）共用同一个 `validateModelId`**（都精确匹配纯 modelId、都拒斜杠）。**组件 + 后端已最大限度复用**（用户复用标准达成）。唯一偏离是 member-chat 调用点 `component-member-chat-input-bar.tsx:88` 自己把结构化对象拍扁成 `"provider/model"` 斜杠串——另两个调用点（`page-chat.tsx:151` 结构化两字段、`section-squad-chat.tsx:164` 纯 modelId）都没这么干。

**修复 = member-chat 调用点序列化对齐另两个调用点（modelId 纯值）**，后端零改动，不破坏 `[P0]model_resolve.md §4 原则 3` 不变量、不动已绿后端测试。不走「后端兼容斜杠」备选（那会让 §4 原则 3 失守、污染 resolver/validator 两层、触发后端测试连锁重写，且违背已确立设计原则——三个持久化字段本就统一契约纯 modelId）。

**先例**：v0.0.113 已为 `squad.modelDefault` 做过同款读侧 bug 修复（`parseModelRef` → 纯 modelId 读取，见 `[P1]session_config_studio.md §70` 修正记录）。member.model 是漏网的同款，本版本照做。

**顺手清理**：
- 把 picker 内的 file-local `findProviderIdByModelId` 提升到 `providers.ts` export——member-chat 显示侧反查也复用它（消除第三份重复回找逻辑；`formatModelDisplay` 内 inline 回找保持不动避免扩大范围）。
- `.catch(console.warn)` 改 `.catch(setError)`——复用现有 error state 机制在输入栏下方红字提示（:207 已有渲染分支）。修复格式后正常路径不再 400，但 network/竞态 fail 仍需对用户可见（用户诉求「选完没效果」的双层语义：a. 选了不生效 b. 用户不知道为啥不生效）。

## 2. 核对结果（architect 落表前已 grep/读代码验证）

### 2.1 全局斜杠格式命中（整个 `app/web/src/`）

| 命中 | 性质 | 是否要改 |
|------|------|---------|
| `app/web/src/components/studio-page/component-member-chat-input-bar.tsx:88` `{ model: \`${sel.providerId}/${sel.modelId}\` }` | **PATCH body 写入（bug 根源）** | ✅ 改纯 modelId |
| `app/web/src/components/chat/ModelPicker.tsx:124` `key={\`${opt.providerId}/${opt.modelId}\`}` | React `key` 属性（非 PATCH body） | ❌ 不改 |
| `app/web/src/components/chat-page/component-input-model-picker.tsx:251` `key={\`${opt.providerId}-${opt.modelId}\`}` | React `key` 属性 | ❌ 不改 |

**squad 层**：`component-new-squad-modal.tsx:52` `modelDefault: modelSel!.modelId` 已是纯 modelId，无 bug。squad 层从未写斜杠格式。

**结论**：PATCH body 斜杠写入**全局唯一一处**——`component-member-chat-input-bar.tsx:88`。诊断 agent 范围确认正确，无遗漏。

### 2.2 已存在可复用的 `findProviderIdByModelId`

`app/web/src/components/chat-page/component-input-model-picker.tsx:287-296`——picker 内 file-local helper：

```ts
function findProviderIdByModelId(
  providers: { id: string; models: { modelId: string }[] }[],
  modelId: string,
): string | null {
  for (const p of providers) {
    if (p.models.some((m) => m.modelId === modelId)) return p.id;
  }
  return null;
}
```

picker 已用它反查 `squad.modelDefault`（纯 modelId）作为 effectiveDefault。member-chat 显示侧反查 `member.model` 同款需求——**提升 export 共用**。

### 2.3 显示侧也有 bug（同一根源）

`component-member-chat-input-bar.tsx:85` `memberModelSel = parseModelRef(member.model)`：
- 后端存的 `member.model` 是纯 modelId（修复后也是），`parseModelRef`（providers.ts:40-45）要求含 `/` → 恒返 null → picker 收到 `model=null` → hover 显「未配置」、列表项 selected 高亮永不命中。
- 修复必须**同时**改显示侧：去掉 parseModelRef，改用 `findProviderIdByModelId` 反查 → `{providerId, modelId}`。

### 2.4 后端零改动（确认）

| 后端符号 | 位置 | 立场 | 结论 |
|---------|------|------|------|
| `validateModelId(svc, modelId)` | `app/server/src/services/model-validation.ts:85-107` | 纯 modelId 精确匹配（`m.modelId === modelId`），reserved 白名单短路 | 正确，不改 |
| `patchMemberService` | `app/server/src/services/member-mutations.ts:139-189`（model 校验 :157-160） | 传 patch.model 给 validateModelId | 正确，不改 |
| `handlePatchMember` | `app/server/src/handlers/member.ts:208-259`（400 返 :256） | throw 走 `msg.startsWith('model ')` 返 400 | 正确，不改 |
| `resolveModel` fallback 链 | `app/server/src/services/model-resolver.ts:133-143,169-` | `member.model` / `squad.modelDefault` 均期望纯 modelId（§4 原则 3） | 正确，不改 |

**后端测试夹具**（`squad-member-service-model-validation.test.ts` / `model-resolver.test.ts`）全部用纯 modelId——佐证后端实现立场正确，以前端对齐后端为准。

## 3. 文件级变更清单

| 文件路径 | 操作 | 变更内容 |
|---------|------|---------|
| `app/web/src/lib/providers.ts` | 修改 | 新增 export `findProviderIdByModelId(providers, modelId)`（从 picker 提升） |
| `app/web/src/components/chat-page/component-input-model-picker.tsx` | 修改 | 删 file-local `findProviderIdByModelId`（:287-296），改 import from `../../lib/providers`；3 处调用点（:110/:142/:147 之前的 inline）签名不变 |
| `app/web/src/components/studio-page/component-member-chat-input-bar.tsx` | 修改 | `handleModelChange` PATCH body 改纯 modelId（去 `providerId/` 前缀）；`memberModelSel` 从 `parseModelRef` 改用 `findProviderIdByModelId` 反查；`:89`/`:96` 两个 `.catch(console.warn)` 改 `.catch(setError)` 复用现有 error state |
| `app/web/src/components/studio-page/__tests__/component-member-chat-input-bar.test.tsx` | 修改 | ⑦b 断言从 `{ model: '01J7PROVIDER1/mock-model-a' }` 改 `{ model: 'mock-model-a' }`（纯 modelId）；新增「PATCH 失败 → error UI 可见」用例 |
| **后端** | **无改动** | `model-validation.ts` / `member-mutations.ts` / `handlers/member.ts` / `model-resolver.ts` 全部正确，不动 |

## 4. spec 对齐清单（doc-modifier 阶段 5 执行；本表为依据）

| spec 文件 | 位置 | 现错描述 | 改为 |
|----------|------|---------|------|
| `specs/ui/components/chat-page/component-input-model-picker.md` | §11 字段格式表（line 178-184）+ §0 header changelog | 表格写 `member.model` 格式 = `providerId/modelId`，`parseModelRef` 解析 | 改为 `member.model` = **纯 modelId**（与 `squad.modelDefault` 同款），picker 侧用 `findProviderIdByModelId` 反查；去 `parseModelRef(member.model)` 误导写法 |
| `specs/api/overall/11-squad.md` | §4.5 line 128 | `PATCH /squad/:id/member/:mid body {model: 'providerId/modelId'}` | 改为 `{model: '纯 modelId'}`；inherit 清空 `{model: ''}` 不变 |
| `specs/tech/agent/providers_and_models/[P0]model_resolve.md` | §4 原则 3（line 112） | 已正确（ModelRef=纯 modelId），但未约定**前端写入侧** picker 格式 | 补一句：picker 写入 PATCH body 也用纯 modelId（picker 内部反查 provider 仅用于显示，不持久化）；§7 `session.modelId` 保留字表保持不动 |

> 三份 spec 以 `[P0]model_resolve.md §4 原则 3` 为权威对齐基准。

## 5. method 级 change_plan（8 列 — 行=函数/符号）

| 所属模块 | 文件路径 | 函数/符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|---------|---------|----------|------|---------|------|------|--------|
| web/providers | app/web/src/lib/providers.ts | findProviderIdByModelId() | 新增（提升） | 从 `component-input-model-picker.tsx:287-296` 提升；签名 `(providers: ProviderItem[], modelId: string) => string \| null`；body 同款（跨 providers 反查 modelId 命中 → 返 provider.id） | MUST 与 picker 内 file-local 原实现行为一致（不引入新语义）；MUST NOT 读 providerId 入参（纯 modelId 反查是唯一职责）；export 出去供 picker + member-chat 复用 | picker `component-input-model-picker.tsx:287-296`；`formatModelDisplay` providers.ts:141-142 同款 inline 回找（保持不动） | +12 |
| web/chat-page/picker | app/web/src/components/chat-page/component-input-model-picker.tsx | findProviderIdByModelId（file-local） | 删除 | 删 file-local :287-296；改 import from `../../lib/providers`；3 处调用点（:110/:142/:147 附近 inline 表达式）签名不变 | MUST 保持调用点行为不变（只换来源：file-local → import）；MUST NOT 改 `ModelSelection` 类型或 `useProviders` 用法 | providers.ts 新 export（本表上一行） | -10/+1 |
| web/studio/member-chat | app/web/src/components/studio-page/component-member-chat-input-bar.tsx | handleModelChange() | 修改 | :88 PATCH body 从 `{ model: \`${sel.providerId}/${sel.modelId}\` }` 改 `{ model: sel.modelId }`（纯 modelId，去 providerId 前缀）；对齐后端 `validateModelId` 纯 modelId 契约 | MUST 写纯 modelId（后端 `validateModelId` `m.modelId === modelId` 精确匹配，斜杠永远不命中）；MUST NOT 在 body 拼任何前缀/分隔符；保留字 `default` 经 handleInherit 走 `model:''` 分支不进本函数 | `[P0]model_resolve.md §4 原则 3`（line 112）；`model-validation.ts:85-107`；`member-mutations.ts:157-160` | +1/-1 |
| web/studio/member-chat | app/web/src/components/studio-page/component-member-chat-input-bar.tsx | memberModelSel（派生） | 修改 | :85 从 `parseModelRef(member.model)` 改用 `findProviderIdByModelId(providers, member.model)` 反查 → 命中返 `{providerId, modelId}`，不命中/null 返 null；需 `useProviders()` 拉列表 | MUST 复用 export 的 `findProviderIdByModelId`；MUST NOT 继续用 `parseModelRef`（纯 modelId 无 `/` 恒 null）；保留字（`''`/`default`/`none`）→ null（picker 收 null 显「未配置」/走 defaultModelId 态） | `parseModelRef` providers.ts:40-45（弃用于本文件）；§10 member-chat 反查同款（picker 内 defaultModelId 路径已验证）；`component-input-model-picker.md §10` | +5/-1 |
| web/studio/member-chat | app/web/src/components/studio-page/component-member-chat-input-bar.tsx | handleModelChange / handleInherit 的 .catch | 修改 | :89 + :96 两处 `.catch((e) => console.warn('patchMember ... failed:', e))` 改 `.catch((e) => setError(e instanceof Error ? e.message : String(e)))`；复用现有 error state（:79）+ 红字渲染（:207） | MUST 复用现有 `error` useState（:79 已存在）+ 渲染分支（:207 已存在）；MUST NOT 引入 toast / 新错误态机制（最小完整修复，不扩架构）；setError 语义与 handleSend :123 一致 | 现有 error state :79/:207；handleSend :123 同款 catch→setError | +2/-2 |
| web/studio/member-chat/test | app/web/src/components/studio-page/__tests__/component-member-chat-input-bar.test.tsx | ⑦b 用例断言 | 修改 | :219 标题 + :227 断言：`{ model: '01J7PROVIDER1/mock-model-a' }` → `{ model: 'mock-model-a' }`（纯 modelId）；夹具 member.model 期望值同步改纯 modelId | MUST 断言 PATCH body 收到纯 modelId（不是斜杠）；MUST NOT 改 mock providers 结构（provider/model 列表不变，只是 body.model 字段格式变了） | 现有用例 :219-227；修复后 :88 行为 | +2/-2 |
| web/studio/member-chat/test | app/web/src/components/studio-page/__tests__/component-member-chat-input-bar.test.tsx | ⑦d 用例（新增） | 新增 | 新增「PATCH 失败 → 输入栏红字可见」用例：mock patchMember reject → 断言 error UI 文本出现（testid 或文本匹配） | MUST 覆盖 `.catch(setError)` 新路径（防回退到 console.warn）；MUST NOT mock fetch 层（走 squad-api.patchMember 真实调用链） | 现有 error state 渲染 :207 | +18 |
| spec/ui | specs/ui/components/chat-page/component-input-model-picker.md | §11 字段格式表 + §0 header changelog | 修改 | 表格中 `member.model` 格式：`providerId/modelId` → **纯 modelId**；picker 侧解析：`parseModelRef` → `findProviderIdByModelId`；header 加 v0.0.154 changelog 一行 | MUST 与 `[P0]model_resolve.md §4 原则 3` 一致；MUST NOT 留任何 `member.model` 斜杠格式描述（前后端字段格式唯一）；保留 `squad.modelDefault` 纯 modelId 行不变 | `[P0]model_resolve.md §4 原则 3`（line 112）；§11 表（line 178-184） | +6/-4 |
| spec/api | specs/api/overall/11-squad.md | §4.5 provider/model 解析段（line 128） | 修改 | `PATCH /squad/:id/member/:mid body {model: 'providerId/modelId'}` → `{model: '纯 modelId'}`；inherit `{model: ''}` 不变；补一句「picker 内部反查 provider 仅用于显示，不持久化」 | MUST 与 ui spec + tech spec 三处对齐；MUST NOT 改 inherit 清空语义（`model:''` 仍走回退链）；保留 `POST /session/:id/messages` providerId/modelId override 描述（那是另一条链路，不在本版本） | ui spec §11；`[P0]model_resolve.md §4 原则 3` | +2/-1 |
| spec/tech | specs/tech/agent/providers_and_models/[P0]model_resolve.md | §4 原则 3（line 112） | 修改（补充） | 原则 3 已正确（ModelRef=纯 modelId）；补一句子句：「前端 picker 写入 PATCH body 也用纯 modelId——picker 内部反查 provider 仅用于显示名渲染，不进持久化字段」 | MUST NOT 改原原则 3 语义（ModelRef=纯 modelId 不变量不动）；仅补前端写入侧约定 | `[P0]model_resolve.md §4`；§7 session.modelId 保留字表不动 | +1 |

## 6. 任务拆分建议（给 orchestrator）

- **Task 1（前端修复 + UT 更新 / 1 个 coder）**：providers.ts 新 export + picker 去 file-local 改 import + member-chat-input-bar 三处改（PATCH body / memberModelSel 反查 / catch setError）+ UT 更新（⑦b 断言改）+ 新增 ⑦d（catch 路径覆盖）。文件 4 个、行数 ~40 行改动。
- **Task 2（spec 对齐 / doc-modifier 阶段做）**：改 ui §11 + api §128 + tech §4 原则 3 三处 spec（文本对齐，不改代码）。

**测试范围**：
- **UT**（必跑）：`component-member-chat-input-bar.test.tsx`（⑦b 断言 + ⑦d 新增）+ `component-input-model-picker.test.tsx`（确保 picker 改 import 后不回归）+ 后端 `squad-member-service-model-validation.test.ts` / `model-resolver.test.ts`（确认零改动下仍全绿）。
- **AT**：不新增（CLAUDE.md「普通 feature 不新增 AT」铁律 + 这是确定性 HTTP 契约，UT 覆盖足够）。版本验证走现有冒烟集回归即可。
- **ET**：不新增（纯字段格式修复，UI 行为不变——picker 显示效果与 §10 v0.0.113 已修的 squad-chat 同款）。

## 7. 不变量（reviewer 查偏离清单）

1. `[P0]model_resolve.md §4 原则 3` ModelRef=纯 modelId 不变量不动（后端零改动）。
2. `member.model` 持久化字段格式唯一：**纯 modelId**（无斜杠、无 `providerId:` 前缀、无保留字以外的特殊形态）。
3. `squad.modelDefault` 纯 modelId 格式不动（本来就对）。
4. picker `defaultModelId` / `defaultModel` / `model` 三 prop 语义不变（ModelSelection | null）。
5. `handleInherit` 清 `model:''` 语义不变（inherit 走 resolver fallback 链）。
6. 不引入 toast / 新错误态机制（复用现有 `error` useState + :207 渲染）。
7. 不改后端 `validateModelId` / `patchMemberService` / `handlePatchMember` / `resolveModel`（实现立场正确）。
