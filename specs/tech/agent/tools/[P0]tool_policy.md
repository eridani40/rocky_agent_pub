---
type: spec
title: Tool Policy + resolveToolSet（profile 单源驱动三层一致）
priority: P0
status: active
updated: 2026-07-29
since: v0.0.48
---

# Tool Policy + resolveToolSet（v0.0.204：bound 迁 profile yaml，TOOL_POLICY 常量删除）

> 定位：工具上限（bound）与运行时解析的单源机制。v0.0.204 起：bound 从 TS 常量（`TOOL_POLICY`，已删）迁入 **`app/plugins/session-types/*.yaml` 的 `toolBound` 字段**（每 SessionKind 组合一份）；`resolveTools` 重写为 **`SessionTypePolicy.resolveToolSet(kind, instanceOverride)`**；`ToolPolicyRole` 类型删除（SessionKind 即唯一身份键）。
> 概念权威：身份 → `../session/[P0]session_kind.md`；profile 配置层 → `../session/[P0]session_type_profile.md`。

## 1. 设计原则（不变量）

1. **policy 单源**：bound = 全系统唯一工具上限来源，落 profile yaml（不再是 TS 常量）。config/schema/exec 三层都不自持白名单。
2. **bound = 上限**：main-run 类型 resolve = bound；subagent 等带实例白名单的场景 resolve = `instanceOverride.tools ∩ bound`。
3. **三层一致**：config 层（`buildSessionConfigFromDeps` 算 config.tools）/ schema 层（spec.toolDefinitions 给 LLM）/ exec 层（spec.allowedTools 门控）同源产出，无独立裁剪。
4. **runKind 粒度**：summary（零工具）与 consolidate（[skill_manage, memory_manage]）白名单不同，由各自 profile 文件的 toolBound 表达（`{kind}:${runKind}` 文件）。
5. **配置即代码资产**：bound 改动 = 改 yaml + 版本评审；validator 启动校验 toolBound 引用已注册工具（幽灵名硬失败）。

## 2. bound 数据（迁移映射）

v0.0.204 删除 `TOOL_POLICY`/`SHARED_PLAYGROUND_BOUND`（原 `app/server/src/agent/tool-policy.ts`），值一对一迁入 profile 文件：

| profile 文件 | toolBound 来源（迁移自） |
|---|---|
| `playground-rocky.parent.main.yaml` | 原 playground-rocky bound |
| `studio-squad.parent.main.yaml` | 原 studio-squad bound（[send_message]）+ skill_manage/memory_manage（=3，consolidate 交集非空 invariant，见 session_type_profile.md §4） |
| `studio-leader.parent.main.yaml` / `studio-mate.parent.main.yaml` | 原 studio-leader / studio-mate bound |
| `*.subagent.main.yaml`（playground/studio） | 原 subagent bound + skill_manage/memory_manage（consolidate 交集非空 invariant） |
| `*.summary.yaml` | `[]`（零工具，compaction） |
| `*.consolidate.yaml` | `[skill_manage, memory_manage]`（迁自 CONSOLIDATION_ALLOWED_TOOLS） |
| `default.yaml`（基座） | playground-rocky bound（继承链兜底） |
| `summary.yaml` / `consolidate.yaml`（基座） | 同名 runKind 共性（summary=[] / consolidate=[skill_manage,memory_manage]） |

> 注：原版本含 academy-coach.parent.main / academy-trainer.parent.main / academy-student 等 profile 行；academy 已于 v0.0.208 整体删除，对应 profile 文件与 yaml 同步删除。

## 3. resolveToolSet 签名与流程

```typescript
interface SessionTypePolicy {
  resolveToolSet(kind: SessionKind, instanceOverride?: { tools?: string[] }): {
    tools: Tool[];             // config.tools（registry Tool[] 子集，保注册序）
    toolDefinitions: ToolDefinition[]; // 给 LLM（保注册序）
    allowedTools: string[];    // exec 门控白名单（保注册序）
  };
}
```

```
resolveToolSet(kind, override):
  bound = profile(kind).toolBound          // 继承合并后值；main-run 无 override 时即结果
  allowedNames = override?.tools ? new Set(override.tools) ∩ new Set(bound) : new Set(bound)
  三件套 = allTools/allToolDefs 按注册序 filter allowedNames（剔幽灵名）
```

