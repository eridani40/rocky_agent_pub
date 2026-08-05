# v0.0.21 PRD 变更日志

## 概述

本版本交付 **最小可用的 Skill 子系统**：左侧 nav 新增 Skill 入口 → skill 管理页（拖拽/选择安装 + 列表 + 预览 + 开关 + 删除）+ agent 侧 skill 读工具 + system prompt 注入 enabled skill 的 L0（name+description）。

一句话：**用户在 UI 里安装 / 启停 / 预览 / 删除 skill；agent 通过 system prompt 知道有哪些 skill（L0），按需调 skill 工具读 SKILL.md 全文（L1）行动。**

权威输入：`reqs/v0.0.21/req.md` + 设计稿 `reqs/v0.0.21/easy-opc-skill-v10.html`（视觉契约）+ `states/v0.0.21/user_query.md`（4 条决策）。
spec 权威源（已 reconcile）：
- tech：`specs/tech/agent/skills/`（overview / skill_definition / skill_tool，v0.3）
- ui：`specs/ui/components/skill-page/`（7 组件）+ `specs/ui/components/framework/nav-rail.md`（第 5 项）
- system prompt：`specs/tech/agent/context/[P0]extension point and implementations.md`（`skills` mapper 占位）

---

## 1. 版本定位

### 1.1 范围

**IN（v0.0.21 三方向）**：
1. **Skill 管理 UI**：nav 第 5 项 `skill` → `page-skill`（多 tab 容器，当前仅「Skill 管理」1 个 tab）/ drop-zone（拖拽 + 选择文件/文件夹，全格式 folder/zip/.skill，**走后端解压**，非前端 JSZip mock）/ list（卡片：固定渐变星形 logo + name + 状态 badge + description + toggle + 预览按钮 + 删除按钮）/ preview modal（左整树 + 右文件内容懒取）/ delete modal（确认 → 物理删除）
2. **skill 读工具**：tool 名 `skill`，纯读，input `{name}` → `{name, skillDir, body, scope}`；双层寻址（workspace 优先 → app 级 fallback）；**无 list**（L0 常驻 system prompt）
3. **system prompt skills 注入**：`skills` mapper 填肉（已占位 no-op）→ 把合并去重后的 catalog（`name + description`，workspace 胜出同名）注入 system prompt L0；`tool_guidance` 自动介绍 `skill` 工具

**OUT（本版本明确排除）**：

| 排除项 | 理由 |
|--------|------|
| agent 写技能（create/patch/edit/archive） | self-evolution，roadmap（见 skill_tool §6） |
| skill 工具 list | L0 常驻 system prompt，list 冗余占 token（永不做） |
| `.claude/skills/` 路径 | 偏离 Electron app 模型，改 `.rocky` 双层（见 skill_definition §4.2） |
| skill 自定义 icon / logo | logo 固定渐变星形；frontmatter 无 icon 字段 |
| skill market / 分发 / 供应链安全 | P1+ |
| 治理字段强制（mutable 拒写） | 无 agent 写入动作可强制，仅记录（见 overview §治理） |
| skill 改 mutable / 编辑 frontmatter | UI 只做 install/enable/delete/preview |
| 前端解压（JSZip） | 设计稿 mock，生产走后端安装（见 drop-zone spec 决策） |

### 1.2 关键决策记录

| 决策 | 选择 | 出处 |
|------|------|------|
| 整体范围 | 最小可用（UI 管理 + 读工具 + L0 注入），不做 agent 写技能 | user_query 决策 1 |
| 存储 | 双层 `.rocky`：app 级 `<dataDir>/skills/` + workspace 级 `<workspace>/.rocky/skills/`，**不用 `.claude/`** | user_query 决策 2 / skill_definition §4 |
| 安装 | 后端 API + 全格式（folder/zip/.skill，加 zip 依赖），不照搬设计稿前端 JSZip mock | user_query 决策 3 / drop-zone spec |
| 工具契约 | 纯读 `skill`（name → 全文+路径+scope），**无 list**；列表常驻 system prompt | user_query 决策 4 / skill_tool §1 |
| 双层覆盖优先级 | **workspace 级覆盖 app 级**（同名 workspace 胜出） | skill_definition §4.1 |
| 工具名 | `skill`（纯读语义清晰；旧 `skill_manage` 暗示含写） | skill_tool §7 |
| 删除 | 物理删除（不可撤销，对齐设计稿文案） | delete-modal spec |
| logo | 固定渐变星形，不支持自定义 | skill-item spec |

