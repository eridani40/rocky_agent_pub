# v0.0.239 PRD 变更日志 — session 工作区 file tab 文件自然排序

> 版本：v0.0.239 · 主题：session 右侧「工作区」file tab 文件树改自然排序（numeric-aware，对齐 VSCode）——`90.txt` 排在 `100.txt` 前
> 创建：2026-08-02 · 需求源：`reqs/[working] v0.0.239.file_sort/req.md`
> 概念权威源：`specs/ui/components/chat-page/component-workspace-panel.md`（工作区面板 UI 契约，含 tree / childrenCache 数据契约）+ `specs/ui/overall/00-app-guide.md §3.1`（Playground workspace panel 操作路径）
> PRD 边界（用户裁决 2026-07-14）：本文只覆盖**用户可感知**的产品逻辑/体验（排序观察行为）；技术契约（比较器落点是 reducer `setTreeLoaded`/`setChildrenLoaded` 还是渲染层 `TreeLevel`、`localeCompare` 参数、SSE stale 重取 ingest 点）由 architect 落 `specs/tech/version_logs/v0.0.239/change_plan.md`，PRD 不发明技术细节。

---

## 0. 决策基线（用户已拍板，本 PRD 不推翻）

| # | 决策 | 出处 |
|---|------|------|
| D1 | **排序语义 = 自然排序（numeric-aware）**，对齐 VSCode：数字段按数值比较，非数字段按字典序，大小写不敏感 | req.md |
| D2 | **排序位置 = 前端**（用户「前端排序也行」）：reducer / 渲染层加 `localeCompare(b, undefined, { numeric:true, sensitivity:'base' })` 比较器 | req.md + context findings |
| D3 | **覆盖两层**：顶层 `state.tree` + 展开子目录 `state.childrenCache[path]`（SSE stale 重取也走这两个 ingest 点） | context findings |
| D4 | **范围 = 仅 session 工作区 file tab**（chat-page / academy section-version-chat / studio section-right-tabs 三处复用 `SectionWorkspacePanel`，改一处全覆盖） | req.md |
| D5 | **技能管理页 `app/web/src/components/common/file-tree.ts` 同样非数字排序但 OUT OF SCOPE**（如要一致需用户明确扩范围） | req.md + context findings |
| D6 | **流程 = 完整流程 + worktree**；researcher 跳过（自然排序是标准算法、无竞品）；**无设计稿**（视觉保真 compare 跳过） | req.md |
| D7 | **文件夹/文件分组 = VSCode 式文件夹置顶**：dir 先于 file，各自内部按 `localeCompare(b.name, undefined, { numeric:true, sensitivity:'base' })` 自然序——对齐 VSCode 默认 | 用户补充裁决 |

---

## 1. 版本主题（产品语义）

**现状（用户痛点）**：session 右侧「工作区」file tab 的文件列表**全链路无任何排序逻辑**——顺序来自后端 `handleWorkspaceTree` 的 `readdirSync` OS 字节序（macOS 字典序），导致 `100.txt` 排在 `90.txt` **前面**（字典序 `'1' < '9'`），与用户直觉（数字大小）和 VSCode 行为相悖。痛点在文件名含数字段时最明显（如 `1.txt / 10.txt / 2.txt / 90.txt / 100.txt` 这种命名）。

**目标**：文件树在**前端**按「文件夹置顶 + 自然序（numeric-aware）」排序——**先按节点类型分组**（dir 在前、file 在后），**各自内部**数字段按数值比较（`90 < 100` → `90.txt` 排前）、非数字段按字典序、大小写不敏感（`A.txt` 与 `a.txt` 同序级）；文件夹之间也走自然序（`a9/ < a10/`）。覆盖顶层文件列表 + 展开子目录的子文件列表两层；SSE 触发的 stale 重取也走同一排序，保证刷新后顺序一致。