- **summary/consolidate run**：toolDefinitions 不走本产出——`profile.toolDefinitionsSource: host-snapshot` 钉死 cache 契约（= host snapshot.tools；snapshot 为 sideRun 必填输入，生产三路径 caller 均非空，无重建分支）；本方法只产 allowedTools。调用形态：buildRunDeps 以 `override.tools = snapshot.tools 名表` 调 `resolveToolSet(effectiveKind, {tools})`（= snapshot ∩ toolBound，注册序；旁路白名单与主链同一单源）。
- **subagent**：override.tools = spawn eff.tools（`subAgentConfig.tools`，input ?? template）；∩ bound 最后裁。优先级：spawn input > template > profile bound。
- 旧三态入参（`kind`/`mainAllowedTools`/`enableToolWhitelist+toolWhitelist`）整体删除。

## 4. 调用点（v0.0.204 后）

### 4.1 policy 注入：deps 单路 fail-fast

`SessionTypePolicy` 实例由 bootstrap 装配（`bootstrap-agent-phase.ts` 从 `app/plugins/session-types/` 加载构建），经 **`SessionHandlerDeps.sessionTypePolicy` 单路注入**全部消费方——`buildSessionConfigFromDeps` 直读 `deps.sessionTypePolicy`（**必填，未注入 fail-fast throw**）；`AgentManager`/`buildRunDeps` 同理（构造注入必填）。无 lazy 单例、无双构造路径、无 positional 参数旁路。链路：bootstrap-agent-phase deps 字面量 → bootstrap.ts `BootstrapResult` → router-helpers sessionDeps（session-debug 等端点自动获益）。测试经 `buildRealSessionTypePolicy`（`agent/__helpers__/session-type-policy-test-helper.ts`，真 yaml 加载）或 mock 注入 deps fixture。

### 4.2 调用点表

| 层 | 位置 | 用法 |
|---|---|---|
| config | `handlers/session-config.ts buildSessionConfigFromDeps` | `deps.sessionTypePolicy.resolveToolSet(kind, {tools: subAgentConfig?.tools})` → config.tools |
| schema/exec | `agent/build-run-deps.ts buildRunDeps` | 读 config.tools 派生 spec.toolDefinitions/spec.allowedTools（name set 等价不变量） |
| 旁路 run | `build-run-deps.ts`（summary/consolidate 分支） | allowedTools=resolveToolSet 产出；toolDefinitions=snapshot.tools（host-snapshot，snapshot 必填） |
| reminder | `agent/side-run-reminder-injector.ts` | 两态文案从 allowedTools 派生（入参 `{allowedTools, runKind, sessionId}`；allowedTools = buildRunDeps 经 `resolveToolSet(effectiveKind, {tools: snapshot.tools 名表})` 产出 = snapshot ∩ toolBound（注册序），reminder 广告的工具 = 实际可执行的） |

## 5. RunSpec / SessionConfig 字段关系

| 字段 | 语义 | v0.0.204 |
|---|---|---|
| `RunSpec.toolDefinitions` | 给 LLM 的工具声明（cache 契约，整 run 不变） | 不变（resolveToolSet 产出 / 旁路 run = snapshot.tools，snapshot 必填无重建分支） |
| `RunSpec.allowedTools` | 执行层白名单 | 不变（resolveToolSet 产出） |
| ~~`RunSpec.enableToolWhitelist/toolWhitelist`~~ | caller intent 对 | **删除**（类型级收编 profile） |
| `SessionConfig.tools` | config 层实例白名单 | 不变（resolveToolSet 产出） |
| ~~`SessionConfig.scope`~~ | 死字段 | **删除**（零消费） |

## 6. 静态工具注册（无分岔）

`registry.defaultTools(workdir)` 全集注册与类型无关；可见性全由 bound + exec 门控收束。统一拒绝错误 code（`tool_not_allowed`）不变（→ `[P0]tool_execution_engine.md §3.1`）。

## 7. 边界

| 零件 | 归属 |
|---|---|
| profile yaml schema/继承/validator/enabled | `../session/[P0]session_type_profile.md` |
| SessionKind/RunKind/canonicalId | `../session/[P0]session_kind.md` |
| subagent spawn 链（eff.tools/subAgentConfig） | `../../multi_agent/[P1]subagent_derivation.md §4` |
| 旁路 run reminder 注入点 | `../agent_interface_and_loop/[P0]side_run_reminder.md` |

> 变更历史见 `log.md`。v0.0.204 前历史（TOOL_POLICY 常量/5→7 角色/capByParent 等）见 log.md 位置轴。
