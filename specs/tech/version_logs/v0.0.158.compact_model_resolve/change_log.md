# v0.0.158.compact_model_resolve — 变更日志

> 版本主题：删「独立 summary 模型」层——所有 session 场景（chat / 手动 compact / 自动 compact / T1 记忆整理）统一走 **`agentManager.resolveConfigBySid(sid)` 唯一入口**（chat/compact 同链），无 `task` 参数、无 body override、无 summary 独立子链。
>
> 详细变更契约见同目录 `change_plan.md`（method 级）；本 log 记录 change_plan 未覆盖的实际连带处理 + 已同步 spec 偏离 + spec-code 一致性验证结论。

## 1. change_plan 未覆盖的连带处理（doc-modifier 补记）

### 1.1 Task-2 附带处理（squad 字段整删）

- **`app/web/src/components/studio-page/__tests__/component-manage-tab-summary-model.test.tsx` mv 到 `soft_deleted/v0.0.158-squad-summary/`**（4 case，全测已删的 summary picker 契约）
  - **归属**：change_plan §L Task-4（前端）自然连带；§L 仅列 `section-squad-chat.test.tsx` 的 [P5] 两 case。
  - **原因**：随 summary 字段整删，本文件所有 case 用例无意义。与 Task-2 处理 `handlers/__tests__/squad-summary-model.test.ts`（§G Task-2 已 mv 到同目录）完全同款惯例。
  - **coder 归属**：coder-t4 处理（20:52 findings）；未偏离核心约束。

- **`app/server/src/handlers/__tests__/squad-summary-model.test.ts` mv 到 `soft_deleted/v0.0.158-squad-summary/`**
  - **归属**：change_plan §G Task-2；已在 change_plan 覆盖（`ProviderModelOverride` interface 整删 + schema 删字段）；此项为 coder-t2 20:35 findings 记录。

### 1.2 Task-4 §F CompactForkedRunner type 实际定义位置

- **`change_plan §F` 描述**：`CompactForkedRunner` type 定义在 `app/server/src/agent/context-compact-runner.ts`。
- **实际代码**：type 定义在 **`app/server/src/agent/context-engine.ts`**（`ForkedRunRunner` type 就是 change_plan §F 说的 `CompactForkedRunner` type 的实际定义位置）。
- **归属**：spec ↔ code 命名漂移（无功能影响）；coder-t4 按代码实际实现，无 change_plan 偏离；doc-modifier 记入本 log 作为「架构 spec 引用符号漂移」备忘。**未修 change_plan**（架构期冻结契约）。

### 1.3 session-debug.ts 漏识别的 caller

- **`app/server/src/session-debug.ts`**：作为 `buildSessionConfigFromDeps` 的 caller，其调用签名同步适配签名瘦身（删 undefined bodyOverride + 末位 task 参数）。
- **归属**：change_plan §B 未列此文件为 caller；coder-t1 实现时发现 + 同步适配。属 spec 落后（B 段列了「session-messages / session-compact / bootstrap 三处 caller 都改为不传 bodyOverride」漏了 session-debug）。**已由 coder-t1 按新签名适配**（无功能影响，session-debug 只在 dev 场景手动调）。

### 1.4 session-workspace-manager-f2.test.ts flaky 加固

- **`app/server/src/agent/__tests__/session-workspace-manager-f2.test.ts` 加 vitest `retry:2`**
  - **背景**：chokidar 全量并发下偶发 flaky（单跑 6/6 通过，全量并发下偶发 fail），与本版本改动零因果——属基线 flaky 债（memory `chokidar-watcher-await-ready-addDir` 类型）。
  - **归属**：coder-t4 code review 中 reviewer 观察到此单 fail 影响 review 判定（1 failed 与 Task-4 无因果）；为收敛 UT 全绿加固加 `retry:2`。
  - **技术权威**：`specs/tech/agent/session/[P0]session_workspace_manager.md`（懒监听重构）。
  - **性质**：非本版本引入的 bug；仅测试稳定性加固，不改产品逻辑。

