# v0.0.113.ui_opt — UI 优化四件套（skill 页滚动 / 成员 skills 重构 / 记忆板块删除 / 模型 hover 展示）

> 类型：UI 优化 + 成员配置语义重构（① bug 修 + ② 交互重构含新数据概念 + ③ 板块删除 + ④ 展示修正）
> 引入版本：v0.0.113 · 状态：PRD 设计中（待用户确认）
> 前置概念权威源（已读对齐）：
> - `specs/ui/components/studio-page/member-panel.md`（成员面板 5 section + testid 契约）
> - `specs/ui/components/skill-page/page-skill.md`（skill 管理页布局/视觉基线）
> - `specs/ui/components/chat-page/component-input-model-picker.md`（模型 picker hover 预览三态 + testid 契约）
> - `specs/tech/agent/skills/[P0]skill_architecture.md`（三层 skill catalog + enabled 持久化 + resolve）
> - `specs/prd/overall/06-skill.md`（skill 子系统产品定义）+ `08-squad-studio.md §8.2 D`（成员编辑）
> - 现状代码事实：`section-member-panel.tsx` / `section-member-chat.tsx` / `component-input-model-picker.tsx` / `model-resolver.ts` / `handlers/session-config.ts`（D4 交集）
> **详细分文件**：② 成员 skills 叠加快照机制见 `2-member-skills-mechanism.md`。

---

## 1. 背景与范围

用户对 studio 团队管理 + skill 页提出 4 个 UI 优化点。四点相互独立，可并行开发：

1. **① skill 配置页无法上下滚动**（bug）：全局 skill 管理页（`page-skill`）内容超视口高度时无法滚动，底部卡片被截断看不到。
2. **② 成员编辑「技能与模型」板块重构**：现有 skills 用 4 个死占位选项（planning/testing/research/coding），运行时被交集过滤后实际全空；model 模块与对话界面模型入口冗余。重构为「继承/自定义」switch + 全量 skill 叠加快照筛选器；删 model 模块；板块改名 skills。
3. **③ 成员编辑「记忆」板块删除**：会话界面已有记忆入口，成员编辑面板内的记忆 section 冗余。
4. **④ studio 模型选择 hover 展示「未配置」**：成员在 squad 内、team 继承全局、member 也未单独配模型时，对话能正常 resolve 到默认模型，但模型入口 hover 却显示「未配置」，应展示实际生效模型名 +「（默认）」标识。

**范围**：主要为前端 UI 改动；② 引入新数据概念（成员局部 skill 开关快照）需 architect 落 tech spec 数据模型 + resolve 逻辑；④ 涉及 studio 模型 resolve 链展示语义，含一处 spec↔code 不一致待架构钉死。

---

## 2. 功能需求

### 2.1 ① Skill 管理页可上下滚动（bug 修复）[v0.0.113]

**描述**：全局 skill 管理页（nav → skill，`page-skill`）内容纵向超出视口时，页面必须能上下滚动，底部 skill 卡片/drop-zone 完整可达。

**优先级**：P0（功能可达性 bug）

**用户故事**：作为管理 skill 的用户，当已安装 skill 数量较多、页面内容高于视口时，我希望能上下滚动看到并操作所有 skill 卡片，而不是底部内容被截断无法触达。

**用户行为链路**：nav-rail 点 `skill` → 进入 skill 管理页 → 安装多个 skill 使内容超视口 → 向下滚动 → 看到并可操作底部卡片。

**功能交互细节**：
- 页面在内容高于视口时出现纵向滚动，header 区（标题 + sub desc）可随内容一起滚动或保持现有布局（不强制 sticky，保持现有视觉基线 `page-skill.md §视觉基线`）。
- 保持现有布局：header `border-b` 分隔 + body `max-width 880px` 左对齐不变。
- 现状根因（供 architect/coder 参考，非产品约束）：`page-skill` 根 `<main>` 同时 `flex-1 overflow-y-auto flex flex-col`，body 区 `flex-1` 未设 `min-height:0`，flex 撑高吃掉滚动。具体修法留 coder。

**界面要素**：纯布局/CSS 修复，无新增 testid，不改数据契约。

**验收标准**：内容超视口时可滚动到底部，最后一个 skill 卡片完整可见可点。

---

### 2.2 ② 成员编辑「skills」板块重构 [v0.0.113]

> **完整产品行为（switch 语义 + 叠加快照机制）见 `2-member-skills-mechanism.md`**。此处给概述。

**描述**：成员编辑面板（`member-panel`）的「技能与模型」section 重构为「skills」section：
- **skills 用一个 switch**：`off = 继承全局 skills`（收起下方内容）/ `on = 自定义 skills`（下方展开「简化版全量 skill 筛选器」）。
- **删除 model 模块**（与对话界面模型入口冗余）。
- **section 标题从「技能与模型」改为「skills」**。