**产品不变量**：
- **观察行为对齐 VSCode**：用户在 VSCode 文件浏览器看到的顺序 = 本 app 工作区 file tab 看到的顺序（文件夹置顶 + 数字段数值比较两大核心规则一致）。
- **仅排序，不改数据契约**：`tree` / `childrenCache` 数据结构、`GET /session/:id/workspace/tree?parent=` 接口契约、lazy 加载机制、watch/SSE 通道**全部不变**——只在数据进入渲染前的某处加比较器（落点归架构期）。
- **三处复用入口全覆盖**：改 `SectionWorkspacePanel` 链路一处，chat-page / academy section-version-chat / studio section-right-tabs 三处同时受益（v0.0.227 已验证此三处共用）。
- **文件夹置顶、文件随后（对齐 VSCode 默认）**：排序先按节点类型分组（dir 在前、file 在后），各自内部再按 name 自然序——文件夹之间也走自然序（`a9/ < a10/`），文件与文件之间、文件夹与文件之间不混排。
- **排序语义 = 与 VSCode 完全一致（逐段比较）**：文件名拆成交替的**文字段 + 数字段**——文字段按字符串序比较、数字段按数值大小比较；若两数字段**值相等但格式不同**（如 `09` vs `9`，值都是 9）则再按**文字（字符串）兜底**比较。本规则 = VSCode 的自然排序逻辑（**非简单 `localeCompare` 即拍板**——见 §4 架构期责任，`localeCompare(numeric)` 是否完全等价 VSCode 须实测）。

---

## 2. 功能需求（用户可感知）

### 2.1 顶层文件列表自然序显示 [v0.0.239]

**优先级**：P0
**用户故事**：作为用户，我在 session 工作区 file tab 看到顶层文件列表时，希望数字命名的文件按数值大小排列（`90.txt` 排在 `100.txt` 前；`1.txt / 2.txt / 10.txt / 90.txt / 100.txt` 升序），而不是字典序错乱的 `1 / 10 / 100 / 2 / 90`——和 VSCode 一致，符合直觉。

**产品规则**：
- **顶层 `state.tree`（GET tree 无 parent 返回的 flat 一层 `WsTreeNode[]`）在渲染前按「文件夹置顶 + 自然序」排列**：比较器**先按节点类型分组**（dir < file，文件夹在前、文件在后），**各自内部再按** `localeCompare(b.name, undefined, { numeric:true, sensitivity:'base' })` 自然序——文件夹之间也按自然序排（`a9/ < a10/`），不与文件混排。
- **数字段按数值**：`'90' < '100'`（数值 90 < 100）；**非数字段按字典序**；**大小写不敏感**（`sensitivity:'base'`）；**同值不同格式兜底**：两数字段值相等但格式不同（如 `09` vs `9`，值都是 9）→ 再按数字段的**原 digit 字符串序**兜底比较（与 VSCode 一致，见 §1 不变量 + §4 架构期实测责任）。
- **节点类型判定**（归架构期）：按 `WsTreeNode.type`（`'dir'` vs `'file'`）区分；具体类型字段名/枚举值由架构期核对数据契约（spec gap 见 §4）。
- **稳定排序**：相同 name 不会发生（文件系统同目录无重名），无需额外 tiebreak。

#### E2E Use Cases（顶层）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-239-TOP-1 | 打开 session → 右侧工作区 file tab（顶层含 `90.txt` `100.txt`） | `90.txt` 排在 `100.txt` **前面**（核心断言） |
| UC-239-TOP-2 | 顶层含 `1.txt / 2.txt / 10.txt / 100.txt / 90.txt` | 升序：`1 / 2 / 10 / 90 / 100`（数字段数值序） |
| UC-239-TOP-3 | 顶层含混合 `a.txt / A.txt / b.txt`（若 FS 大小写敏感可共存） | `a / A / b`（大小写不敏感，a 与 A 同序级） |
| UC-239-TOP-4 | 顶层混合 `file10.md / file2.md / file1.md` | `file1 / file2 / file10`（前缀 + 数字段） |
| UC-239-TOP-5 | 顶层含 folder `docs/` + file `90.txt` + file `100.txt` | 顺序：`docs/` → `90.txt` → `100.txt`（文件夹置顶，文件段内自然序） |
| UC-239-TOP-6 | 顶层含 folder `a9/` + folder `a10/` + file `b.txt` | 顺序：`a9/` → `a10/` → `b.txt`（文件夹段内自然序 + 文件夹整体置顶） |
| UC-239-TOP-7 | 顶层含 `9.txt` 与 `09.txt` 共存（数字段同值 9、格式不同） | 顺序**与 VSCode 一致**（按「同值不同格式→文字兜底」规则，预期 `09.txt` 排在 `9.txt` 前；具体以架构期 VSCode 实测为准） |