## 2. 已同步的 spec 偏离（本 doc-modifier 阶段修完）

change_plan 顶部「已知 spec 偏离」5 条：

| # | spec 文件 | 修法 | 状态 |
|---|---|---|---|
| 1 | `specs/tech/agent/context/[P0]context_compact_detail.md §2b.1 / §6.4` | §2b.1 加 v0.0.158 段：handler 走唯一入口 `resolveConfigBySid`，删 `task='summary'` + `summaryModelDefault*` fallback；§6.4 caller 契约加行：runner input 删 `config` 字段，bootstrap 闭包内自 resolve | ✅ 已修 |
| 2 | `specs/tech/agent/providers_and_models/[P0]model_resolve.md` | 全文重构：§2 ResolveModelInput 删 task/bodyOverride*/summary*；§3 fallback 4→2 行（chat 单链）；§3.1 resolveDefaultModel 去 task；§4 原则 6 重写（chat/compact 同链）；§5 加 bootstrap 闭包一行 + §5.1 调用图加自动/T1 分支；§6 错误体 detail 删 task；§8 边界表更新 | ✅ 已修 |
| 3 | `specs/api/overall/04-agent-session.md §3.2` POST /messages | body providerId/modelId 标为「v0.0.158 已废弃」+ 兼容层说明（静默忽略不 400，不落 session）；§7 POST /compact 步骤 2 加 v0.0.158 唯一入口收敛；§9 错误码表 detail.task 已删说明；顶部版本行加 v0.0.158 修订段 | ✅ 已修 |
| 4 | `specs/api/overall/11a-squad-endpoints.md §1` Squad 字段表 | §1.1 CreateSquadBody 删 summaryModelDefault + 补建队事务 leader session modelId 缺省行为；§1.3 SquadDetail 删 summaryModelDefault 字段；§1.4 PatchSquadBody 删 summaryModelDefault；§5 版本段加 1.6 记条；顶部版本行加 v0.0.158 修订段 | ✅ 已修 |
| 5 | UI spec `component-manage-tab.md` / `section-default-models-and-request.md` | `component-manage-tab.md` **不存在**（该组件无 md spec 文件；跳过）；`section-default-models-and-request.md` 已重写（Props/testid/契约收窄 chat 单字段 + summary 项标为 v0.0.158 已删）；`common/component-key-model-picker.md` `testIdSuffix` 注释加 v0.0.158 说明 | ✅ 已修（4/4 存在的 md 已修，1/5 不存在的跳过并记录） |

## 3. 各 KB `log.md` 追加（本 doc-modifier 阶段做）

- `specs/tech/agent/context/log.md` — 追加 v0.0.158.compact_model_resolve 条（§2b.1 / §6.4 修复要点）
- `specs/tech/agent/providers_and_models/log.md` — 追加 v0.0.158.compact_model_resolve 条（§2/§3/§4/§5/§8 全文重构要点）
- `specs/tech/agent/session/log.md` — 追加 v0.0.158.compact_model_resolve 条（session-messages / session-compact / bootstrap 收敛要点）
- `specs/tech/migration/log.md` — 追加 v0.0.158.compact_model_resolve 条（clean-default-models-summary + clean-squad-summary-model-default 两 handler 新增要点）
- `specs/tech/squad/log.md` — 追加 v0.0.158.compact_model_resolve 条（squad schema 删 summaryModelDefault* 字段族）
- **KB index.md 更新**：
  - `specs/tech/agent/providers_and_models/index.md ①` model resolve 行措辞更新 + ⑤ 导航 `[P0]model_resolve.md` 描述更新
  - `specs/tech/agent/context/index.md ①` compact 概念行加 v0.0.158 唯一入口说明

## 4. 代码-spec 一致性验证结论（MANDATORY — 用户明确纪律）

按 orchestrator 委派要求逐项验证「代码实现 == spec 契约」：