**优先级**：P0

**用户故事**：作为团队管理者，我希望在成员编辑里用一个开关决定该成员「继承全局 skills」还是「自定义 skills 开关」，自定义时能像全局 skill 页一样逐个开关 skill，且新增的 skill 会自动按全局配置生效，以便管理成员能力而不必手动同步每次全局变更。

**用户行为链路**：
- 单聊点成员头像 → 进 member 面板 → 「skills」section →
  - **off（默认/继承）**：switch 关，下方收起，该成员 session + subagent 的 skills = workspace skills + 全局 enabled skills。
  - **on（自定义）**：switch 开 → 下方展开筛选器（全量 skill 列表，每项一个开关 + 搜索）→ 逐项开关 → 右下悬浮保存 → 保存局部开关快照。
- 生效范围：该成员 session **及其 subagent**。

**生效语义（产品口径）**：该成员可见 skills = **workspace skill（永远生效）** + 全局 skill 配置**叠加**已保存局部开关的结果。详见 `2-member-skills-mechanism.md`。

**界面要素（简化版 skill 筛选器）**：
- 比全局 skill 页（`page-skill`）简化：**只做 enable/disable 开关列表 + 搜索**，**不含** skill 详情预览 / 安装 drop-zone / 删除 / 编辑。
- 每行 = skill name + description（省略）+ 开关；顶部可选搜索框按 name 过滤。
- switch off ↔ on 切换时下方筛选器的出现/收起**不得导致其他 section 位移**（用高度动画或预留，保持布局稳定 MANDATORY）。

**约束**：
- **不兼容旧数据**（用户拍板）：旧 `member.skills` 白名单（planning/testing/research/coding 死占位）直接推翻重写，无需数据迁移/兼容。
- 现有 `SKILL_OPTIONS` 常量（`squad-types.ts:186`）+ 现有 `MultiCheck` skills 编辑器（testid `member-skills-editor`）+ 现有 `ModelPicker`（testid `member-model-input`）均删除/替换。
- 新概念「成员局部 skill 开关快照」+ 新 UI 筛选器组件 + 新 testid **需先落 ui/tech spec**（交 architect + coder 编码前置产组件 spec）。

**验收标准**：off 时该成员 skills = 全局 enabled；on 时按快照叠加；新增 skill 未记录时按全局配置生效；off 保存后再 on = 快照清空恢复全局；切换不导致布局位移。

---

### 2.3 ③ 成员编辑「记忆」板块删除 [v0.0.113]

**描述**：删除成员编辑面板中的「记忆」section（当前 `member-section-memory`，内嵌 `MemberPanelMemory`：summary 展示 + compact 触发）。理由：会话界面已有记忆入口，面板内记忆管理冗余。

**优先级**：P1

**用户故事**：作为团队管理者，我在成员编辑面板里不再需要单独的记忆管理入口，因为对话界面已提供记忆管理，避免重复入口造成混淆。

**用户行为链路**：单聊点成员头像 → 进 member 面板 → 面板中**不再有**「记忆」section（只剩 姓名介绍 / 当前任务占位 / skills / 心跳配置）。

**界面要素**：
- 移除 `member-section-memory` section + `member-panel-memory-tab` 标题 + `MemberPanelMemory` 子组件挂载。
- 相关 testid（`member-section-memory` / `member-memory-summary` / `member-memory-compact-btn` / `member-panel-memory-tab`）从 member-panel 移除（组件 spec `member-panel.md` 需同步更新）。
- 布局：删除后剩余 section 顺序自然上移，不留空位。

**约束**：仅删 member 面板内的记忆入口；会话界面（chat）记忆入口不动；后端 session_memory 机制不动（纯前端删入口）。

**验收标准**：member 面板不再渲染记忆 section；会话界面记忆功能不受影响。

---

### 2.4 ④ studio 模型选择 hover 展示实际生效模型（默认）[v0.0.113]

**描述**：studio 成员/群聊对话界面的模型选择入口（`InputModelPicker`，chat-input-bar 内），当 member 与 squad（team）都未配置模型（team 继承全局）时，hover 预览菜单当前展示「未配置」，但对话实际能 resolve 到全局默认模型。诉求：hover 应展示**实际会生效的那个模型名 +「（默认）」标识**，而非「未配置」。

**优先级**：P1

**用户故事**：作为 studio 成员对话用户，当团队和成员都没单独配模型（继承全局默认）时，我希望模型入口 hover 告诉我「实际用的是哪个模型（默认）」，而不是误导性的「未配置」——因为对话其实能正常工作。

