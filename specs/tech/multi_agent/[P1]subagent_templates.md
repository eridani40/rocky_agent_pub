---
type: spec
title: Sub-Agent 模板（用户配置）
priority: P1
status: active
updated: 2026-08-03
since: v0.0.28
related: [subagent_derivation.md, design.md, ../config/[P0]app_config.md]
---

# Sub-Agent 模板（用户配置）

> 定位：sub-agent **模板** = 用户可配置的「派生蓝图」，方便 `agent.spawn` 时按模板快速派生子 agent。**模板只是便利手段**，不是 session 类型（session role/derivation 是身份概念，见 `subagent_derivation.md §2`）。
> 参考：`index.md`、`subagent_derivation.md §4`（agent.spawn 如何用模板）、`design.md`（O1/D8）、`../config/[P0]app_config.md §3.11`（v0.0.89 起存储迁入 app_config.sub_agent_templates）。
> 设计对照：Claude Code subagent 定义（name/description/tools/model）。

---

## 1. 定位

- **模板 = 用户配置**（非代码）：用户可复制、新增、编辑模板。
- **用途**：`agent.spawn(templateRef=...)` 时载入模板的 systemPrompt/tools/skills/**modelId** + 可选 **role**/**derivation**，避免每次 inline 重写；spawn 时仍可覆盖 systemPrompt/tools/skills（**modelId/role/derivation 不可覆盖**——见 D8 修订）。
- **预配**：系统内置 1 个默认模板 **`explorer`**（开箱即用）。（注：原版本曾内置 `knowledge_learning_trainer` 模板供 academy trainer 拉起，academy 已于 v0.0.208 整体删除，该 builtin 模板与对应 profile/scope yaml 同步删除。）
- **关键约束（D8 修订 v0.0.28 + v0.0.204 扩展）**：模板**可带 `modelId`**（走模板→child model = template.modelId）；**自定义（inline 无 templateRef）只能 inherit parent.modelId**；**spawn 入参无 modelId 字段**（spawn 时不可覆盖）。**[v0.0.204]** 模板可带 `role?` + `derivation?`（spawn 泛化机制，详见 `subagent_derivation.md §4`）：缺省 = `role=parent.role`（bloodline）+ `derivation='subagent'`；显式指定 = 拉起非 subagent 形态的 child。

> 与 session 身份正交：身份 = `biz/role/derivation`（`SessionKind`，见 `../agent/session/[P0]session_kind.md`）；`subAgentTemplateType` = `explorer` 等（模板标签）。一个 sub-agent session = `derivation:'subagent'` + `subAgentTemplateType:'explorer'`；一个 trainer session = `derivation:'parent'` + `role:'trainer'` + `subAgentTemplateType:'knowledge_learning_trainer'`。

---

## 2. 数据结构

```typescript
interface SubAgentTemplate {
  name: string;                   // 模板标识（= templateRef；= 派生 session 的 subAgentTemplateType）
  description: string;            // 人读说明（UI 展示 + 给 parent LLM 选模板用）
  systemPrompt: string;           // 子 agent 人设
  tools: string[];                // 工具白名单（含 send_message 的可达目标）
  skills?: string[];              // 可选 skills
  modelId?: string;               // 【v0.0.28 D8 修订·新增】可选——模板指定 model；走模板时 child model = template.modelId（spawn 入参无 modelId，不可覆盖）
  builtin?: boolean;              // 系统预配（explorer=true），用户不可删但可复制衍生
  // ── v0.0.204 spawn 泛化字段 ──
  role?: Role;                    // 可选——拉起非 bloodline role 的 child（如 trainer='trainer'）；缺省 = parent.role（bloodline）
  derivation?: Derivation;        // 可选——拉起非 subagent 形态的 child（如 trainer='parent' 独立身份，不挂 parentSessionId）；缺省 = 'subagent'
}
```

- `name` 唯一（用户配置内）；`builtin:true` 的模板只读，用户可「复制新增」改出私有版本。
- `modelId` 缺省 = 走 parent.modelId（即模板不指定 = inherit parent）。
- `role` / `derivation` 缺省 = `parent.role` / `'subagent'`（典型 subagent 派生场景）；显式指定 = 拉起独立身份的 agent（trainer 是首个用例）。
- 派生时 `subAgentTemplateType` 记录所用模板 `name`（审计/观测，见 derivation §2）。

---

## 3. 存储（v0.0.89 迁入 app_config `sub_agent_templates` 配置组）

> **v0.0.28 已定**（原 TBD 「dev_config group vs EP」→ dev_config group）；**v0.0.89 迁入 app_config**（dev_config entity 废弃，所有 group 迁入 app_config，详见 `../config/[P0]app_config.md §3.11`）。

- **位置**：`app_config` 的 `sub_agent_templates` 配置组（一组模板记录）。
- **CRUD**：用户可 list / create / copy / edit / delete（builtin 除外）。复制 explorer → 改名改字段 → 存为新模板。builtin explorer 只读，可复制衍生。v0.0.89 起 DELETE/PUT 经专用 handler `app-config-template-handlers.ts` + 专用路由 `/config/app/sub_agent_templates`；通用 `GET /config/app?group=sub_agent_templates` 列表/读取不变。
- **加载**：`agent.spawn` 解析 `templateRef` → 经 `loadTemplateFromDevConfig`（v0.0.89 函数名保留，实现已切 app_config）从 app_config `sub_agent_templates` 组读对应模板；找不到 → error。
- **builtin 模板**：`explorer`（用户通用）。builtin 只读，可复制衍生。
- **UI**：复用现有 config 页，新增 sub_agent_templates 组的 list/copy/edit/delete 视图。