| 契约点 | 验证方法 | 结论 |
|---|---|---|
| `resolveConfigBySid` 唯一入口在三处 forkedRunner+consolidationRunner 闭包内被调 | grep `resolveConfigBySid` `app/server/src/bootstrap.ts` + `app/server/src/handlers/session-compact.ts` | ✅ 命中 3 处闭包内首行调用（`session-compact.ts:83` + `bootstrap.ts:753` setForkedRunner + `bootstrap.ts:793` setConsolidationRunner），与 spec 一致 |
| studio compact 真的走 `squad.modelDefault`（不再读 `squad.summaryModelDefault`） | grep `summaryModelDefault` `app/server/src/` 非测试 | ✅ 仅存 migration handler `clean-squad-summary-model-default.ts` 引用（存量清理正向）+ header 注释历史标记；无功能代码读取路径 |
| playground compact 真的走 `session > app_config.default_models.chat`（不再读 `default_models.summary`） | grep `default_models.summary` / `readPlaygroundDefault` | ✅ `services/model-resolver.ts::readPlaygroundDefault` 内部固定读 `default_models.chat`（无 task 参数）；migration handler `clean-default-models-summary.ts` 清存量 |
| POST /messages body providerId/modelId 收到后**静默忽略不 400**（兼容层） | 读 `app/server/src/handlers/session-messages.ts:220-224` 注释 + 240-243 skipActivate 分支代码 | ✅ 代码明确注释「v0.0.158：body.providerId / body.modelId 静默忽略（兼容层）——前端不再传，旧 client 传字段也不解析、不校验、不落 session、不 400」；handler 内确实无 400 分支读 body override |
| `buildSessionConfigFromDeps` 签名瘦身（删 task + bodyOverride） | 读 `app/server/src/handlers/session-config.ts` 签名 | ✅ 签名对齐 change_plan §B（无 task / 无 bodyOverride 参数） |
| `ProviderModelOverride` interface 整删 | grep `ProviderModelOverride` | ✅ 0 引用（`session-config.ts` interface 已删；session-messages / session-compact / bootstrap 三处 caller 都已适配） |
| `CompactForkedRunner` + `ConsolidationRunner` type input 删 `config` 字段 | 读 `app/server/src/agent/context-engine.ts` + `compact-types.ts` | ✅ input 无 config 字段（bootstrap 闭包内自 resolve） |
| `CompactCtx.config` 保留 | 读 `compact-types.ts` | ✅ 保留（consolidation handler 从 `ctx.config.sessionId` 派生 sid） |
| migration handler `clean-default-models-summary` + `clean-squad-summary-model-default` 已实现 + registry 注册 | 读 `handlers/handlers.yaml` + `handlers/index.ts` + 两个 handler 文件存在 | ✅ 两 handler 均已实现（幂等 + 非破坏性 + `versionRange:'<0.0.158'`）+ registry 正确注册 |

**无发现代码偏离 spec 的新情况**。所有 change_plan 覆盖的变更、5 条已知 spec 偏离、以及本 log §1 记录的连带处理，均已在代码中实现并在 spec 中同步描述。

## 5. 值得 orchestrator 关注的隐藏问题

**无**。本版本 doc-sync 阶段一次跑通：
- 5/5 已知 spec 偏离全部修完（4/5 存在的 md 修完，1/5 `component-manage-tab.md` 不存在 md spec，已在本 log §2 记录并跳过）；
- 5 个 KB `log.md` 追加 v0.0.158.compact_model_resolve 条 + 2 个 index.md 概念表更新；
- 4 个 change_plan 未列的连带处理（Task-2 附带 test mv / Task-4 §F type 定义位置漂移 / session-debug.ts 漏识别 caller / f2 test flaky 加固）已在本 log §1 完整记录；
- 代码-spec 一致性验证 8 项全绿，无新偏离。

## 6. 交付摘要