**用户行为链路**：
- 进 studio → 打开某成员单聊（或群聊）→ member 未配模型 + squad `modelDefault` 为空（继承全局）→ hover 模型选择入口（`chat-model-picker`）→ 预览菜单（`model-picker-preview`）展示 **「{全局默认模型名}（默认）」**（而非「未配置」）。
- 三级链：member → squad → global。前两级都没配时展示实际 resolve 到的 global 默认。

**功能交互细节**：
- 「未配置」仅在**三级链跑完确实无可用模型**时才展示（真未配）；只要能 resolve 到某个模型（含继承 global 默认），就展示该模型名 +「（默认）」。
- **针对入口**：主要针对**成员/群聊对话界面的模型 picker**（`InputModelPicker`，`section-member-chat.tsx` + `section-squad-chat.tsx` 内，testid `chat-model-picker` / hover 预览 `model-picker-preview`）。成员编辑面板内的 model 入口已在 ② 删除，不涉及。
- 现状根因（供 architect 参考，非产品定方案）：studio picker 的 `defaultModel` 仅由父级透传 `squad.modelDefault`；squad 继承全局时该字段为空 → picker 拿不到全局默认 → 显「未配置」。picker 需要知道「实际会生效的默认模型」（三级链 resolve 结果）。

**约束 / 开放技术点**：④ 的 resolve 链修正 + 前端如何拿到「实际生效默认模型」属技术实现，留 architect（见 §6）。PRD 只定义展示口径。

**验收标准**：member + squad 均未配、team 继承全局时，hover 展示实际生效模型名 +「（默认）」；真无可用模型时才显「未配置」。

---

## 3. 关键用户路径（MANDATORY — 测试最低覆盖）

每条路径 = 至少一个 API/E2E case。

| ID | 路径 | 类型 |
|----|------|------|
| P-1 skill页滚动 | nav→skill → 安装多 skill 使超视口 → 向下滚动 → 底部卡片完整可见可点 | E2E |
| P-2 成员skills-off继承 | 进 member 面板 → skills switch=off（默认）→ 该成员 session skills = workspace + 全局 enabled | E2E + API |
| P-3 成员skills-on自定义+新增skill | switch=on → 展开筛选器 → 关某 skill + 存 → 快照生效；之后全局新增 skill（不在快照）→ 该成员按全局配置生效 | E2E + API |
| P-4 成员skills-off再on恢复全局 | on 存 → off 存 → 再 on → 快照清空，全部恢复全局开关 | E2E + API |
| P-5 记忆板块已移除 | 进 member 面板 → 面板不含记忆 section（无 `member-section-memory`） | E2E |
| P-6 模型hover展示默认 | studio 成员单聊（member+squad 未配、继承全局）→ hover 模型入口 → 展示「{默认模型}（默认）」而非「未配置」 | E2E |
| P-7 model模块已删 | 进 member 面板 → skills section 无 model 入口（无 `member-model-input`）；标题为 skills | E2E |

---

## 4. E2E Use Cases

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-1 | nav 点 skill → 安装若干 skill 使内容超视口 → 页面向下滚动 | 底部 skill 卡片完整可见、可点 toggle/删除，无截断 |
| UC-2 | 单聊点成员头像 → member 面板 → 看 skills section（switch 默认 off） | 板块标题为 skills；switch=off；下方筛选器收起；无 model 入口 |
| UC-3 | member 面板 → skills switch 打开 on | 下方展开全量 skill 筛选器（开关列表 + 搜索），其余 section 无位移 |
| UC-4 | on 状态关闭某 skill → 点右下悬浮保存 | 保存成功；快照记录该 skill=off；重开面板该 skill 仍为 off，其余按全局展示 |
| UC-5 | on 存 → switch off 存 → 再 switch on | 筛选器回到全部按全局开关（快照已清空恢复全局） |
| UC-6 | 单聊点成员头像 → member 面板 | 面板不含记忆 section（无记忆 summary / compact 按钮） |
| UC-7 | studio 成员单聊（member+squad 未配、team 继承全局）→ hover 模型入口 | hover 预览展示「{全局默认模型名}（默认）」，不显示「未配置」 |
| UC-8 | member 面板 skills section 查看 | 无 model 选择入口（model 模块已删）；标题为 skills |

---

## 5. 设计决策（用户拍板）

