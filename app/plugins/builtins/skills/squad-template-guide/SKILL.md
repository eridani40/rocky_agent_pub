---
name: squad-template-guide
description: 如何创建自定义 Rocky Agent 团队模板。何时加载——用户想自定义/创建/复用 squad 模板、想了解模板目录结构和 manifest 字段、想搭建自己的团队配置包时。
---

# 团队模板创建指南

## 1. 什么是团队模板

团队模板 = **可复用的 squad 配置包**。把一个配置好的 squad（团队规则 + agent 定义 + skills + memory + 模板 + 命令 + 权限）打包成模板，创建新 squad 时选「从模板创建」，一键得到结构完整、团队就绪的 squad（leader + N mate + 全部配置文件）。

| 概念 | 说明 |
|---|---|
| **template** | 模板（slug 目录下 manifest.json + 配置文件） |
| **builtin template** | 随 app 打包的模板（`builtin: true`，启动时自动复制到用户目录） |
| **manifest.json** | 模板元信息 + mate 清单 |

## 2. 模板目录结构

```
{slug}/
├── manifest.json          # 元信息 + mate 清单
├── AGENTS.md              # 团队规则（创建 squad 时复制到 squad 根）
├── .rocky/
│   ├── agents/            # {role}.md（如 prd.md, coder.md）
│   ├── skills/            # 通用 skills
│   ├── memory/            # group memory
│   ├── templates/         # 工作模板文件
│   ├── commands/          # 命令文件
│   └── settings.json      # 权限配置
```

## 3. manifest.json 字段说明

```json
{
  "slug": "my-team",
  "name": "My Team",
  "description": "一句话描述",
  "leaderName": "Alice",
  "leaderIntro": "团队 leader，负责分配任务",
  "builtin": false,
  "members": [
    { "name": "developer", "intro": "开发者...", "skillConfig": { "mode": "inherit", "overrides": {} } }
  ]
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `slug` | string | ✅ | 唯一标识（kebab-case，= 目录名） |
| `name` | string | ✅ | 显示名 |
| `description` | string | ✅ | 一句话描述 |
| `leaderName` | string | ✅ | 预填 leader 名（用户创建时可改） |
| `leaderIntro` | string | ❌ | 预填 leader intro |
| `builtin` | boolean | ✅ | 是否 builtin（随 app 打包） |
| `members` | MemberSpec[] | ✅ | mate 清单（不含 leader） |

**MemberSpec**：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | ✅ | mate 名（如 `developer`） |
| `intro` | string | ✅ | 一句话介绍 |
| `skillConfig` | object | ✅ | skill 叠加配置：`{ mode: "inherit", overrides: {} }` |

## 4. agent 文件命名

模板中 agent 文件用 **`{role}.md`**（如 `prd.md`、`coder.md`），不含 memberId。

创建 squad 时自动改名为 `.rocky/agents/{name}-{memberId}.md`：

```
模板 .rocky/agents/prd.md     →  新 squad .rocky/agents/prd-01XYZ.md
模板 .rocky/agents/coder.md   →  新 squad .rocky/agents/coder-01ABC.md
```

## 5. 泛化原则

模板内容分两类：

**A 类 — 固定写死（团队方法论）：**

团队工作流、状态流转、质量关卡、spec 驱动方法论、角色分工、协作纪律——这些是模板创造的**概念体系**，是模板的核心价值，直接写死在 AGENTS.md 和 agent 文件中。

**B 类 — 不绑定具体项目（环境/工具）：**

| 内容 | 原则 |
|---|---|
| 测试框架 | 不假设具体框架（不写死 vitest / jest / pytest） |
| 项目目录 | 不假设具体路径（不写死 `tests/api/`、`src/`） |
| 构建工具 | 不假设 bun / vite / webpack / make |
| 脚本路径 | 不写死具体脚本名 |

**一句话原则：模板即插即用，不限制用户的技术栈。** A 类方法论是模板的灵魂，B 类环境细节留给用户自己填。

## 6. 模板放哪里

| 类型 | 位置 |
|---|---|
| 用户自定义模板 | `~/.rocky_agent_prod/squad-templates/{slug}/` |
| builtin 模板 | 随 app 打包，启动时自动复制到用户目录 |

builtin 模板（`builtin: true`）每次启动覆盖用户目录同名 slug，保证最新版生效；用户自定义模板（`builtin: false`）不会被覆盖。

## 7. 创建步骤

1. **创建目录**：`~/.rocky_agent_prod/squad-templates/{your-slug}/`
2. **写 manifest.json**：按 §3 字段填写，`slug` = 目录名
3. **放配置文件**：
   - `AGENTS.md` — 团队规则
   - `.rocky/agents/{role}.md` — 每个 mate 的角色定义
   - `.rocky/skills/` / `.rocky/memory/` / `.rocky/templates/` / `.rocky/commands/` — 按需放置
   - `.rocky/settings.json` — 权限配置（可选）
4. **重启 app** — builtin 模板复制在启动时执行
5. **验证**：`GET /squad-templates` 返回的列表中应包含你的模板
6. **使用**：创建新 squad 时，NewSquadModal 下拉选择你的模板

## 8. 完整示例

以下是一个精简的「双人开发团队」模板示例：

**目录结构**：

```
mini-dev-team/
├── manifest.json
├── AGENTS.md
└── .rocky/
    └── agents/
        └── coder.md
```

**manifest.json**：

```json
{
  "slug": "mini-dev-team",
  "name": "Mini Dev Team",
  "description": "精简二人团队：leader + coder",
  "leaderName": "Lead",
  "leaderIntro": "团队 leader，负责任务分配与协调",
  "builtin": false,
  "members": [
    {
      "name": "coder",
      "intro": "代码开发者，实现任务并编写测试",
      "skillConfig": { "mode": "inherit", "overrides": {} }
    }
  ]
}
```

**创建 squad 时的效果**：

- 建 squad + leader（名 = `Lead`，用户可改）
- hire 1 个 mate（`coder`），自动生成 memberId
- 复制 `AGENTS.md` → squad 根目录
- 复制 `.rocky/agents/coder.md` → `.rocky/agents/coder-{memberId}.md`
- 结果：一个结构完整、立即可用的二人 squad
