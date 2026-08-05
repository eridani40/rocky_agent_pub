# Skill 子系统 — 产品需求文档 [v0.0.21] [v0.0.149 modified]

> version: 1.2 · 引入版本 v0.0.21 · 最后更新：2026-07-24（v0.0.198：「我的」tab 两处 UI 优化 — 安装弹层 + 来源筛选）
> 本文承载 Skill 子系统的全量产品定义（v0.0.21 引入最小可用版）。增量见 `specs/prd/version_logs/v0.0.21/change_log.md` + `specs/prd/version_logs/v0.0.149.memory_opt/change_log.md` + `specs/prd/version_logs/v0.0.198.skill_ui/change_log.md`。
> 概念权威源：`specs/tech/agent/skills/`（overview / skill_definition / skill_tool，v0.3）+ `specs/ui/components/skill-page/`（7 组件）+ `specs/ui/components/framework/nav-rail.md` + `specs/tech/agent/context/`（system_prompt `skills` mapper）。

## 目录

| 章节 | 说明 |
|------|------|
| §6.1 产品概述 | skill 定位、目标用户、核心价值 |
| §6.2 功能需求 | UI 管理 / skill 读工具 / system prompt L0 注入 |
| §6.3 关键用户路径（MANDATORY） | 7 条核心路径（测试最低覆盖） |
| §6.4 范围边界（IN / OUT） | v0.0.21 scope |
| §6.5 设计决策 | 双层存储 / 纯读工具 / L0 注入 / 物理删除 |
| §6.6 验收口径 | UI / 视觉 / API / agent 侧 |

---

## 6.1 产品概述 [v0.0.21]

### 6.1.1 定位

skill 是 agent 的**可复用能力载体**（标准 `SKILL.md`，兼容 Claude Code / OpenClaw 生态）。Skill 子系统管 skill 的**定义、存储、加载、读取**。

v0.0.21 交付**最小可用**：用户在 UI 安装/启停/预览/删除 skill；agent 通过 system prompt 知道有哪些 enabled skill（L0），按需调 `skill` 工具读 SKILL.md 全文（L1）行动。

一句话：**用户装 skill，agent 用 skill。**

### 6.1.2 目标用户

- **终端用户**：在 skill 管理页拖拽安装 skill、启停、预览内容、删除。
- **agent**：经 system prompt L0 感知可用 skill，调 `skill` 工具读全文行动。
- **自动化（verifier）**：curl skill API、Playwright 驱动 skill 管理页验证视觉/功能、真 LLM 验证 agent 触发 skill 工具。

### 6.1.3 核心价值

1. **可复用**：标准 SKILL.md 协议，兼容生态，不造新协议。
2. **渐进披露（progressive disclosure）**：L0 catalog 廉价常驻 system prompt；L1 全文按需；L2 references 深度钻取。控 token。
3. **双层 scope**：app 级（全局）+ workspace 级（项目），同名 workspace 覆盖 app。
4. **最小可用**：先跑通消费侧（装/读），写技能（self-evolution）留 roadmap。

---

## 6.2 功能需求

### 6.2.1 Skill 管理页（UI）[v0.0.21]

对齐 `specs/ui/components/skill-page/`。所有数据走**后端 skill API**（list/install/toggle/delete/tree/file），endpoint 待 api 阶段定稿。

**导航**：nav-rail 第 5 项 `skill`（四角星图标），view id `skill` → `page-skill`。

**页面结构**（`page-skill`）：
- header：标题「Skill 管理」+ sub desc
- tab 栏（`component-skill-tabs`）：**`[v0.0.167]` 2 个 tab「我的」(manage，默认激活) / 「市场」(market)**（v0.0.167 前仅「我的」单 tab，label 原为「Skill 管理」）；切 tab 不卸载「我的」列表 state（常驻）
- drop-zone（`component-skill-drop-zone`）：拖拽 / 选择文件 / 选择文件夹 → multipart 上传后端 install（**后端解压**，非前端 JSZip）
- list（`section-skill-list`）：空态「还没有已安装的 Skill」/ 纵向排列 `component-skill-item` 卡片