---

### 2.2 子目录展开自然序显示 [v0.0.239]

**优先级**：P0
**用户故事**：作为用户，我展开一个子目录（如 `docs/`）看到里面的文件时，希望它们也按自然序排（不是顶层排了、子目录还乱）——全树一致体验。

**产品规则**：
- **子目录 `state.childrenCache[path]`（lazy GET `?parent=<path>` 返回的 `WsTreeNode[]`）在渲染前同样按「文件夹置顶 + 自然序」排列**（同一比较器：先 dir < file 分组，各自内部再 `localeCompare(b.name, undefined, { numeric:true, sensitivity:'base' })`，覆盖第二层）。
- **lazy 加载机制不变**：点文件夹 expand → 触发现有 lazy GET 子目录流程，只是返回数据进入缓存前/渲染前加排序。
- **缓存的复用语义不变**：已展开过的子目录折叠再展开用缓存数据，顺序仍正确（排序要在数据 ingest 进缓存时而非仅在渲染时——落点归架构期，但产品要求 = 缓存命中也要有序）。

#### E2E Use Cases（子目录）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-239-SUB-1 | 展开含 `90.txt` `100.txt` 的子目录 | 子目录内 `90.txt` 排在 `100.txt` 前 |
| UC-239-SUB-2 | 展开子目录 → 折叠 → 再次展开（缓存命中） | 顺序仍正确（缓存数据也按自然序） |
| UC-239-SUB-3 | 子目录内含 `doc1.md / doc10.md / doc2.md` | 升序：`doc1 / doc2 / doc10` |
| UC-239-SUB-4 | 子目录内含 folder `sub9/` + folder `sub10/` + file `x.txt` | 顺序：`sub9/` → `sub10/` → `x.txt`（子目录层也文件夹置顶） |

---

### 2.3 SSE 文件变化后顺序仍正确（stale 重取） [v0.0.239]

**优先级**：P0（回归保护，watch/SSE 是工作区已有核心机制）
**用户故事**：作为用户，当工作目录里的文件被 agent / 外部新增或改名（触发 chokidar watch → SSE `file_changed` / `dir_changed` → 标 stale → 重取），我希望重取后的列表顺序仍按自然序——不会因为一次刷新又回到字典序错乱。

**产品规则**：
- **stale 重取 ingest 点 = 同 §2.1 / §2.2**：SSE 标 stale 后触发的 tree / children 重取，走与首次加载完全相同的 ingest 链路 → 自然走到同一个排序比较器 → 顺序自动正确。
- **watch/SSE 行为零变更**：本版本不改 chokidar watch、SSE 事件 payload、stalePaths 机制——仅依赖「重取走同一 ingest 点」这一既有架构事实（如架构期发现重取走独立路径需补排序，属必须覆盖而非开放点）。

#### E2E Use Cases（SSE 一致性）

| ID | 用户操作链路 | 预期结果 |
|----|-------------|---------|
| UC-239-SSE-1 | agent 新增 `100.txt`（已有 `90.txt`）→ SSE dir_changed → 重取顶层 | 刷新后 `90.txt` 仍排在 `100.txt` 前（不回字典序） |
| UC-239-SSE-2 | agent 在展开的子目录改名 `old.txt` → `new100.txt`（与 `90.txt` 共存）→ SSE 重取子目录 | 子目录刷新后 `90.txt` 排在 `new100.txt` 前 |

---

## 3. 关键用户路径（MANDATORY — 测试最低覆盖）

