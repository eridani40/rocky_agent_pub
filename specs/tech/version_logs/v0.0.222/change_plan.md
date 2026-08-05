---
type: change_plan
version: v0.0.222
title: subagent 不传 tools 时默认用 profile toolBound（修 ?? [] 降级 bug）
status: approved
created: 2026-07-30
---

# v0.0.222 change_plan — subagent tools 默认继承 bound

## 背景（根因）
spawn 不传 `tools`（也无 `templateRef`）→ `eff.tools = undefined`（`template-loader.ts:100`）→ 落库 `agent-tool.ts:330` `childConfig.tools ?? []` 把 `undefined` 降级成 `[]` → `resolveToolSet`（`session-type-policy.ts:92`）判 `[] !== undefined` 走交集分支 → 空集 → subagent 零工具 + tool_guidance prompt 段缺席。

`resolveToolSet` 本有 `instanceOverride.tools === undefined → new Set(bound)` 全集分支（`session-type-policy.ts:94`），设计意图即「不传 = 继承 bound」。`?? []` 破坏了这个语义。

## 修复原则
让 `undefined`（未指定）一路透传到 `resolveToolSet`，恢复「未传 tools = 继承 subagent profile toolBound」语义。三态语义：
- `undefined` = 继承 bound 全集（**新默认**）
- `[]` = 显式空（交集空集，保留 LLM 显式传空能力）
- 非空 = 与 bound 取交集（不变）

默认工具集 = `app/plugins/session-types/subagent.yaml` 的 `toolBound`（19 工具）：read/write/edit/glob/grep/bash/skill/memory/web_search/web_fetch/browser/see_image/send_message/computer/ask-question/history_search/history_get_context/skill_manage/memory_manage。

## 变更契约（method 级，8 列）

| 模块 | 文件 | 函数·符号 | 类型 | 变更内容 | 约束 | 参考 | 影响行 |
|------|------|-----------|------|----------|------|------|--------|
| agent/tools | app/server/src/agent/tools/agent-tool.ts | createChildSessionImpl（落库 subAgentConfig） | 改 | `tools: input.childConfig.tools ?? []` → `tools: input.childConfig.tools`（透传 undefined，不降级） | childConfig.tools 已是 `tools?: string[]`（line 295）；透传 undefined 让下游 resolveToolSet 走 bound 全集分支 | session-type-policy.ts:92-94 | 330 |
| agent/store | app/server/src/agent/session-store-types.ts | Session.subAgentConfig.tools | 类型改 | `tools: string[]` → `tools?: string[]`（承载 undefined 语义） | 落库/读取链路透传整个 subAgentConfig 对象（core-impl.ts:96 / converters.ts:93），不单独处理 tools，改类型不影响。[deviation 补] `buildSessionConfigFromDeps`（session-config.ts:167）形参 `subAgentConfig.tools` 独立声明为 `tools: string[]`（必填），需同步改 `tools?: string[]` 可选——否则 5 处调用点 typecheck fail（bootstrap-agent-phase.ts:233 / session-debug.ts:99 / 3 测试文件）；实现体 line 289 早用可选链，仅签名落后（coder 已实现） | session-config.ts:289 已用可选链 | 149 |
| agent/store | app/server/src/agent/session-store-types.ts | CreateSessionInput.subAgentConfig.tools | 类型改 | 同上（`tools: string[]` → `tools?: string[]`） | — | — | 373 |
| test | app/server/src/agent/tools/__tests__/spawn-action-direct.test.ts | （新增 case） | 新增 | 三态验证：① 不传 tools（无 templateRef）→ subAgentConfig.tools 落库 === undefined（非 `[]`）；② 传子集 → 落库 === 子集；③ 传 `[]` → 落库 === `[]` | 复用现有 spawn-action-direct.test.ts 的 executeSpawn 直调模式 | template-loader.test.ts | 新增 ~3 case |

## 不变（确认无需改 — 关键）
- **`resolveToolSet`**（`session-type-policy.ts:87-109`）：已支持 `instanceOverride.tools === undefined → new Set(bound)`；去掉 `?? []` 后 undefined 自动透传到此走全集分支，**无需改**
- **`buildSessionConfigFromDeps`**（`session-config.ts:288`）：`policy.resolveToolSet(kind, { tools: subAgentConfig?.tools })` 已用可选链，undefined 安全
- **`resolveEffective`**（`template-loader.ts:100`）：`eff.tools = input.tools ?? template?.tools`，undefined 语义本就正确
- **`academy-student.ts:219`**：显式传 tools 构造 subAgentConfig，不受影响（类型改可选后兼容）

## 风险
- **低**：纯装配逻辑 + 类型放宽；无数据迁移（`undefined` 与 `[]` 在现有透传链路都安全）
- **兼容**：旧 session record 的 `subAgentConfig.tools` 是 `string[]`（必填），新代码读到非 undefined 不影响行为；新落库可能为 undefined，下游已可选链兼容
- **行为变化**：原本不传 tools 的 subagent 从「零工具」变「bound 19 工具」——这是本次修复目的，非回归