**单卡**（`component-skill-item`）：固定渐变星形 logo + name + 状态 badge（已启用/已禁用）+ description（2 行省略）+ toggle + 预览按钮 + 删除按钮。受控（enabled 由父持有 + 后端持久化）。**`[v0.0.55 modified]`** 加第 2 个 toggle **自进化(evolvable)**（复用 nav skill 列表，不另做 panel）；字段 `mutable → evolvable` 改名 + 删 `mutableLocked` 维度（v0.0.51 刚引入零历史包袱）；`PATCH /skill/:name/governance` 简化为只改 evolvable。详见 `specs/prd/version_logs/v0.0.55.memory_ui_session_lock/change_log.md` §2.3。**`[v0.0.167]`** name 行加只读**来源徽标**：有 `marketRef`→「市场」/ 否则「本地」（区分市场安装 vs 本地创建/上传）。

**预览 modal**（`component-skill-preview-modal`）：左文件树（**一次性整树** `/tree`，默认全展开 dir）+ 右内容（按 path 懒取 `/file`，mono `<pre>`）。820×560。

**删除 modal**（`component-skill-delete-modal`）：确认 → **物理删除**（不可撤销，对齐设计稿文案）。

**SkillItem 契约**：`{id, name, description, enabled, evolvable}` **`[v0.0.167]` +`marketRef?`/`marketSource?`**（来源徽标数据；`marketRef`=安装来源 provider ref，`marketSource`=provider id）。name/description 来自 SKILL.md frontmatter（缺失 fallback 目录名 / 「未提供介绍」）。

### 6.2.1b 市场 tab [v0.0.167]

对齐 `specs/tech/agent/skills/[P1]skill_market.md`（后端）+ `specs/ui/components/skill-page/section-skill-market.md`（前端）。复用 v0.0.166 交付的市场后端（`/skills/market/{capabilities,search,detail,install}`）。

- **能力协商门控**：`SectionSkillMarket` 挂载即调 `GET /skills/market/capabilities` → `503`（无 provider）渲染 noProvider 引导态，否则据声明维度渲染（skills.sh 仅声明 `stats:['installs']`）。**信息维度由 capabilities 门控，不造假 skills.sh 无的数据**（多源侧栏/分类/排序/stars/版本均不渲染——详见 §6.4 non-goals）。
- **搜索 + 结果网格**：搜索框 → `GET /skills/market/search?q=` → 结果卡（`component-market-item`，只显示 name/ref/installs，无 description——search 不返回）。
- **详情弹窗**（`component-market-detail-modal`）：点卡 → `GET /skills/market/detail?ref=` 取 readme + 文件列表 → 一键安装 `POST /skills/market/install`（202）。
- **同源识别（精确 ref 匹配）**：市场 `item.ref === 已安装 skill.marketRef` → 卡显示「已安装」（列表即时判定，零额外请求）。
- **可更新态（惰性判定）**：详情弹窗点「检查更新」拉当前 `detail.hash` 与已安装 `installedHash` 比对，不同→「可更新」→ 更新走 `installMarketSkill(ref,{overwrite:true})`（**同源覆盖守卫**：后端只在读磁盘 frontmatter `market_ref` 与请求 ref 相同才覆盖，MUST NOT 覆盖本地/异源同名 skill）。

### 6.2.1c 「我的」tab UI 优化 [v0.0.198]

对齐 `specs/prd/version_logs/v0.0.198.skill_ui/change_log.md`。纯前端版本，**零后端 API 变更**（GET /skill 仍全量返回；数据规模个位~几十，分页 no-op 已砍）。两处改造：

