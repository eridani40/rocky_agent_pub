---
type: spec
title: SessionType Profile（agent 行为契约配置层）+ SessionTypePolicy
priority: P0
status: active
updated: 2026-07-26
since: v0.0.204
---

# SessionType Profile — agent 行为契约配置层

> 管什么：每个 SessionKind 组合一份显式行为契约（`app/plugins/session-types/*.yaml`）、extends 继承、启动校验、`SessionTypePolicy` 读取接口、扩展流程。
> 不管什么：SessionKind/SessionContext 身份结构本身（→ `[P0]session_kind.md`）；plugin EP/scope 机制（→ `../../plugin_system/` + `../../config/[P0]ext_impl_scope.md`）。
> 需求：`reqs/[working] v0.0.204.agent_config/req.md`；方案：`states/v0.0.204/proposal.md` + 用户拍板 Q1-Q6 + 追加裁决 + 终版概念修正。

## 1. 是什么与核心裁决

**一个问题一个答案**：「这个 agent 是什么」= SessionKind（含 runKind）；「它怎么行为」= 它的 profile 文件 + 它名字对应的 scope 文件。废掉此前 5 键并存（ToolPolicyRole/scopeId 路由表等）。

用户拍板（v0.0.204，含终版概念修正）：

1. **scopeId = 纯字符串拼接**——由 SessionKind canonical id 直接得出，无路由表、无决策逻辑（`AgentScopeRouter` 删除，不进 policy）。所有用到的 scope 组合全量配 yaml 文件（空文件 = 全继承）。
2. **每组合一文件**——profile 与 scope 均如此；空内容 = 全继承父级。
3. **工具策略粒度细到 runKind**——summary 与 consolidate 白名单不同，由各自 profile 文件 toolBound 表达。
4. **policy 只剩真决策**——凡能用「id 拼接 + 全量配置文件」解决的不进 `SessionTypePolicy` interface。
5. **一版做完**——配置层 + 读取收敛 + 装配合并（buildRunDeps）+ 删 TOOL_POLICY/AgentScopeRouter，不留新旧并行。
6. **runKind 扁平闭合枚举**（main/summary/consolidate）、**存量数据零迁移**（落盘形状不变）、profile 落 `app/plugins/session-types/`。
7. **forked 概念彻底退役**——类型系统无 forked、代码零 `if forked`、无 isForked/forkedRun/buildForkedDeps/ForkedContextPort/ForkedLifecyclePort/MUTED_BUS 等命名。summary/consolidate 的 cache 契约由 profile `toolDefinitionsSource: host-snapshot` 字段承载（仍是「该 runKind 的共性配置」语义，但不再叫「forked 的定义」）。
8. **手动/自动 summary 同 type 同 profile**——「手动 / 自动」不是类型差异，是 run 输入状态差异（snapshot 有/无）。profile/scope **禁止**任何区分手动/自动的字段。

## 2. canonical id 与文件命名

```
id = ${biz}-${role}:${derivation}:${runKind}     # 4 段（runKind ∈ main/summary/consolidate）
例：playground-rocky:parent:main / playground-rocky:parent:summary
   studio-squad:parent:consolidate / studio-leader:parent:main
   studio-leader:subagent:main
```

- **scopeId = id**（纯拼接，`scopeIdOf(kind)` 单行函数，零逻辑）。
- 文件名 = id 中 `:` 换 `.`：`studio-leader.parent.main.yaml`（文件系统安全）。
- summary/consolidate run 的 biz/role/derivation = host session 的 kind（旁路 run 不另立身份）。

## 3. profile yaml schema

每个字段 = 一个行为策略点。default.yaml 全字段显式（基线）；其余文件只写差异（空 = 全继承）。

```yaml
id: playground-rocky:parent:main
extends: default                # 必填（root 除外），单父，显式声明
enabled: true                   # Q4 预留；false = createSession 拒绝（fail fast）
toolBound: [read, write, ...]   # P6 工具上限；resolveToolSet 结果 = instanceOverride ∩ bound
toolDefinitionsSource: own      # own | host-snapshot（summary/consolidate=host-snapshot，cache 契约钉死）
runShape:                       # P9/P13/P14/P15
  drainMode: eager              # eager | none
  backgroundPath: false
  maxIterDefault: 25
  touchesStateMachine: true
  persistsRun: true
  usagePartition: current       # current | sub | summary | consolidate
lifecycleHooks:                 # P16
  abortFinalize: four-step      # four-step | none
  cascadeChildren: true
eventChannel:                   # P4（groupKey 由 sid+runKind 全局拼接，不进配置）
  emitDefault: true
modelHints:                     # P11
  readsSquadDefault: false
skillSource: global-enabled     # P12：global-enabled | member-overlay | none
eosStop: []                     # P10：studio-squad = ['<EOS>']
autoNaming: true                # P17（仅 playground-rocky:parent:main）
preloadContext: none            # P18：none | studio
# 非身份维度的属性字段（按需启用，例：studio-mate 可加 userReachable:false）
userReachable: true             # 用户是否可直接触达（false = 不可触达，如内部辅助 agent）
ephemeral: false                # 临时生命周期，task 终态即回收（数据保留）
```