### 1.3 待用户确认（非阻断）

**`<workspace>/.rocky/skills/` 是否随 git 共享？**

- **推荐**：**默认不进 git（个人本地，加入 `.gitignore`）**。
- **理由**：
  1. skill 是用户**个人安装的运行时资产**（类似 `node_modules`），非项目源码；进 git 会污染 repo、放大 diff、跨成员冲突。
  2. 团队共享 skill 应走**专门分发渠道**（future skill market / registry），而非「塞 repo」。
  3. app 级 `<dataDir>/skills/` 本就不进 git（在用户 home）；workspace 级保持一致更可预测。
  4. 若团队确需共享，可由用户**手动**取消 gitignore（spec 不强制）。
- **影响**：install 后端写入 `<workspace>/.rocky/skills/` 时，若该目录未在 `.gitignore`，不主动忽略也不主动添加（尊重用户 repo 配置）；app 启动时建议在 workspace 根生成 `.gitignore` 条目（**可选，标 P2，本期不强制**）。
- **标注**：`[待用户确认]`，AFK 期间按推荐推进。

---

## 2. 功能点清单

### 2.1 Skill 管理页（UI）

对齐 `specs/ui/components/skill-page/`。所有数据走**后端 skill API**（list/install/toggle/delete/tree/file），endpoint 待 api 阶段定稿，UI spec 锁定数据契约 + 视觉。

| 组件 | 职责 | 视觉契约 |
|------|------|---------|
| `page-skill` | 页根，组合 header + tabs + drop-zone + list，挂载取列表，乐观更新 | 设计稿 §config-area |
| `component-skill-tabs` | 多 tab 容器（**当前仅「Skill 管理」1 个**，预埋扩展） | 设计稿 §skill-tabs |
| `component-skill-drop-zone` | 拖拽 / 选择文件 / 选择文件夹 → multipart 上传后端 install | 设计稿 §drop-zone |
| `section-skill-list` | 列表容器（空态 + 卡片纵向排列） | 设计稿 §skill-list |
| `component-skill-item` | 单卡：固定渐变星形 logo + name + badge + desc(2 行省略) + toggle + 预览 + 删除 | 设计稿 §skill-card |
| `component-skill-preview-modal` | 左整树（一次性 `/tree`）+ 右内容（按 path 懒取 `/file`） | 设计稿 §pv-modal |
| `component-skill-delete-modal` | 确认 → 物理删除（不可撤销） | 设计稿 §modal |
| nav-rail 第 5 项 `skill` | 四角星图标，view id `skill` → `page-skill` | 设计稿 §icon-nav skill |

**SkillItem 数据契约**：`{id, name, description, enabled}`（name/description fallback 自 SKILL.md frontmatter，缺失时 name←目录名、description←「未提供介绍」）。

### 2.2 skill 读工具（agent tool）

对齐 `specs/tech/agent/skills/[P0]skill_tool.md`。

- **接口**：`read({name}) → {name, skillDir, body, scope}`
- **寻址**：workspace 级 `<workspace>/.rocky/skills/<name>/SKILL.md` → app 级 `<dataDir>/skills/<name>/SKILL.md` → `SkillNotFoundError`
- **body**：SKILL.md 全文（frontmatter + 正文）= progressive disclosure L1
- **skillDir**：供 agent 用已有 Read 工具钻取 references/scripts（L2，无需新工具）
- **scope**：回显命中层（透明 + debug）
- **错误**：`SkillNotFoundError` / `SkillMalformedError`（无 frontmatter / 缺 name / name 与目录不符）→ 工具结果返回错误信息，不 crash session

