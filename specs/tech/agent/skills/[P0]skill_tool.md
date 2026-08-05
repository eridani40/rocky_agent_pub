---
type: spec
title: skill 工具（纯读）
priority: P0
status: active
updated: 2026-07-02
since: v0.0.21
---

# skill 工具（纯读）

主文档：`index.md`。skill 定义见 `[P0]skill_definition.md`。

## 1. 概述

暴露给 agent 的 skill 工具是 **`skill`（纯读）**：输入 skill name → 返回该 skill 的 SKILL.md 全文 + skill 目录绝对路径。只读 **enabled** skill（disabled skill 不在 L0 catalog，agent 不可见；如需读 disabled skill 全文用 `skill_manage.read`，见 `[P0]skill_manage_tool.md`）。

**与 skill_manage 的边界**：`skill` 工具 = 对话中按需加载用（progressive disclosure L1），只读 enabled skill；`skill_manage` 工具 = 管理用（create/patch/disable/enable/list/read），list 含 disabled、read 可读 disabled 全文。

**为什么不做 list**：skill 列表（L0：name+description+mutable）**常驻 system prompt**（见 `../context/[P0]system_prompt.md` §4 `skills` mapper）。agent 不需要工具 list——它已从 system prompt 知道有哪些 skill、各自 description。`skill_manage.list` 存在是因为管理场景需要看全部 skill（含 disabled），与对话中按需加载不同。

## 2. 接口定义

```typescript
interface SkillTool {
  /**
   * 读取一个 skill 的 SKILL.md 全文 + 目录绝对路径。
   * 用于 progressive disclosure 的 L1（L0 已由 system prompt 注入）。
   */
  read(input: { name: string }): SkillContent;
}

interface SkillContent {
  name: string;            // skill name（kebab-case）
  skillDir: string;        // skill 目录绝对路径（用于 L2 钻取：agent 可用 Read 工具读 references/scripts）
  body: string;            // SKILL.md 全文（含 frontmatter + 正文）
  scope: "app" | "workspace";  // 命中的 scope（同名时 workspace 胜出，见 skill_definition §4.1）
}
```

### 2.1 输入

| 字段 | 类型 | 必需 | 说明 |
|------|------|------|------|
| `name` | string | 是 | skill name（kebab-case，与 SKILL.md frontmatter `name` / system prompt L0 一致） |

### 2.2 输出（SkillContent）

| 字段 | 说明 |
|------|------|
| `name` | 回显 skill name |
| `skillDir` | skill 目录绝对路径。agent 可据此用 Read 工具读 `references/*.md` 等（L2 钻取） |
| `body` | SKILL.md 全文（frontmatter + 正文），对应 progressive disclosure 的 L1 |
| `scope` | 命中的 scope。双层同名时 workspace 级胜出（见 skill_definition §4.1） |

## 3. 寻址规则（双层合并）

1. 按 `name` 在 `<workspace>/.rocky/skills/<name>/SKILL.md` 查找（workspace 级）。
2. 未命中 → 在 `<dataDir>/skills/<name>/SKILL.md` 查找（app 级）。
3. 仍未命中 → 抛 `SkillNotFoundError`（带 name + 已查路径）。
4. 命中 → 返回 SkillContent，`scope` 标实际命中层。

> workspace 级优先的理由见 `skill_definition.md` §4.1。

## 4. 错误

| 错误 | 触发 | 处理 |
|------|------|------|
| `SkillNotFoundError` | name 在两层都不存在 | 工具结果返回错误信息（agent 可向用户说明或忽略） |
| `SkillMalformedError` | SKILL.md 无 frontmatter / 缺 name / name 不匹配目录 | 工具结果返回错误信息（不 crash session） |

读操作不涉及治理字段（不写不入），无 mutable 检查。

## 5. 与 system prompt 的关系（避免循环）

- **L0（system prompt 注入）**：所有 skill 的 `name + description` 合并去重后注入 system prompt `skills` mapper（见 system_prompt §4）。agent 由此知道有哪些 skill、何时用。
- **L1（skill 工具读）**：agent 决定用某 skill 时，调 `skill` 工具取全文。**工具不重复返回 L0**（不把 catalog 再塞一遍）。
- **L2（Read 工具钻取）**：agent 拿到 `skillDir` 后，用已有 Read 工具读 `references/*`（无需新工具）。

## 6. skill_manage 工具（已设计，见 `[P0]skill_manage_tool.md`）

`skill_manage` 是 agent 管理 skill 的工具，与 `skill`（纯读）区分：

| 工具 | 用途 | 读 disabled? | list? |
|------|------|-------------|-------|
| `skill`（本工具） | 对话中按需加载（L1） | 否（只读 enabled） | 否（L0 常驻 prompt） |
| `skill_manage` | 管理用（create/patch/disable/enable/list/read） | 是（list 含 disabled，read 可读 disabled 全文） | 是（管理场景需看全部） |

`skill_manage` 动作受 `mutable` 治理（`mutable=false` 拒绝 patch/disable/enable），见 `skill_definition.md` §6 + `[P0]skill_manage_tool.md`。

## 7. 设计决策

- **纯读（enabled only）**：对话中按需加载用，只读 enabled skill（disabled 不在 L0 catalog）。管理场景用 `skill_manage`。
- **不做 list**：L0 catalog 常驻 system prompt，对话场景工具 list 冗余。`skill_manage.list` 供管理场景用（含 disabled）。
- **返回 skillDir**：让 L2 钻取复用已有 Read 工具，不造新工具。
- **scope 回显**：让 agent 知道 skill 来自哪层（debug/透明），双层同名时显式说明 workspace 胜出。
- **工具名 `skill`**：纯读语义清晰；管理工具命名 `skill_manage`（见 `[P0]skill_manage_tool.md`）。

## 8. 文件级变更清单

| 文件 | 操作 | 变更内容 |
|------|------|---------|
| `app/server/src/tools/skill.ts`（或 plugin） | 新增 | `SkillTool`（read action）：双层寻址 → 返回 SkillContent |
| `app/server/src/skills/resolver.ts`（暂定） | 新增 | 双层 scope 解析：workspace 级优先 → app 级 fallback；供 skill 工具 + system prompt skills mapper 共用 |
| `app/web/...` skill 管理 UI | 新增 | install/enable/delete/preview（见 PRD/UI spec） |

> 精确文件路径在 arch/coder 阶段按实际代码结构确定；本表给职责粒度。

> 变更历史见 `log.md`（本 KB 位置轴）+ `specs/tech/version_logs/vX.Y/change_log.md`（跨版本发布说明）。