| 决策 | 选择 | 理由 |
|------|------|------|
| ② 旧 member.skills 白名单 | 不兼容旧数据，直接推翻重写 | planning 等 4 项本就是死占位（catalog 无对应，运行时交集全空），无迁移价值 |
| ② skills 生效语义 | 全局配置 **叠加** 局部开关快照（overlay），废弃旧「交集/白名单」(D4) | 交集语义让占位选项过滤掉一切；overlay 让 off=继承全局、on=局部覆盖，新增 skill 自动按全局生效 |
| ② workspace skills | 永远生效（不受 member switch 影响） | 项目级 skill 是团队约定，成员开关只管全局 skill 可见性 |
| ② off 保存再 on | 快照清空，全部恢复全局开关 | off=纯继承，不保留历史局部开关，语义干净 |
| ② model 模块 | 删除 | 与对话界面模型入口冗余 |
| ② section 标题 | 「技能与模型」→「skills」 | 删 model 后仅剩 skills |
| ③ 记忆 section | 删除 | 会话界面已有记忆入口 |
| ④ hover 展示 | 展示实际生效模型 +「（默认）」，非「未配置」 | 对话能 resolve 到默认，展示应反映真实生效链（member→squad→global） |
| 流程 | 全自动推进，需求已明确 | 用户确认 |

---

## 6. 需 architect 决策的开放技术点

| 编号 | 开放点 | 说明 |
|------|--------|------|
| O-1 | ② 成员局部 skill 开关快照**数据模型** | 新概念：替换 `member.skills`（whitelist）为「模式（inherit/custom）+ 局部开关快照 map」。需落 `specs/tech/` 数据结构 + 存储（member entity 字段 / app_config？）。PRD 只定产品行为。 |
| O-2 | ② overlay resolve 逻辑替换 D4 交集 | `session-config.ts` 当前 `catalog ∩ member.skills`（D4）。新逻辑：off→全局 enabled；on→全局配置 overlay 快照；workspace 永远生效。需重写 studio 分支 skills 解析。 |
| O-3 | ② 简化版 skill 筛选器组件 + testid | 新 UI 组件（enable/disable 列表 + 搜索），需 coder 编码前置落 `specs/ui/components/` 组件 spec + testid 契约（复用/参考 skill-page item 但简化）。 |
| O-4 | ④ studio 模型 resolve 链是否读 global 默认 | 核心矛盾：`model-resolver.ts` 明文核心约束「studio 分支 MUST NOT 读 app_config.default_models」，但 req 称对话能 resolve 到 global 默认。需钉死：squad.modelDefault 是否创建时 seed 自全局？还是 resolver 需为 studio 增读 global？（见 §7 spec↔code 不一致） |
| O-5 | ④ 前端如何拿「实际生效默认模型」 | studio `InputModelPicker` 现只收 `squad.modelDefault` 作 defaultModel；继承全局时为空。需定：前端自拉 global 默认（如 playground `defaultModel===undefined` 自 fetch 分支）/ 后端返回 resolve 后的 effective model / 其他。 |
| O-6 | ②③ member-panel 组件 spec testid 变更 | `member-panel.md` 需更新：删记忆/model testid，加 skills switch + 筛选器 testid，section 标题改名。coder 编码前置产 spec。 |

---

## 7. spec↔code 不一致记录（发现于 PRD 阶段，交 architect 钉死）

| 位置 | 不一致 | 建议 |
|------|--------|------|
| `handlers/session-config.ts:134` 注释 vs `model-resolver.ts` 实现 | 注释写 studio modelId 回退链 `... ?? squad.modelDefault ?? app_config 默认（D5）`，但 `model-resolver.ts` 核心约束明文「studio 分支 MUST NOT 读 app_config.default_models」，`buildFallbackChain` studio 链也确无 app_config 读取。二者矛盾。 | architect 钉死 studio 是否应回退 global 默认（关联 ④ / O-4）。若不读，squad.modelDefault 空 + member 空时 studio chain 抛 `ModelNotConfiguredError`——与「对话能 resolve 到默认」的 req 陈述冲突，须核实 squad.modelDefault 实际是否为空（可能创建时 seed）。同步修正注释或实现。 |
| `member-panel.md` 组件 spec | spec 仍描述 skills=`MultiCheck`(SKILL_OPTIONS 4 占位) + model=`ModelPicker`；旧 gap 段还提 `member-systemprompt-input` stale。本版本 ② 后 skills 改 switch+筛选器、删 model、③ 删记忆。 | doc-modifier/coder 编码前置同步 `member-panel.md`（testid + section 结构 + 视觉基线）。 |

---

## 8. 范围边界

### IN [v0.0.113]
- ① skill 页滚动修复；② 成员 skills switch + 叠加快照筛选器 + 删 model + 改名；③ 删记忆 section；④ studio 模型 hover 展示实际生效模型（默认）。

### OUT（显式不做）
- 会话界面记忆入口改动（③ 只删 member 面板入口）。
- 全局 skill 页（`page-skill`）功能改动（① 仅修滚动，不改功能）。
- squad/member 其他配置字段。
- playground 模型 picker 行为（④ 仅针对 studio；playground 已正确）。
- skill 后端安装/删除/预览逻辑。