1. **安装区默认收起 + 「+」按钮弹层**：tab 栏最右加黑色「+」按钮（ml-auto 固定位），点击展开 `component-skill-drop-zone`（原有拖拽/选择交互不变），「取消」/再点「+」收起；**安装成功（POST /skill/install 202）自动收起**（强约束）。实现：`component-skill-tabs` 加 `actionSlot?: React.ReactNode` **通用右槽**（`ml-auto self-center`，tabs 不关心槽内是何元素），`page-skill` 持 `installExpanded` state + 把「+」按钮塞 actionSlot——不在 tabs 里塞业务语义（`expanded`/`onToggleInstallZone`）。
2. **来源筛选条**：列表上方加 4 选项筛选（全部 / 内置 / 市场 / Rocky），**纯 filter**（全量已在 `page-skill` state），切来源 tab 直接重算可见列表，无分页。Rocky hover tooltip「来自于 Rocky 的自我迭代和进化」。映射：内置=`scope==='builtin'`、市场=`marketRef` 非空、Rocky=`productionMethod==='consolidation'`（三类基本互斥，不做交集）。新 UI 元素 `component-skill-source-filter`（受控组件 + 导出纯函数 `filterSkillsBySource`）。

**布局稳定性（INV）**：「+」按钮 `shrink-0` + 固定 26×26 空间（不随 expanded 切换位移）；安装区展开/收起用**条件渲染**（`{installExpanded && <DropZone/>}`）而非 display:none / 高度 transition——收起态彻底卸载 drop-zone（含内部 file input ref），dragOver 落不到不可见元素，简单干净。

**视觉说明**：本版本无设计稿，按现有 skill 页组件视觉调性延伸（全 token、双主题无特判）。

### 6.2.2 skill 读工具（agent tool）[v0.0.21]

对齐 `specs/tech/agent/skills/[P0]skill_tool.md`。

- **tool 名**：`skill`（纯读语义清晰）
- **接口**：`read({name}) → {name, skillDir, body, scope}`
- **寻址**：workspace 级 `<workspace>/.rocky/skills/<name>/SKILL.md` → app 级 `<dataDir>/skills/<name>/SKILL.md` → `SkillNotFoundError`
- **body**：SKILL.md 全文（frontmatter + 正文）= L1
- **skillDir**：供 agent 用已有 Read 工具钻取 references/scripts（L2，无需新工具）
- **scope**：回显命中层
- **错误**：`SkillNotFoundError` / `SkillMalformedError` → 工具结果返回错误，不 crash session
- **无 list**：L0 常驻 system prompt，list 冗余

### 6.2.3 system prompt L0 注入 [v0.0.21]

对齐 `specs/tech/agent/context/`（`skills` mapper 已占位 no-op，本期填肉）。

- **触发点**：system_prompt mapper 链（mapper→reducer→builder）的 `skills` mapper
- **内容**：合并 app 级 ∪ workspace 级（按 `name` 去重，**workspace 胜出**）→ 注入每条 `name + description`
- **范围**：仅 `enabled=true` 的 skill 参与（与 UI toggle 联动）
- **tool_guidance**：现有自动介绍工具机制自动把 `skill` 工具介绍进 system prompt

---

## 6.3 关键用户路径（MANDATORY — 测试最低覆盖）