| # | 路径 | 操作链路简述 | 验证层 |
|---|---|---|---|
| **UC-239-TOP** 顶层自然序 | 打开 session → file tab → 看顶层文件顺序 | `90.txt` 排在 `100.txt` 前；多数字文件升序；**文件夹置顶**（dir 段在内、file 段在后，各自自然序） | UT（比较器 + reducer ingest 排序 + 文件夹分组）为主；ET 视情况（属 UI 微调，UI-only UT 豁免 AT/ET 用户铁律可由 orchestrator 裁决） |
| **UC-239-SUB** 子目录自然序 | 展开子目录 → 看子文件顺序 | 子目录内同样 `90.txt < 100.txt`；文件夹置顶；缓存命中仍有序 | UT |
| **UC-239-SSE** stale 重取一致 | agent 改文件触发 SSE → 刷新后顺序 | 仍按自然序（不回字典序） | UT（ingest 路径覆盖） |

> 覆盖方式遵循「核心冒烟集 + UT」原则（CLAUDE.md 持久化测试用例库铁律）：本版本 = 普通 feature（无新 LLM 不确定性场景、无新板块、无接口契约变更），**不新增持久 AT/ET case**——以 UT（比较器 + 两层 ingest 排序 + SSE stale 重取走同 ingest）覆盖为主。前端纯展示改动且无接口/落库/后端逻辑变更，按 `ui-only-ut-skip-at-et` memory 倾向豁免 AT/ET，由 orchestrator 在 test-plan 裁决。

---

## 4. 概念对齐（PRD ↔ ui/tech spec，不发明新概念）

| PRD 引用 | 权威 spec / 归属 |
|---|---|
| workspace panel（tree / childrenCache / lazy 加载 / watch-SSE / handleOpen 概念） | `specs/ui/components/chat-page/component-workspace-panel.md`（已有，本版本**追加排序 clause**，见下 gap） |
| 三处复用入口（chat-page / academy / studio 共用 `SectionWorkspacePanel`） | `component-workspace-panel.md`（v0.0.227 已落实三处共用） |
| workspace panel 操作路径（用户导航） | `specs/ui/overall/00-app-guide.md §3.1`（line 63，已有） |
| 后端 tree 端点 + readdirSync OS 字节序（不改） | `specs/api/overall/04-agent-session.md §2.6` workspace 端点（已有，本版本零变更——排序纯前端） |

**spec gap（PRD 标注，由 architect/coder 补，PRD 不发明）**：

- **`component-workspace-panel.md` 当前无任何排序 clause**（已 grep 核实：tree / childrenCache Props 已概念化，但无「文件按何序排列」的产品规则）。**需补一节「§4.X 文件排序：文件夹置顶 + 自然序 numeric-aware」**：声明顶层 `tree` + 子目录 `childrenCache[path]` 均按**先节点类型分组（dir < file）再按** `localeCompare(b.name, undefined, { numeric:true, sensitivity:'base' })` 排序；落点（reducer ingest 还是渲染前）由架构期定；节点类型字段（`WsTreeNode.type`）由架构期核对数据契约；排序对 watch/SSE stale 重取同样生效（走同一 ingest）。coder 编码前置产/更新组件 spec 时落实此节。
- **架构期责任：核实所选比较器与 VSCode 真实行为逐一对齐**（MANDATORY）。VSCode 走 ICU `Intl.Collator(numeric)`，理论上与 `localeCompare(numeric:true)` 同源，但**「同值不同格式兜底」（如 `09` vs `9`）边界须实测验证，不可假设 `localeCompare(numeric)` 就够**。若发现 `localeCompare(numeric)` 与 VSCode 在某边界不一致，architect 须选能对齐 VSCode 的实现（如自定义分段比较器：拆 chunk → 文字段字符串序 / 数字段数值序 / 同值数字段按原 digit 字符串兜底）并向 orchestrator 汇报。

**与既有 spec 的已知差异（doc-modifier 阶段 5 待同步）**：