### 2.3 system prompt skills 注入

对齐 `specs/tech/agent/context/[P0]extension point and implementations.md`（`skills` mapper 已占位 no-op，本期填肉）。

- **触发**：system_prompt mapper 链（mapper→reducer→builder）中的 `skills` mapper
- **内容**：合并 app 级 ∪ workspace 级（按 `name` 去重，**workspace 胜出**）→ 注入每条 `name + description`（L0 catalog）
- **范围**：仅 `enabled=true` 的 skill 参与（disabled skill 不进 L0）—— **本期约定**（与 UI toggle 联动，待 api 阶段确认 enabled 状态存储位置）
- **tool_guidance**：现有自动介绍工具机制会自动把 `skill` 工具介绍进 system prompt，无需额外工作

---

## 3. 关键用户路径（MANDATORY — 测试最低覆盖）

| ID | 用户操作链路 | 预期结果 | 类型 |
|----|-------------|---------|------|
| **路径 A** | 点 nav `skill` → 进入 skill 管理页 | 显示 header + 1 个 tab「Skill 管理」+ drop-zone + list（空态或已装 skill 列表） | E2E |
| **路径 B** | 拖拽/选择文件夹 → drop-zone 收集 → 后端 install（解压 + 解析 SKILL.md + 持久化到 `.rocky/skills` 或 `dataDir/skills`）→ 列表刷新 | 新 skill 卡片出现（name + description 来自 frontmatter） | E2E + API |
| **路径 C** | 拖拽/选择 .zip / .skill 文件 → 后端 install（zip 解压）→ 列表刷新 | 新 skill 卡片出现 | E2E + API |
| **路径 D** | 点 skill 卡片 toggle → enabled/disabled → 后端 PATCH `{enabled}` → 重新发消息 | toggle 切换；system prompt 是否注入该 skill 的 L0（name+desc）随 enabled 变化 | E2E + API |
| **路径 E** | 点预览按钮 → modal 打开 → 左侧整树（一次性 `/tree`）→ 点文件 → 右侧懒取文本内容（`/file?path=...`） | 看到文件树 + 点文件看文本（含 SKILL.md / references） | E2E + API |
| **路径 F** | 点删除按钮 → delete modal 打开（含 skill name + 「无法撤销」警告）→ 确认 → 后端物理删除 → 列表移除 | 列表中该 skill 消失；目录从持久化移除 | E2E + API |
| **路径 G（agent 侧）** | 用户发消息 → agent 在 system prompt 看到 enabled skill 的 L0 列表（name+desc）→ agent 判断需用 → 调 `skill` 工具(name) → 返回 SKILL.md 全文(L1) + skillDir → agent 据此行动（可 Read references 做 L2 钻取） | agent 正确触发 skill 工具、拿到全文、据此响应 | API（真 LLM） |

**路径数确认**：7 条（A-G），覆盖 UI 全操作（导航/安装×2 格式/启停/预览/删除）+ agent 侧链路。每条至少 1 个 API/E2E case。

---

## 4. 非目标（NON-GOALS）

- agent 通过工具 create / patch / edit / archive skill（self-evolution，roadmap）
- skill 工具 `list`（L0 常驻 system prompt，永不做）
- `.claude/skills/` 路径（改 `.rocky` 双层）
- skill 自定义 icon / logo 字段（固定渐变星形）
- skill market / 第三方分发 / 供应链安全（ClawHub 等，P1+）
- 治理字段（source/production_method/mutable）强制（仅记录，无写入动作可强制）
- skill 版本管理（git tag / semver）
- skill 与 plugin_system extension_point 的关系（未定）
- 前端 JSZip 解压（设计稿 mock，生产走后端）

---

## 5. 设计决策（已确认，对齐 spec）

### 5.1 为什么是「最小可用」而非全套 self-evolution

