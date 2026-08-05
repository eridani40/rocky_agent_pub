# v0.0.36 Tech Change Log — squad 模型选择器 + 实时读取 + 防呆校验

> version: 1.0 · 2026-06-30
> 范围红线：squad 创建/hire 的 modelDefault/model 字段从自由填名改为 ModelPicker 选择器；前端 provider/model 列表实时化；后端写入校验 + 运行时兜底双保险。POST/PATCH /squad 语义增强（非新端点）、无新 UI 页面。
> **补充（2026-06-30）**：编辑界面（`component-manage-tab` squad + `section-member-panel` member）同样换 ModelPicker；member 加 **inherit 语义**（`member.model=""` 空串 = 继承，运行时动态解析 `squad.modelDefault`；从旧「copy」改为动态继承）。详见 `reqs/v0.0.36/req.md` §编辑界面模型选择器。
> 权威输入：`reqs/v0.0.36/req.md` + `states/v0.0.36/task.json` + `states/v0.0.36/task-board.md`。
> 简化流程（特例）：coding → code-review（inline，账户 quota 限 subagent）→ doc-modifier（本文件，inline）。AT/ET 用户自测（用户明确豁免）。

---

## 1. 改动摘要

squad 创建/激活链路的 model 配置治理（4 项）：

1. **UI 换选择器（T2）**：`new-squad-modal` modelDefault + `hire-modal`（Fresh/derive）model 从自由填名 input → `ModelPicker`（复用 `chat/ModelPicker`，加可选 `testid` prop 保各页 testid 契约；chat 页默认 `chat-model-picker` 零影响）。**删硬编码非法默认值 `'claude-sonnet'`**，改 `modelSel: ModelSelection | null`（未选=继承）。
2. **provider/model 列表实时化（T1）**：`lib/providers.ts` 去 module 级永久缓存 `cachedProviders`，`fetchProviders` 每次实时 `GET /provider`；保留 `inFlight` 同瞬间并发去重（settle 后清空，**不跨时间缓存**）。
3. **写入校验 fail-fast（T3-A）**：新增 `services/model-validation.ts` 的 `validateModelId` 单一权威，被 squad/member handler（POST/PATCH/hire）+ service 双层复用 → 非法 modelId 返 400。
4. **运行时兜底救活存量（T3-B）**：`resolveProviderModel`（`session-messages.ts`）`effectiveModelId` 精确匹配失败时，兜底到 enabled default → 首个 enabled → 首个 model；仅 provider 完全无 model 才抛。救活 v0.0.36 前已落库的非法 modelDefault squad。

## 2. 根因

- UI 自由填名 + 默认值非法 `'claude-sonnet'` → 存库后 studio 激活 `resolveProviderModel` 精确匹配 modelId 失败 → `ModelNotFoundError` → 群聊/leader/mate 激活全崩。
- `lib/providers.ts` 模块级永久缓存：开机首拉后永不刷新，配置中心新增 model 选择器里看不到（除非整页刷新）——违背用户「实时读取」要求。

## 3. 设计决策

- **校验 + 兜底双保险**：写入校验挡新增非法值（fail-fast 400），运行时兜底救活存量（不崩）。`appConfig` 可选注入（router prod 始终注入），省略时退化既有非空校验，保旧测试零回归。
- **`validateModelId` 单一权威**：自包含结构子集类型（`ValidationProvider/Model`）读 providers 组，不反向依赖 handler（避免 service→handler 架构反转）。判定口径：`provider.enabled !== false` 且 `model.enabled !== false`（默认启用，显式 false 才排除）。
- **`ModelPicker` 复用 + testid 参数化**：加可选 `testid` prop（默认 `chat-model-picker`，list = `${testid}-list`），studio 弹层传语义化 testid（`new-squad-model` / `hire-fresh-model` / `hire-derive-model`）保 E2E 契约。
- **实时化保留并发去重**：去永久缓存但保留 `inFlight`（同瞬间多组件挂载合并为一次请求，settle 后 `finally` 清空）。

## 4. 影响的 specs

- `specs/api/overall/11a-squad-endpoints.md` §1.1/§1.4：POST/PATCH /squad `modelDefault` 校验语义（required → 必须是某 enabled provider 的合法 enabled modelId，否则 400）。
- `specs/ui/overall/06-studio.md` §6/§7：model 字段 = ModelRef 选择器（**spec 本已如此描述**，本版代码对齐；T2 实现了 spec 既有契约）。
- `specs/tech/squad/[P1]data_model.md`：`modelDefault`/`member.model` 写入校验 + `resolveProviderModel` 运行时兜底语义；model 字段形态明确为**直接 modelId**（非 ModelRef id，§6.2「待定」收敛）。

## 5. 测试

- **全量 UT：3485 passed | 4 skipped（zero fail）**，309 test files；`bun run typecheck` EXIT 0。
- T1 前端实时化：15 + ModelPicker 组件级 + 引用方 180 回归绿。
- T2 UI：new-squad 4 + hire 3 + page-studio 5 + studio-page 62 全绿。
- T3 后端：model-validation 6 + service 7 + fallback 6 + handler 9 + cross-search 6；非回归 squad/member handler+service 41+60。
- **code-review PASSED**（inline）：文件全 ≤300（squad.ts 恰 300；router.ts 498 为既有超长，本版仅 +2 appConfig 注入）；`validateModelId` 4 处复用无冗余；兜底链正确。Minor：test `act(...)` cosmetic warning（非阻塞）。
- **AT/ET：用户特例自测豁免**（用户明确「无需 at et，这是特例」）。

## 6. 交付文件

- 新增：`app/server/src/services/model-validation.ts`（79 行）+ 4 个后端测试文件；`app/web/src/lib/__tests__/providers.test.ts` + `app/web/src/components/chat/__tests__/model-picker-realtime.test.tsx`。
- 修改：`app/web/src/lib/providers.ts`（实时化）、`app/web/src/components/chat/ModelPicker.tsx`（+testid）、`component-new-squad-modal.tsx`、`component-hire-modal.tsx`；`app/server/src/handlers/{squad,member,session-messages}.ts`、`services/{squad,member}-service.ts`、`router.ts`（+2）。