- `component-workspace-panel.md §交互` → 补「文件排序：文件夹置顶 + 自然序 numeric-aware」clause（顶层 + 子目录两层 + SSE stale 一致 + dir<file 分组）。
- `specs/ui/overall/00-app-guide.md §3.1` workspace panel 行 → **可选微补**「文件按文件夹置顶 + 自然序排列（数字段按数值，如 `90.txt < 100.txt`）」（让用户手册观察口径准确；如 orchestrator 判定属实现细节则可不补——产品观察行为已在 PRD 描述）。

---

## 5. 范围边界（IN / OUT）

**IN（本版本改）**：
- session 工作区 file tab（`SectionWorkspacePanel` 链路）顶层 + 子目录文件列表的「文件夹置顶 + 自然序」排序（dir 先于 file，各自内部 `localeCompare(numeric:true)`）。
- 三处复用入口同时生效（改一处）。

**OUT（本版本不改）**：
- **技能管理页 `app/web/src/components/common/file-tree.ts`**：同样非数字排序（`localeCompare` 无 `numeric:true`，`100 < 90` 错），但**不在本版本范围**（用户铁律「只做 query 要求的」）。如需一致需用户明确扩范围另立版本。
- **后端 tree 端点 / readdirSync**：排序纯前端，后端原样返回不排序（D2 决策）。
- **数据契约 / 接口 / lazy / watch-SSE 机制**：零变更。

---

## 6. 产品开放点（待用户裁决 / 已裁决）

1. ✅ **排序算法** = `localeCompare(b, undefined, { numeric:true, sensitivity:'base' })`（D1/D2 已裁决）——codebase `academy-page/use-derive-options.ts L91` 已有此惯用法（参考，非新发明）。
2. ✅ **落点（reducer vs 渲染层）** = **归架构期**——PRD 只要求「数据进渲染前必经排序、缓存命中也有序、SSE 重取走同 ingest」三条件满足，具体落 reducer `setTreeLoaded`/`setChildrenLoaded` 还是渲染层 `TreeLevel` 由 architect 拍。
3. ✅ **文件夹/文件分组 = 文件夹置顶（D7 已裁决）**：dir 先于 file，各自内部自然序——对齐 VSCode 默认。节点类型判定按 `WsTreeNode.type`（具体字段名/枚举值由架构期核对数据契约）。

---

## 7. 验收口径

- **功能**：UC-239-TOP / SUB / SSE 全 PASS（UT 为主）；本版本无新持久 AT/ET case（普通 feature 铁律 + UI-only UT 豁免倾向）。
- **核心不变量**：`90.txt` 排在 `100.txt` 前（顶层 + 子目录 + SSE 刷新后三层都成立）。
- **文件夹置顶不变量**：dir 先于 file（顶层 + 子目录），文件夹段内、文件段内各自自然序（`a9/ < a10/`、`90.txt < 100.txt`）。
- **回归不变量**：watch/SSE 机制、lazy 加载、`handleOpen` `.md` 拦截（v0.0.227）、拖宽/收起展开（component 既有多交互）零变更。
- **范围不变量**：技能管理页 `file-tree.ts` 不受影响（OUT，不顺便改）。
- **持续可打包护栏**：纯前端 UI 改动，不触后端 / 不触 plugin / 不触 runtime-config / 不触路径展开——packaged 专属四陷阱全部不沾，无需 packaged 版验证。
- **视觉保真门禁**：**无设计稿**（D6 已确认）→ 本项跳过 vision_check compare；视觉一致性以「文件树外观与现状完全一致，仅顺序变化」为口径。

---

## 8. 版本

**v0.0.239** — session 工作区 file tab 文件树改「文件夹置顶 + 自然序（numeric-aware，对齐 VSCode 默认）」；前端比较器**先按节点类型分组（dir < file）再按** `localeCompare(b.name, undefined, { numeric:true, sensitivity:'base' })`，覆盖顶层 `state.tree` + 子目录 `state.childrenCache[path]` 两层 + SSE stale 重取同 ingest；后端 / 数据契约 / lazy / watch-SSE 零变更；技能管理页 `file-tree.ts` 同问题 OUT OF SCOPE。详见本 PRD + change_plan（architect 落 `specs/tech/version_logs/v0.0.239/change_plan.md`）。
