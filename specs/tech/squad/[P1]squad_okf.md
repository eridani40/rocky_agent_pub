---
type: spec
title: OKF 文档组织建议（squad 工作目录）
priority: P2
status: active
updated: 2026-08-02
since: v0.0.33.3
---

# OKF 文档组织建议（squad 工作目录）

> 定位：okf 方法（Open Knowledge Format，业务无关，见 `.claude/skills/okf-skill/`）作为 squad 工作目录内容组织的**轻量建议**——非强制结构、无后台投影、agent 工具不依赖 okf 文件布局。本文给出 squad 场景下采用 okf 时的根布局、frontmatter 总则、坏链容忍、index/log 规则。
> 哲学：一个目录的 md + YAML frontmatter（`type` 唯一必填）、关系用标准相对路径链接、**坏链 = 待写的知识（必须容忍）**、变更显式记 `log.md`、增量更新永不重写、规范立在「结构」上不立在「工具」上。
> 边界：squad 工作目录**不强制** okf；agent 可按 okf 组织（推荐），也可朴素 markdown。无"OKF 主面 + store 投影"双轨、无工具同步约束。

---

## 1. 工作目录根布局（建议）

squad 工作目录根 = `data_dir/squads/{squadId}/`（与 member store `members/{id}.json` 同根）。建议区分**最终成果**与**草稿/试错**：

```
data_dir/squads/{squadId}/
├── (okf 知识库 — agent 自愿组织，非强制)
│   ├── index.md                  # 入口（agent 手写或维护）
│   ├── log.md                    # 变更记录，ISO 日期倒序（§4）
│   └── *.md                      # 按 okf type 组织的知识文件
├── 交付/                          # 最终成果（用户可感、可交付的产出）
├── temp/                          # 草稿 / 试错 / 中间产物
├── reports/{daily,...}/*.md       # 报告（已有目录）
└── members/{id}.json              # store member（按 squadId 分片落此；entity='members' 复数）
```

- **交付 vs temp 区分**：`交付/` 放最终成果（leader/user 验收的对象），`temp/` 放草稿与试错（可随时清理）。命名建议带日期版本（如 `方案-20260802.md`）便于追溯。
- **okf 子结构由 agent 自愿维护**：agent 可用 okf 方法（index/log + type frontmatter）组织知识，也可朴素 markdown；工具层零依赖 okf 文件布局。
- **store 与 okf 无投影关系**：member store（`members/{id}.json`）是工具读写面；okf md 是 agent 工作笔记面，两者无自动同步、无冲突仲裁。

---

## 2. frontmatter 总则（采用 okf 时）

- 每个文件 YAML frontmatter，**`type` 是唯一必填字段**（机器路由 / 过滤核心开关）。
- `type` 自由命名（如 `report` / `note` / `design` / `decision`），无固定枚举——按 squad 工作需要自定。
- 日期 ISO（`YYYY-MM-DD`）；`created` 不可变，`updated` 每次改。
- 字段缺失 / 未知字段 → 消费端**容忍**（OKF 宽容消费，不报错）。

---

## 3. 关系与链接

- **标准 markdown 相对路径**（如 `[设计 A](../temp/设计-A.md)`），**禁用 `[[]]` 双链**（不可移植）。
- 反链靠**显式字段**或正文链接，不维护反向索引。

---

## 4. 坏链容忍（OKF 核心设计）

- 任何相对路径链接的目标**不存在 = "待写的知识"**，不是错误。
- 消费端（agent 读 okf / grep 搜索）**必须容忍**：渲染成"待建"占位 + 记 warning。
- 例：index.md 引用 `方案-X.md` 但该文件还没建 → index 仍可读，方案待补。

---

## 5. index.md / log.md（采用 okf 时）

- **index.md**：squad 知识库入口（agent 手写维护，列出当前知识文件 `标题 + 链接 + 一句话`）。agent 进 okf 先读 index。
- **log.md**：变更记录，ISO 日期**倒序**（最新在前）。每次写 / 改知识文件 → append 一行。可追溯、可审计。
```
## 2026-08-02
- 新增 note「性能优化思路」（by leader）
- 更新 report 08-01 daily（by member-xxx）
```

---

## 6. 边界 + 衔接

| 零件 | 归属 |
|---|---|
| okf 文档组织建议（根布局 / frontmatter / 坏链容忍 / index/log） | 本文 ✅ |
| okf 方法本身（业务无关，skill 教程） | `.claude/skills/okf-skill/` |
| okf-skill（教 okf 规范给全员） | skill 目录 |
| squad 工作目录布局（outputs/reports/members/.rocky 等管理性子目录） | `[P1]squad_workspace.md` |
| member store（工具读写面，与 okf 无投影关系） | `[P1]data_model.md §1.2/§3` |

---

---

> 变更历史见 [\`log.md\`](log.md)（本 KB 位置轴）+ [\`specs/tech/version_logs/vX.Y/change_log.md\`](../version_logs/)（跨版本发布说明）。
