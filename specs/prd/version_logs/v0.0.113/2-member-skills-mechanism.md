# ② 成员 skills 叠加快照机制（产品行为详解）[v0.0.113]

> 归属：`change_log.md §2.2`。本文详述成员编辑「skills」板块的 switch 语义 + 局部开关快照的**产品行为**。
> **新概念声明**：「成员局部 skill 开关快照」是 v0.0.113 引入的新数据概念，其**数据结构 + resolve 逻辑属技术实现，需 architect 先落 tech spec**（`change_log.md §6 O-1/O-2`）。本文只定义「用户看到什么、怎么交互、期望结果」。

---

## 1. 概念背景（对齐已有 skill 架构）

已有概念（权威 `specs/tech/agent/skills/[P0]skill_architecture.md` + `handlers/session-config.ts`）：

- **全局 skill catalog（三层）**：builtin < app（`<dataDir>/skills/`）< workspace（`<workspaceDir>/.rocky/skills/`），同名 workspace 覆盖 app。
- **全局 enable/disable**：存 `app_config` 的 `skill_state` group（key=skill name，data `{enabled,scope}`），fallback 缺省 enabled=true。全局 skill 页（`page-skill`）的 toggle 改这里。
- **旧 studio 机制（D4，本版本废弃）**：studio 成员 session skills = `catalog.entries.filter(e => e.enabled && member.skills.includes(e.name))`——member.skills 是**白名单/allow-list**，取「全局 enabled ∩ member 白名单」的交集。因 member.skills 现存 4 个死占位（planning/testing/research/coding，catalog 无对应），交集恒空。

**本版本用「叠加（overlay）」替换「交集（intersection）」**：off=纯继承全局；on=全局配置 overlay 局部开关快照。

---

## 2. switch 两态（用户视角）

成员编辑面板「skills」section 顶部一个 switch：

### 2.1 off = 继承全局 skills（默认）

- switch 关闭时，下方筛选器**收起**（不展示 skill 列表）。
- 该成员 session **及其 subagent** 的可见 skills = **workspace skills（永远生效）** + **全局 enabled skills**（= 全局 skill 页配置的 enabled 项，as-is）。
- 无任何局部覆盖；成员完全跟随全局配置。
- **默认新成员 = off**（继承全局）。

### 2.2 on = 自定义 skills

- switch 打开时，下方**展开「简化版全量 skill 筛选器」**（见 §4）。
- 该成员可见 skills = **workspace skills（永远生效）** + **全局 skill 配置 叠加 已保存的局部开关**。
  - 叠加口径（overlay）：以全局配置为底，局部开关快照有记录的 skill 用快照值覆盖；快照没记录的 skill（如后续新增）按**全局配置**生效。
- 局部开关快照 = 该成员保存时的一份「skill name → on/off」冗余开关信息。

---

## 3. 叠加快照机制（核心产品行为 — 务必实现正确）

用户原话拆解为 5 条不可违背的产品规则：

| 规则 | 描述 |
|------|------|
| R1 生效叠加 | 成员 global-skill 可见性 = 全局 skill 配置 **叠加** 已保存局部开关；快照有记录 → 用快照；无记录 → 跟全局。 |
| R2 workspace 恒生效 | workspace 层 skill 永远对该成员 session + subagent 生效，不受 switch / 快照影响。 |
| R3 新增 skill 按全局 | on 保存后，全局新增的 skill（快照里没有该 name）→ 按**全局配置**生效（不因快照旧而被漏掉/误关）。 |
| R4 打开页面展示叠加效果 | 下次打开该成员配置页，筛选器展示「**全局所有 skill ∪ 快照叠加**」后的每项当前效果（每个 skill 的当前 on/off = 叠加结果）。 |
| R5 保存补齐快照 | 点保存时，把当前筛选器里**新出现的 skill**（之前快照没有的）开关补进快照（快照随全局 skill 增长而补全）。 |

**另一条（off→on 重置）**：
| R6 off 保存清空 | switch off 保存后再 switch on → 快照**清空**，全部恢复全局开关（on 重新从「全跟全局」起步，不复用历史快照）。 |