## 4. 继承规则

- **显式 `extends` 单父**，无隐式推导；链深不限（Q6）；validator 校验父存在 + 无环。
- 逐字段深合并；缺省字段取父级值。
- **禁跨 biz**（validator 硬失败：业务 profile 的父必须同 biz）；允许的跨 biz 父 = 系统基座四个：**`default` + `summary` + `consolidate` + `subagent`**：
  - `default` = 主链 root 回退终点（main run 共性）
  - `summary` = summary runKind 共性（drainMode none / persistsRun false / usagePartition summary / toolBound=[] / toolDefinitionsSource host-snapshot / maxIterDefault 1 / abortFinalize none / cascadeChildren false）
  - `consolidate` = consolidate runKind 共性（同 summary 共性，但 toolBound=[skill_manage, memory_manage]）
  - `subagent` = 派生子 agent 共性（toolBound：基础探索 + send_message + skill_manage/memory_manage（consolidate 交集非空 invariant），无 agent/cron/team；其余字段继承 default）
- 典型链：`studio-squad:parent:summary → summary → default`；`studio-squad:parent:main → default`；`studio-squad:parent:consolidate → consolidate → default`；`studio-leader:subagent:main → subagent → default`。
- **main toolBound ∩ consolidate 基座 toolBound 必须非空（INVARIANT）**：consolidate 旁路 run 复用 main run 的 snapshot.tools（`toolDefinitionsSource: host-snapshot`），allowedTools = profile（consolidate）toolBound ∩ snapshot.tools。main 类型的 toolBound 若不含 `skill_manage`/`memory_manage`，交集为空 → fork-2 allowedTools=[] 空跑（reminder 广告两工具却全被门控）。故每个可触发 compact 的 main profile 都须带上这两工具（非主 run 主动用，是为旁路交集）：`studio-squad.parent.main`=3（send_message + 两工具）、`subagent` 基座（含两工具）。UT 钉死 squad main∩consolidate 基座 = [skill_manage, memory_manage]。

## 5. scope yaml 对接（含 extends 扩展 + studio 拆分治理）

- scope 文件与 profile 同id同名（`app/plugins/scopes/<id 文件名>`），**每组合一份**；scope yaml 增加 `extends` 字段（单父链式回退，取代原「未激活 EP 直接回退 default」的二级模型；`resolveSourceScope` 沿链走）。
- summary/consolidate 各 scope 显式 `extends: summary` / `extends: consolidate`（基座文件承载共性：summary_builder/consolidate_builder / in_memory_session_store / reject_should_compact / noop_* / 关 reminder_injector+search_indexing；原 forked.yaml 拆为 summary.yaml + consolidate.yaml 两个基座）。
- **studio 拆分治理（Q3）**：playground 与 studio 不再共用 default 的 prompt/reminder 链——
  - `playground-rocky.parent.main.yaml`：system_prompt_mapper 去 squad_role/team_roster/memory_group/parent_task；system_reminder 去 squad_* 5 项。
  - `studio-squad/studio-leader/studio-mate.parent.main.yaml`：extends default（现状等价，显式独立成文件，后续按需分化）。
  - `default.yaml` 保持全量基线（root 回退终点）不变。
- subagent 各类型 scope 显式配置（见 §9 偏差#5：v0.0.183 把全 subagent 主 run 路由进 forked scope 的隐式语义，本版本按类型显式声明，persistent_session_store + 主链语义）。

## 6. SessionTypePolicy interface（收缩后）

```typescript
interface SessionTypePolicy {
  /** 继承合并后的 profile（唯一读取入口；纯数据，无逻辑） */
  profile(kind: SessionKind): ResolvedSessionProfile;
  /** P6 唯一真决策：bound（profile，runKind 粒度）∩ instanceOverride */
  resolveToolSet(kind: SessionKind, instanceOverride?: { tools?: string[] }): {
    tools: Tool[]; toolDefinitions: ToolDefinition[]; allowedTools: string[];
  };
}
```

