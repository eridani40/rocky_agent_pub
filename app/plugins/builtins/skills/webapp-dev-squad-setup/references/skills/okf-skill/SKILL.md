---
name: okf-skill
description: OKF（Open Knowledge Format）文档化知识管理方法——把一套知识（目标/需求/任务、技术文档、规范、笔记……任意领域）组织成「一个目录的 markdown 文件 + frontmatter」，用文件工具读写搜索。何时加载——要在某个 OKF 知识库（任意 .md 目录）里读/写/搜索/新建知识节点，或要建立/整理一套文档时。**业务无关、可复用**：只教纯 OKF 方法（目录=知识库、type frontmatter、相对链接、坏链容忍、index/log、增量更新、文件工作流），**不含任何具体业务的类型/存储/工具/角色**——那是各消费方自己的事。
---

# OKF（Open Knowledge Format）—— 文档化知识管理方法

## 1. 是什么（心智模型，先读）

OKF = 把一套知识管理成**「一个目录的 markdown 文件」**。每个 `.md` = 一个知识节点。

规范立在**结构**上（目录布局 + frontmatter + 相对链接），**不立在任何工具/数据库上**——所以任何
`bash` / `grep` / `cat` / 编辑器 / `git` 都能消费它。结果：可移植、可版本管理、可长期演进。

**OKF 只管「文档怎么组织」。** 同一套知识可能**并行**还用别的方式管理（结构化存储、专用工具、UI……）——
那是**消费方的事**，OKF 不关心、不规定。有哪些 type、要不要同步到别处、谁能读写——全由消费方定。

## 2. 核心规则（六条，记住这六条就够用）

1. **知识库 = 一个目录**：一个目录（含子目录）= 一个知识库（KB）；每个 `.md` = 一个知识节点（id ≈ 相对路径去 `.md`）。
2. **frontmatter `type` 唯一必填**：每个 `.md` 顶部 YAML frontmatter 里 **`type` 必填**（机器路由/过滤的核心开关）；**有哪些 type 由消费方定**。其余字段可选，消费端**宽容**（缺失/未知字段不报错）。
3. **关系 = 标准 markdown 相对路径链接**：`[标题](../dir/x.md)`；**禁用 `[[]]` 双链**（不可移植）。反链靠**显式字段**（如 `parent: ../a.md`），不维护反向索引。
4. **坏链容忍**：链接目标不存在 = **「待写的知识」，不是错误**。消费端容忍 + 记 warning，**不阻断工作**。
5. **`index.md` + `log.md` 是保留名**（每个 KB 各一）：`index.md` = 入口/总览（进 KB 先读它）；`log.md` = 变更记录，ISO 日期**倒序**、append-only。
6. **增量更新、永不重写**；**现状与变更分离**：正文 = 当前现状（查现状 / 全量）；变更进 `log.md`（查改变 / 增量）。

## 3. frontmatter 速写

- `type` 必填；ID（若用）全 KB 唯一、稳定；日期 ISO（`YYYY-MM-DD`），`created` 不可变、`updated` 每次改。
- 字段缺失 / 未知字段 → **宽容消费，不报错**。
- 通用示例（**`type` 名仅示意，按你的领域定**）：

```yaml
---
type: note            # 你的领域定：spec / concept / goal / task / ...
title: 示例节点
created: 2026-06-30
updated: 2026-06-30
related: [../other.md]   # 相对路径链接（可选）
---
正文 = 当前现状。
```

## 4. 知识库布局

```
<kb-root>/
├── index.md          # 入口/总览：列全节点 id+title+链接（进来先读）
├── log.md            # 变更记录，ISO 倒序、append-only
├── <子目录>/          # 按你的领域分组（子目录可作子 KB，父 index 链向子 index）
│   └── {节点}.md      # 知识节点 = frontmatter + 正文
└── ...
```

`log.md` 格式（ISO 倒序，最新在前）：

```
## 2026-06-30
- 新增 note「示例节点」
- 更新 spec「X」：补 §3 边界
```

## 5. 文件工作流（你日常的姿势）

| 操作 | 姿势 |
|---|---|
| 查全貌 | `cat index.md` |
| 查单项 | `cat <子目录>/{节点}.md` |
| 搜索 | `grep -rn "关键词" --include='*.md' .` |
| 改 | `write` / `edit` 直接改 md（frontmatter `updated` 同步刷新） |
| 新建 | 建 md + 写合法 frontmatter（`type` 必填）+ append `log.md` 一行 |
| 追变更 | append `log.md`（ISO 倒序，最新在前）—— 别把变更史堆进正文 |

## 6. 边界：OKF 不管什么（这些是消费方的事）

- **有哪些 type / 字段 schema**：你的领域自己定（例：squad 用 goal/kr/requirement/task；tech specs 用 index/spec/concept）。
- **要不要同步到别处**（结构化存储 / 数据库 / 专用工具 / UI / 看板）：那是消费方**并行的另一种方式**，OKF 不碰、不规定同步责任。
- **谁能读写哪些**（权限 / 角色 / 可见性）：消费方的治理，OKF 不管。

> OKF 只保证：一个目录的 md + frontmatter + 相对链接，可移植、可 grep、可长期演进。具体怎么用它管你那套知识——看你的消费方规范（如 squad 的 teamwork 技能、项目的文档规范）。