### 3.1 时序示例（帮助理解，非实现约束）

设全局 enabled skills = {A:on, B:on, C:on}，workspace skills = {W}。

1. 成员 switch=on，把 B 关掉，保存 → 快照 = {B:off}（A/C 未动=跟全局）。
   - 成员可见 = W + A + C（B 被局部关）。
2. 全局新增 skill D（enabled）。成员未重开配置页。
   - 成员可见 = W + A + C + D（D 不在快照 → 跟全局 enabled，R3）。
3. 成员重开配置页 → 筛选器展示 A:on, B:off, C:on, D:on（D 按全局，R4）。点保存 → 快照补 D → {B:off, D:on}（R5；D 当前值=on 入快照）。
4. 成员 switch=off 保存 → 快照清空。再 switch=on → 筛选器全部按全局（A/B/C/D 全 on），无历史局部（R6）。

---

## 4. 简化版 skill 筛选器（UI 描述）

on 时下方展开的筛选器，**参考全局 skill 页（`page-skill`）但简化**：

**保留**：
- 全量 skill 列表（每行 = skill name + description 省略 + 一个开关/勾选）。
- 可选顶部搜索框（按 name 过滤，skill 多时用）。
- 开关即时反映叠加后当前态（R4）。

**去掉（相对全局 skill 页）**：
- ❌ skill 详情预览 modal（文件树 / 内容）。
- ❌ 安装 drop-zone（拖拽/选择文件）。
- ❌ 删除按钮 + 删除确认 modal。
- ❌ 编辑 / evolvable 治理 toggle。
- 即：**只做 enable/disable 开关 + 搜索**，是一个纯「可见性开关列表」，不是 skill 资产管理器。

**布局稳定性（MANDATORY）**：switch off↔on 切换时筛选器出现/收起**绝不能导致其他 section（当前任务 / 心跳配置）位移**——用高度过渡动画或预留空间实现，禁止 `display:none`+常规流导致相邻 section 跳动。

---

## 5. 与 session/subagent 的关系

- 生效对象 = 该成员的 session **及其派生的 subagent**（subagent 跟随 parent member 的 skill 可见性）。
- 与已有 skill 三层机制的关系：本机制只影响「全局 skill（app 层，含 builtin 视 architect 决策）对该成员的可见性」；workspace 层始终生效（R2）。
- 全局 skill 页的 enable/disable 是**全局默认**；成员 on 时的局部快照是**该成员的覆盖层**，叠加在全局之上。

---

## 6. 验收标准

| 编号 | 断言 |
|------|------|
| A-1 | off（默认）：成员 session skills = workspace + 全局 enabled（无局部过滤）。 |
| A-2 | on + 关某 skill + 存：该成员该 skill 不生效，其余跟全局。 |
| A-3 | on 存后全局新增 skill：该成员按全局配置生效该新 skill（R3）。 |
| A-4 | 重开配置页：筛选器展示全局所有 skill 的叠加效果（R4）；保存补齐新 skill 进快照（R5）。 |
| A-5 | off 存 → 再 on：快照清空，全部恢复全局开关（R6）。 |
| A-6 | workspace skill 在 off/on/任意快照下均对成员 session + subagent 生效（R2）。 |
| A-7 | 布局：switch 切换筛选器出现/收起不导致其他 section 位移。 |

---

## 7. 交 architect / coder（新概念落地清单）

1. **tech spec（architect）**：局部 skill 开关快照数据模型（模式 inherit/custom + 快照 map 存哪）；overlay resolve 逻辑替换 `session-config.ts` 的 D4 交集；off→on 快照清空规则；快照补齐规则（R5）。
2. **ui 组件 spec（coder 编码前置）**：简化版 skill 筛选器组件（testid 契约）+ member-panel skills section 结构（switch testid + 筛选器 + 删 model/记忆 testid）。
3. **不兼容旧数据**：旧 `member.skills` 白名单 + `SKILL_OPTIONS` 占位常量直接删，无迁移。