| ID | 用户操作链路 | 预期结果 | 类型 |
|----|-------------|---------|------|
| 路径 A | 点 nav `skill` → 进入 skill 管理页 | header + **`[v0.0.167]` 2 tab（我的/市场）** + drop-zone + list（空态/已装）；**`[v0.0.198]` 安装区默认收起、tab 栏最右「+」按钮** + 列表上方**来源筛选条**（全部/内置/市场/Rocky） | E2E |
| 路径 B | 拖拽/选择文件夹 → 后端 install（解压+解析+持久化）→ 列表刷新 | 新 skill 卡片出现 | E2E + API |
| 路径 C | 拖拽/选择 .zip/.skill → 后端 install（zip 解压）→ 列表刷新 | 新 skill 卡片出现 | E2E + API |
| 路径 D | toggle → enabled/disabled → 后端 PATCH → 发消息 | system prompt L0 是否含该 skill 随 enabled 变化 | E2E + API |
| 路径 E | 预览按钮 → modal → 左整树 → 点文件 → 右懒取文本 | 文件树 + 点文件看文本 | E2E + API |
| 路径 F | 删除按钮 → delete modal → 确认 → 物理删除 → 列表移除 | 列表移除；目录持久化移除 | E2E + API |
| 路径 G（agent 侧） | 发消息 → system prompt 见 L0 → agent 调 skill 工具(name) → 返回全文(L1)+skillDir → 据此行动 | agent 正确触发、拿全文、据此响应 | API（真 LLM） |
| 路径 H（市场，[v0.0.167]） | 切市场 tab → capabilities 门控渲染 → 搜索 → 点卡看详情 → 一键安装 → 回列表见来源徽标；同源已装卡显「已安装」，检查更新判「可更新」 | 市场安装落 app scope 写 market_ref/hash；同源识别 + 可更新惰性判定 | E2E + API |

**路径数**：8 条（A-H），覆盖 UI 全操作 + agent 侧链路 + [v0.0.167] 市场 tab。每条至少 1 个 API/E2E case。

---

## 6.4 范围边界

### IN [v0.0.21]
1. Skill 管理 UI（nav / page / tabs / drop-zone / list / item / preview modal / delete modal）
2. skill 读工具（`skill`，纯读，name→全文+路径+scope）
3. system prompt skills L0 注入（`skills` mapper 填肉）
4. 后端安装 API（folder/zip/.skill 全格式，后端解压）
5. 双层存储（`<dataDir>/skills/` + `<workspace>/.rocky/skills/`）

### OUT [v0.0.21]
- agent 写技能（create/patch/edit/archive，self-evolution roadmap）
- skill 工具 list（L0 常驻 system prompt，永不做）
- `.claude/skills/` 路径（改 `.rocky` 双层）
- skill 自定义 icon（固定渐变星形）
- ~~skill market / 分发 / 供应链安全（P1+）~~ **`[v0.0.166]` 后端交付 + `[v0.0.167]` 前端市场 tab 交付**（skills.sh provider + capability negotiation + 同源覆盖守卫 + 惰性可更新；见 §6.2.1b）。**仍 OUT**：多源侧栏/分类过滤/排序/stars/版本号（skills.sh 无此能力，capability 门控不渲染）、供应链安全审计
- 治理字段强制（mutable 拒写，仅记录）**`[v0.0.51]` 落地 + `[v0.0.55 modified]` UI 化**：mutable 强制执行（false 拒 patch/disable/enable）+ governance HTTP 端点（UI 改 mutable）+ nav skill 列表 evolvable toggle；详见 v0.0.51 / v0.0.55 change_log
- 前端 JSZip 解压（设计稿 mock，走后端）

---

## 6.5 设计决策 [v0.0.21]

| 决策 | 选择 | 理由 |
|------|------|------|
| 整体范围 | 最小可用 | 先跑通消费侧；写技能依赖治理+memory，留 roadmap |
| 存储 | 双层 `.rocky`（app + workspace） | Electron app 模型；区分自家生态，不沿用 CLI 的 `.claude/` |
| 覆盖优先级 | workspace 覆盖 app | 项目级 source of truth，团队可 pin 版本；心智可迁移 |
| 安装 | 后端 API + 全格式 | 持久化/解析/原子性前端做不可靠；设计稿 JSZip 是 mock |
| 工具契约 | `skill` 纯读，无 list | L0 常驻 system prompt，list 冗余占 token |
| 工具名 | `skill`（非 `skill_manage`） | 纯读语义清晰；`skill_manage` 暗示含写 |
| 删除 | 物理删除（不可撤销） | 对齐设计稿文案；skill 是用户主动安装资产 |
| logo | 固定渐变星形 | 本期不支持自定义 icon |

