# Skill Governance HTTP API（v0.0.55 — UI 改 evolvable 端点）

> version: 2.0 · 引入版本 v0.0.51（mutable）· **v0.0.55 改名 evolvable + 删 mutableLocked** · 2026-07-03
> 管什么：HTTP 端点 `PATCH /skill/:name/governance`——UI 改 SKILL.md frontmatter `evolvable` 字段（true↔false），**无 lock 约束**（v0.0.55 删 mutableLocked 维度）。
> 不管什么：其他 skill HTTP 端点（install/list/toggle/delete/preview，见 `06-skill.md`）；agent 通过 `skill_manage` 工具改 skill（非 HTTP，见 `14-self-evolution-tool-ref.md` §3）。
> **本文件是 AT（API Test）skill governance 域的唯一依据**：api-verifier 黑盒 curl，不读代码。
> 技术契约权威：`specs/tech/agent/skills/[P0]skill_definition.md` §6（单维度 evolvable）+ §8（UI 改 evolvable 路径）。
>
> **[v0.0.55 SPEC CHANGE]**：`mutable → evolvable`（更直观「是否开启自进化」）；删 `mutableLocked` 维度（UI 一定能改 evolvable，无需 lock；agent 不碰治理元字段）。零历史包袱（v0.0.51 引入、尚未被消费）。

## 1. 概述

UI 改 `evolvable` 是**用户对自己资产的控制权路径**——典型场景：用户手写 skill（默认 `evolvable=false`）想交给 consolidation 优化 → UI 切到 `evolvable=true`；agent 创建的 skill（默认 `evolvable=true`）用户不想被 agent 再改 → UI 切回 `evolvable=false`。

**为什么独立端点（不走 `skill_manage` agent 工具）**：

- `skill_manage` 是 agent 工具（LLM tool_use），其 payload **永远不含 evolvable 字段**（agent 不碰治理元字段——见 `[P0]skill_manage_tool.md §4`）。
- UI 改 evolvable 是**用户行为**，不是 agent 行为——逻辑上不能走 agent 工具调用语义。
- 强制检查点（无）直接在 service 层独立实现，不混入 agent 工具强制规则。

**与 `PATCH /skill/:name`（toggle enabled，见 06-skill §4）的区别**：

| 端点 | 改的字段 | 受什么约束 |
|------|---------|-----------|
| `PATCH /skill/:name` | `enabled`（app_config.skill_state） | 无 evolvable 约束（任何 skill 都可 toggle enabled） |
| `PATCH /skill/:name/governance` | `evolvable`（SKILL.md frontmatter） | 无 lock 约束（v0.0.55 删 mutableLocked） |

## 2. `PATCH /skill/:name/governance`（UI 改 evolvable）

### 2.1 请求

- path：`:name` = skill name（kebab-case）
- body：

```typescript
interface GovernanceBody {
  scope: 'app' | 'workspace';   // 必需，操作层（不缺省，强制 caller 显式指定）
  evolvable: boolean;            // 必需，目标值（true↔false 都允许）
  workspace?: string;            // scope=workspace 时必需（绝对路径，校验同 06-skill §1 workspace 参数安全）
}
```

```json
{
  "scope": "app",
  "evolvable": true
}
```

### 2.2 响应

- `200 OK` · `{ "skill": SkillEntry }`（含已更新的 `evolvable`）

```json
{
  "skill": {
    "name": "my-handwritten-skill",
    "description": "...",
    "scope": "app",
    "skillDir": "/home/u/.rocky_agent_dev/skills/my-handwritten-skill",
    "enabled": true,
    "source": "user",
    "productionMethod": "handwritten",
    "evolvable": true
  }
}
```

> SkillEntry 完整 schema 见 `06-skill.md §8`。`evolvable` 已翻转为请求值；**v0.0.55 起 SkillEntry 不再含 `mutableLocked` 字段**（删维度）。

### 2.3 错误

| HTTP | 触发 | 响应体 |
|------|------|--------|
| `400` | body 缺 scope/evolvable；类型错；scope=workspace 缺 workspace 参数；workspace 路径不存在/非目录 | `{ "error": "<原因>" }` |
| `404` | name 在指定 scope 不存在 | `{ "error": "Not Found" }` |
| `409` | scope=workspace 与 app 同名冲突未显式指定（不自动跨层）| `{ "error": "ambiguous name; specify scope explicitly" }` |

> **[v0.0.55] 删 403 路径**：原 v0.0.51 的 `mutableLocked=true → 403` 已废除（删维度）。所有 skill（含系统内置）UI 都能改 evolvable（用户对自己 dataDir 资产有完全控制权）。

### 2.4 service 层强制逻辑（实现契约）

```
1. resolveSkillByName(name, scope, workspace?)
   ├── not found → 404
   └── found → skill + frontmatter
2. read frontmatter
3. write evolvable = body.evolvable to frontmatter（保留其他字段不变）
4. return updated SkillEntry
```

**强制点位置**：service 层（`app/server/src/skills/governance.ts`），**不在 agent tool 层**。理由：UI 写路径与 agent 写路径正交分离（见 `skill_definition.md §8` 「UI 路径不经过 skill_manage 工具」）。

**原子性**：写 frontmatter 必须 per-file lock 序列化（与 `skill_manage_tool.md §7.2` 同构），避免 UI 改 evolvable 与 agent patch 并发撕裂 SKILL.md。

## 3. 与 agent 路径的边界（正交分离）

| 路径 | 主体 | 改 evolvable? | 受什么约束 |
|------|------|------------|-----------|
| `skill_manage` agent tool（LLM tool_use） | agent | **不可改**（payload 不含 evolvable；agent 不碰治理元字段） | `evolvable=false` 拒绝 patch/disable/enable |
| `PATCH /skill/:name/governance` HTTP | UI（用户） | **可改**（true↔false 都允许） | 无约束（v0.0.55 删 mutableLocked） |

**单维度语义权威**：`specs/tech/agent/skills/[P0]skill_definition.md §6`（单维度 evolvable）。

## 4. 一致性约束

- **scope 显式**：governance 端点不接受 scope 缺省（强制 caller 显式 app|workspace），避免误改另一层同名 skill。
- **workspace 参数安全**：`?workspace=` 必须绝对路径 + 存在 + 是目录（同 06-skill §10 workspace 参数安全）。
- **不修改其他字段**：governance 端点只写 `evolvable`；`name/description/allowed-tools/source/productionMethod/enabled` 全部保留不变。

## 5. 关键用户路径映射（测试覆盖）

| PRD 路径 | API case |
|---------|----------|
| UI 切 evolvable=false→true（手写 skill 交给 consolidation） | PATCH governance 200，查 frontmatter evolvable=true |
| UI 切 evolvable=true→false（锁住 agent 资产） | PATCH governance 200，查 frontmatter evolvable=false |
| UI 改下载 skill（默认 evolvable=false）| PATCH governance 200 |
| UI 改系统内置 skill（默认 evolvable=false）| PATCH governance 200（v0.0.55 不再 403） |
| scope=workspace 缺 workspace 参数 | PATCH governance **400** |
| name 不存在 | PATCH governance **404** |

## 6. AT 验证方式（real HTTP curl）

- **200 成功路径**：curl PATCH 带 `{scope, evolvable}` → 断言响应 `skill.evolvable === body.evolvable` + 断言磁盘 frontmatter 同步更新（read SKILL.md 验证）。
- **不依赖 mock**：调真 HTTP server（默认 test env 端口），真落盘到 test dataDir。