---

## 4. 与 `agent.spawn` 的关系（resolution 规则 — D8 修订 + v0.0.204 spawn 泛化）

```
agent.spawn(input):
  template = input.templateRef ? loadTemplate(input.templateRef) : null
  eff.systemPrompt = input.systemPrompt  ?? template?.systemPrompt  // 无模板且无 inline → error
  eff.tools        = input.tools         ?? template?.tools
  eff.skills       = input.skills        ?? template?.skills
  // ★ D8 修订（v0.0.28）：model 走模板（有）或 inherit parent（无模板）；spawn 入参无 modelId
  //   parent.modelId = parent 运行时 resolved 具体 modelId（runSpawn 经 resolveConfigBySid 取，非 session.modelId raw hint）
  eff.modelId      = template?.modelId ?? parent.modelId
  // ★ v0.0.204 spawn 泛化：role/derivation 走模板显式指定（如 trainer）；缺省 = parent.role / 'subagent'
  eff.role         = template?.role      ?? parent.role        // bloodline role 默认；trainer 模板显式 'trainer'
  eff.derivation   = template?.derivation ?? 'subagent'         // 默认 subagent；trainer 模板显式 'parent'
  childSession.subAgentTemplateType = input.templateRef ?? null
```

- 三种用法（subagent 派生）：①纯模板（`templateRef` only）→ model = template.modelId，role/derivation = parent.role/'subagent'；②纯 inline（`systemPrompt`+`tools`，无 templateRef）→ model = parent.modelId（inherit only），role/derivation = parent.role/'subagent'；③模板+覆盖（`templateRef` + 部分字段覆盖 systemPrompt/tools/skills）→ model 仍 = template.modelId。
- **`parent.modelId` 来源**：上文 `eff.modelId = template?.modelId ?? parent.modelId` 中 `parent.modelId` = parent **运行时 resolved 具体 modelId**（`runSpawn` 调 `agentManager.resolveConfigBySid(parentSid)` 取 parentConfig.modelId），**非** `session.modelId` raw hint。原因：raw hint 常 `'default'`/空，subagent 被 `isStudioMainSession`（需 `derivation='parent'`）切断 squad/classroom default 链 → resolveModel fallback 跑空抛 `ModelNotConfiguredError`。D8 语义（模板优先 / spawn 不可覆盖）不变，仅 parentModelId 来源从 raw hint 变 resolved 具体 model。`providerId` 同源 parentConfig（`client.getInfo().providerId`，SessionConfig 顶层不导出 providerId），落 child session record。
- **swarm 自定义**：用户希望支持 swarm 时自定义 system_prompt + tools → 即用法②/③（inline 或覆盖）。
- **`eff.tools` 三态（resolution 后→落库→resolveToolSet）**：`eff.tools = input.tools ?? template?.tools` 的结果决定 child 工具集——`undefined`（input 与 template 都不传 tools）= 继承 subagent profile toolBound 全集（默认；落库 `subAgentConfig.tools=undefined`，resolveToolSet 走 `new Set(bound)` 全集分支）；`[]` = 显式空（交集空集，保留 LLM 显式传空能力）；非空 = 与 bound 取交集。历史 bug：落库曾用 `?? []` 把 undefined 降级成 [] 致零工具——已修（透传 undefined，详见 multi_agent KB `log.md` v0.0.222）。

---

## 5. 预配模板

### 5.1 `explorer`（用户通用）

```yaml
name: explorer
description: 探索型子 agent——只读探查、广撒网收集信息，不做写操作。适合调研/搜索/只读遍历。
systemPrompt: |
  你是 explorer 子 agent。你的职责是【只读探索】：调研、搜索、读取、汇总信息。
  不执行任何写/改/删除操作。完成后用简明结构化方式把发现回报给调用者。
tools: [read, web_search, web_fetch, send_message]   # 只读 + 回报；无 write/bash 等
skills: []
modelId: null   # 缺省 = inherit parent（explorer 不指定 model）
# role / derivation 缺省 = parent.role / 'subagent'（典型 subagent）
builtin: true
```

---

## 6. 边界

| 零件 | 归属 |
|---|---|
| 模板结构（含 modelId + role + derivation）+ 语义 + resolution 规则 + explorer / trainer 预配 | 本文 ✅ |
| 模板存储后端（`app_config.sub_agent_templates` group） | `specs/tech/config/[P0]app_config.md §3.11` |
| 专用 DELETE/PUT handler + 路由 | `app-config-template-handlers.ts` + `router.ts:/config/app/sub_agent_templates` |
| agent.spawn 工具（用模板，调 `loadTemplateFromDevConfig`）+ spawn 泛化（template.role/derivation 解析） | `subagent_derivation.md §4` + `../agent/tools/[P1]agent_tools.md` |
| 模板 UI（list/copy/edit，复用 config 页） | `specs/ui/components/app-dev-config-page/` |
| trainer 拉起后 profile 字段（userReachable/ephemeral/toolBound） | `../../agent/session/[P0]session_type_profile.md` |

---

## 7. 待定

- 是否支持「模板继承/组合」（一个模板 extend 另一个）——暂不支持，保持简单。