skill spec v0.2 定义了 `skill_manage` 全套写操作（create/patch/edit/archive），但本期目标是**先把 skill 的消费侧跑通**（用户装、agent 读）。agent 写技能属 self-evolution，依赖治理护栏（mutable）与 memory 一级整理，复杂度高，留 roadmap。对齐 overview §子系统定位 + skill_tool §1。

### 5.2 为什么双层 `.rocky` 而非 `.claude`

Claude Code 是 CLI（CWD=项目，home=个人）；rocky_agent 是 Electron app（workspace=打开的目录，dataDir=app 数据根）。用 `.rocky/` 命名区分自家生态，与 Claude Code 的 `.claude/` 互不读取。迁移映射：原「项目级」→ workspace 级，原「个人级」→ app 级。对齐 skill_definition §4。

### 5.3 为什么安装走后端而非前端 JSZip

设计稿 `easy-opc-skill-v10.html` 的 JSZip 是浏览器 mock，生产实现需持久化 + 解析 frontmatter + 跨格式（folder/zip/.skill）+ 写双层目录，前端做不可靠（权限/路径/原子性）。后端统一安装：multipart 上传 → 解压 → 解析 SKILL.md → 持久化 → 扫 frontmatter 返回 SkillItem。对齐 drop-zone spec §决策。

### 5.4 为什么 skill 工具无 list

skill 列表（L0：name+description）经 `skills` mapper **常驻 system prompt**，agent 已知道有哪些 skill、各自 description（即触发器）。工具 list 冗余且重复占 token。`skill` 工具只做 L1（按 name 读全文）。对齐 skill_tool §1。

### 5.5 子决策：workspace 覆盖 app

双层同名时 workspace 级胜出：workspace 更近用户当前任务，团队可在 repo pin 特定版本覆盖全局默认；与现有 `.claude/skills/`（项目覆盖个人）方向一致，心智可迁移。L0 注入取 workspace 的 description，L1 寻址命中 workspace 路径。对齐 skill_definition §4.1。

### 5.6 子决策：工具名 `skill` 而非 `skill_manage`

纯读语义用 `skill` 清晰；旧名 `skill_manage` 暗示含写，易误导。未来若实现写工具，可命名 `skill_manage` 区分。对齐 skill_tool §7。

---

## 6. 验收口径

| 维度 | 口径 |
|------|------|
| UI 功能 | 路径 A-F 全部 E2E PASS（Playwright + vision_check） |
| 视觉保真 | 设计稿 `easy-opc-skill-v10.html` 比对：layout/font/border/color 四维度 + brand/nav/drop-zone/card/badge/toggle/modal 关键元素，整体风格基本一致 |
| API | install（folder/zip/.skill 三格式）/ list / toggle / delete / tree / file 全 PASS；skill 工具 read 双层寻址 + 错误 PASS |
| agent 侧 | 路径 G 真 LLM：enabled skill 的 L0 进 system prompt + agent 正确触发 skill 工具拿全文（真服务，非 mock） |
| 双主题 | light/dark 全组件 PASS |

---

## 7. PRD ↔ spec 对齐核对（MANDATORY）

| 核对点 | PRD | spec | 一致 |
|--------|-----|------|------|
| 存储路径 | `<dataDir>/skills/` + `<workspace>/.rocky/skills/` | skill_definition §4 | ✅ |
| 工具契约 | `skill` 纯读，name→全文+路径+scope，无 list | skill_tool §1-§3 | ✅ |
| 范围 | 最小可用（UI 管理 + 读 + L0 注入），不做写技能 | overview §范围 / skill_tool §6 roadmap | ✅ |
| 组件命名 | page-skill / skill-tabs / drop-zone / list / item / preview-modal / delete-modal | skill-page/ 7 组件 | ✅ |
| nav | 第 5 项 `skill` 四角星 | nav-rail.md | ✅ |
| L0 注入 | skills mapper（enabled only） | extension point §skills mapper | ✅ |

version: v0.0.21（最小可用 Skill 子系统）