### 6.5.1 待用户确认（非阻断）

**`<workspace>/.rocky/skills/` 是否随 git 共享？**

- **推荐**：**默认不进 git（个人本地，加 `.gitignore`）**。skill 是用户**个人安装的运行时资产**（类似 node_modules），进 git 污染 repo、放大 diff、跨成员冲突。团队共享应走专门分发渠道（future market）。
- **标注**：`[待用户确认]`，AFK 按 recommended 推进。

---

## 6.6 验收口径 [v0.0.21]

| 维度 | 口径 |
|------|------|
| UI 功能 | 路径 A-F 全 E2E PASS（Playwright + vision_check） |
| 视觉保真 | 设计稿 `easy-opc-skill-v10.html` 比对：layout/font/border/color + 关键元素（brand/nav/drop-zone/card/badge/toggle/modal），整体风格基本一致 |
| API | install（folder/zip/.skill 三格式）/ list / toggle / delete / tree / file 全 PASS；skill 工具 read 双层寻址 + 错误 PASS |
| agent 侧 | 路径 G 真 LLM：L0 进 system prompt + agent 正确触发 skill 工具拿全文（真服务，非 mock） |
| 双主题 | light/dark 全组件 PASS |

---

## 6.7 注入总量配额（三类分组 + 总量上限）[v0.0.149]

**描述**：skill 注入加「三类分组顺序 + 总量上限」配额，避免 skill 持续积累把 system prompt catalog 撑爆、挤占 prompt cache 命中率。**frontmatter 同步加 `updated` 字段**支撑组内排序。
**优先级**：P0
**用户故事**：作为深度用户，我希望系统提示注入的 skill 有数量上限并按重要性排序，以便 skill 积累多了也不会把系统提示撑爆、能保留最该用的那些。

**核心规则（注入顺序 = 三类分组优先级，先组间后组内）**：

| 顺序 | 分组 | 语义（spec↔code 漂移：派生键） |
|------|------|------|
| 1 | builtin（系统内置） | `scope==='builtin'`（**必看 scope**，source enum 无 'system'，builtin 在 resolver 落 source='user' fallback） |
| 2 | 用户手动（user） | `source==='user'` 且非 builtin scope |
| 3 | ai 维护（agent） | `source==='agent'` |

- **组内排序**：`updated`/`updatedAt` 倒序（最近更新的优先）。frontmatter 新增 `updated` 字段（ISO 8601），create/patch + governance PATCH 刷新 now；builtin 带固定值；缺字段（legacy）→ 排序按 epoch 0 组内末，tiebreak name 升序。**无 skill migration**（文件型，缺失仅排末，下次编辑自动盖戳）。
- **总量上限**：取前 N（默认 50），N 在应用设置「会话」tab 配置（`maxSkillInject`）。**数量语义 = 总量**（非 per-source 配额），按上述分组优先级连续取，取到 N 截止。
- **纯函数 `selectSkillsByQuota`**（`app/plugins/builtins/rocky_context/prompt/skills.ts`）闭环 selection；截断在 mapper 内，不新增 reducer。
- **skill=stable tier，数量变破 prompt cache**（预期内，本版本目的就是控量）。

**OUT**：per-source 配额；改变 source 的 UI 入口（source 是 originator 一次性盖戳，不可变）。

详见 `specs/prd/version_logs/v0.0.149.memory_opt/change_log.md`（需求 1）+ tech `specs/tech/agent/skills/[P0]skill_definition.md §2/§6.2` + `specs/tech/agent/context/[P0]system_prompt.md §4`。

---

version: 1.2（v0.0.21 引入最小可用 Skill 子系统；v0.0.149 加注入总量配额 + frontmatter `updated` 字段；**v0.0.198 加「我的」tab 两处 UI 优化：安装弹层 + 来源筛选**）