- **不在 interface 里**：scopeId（= canonical id 拼接）、groupKey（= sid+runKind 拼接）、enabled/各布尔字段（profile 字段直读）、caller 门控（kind 谓词 helper）。
- 启动期 loader 读 `app/plugins/session-types/*.yaml` → 合并链缓存；validator 校验：id 格式/父存在/无环/enabled 类型文件存在性/toolBound 引用已注册工具/字段枚举闭合/**矩阵完整性（`validateMainMatrix`：每个 enabled 的 `<prefix>:main` profile 必须有对应 `<prefix>:summary` + `<prefix>:consolidate` profile，缺失启动硬失败——main extends default 继承 threshold_should_compact 0.6 + post_compact，run 跑长必产 summary/consolidate 旁路 run，缺 profile/scope 文件则运行时 resolveSourceScope throw 才暴露；scope 侧有对称校验 `validateMainScopeMatrix`，见 `../../plugin_system/[P1]scopes_config_decl.md §3.2`）**/**禁跨 biz extends**（父为四基座 default/summary/consolidate/subagent 豁免）。

## 7. 策略点 → 机制映射（21 点全集）

| 策略点 | 机制 |
|---|---|
| P1/P2 prompt/reminder 链、P7 context EP 链、P8 compact 防递归 | scope yaml（scopeId=canonical id 拼接） |
| P3 会话存储 | scope yaml session_store EP + profile.runShape.persistsRun |
| P4 event 通道 | groupKey 拼接（全局）+ profile.eventChannel.emitDefault |
| P5 静态工具注册 | 全局 registry（无分岔，不配） |
| P6 动态工具集 | `policy.resolveToolSet`（profile.toolBound） |
| P9 maxIter | profile.runShape.maxIterDefault（instanceOverride.maxIter 可覆写） |
| P10 EOS | profile.eosStop |
| P11 model fallback | profile.modelHints.readsSquadDefault |
| P12 skills | profile.skillSource（session-config 按枚举分派既有逻辑） |
| P13/P14/P15 usage/状态机/drain | profile.runShape |
| P16 abort 收尾/级联 | profile.lifecycleHooks |
| P17 autoNaming | profile.autoNaming |
| P18 bootstrap 预载 | profile.preloadContext |
| P20 终态墙 | 全局统一（无分岔） |
| P21 trace 命名 | canonical id 拼接 |

## 8. enabled 语义（Q4）

- profile **文件存在 = 类型已登记**；`createSession` 要求 parent-run 类型（derivation='parent' && runKind='main'）的 profile 文件存在且 `enabled !== false`，否则 fail fast（ValidationError）。
- 未启用类型可不建文件；summary/consolidate runKind 的 profile 永允许沿继承链回退（不设门）。

## 9. spec 偏差修正登记（v0.0.204 一并处理）

1. `SessionConfig.scope` 死字段删除（零消费；`[P1]agent_tools.md §2.2/2.3` 描述的消费已不存在）。
2. `agent_scope_router.md` 全文废止（router 删除，scopeId=拼接）。
3. v0.0.183 曾将**所有** subagent 主 run 路由进 forked scope——playground/studio subagent 的 transcript 落库/prompt 链语义被隐式改变；v0.0.204 起 subagent 各类型 scope/profile 显式声明（恢复 persistent store + 主链语义为目标态）。
4. **build-forked-deps.ts:162 隐式 snapshot 必需**（`toolDefinitions = snapshot.tools`）→ summary/consolidate run 必须双路径：有 snapshot=复用（自动压缩场景）；无 snapshot=完整重建（手动压缩场景）。context engine impl snapshot 可选化（见 change_plan 新增行）。

## 10. 扩展新类型 step-by-step

1. （如新枚举）shared `BizType`/`Role` 加值 + 校验规则（session_kind.md §5）。
2. `app/plugins/session-types/` 加 profile 文件（extends 显式，空=全继承）。
3. `app/plugins/scopes/` 加同 id scope 文件（空=全继承；scope 名自动对得上，无需注册）。
4. （如新 impl）写 impl + groups.json + 相应 scope yaml 引用（现有 plugin 流程不变）。
5. 启动 validator 自动校验闭合（§6）。结束——不改任何 TS 路由/策略代码。

## 11. 打包护栏（MANDATORY）

`scripts/build-plugins.ts` 的 `copyResources` 必须拷贝 `app/plugins/session-types/` 到 packaged dist（同 scopes 目录待遇）；缺失则 packaged 运行时 loader 读不到 profile 硬失败（dev 测不到）。

## 12. 边界

| 零件 | 归属 |
|---|---|
| SessionKind/SessionContext/runKind/校验 | `[P0]session_kind.md` |
| scope yaml schema/validator 机制 | `plugin_system/[P1]scopes_config_decl.md` + `config/[P0]ext_impl_scope.md` |
| resolveToolSet 三层一致（config/schema/exec） | `agent/tools/[P0]tool_policy.md`（重写） |
| buildRunDeps 单装配（含 snapshot 可选双路径） | `agent/agent_interface_and_loop/[P0]agent_loop_unified.md` |
| 实例级 override（subAgentConfig/templates） | `multi_agent/[P1]subagent_derivation.md` |