- **修改 spec**：
  - `specs/tech/agent/providers_and_models/[P0]model_resolve.md`（全文重构）
  - `specs/tech/agent/providers_and_models/index.md`（概念表 + 导航）
  - `specs/tech/agent/context/[P0]context_compact_detail.md`（§2b.1 + §6.4）
  - `specs/tech/agent/context/index.md`（概念表 compact 行）
  - `specs/tech/squad/[P1]data_model.md`（§1.1 squad schema）
  - `specs/tech/squad/[P1]session_config_studio.md`（§3 modelId 解析）
  - `specs/api/overall/04-agent-session.md`（顶部版本行 + §3.2 + §7 + §9）
  - `specs/api/overall/11a-squad-endpoints.md`（顶部版本行 + §1.1 + §1.3 + §1.4 + §5 版本段）
  - `specs/ui/components/app-dev-config-page/section-default-models-and-request.md`（全文重写：删 summary 字段）
  - `specs/ui/components/common/component-key-model-picker.md`（testIdSuffix 注释）
- **追加 KB log**：`context/log.md` + `providers_and_models/log.md` + `session/log.md` + `migration/log.md` + `squad/log.md`
- **新建**：`specs/tech/version_logs/v0.0.158.compact_model_resolve/change_log.md`（本文件）
- **代码-spec 一致性**：8/8 项验证通过，无新偏离

## 7. 合并期偏离（收尾 merge dev1 时新增）

### 7.1 package.json version 保持 0.0.159（不 bump 到 0.0.158，用户裁决）

- **现象**：worktree 开辟时 dev1 tip 为 v0.0.157（package.json=0.0.157）；合回 dev1 时 dev1 已合入 v0.0.156（结构性拆分）+ v0.0.159（computer-use click 修复），版本号已 bump 到 0.0.159。
- **裁决**：不 bump 本版本号（保持 0.0.159 不变）——避免侵入 `[working] v0.0.160.open_codex_align` slot（别人在做的在途需求），符合「不介入其他 worktree 在途工作」范围纪律。
- **本版本 dmg**：无独立发布号（若打包，dmg 版本号 = 0.0.159，与 v0.0.159 合发；v0.0.158 内容以 req.md + change_log + 本版本目录名为准）。
- **偏离 CLAUDE.md「收尾必 bump」惯例**：属发布顺序与开辟顺序错位下的合理偏离；用户明确裁决保持 0.0.159。

### 7.2 dev1 merge 冲突解决（v0.0.156 拆分冲撞）

- **5 个 UU 文件**：`bootstrap.ts` / `handlers/squad.ts` / `page-chat.tsx` / `chat-api.ts` / `session/log.md`。
- **策略**：前 4 个 `--theirs` 接 dev1 拆分版（v0.0.156 A2/A3/T5/T6 把实现挪到 `bootstrap-agent-phase.ts` / `squad-model-helpers.ts` / `use-chat-actions.ts` / `chat-api/message-api.ts`），然后到拆分后的目标文件重新应用 v0.0.158 修改；log.md 手工合并（v0.0.158 顶 + v0.0.156 中间）。
- **补删残留（dev1 拆分未同步 v0.0.158 删字段）**：`handlers/squad.ts` 里 `SquadDetail` / `CreateSquadBody` / `PatchSquadBody` interface + `handleCreateSquad/handlePatchSquad` 校验块 + `toDetail` 回显 + patch 落盘块的 `summaryModelDefault*` 字段——`--theirs` 取回来后再逐项删干净（v0.0.158 Task-2 已删的字段族在 dev1 版本又出现，属 merge 冲突后的必要 re-apply）。
- **UT fix**：`use-chat-actions.test.tsx` 里两条断言（`body: { content, providerId, modelId }`）改为 v0.0.158 契约（`body: { content }`）；`workspace-dir-watcher.test.ts` 「运行时新建子目录不自动被递归监听」全量并发 flaky（chokidar addDir emit 时序超默认 5s）加 `{ retry: 2, timeout: 15000 }`（与 `session-workspace-manager-f2` 同处置）。
- **UT 集成结果**：全绿 7591 passed / 4 skipped / 0 failed（30.98s）。typecheck 全绿。
