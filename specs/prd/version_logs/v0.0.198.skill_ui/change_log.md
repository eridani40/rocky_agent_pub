# v0.0.198 — Skill 页面 UI 优化（安装弹层 + 来源筛选）

> 增量 PRD。权威基础见 `specs/prd/overall/06-skill.md`（v0.0.21 + v0.0.149 modified）。
> 概念对齐：`specs/ui/overall/04-skill-page.md` + `specs/ui/components/skill-page/`（7 组件）+ `specs/api/overall/06-skill.md`（GET /skill 全量返回，§3.1）。
> 纯前端版本，**零后端 API 变更**（GET /skill 仍全量返回；数据规模个位~几十，分页无意义 no-op）。

---

## 1. 背景

Skill 管理页（v0.0.21 引入，v0.0.167 加市场 tab，v0.0.149 加注入配额）当前交互有两处体验问题：

1. **安装区常驻**：「我的」tab 顶部始终占一大块拖拽落点区，列表被下压，已装 skill 多时滚动疲劳。
2. **来源不可见**：列表混合展示 builtin / 本地 / 市场安装 / Rocky 自进化四类来源的 skill，用户无法快速定位某一类。

v0.0.198 通过**纯前端**改造解决以上两点，不动后端 API。

---

## 2. 需求详述

### 2.1 安装区默认收起 + 加号按钮弹层 [v0.0.198]

**描述**：「我的」tab 顶部常驻的拖拽安装区（`component-skill-drop-zone`）改为**默认收起**，用户通过 tab 栏最右侧的「+」按钮主动唤起。

**优先级**：P0
**用户故事**：作为已安装多个 skill 的用户，我希望列表占据主视觉位置而非安装区，以便我快速看到/操作已装 skill；需要安装时也能一键呼出安装区。

**用户行为链路**：
1. 进入 skill 页「我的」tab → 看到列表占据顶部（无安装区占位），tab 栏最右侧见黑色「+」按钮
2. 点「+」→ 列表上方展开安装区（复用 `component-skill-drop-zone` 全部交互：拖拽 / 选择文件 / 选择文件夹）
3. 点安装区右上角「取消」/ 再次点「+」→ 安装区收起
4. 安装成功（后端 `POST /skill/install` 202 返回 + 列表刷新）→ **安装区自动收起**

**交互细节**：
- 「+」按钮位置：tab 栏最右侧（与「我的」「市场」两 tab 同行，靠右对齐），不随 tab 切换位移
- 「+」视觉：黑色圆/方块 + 白色 `+` 图标（light 主题）；dark 主题反色（白底黑图标）。固定尺寸（与 tab 高度齐平）
- 状态指示：安装区展开时「+」可视觉高亮（如背景填实 / 旋转 45° 变 `×`），提供「再点收起」语义
- 安装区展开/收起：高度变化用 `transition` 过渡，避免突兀；**不破坏布局稳定性**（按钮始终占固定空间）
- 安装区收起态保留 `component-skill-drop-zone` 原有 dragover/drop/选择按钮全部行为，只是可见性切换

**界面要素**：
- `component-skill-tabs` 扩展：右侧槽位（`ml-auto`）加 `+` 按钮（受控 `expanded` 状态 + `onToggleInstallZone` 回调，由 `page-skill` 持有）
- `component-skill-drop-zone`：不改自身实现，仅外层包装控制可见性（`visibility` / 高度 transition，不用 `display:none` 以保留 drop 事件挂载）

**子功能**：
- 安装成功自动收起（强约束，见 §4 决策 D3）
- 取消按钮关闭（用户主动退出安装流程）

### 2.2 来源筛选 [v0.0.198]

**描述**：「我的」列表上方加来源筛选条，4 个选项：全部 / 内置 / 市场 / Rocky。筛选 = 纯 filter（全量已在 `page-skill` state），切来源 tab 直接重算可见列表，不影响后端请求。

**优先级**：P0
**用户故事**：作为用户，我希望按 skill 来源快速缩小范围查看，以便区分自家内置、我手动装的、市场安装的、Rocky 自进化的四类 skill。

**用户行为链路**：
1. 「我的」tab 列表上方见 4 个筛选选项（默认激活「全部」）
2. 点「内置」→ 列表只剩 builtin skill（当前 4 个：panorama-designer / okf-skill / teamwork-leader / teamwork-mate）
3. 点「市场」→ 列表只剩有 `marketRef` 的 skill
4. hover「Rocky」→ 显示 tooltip「来自于 Rocky 的自我迭代和进化」
5. 点「Rocky」→ 列表只剩 `productionMethod==='consolidation'` 的 skill（若当前为空则空态）

**交互细节**：
- 选项样式：tab 风格（激活态 accent 文字 + 底下划线）或 segmented 风格（圆角按钮组），与现有 skill tab 视觉协调
- **Rocky tooltip**：原生 `title` 属性或自绘 tooltip，文案「来自于 Rocky 的自我迭代和进化」
- **纯 filter 无分页**：GET /skill 全量返回（数据规模个位~几十）→ 切来源 tab 直接对全量数组重算可见列表，无分页计数器、无「当前页为空」假死风险
- 当前激活筛选 tab 状态由 `page-skill` 持有（常驻，不随「我的/市场」tab 切换丢失，但切到市场 tab 时本筛选条隐藏）

**来源映射（产品语义）**：

| 筛选 tab | 判定条件 | 说明 |
|----------|---------|------|
| 全部 | 无 filter | 全量列表 |
| 内置 | `scope === 'builtin'` | 随 app 发版的内置 skill（`SkillScope` 三层之一） |
| 市场 | `marketRef` 非空 | 由市场 tab 一键安装（v0.0.167 引入字段） |
| Rocky | `productionMethod === 'consolidation'` | Rocky 自我迭代/进化的产物（hover 文案正对应） |

> **注**：「内置 / 市场 / Rocky」三类可能重叠（如 builtin skill 不会同时是市场安装，但 Rocky 自进化产物理论上可能 scope=app）。筛选按上表「**精确匹配单一条件**」语义，不做交集；用户场景下三类基本互斥。

**界面要素**：
- 新 UI 元素 `component-skill-source-filter`（**编码前置由 coder 补组件 spec**，本 PRD 只定义产品语义 + 视觉调性）
- 视觉调性：与现有 `component-skill-tabs` 同色系（全 token，accent 激活色），高度紧凑（不抢占列表视觉权重）

---

## 3. 关键用户路径（MANDATORY — 测试最低覆盖）

| ID | 用户操作链路 | 预期结果 | 类型 |
|----|-------------|---------|------|
| 路径 A | 进 skill 页「我的」tab → tab 栏最右见「+」按钮 → 点击 → 安装区弹层展开 → 点「取消」/再点「+」→ 弹层收起 | 安装区按需呼出 / 收起；列表常驻不被安装区占位 | ET（本版本主验证） |
| 路径 B | 在「我的」列表上方依次切「全部 / 内置 / 市场 / Rocky」→ 观察列表内容 | 每次切换后列表正确按来源过滤；切回「全部」恢复全量；Rocky hover 见 tooltip「来自于 Rocky 的自我迭代和进化」 | ET |
| 安装成功自动收起（功能要做，ET 不验证） | 展开安装区 → 拖拽/选择文件成功 install 202 → 安装区自动收起 + 列表刷新见新卡 | 安装流程顺畅、成功即收起 | UT 覆盖（ET 不验证安装，用户明确） |

**路径数**：2 条 ET（A/B）+ 1 条 UT-only（安装成功自动收起）。

**对齐 overall §6.3**：本版本不新增 overall 关键路径（A-G + H 市场），路径 A/B 是对 overall 路径 A（点 nav 进 skill 页）的**交互细化**——原路径 A 现包含「+」按钮 + 来源筛选的视觉验证。

---

## 4. 设计决策 [v0.0.198]

| 决策 | 选择 | 理由 |
|------|------|------|
| D1 后端 API 变更 | **零变更**（纯前端） | 当前规模个位~几十条，后端全量返回足够；未来规模真变大再议后端分页（.cursor/pagination） |
| D2 来源筛选模型 | **纯 filter**（全量已在 `page-skill` state） | GET /skill 全量返回、规模小（个位~几十），切来源 tab 直接对全量数组重算可见列表即可；分页为 no-op 无意义、已砍（见背景） |
| D3 安装成功自动收起 | 强约束（**必须**自动收起） | 安装是低频高聚焦动作，成功后用户视觉焦点应回到列表（看新装的卡），不应停留在已完成的安装区 |
| D4 `+` 按钮位置 | tab 栏最右（`ml-auto`），不随 tab 切换位移 | 与「我的 / 市场」两 tab 同行最右，符合用户「右上角操作位」心智；位置固定不破坏布局稳定性 |
| D5 来源分类 | 4 类：全部 / 内置（`scope==='builtin'`）/ 市场（`marketRef`）/ Rocky（`productionMethod==='consolidation'`） | 四类基本互斥、覆盖现有 skill 全部来源；Rocky 标签对应已有 `productionMethod` 字段，不新增数据概念 |
| D6 Rocky tooltip 文案 | 「来自于 Rocky 的自我迭代和进化」 | 用户原文；对应 `productionMethod==='consolidation'` 语义 |
| D7 视觉保真门禁 | **跳过**（本版本无设计稿） | 用户未提供设计稿，按现有 skill 页组件视觉调性延伸（`component-skill-tabs` / `component-skill-drop-zone` 同色系 + 全 token） |

---

## 5. 测试范围 [v0.0.198]

**用户已裁决**：纯前端无 API 契约变更 → **AT 豁免**（不设计 AT case）；走 **UT + 1 ET case**。

### 5.1 UT 覆盖

- 来源筛选函数：4 类条件正确分类（builtin / marketRef / consolidation / 全部）
- 安装成功自动收起：install 成功 callback 触发 `setInstallZoneExpanded(false)`

### 5.2 ET 覆盖（1 case）

单 ET case（`tests/e2e/playground-skill-ui-optimization/case.md`）覆盖路径 A + B 串行主路径：
- 进 skill 页 → 验「+」按钮在 tab 栏最右
- 点「+」→ 验安装区弹层展开 + 取消收起
- 切来源筛选 4 类 → 验列表正确过滤 + Rocky hover tooltip

**不验证**：安装流程（拖拽/选择文件 → install → 列表刷新 → 自动收起）—— 用户明确 ET 不验证安装，由 UT 覆盖「成功自动收起」逻辑。

### 5.3 AT 豁免理由

零后端 API 契约变更（GET /skill 仍全量、install/toggle/delete/tree/file 端点不变），AT 框架基于 spec 契约黑盒验契约，无变更则无新 case 可写；前端 filter/slice 是 UI 层逻辑，UT 已覆盖。

---

## 6. 视觉说明 [v0.0.198]

**本版本无设计稿**（用户未提供），按现有 skill 页组件视觉调性延伸：

- **「+」按钮**：黑色圆/方块 + 白色 `+` 图标（light）；dark 反色；尺寸与 tab 高度齐平；固定位置（tab 栏最右）
- **来源筛选条**：与 `component-skill-tabs` 同色系（accent 激活色 + token 边框），高度紧凑；Rocky 同其他三项视觉一致，仅 hover 触发 tooltip

**双主题**：全 token，无特判。

**布局稳定性（MANDATORY）**：
- 「+」按钮始终占固定空间（`visibility: hidden` 不可见时也预留位置，避免 tab 切换位移）
- 安装区展开/收起用 `transition` 高度过渡，不挤压列表突跳

---

## 7. 范围边界

### IN [v0.0.198]
1. tab 栏最右加「+」按钮 + 安装区改默认收起的弹层（`page-skill` + `component-skill-tabs` + `component-skill-drop-zone` 包装）
2. 来源筛选条（新 UI 元素 `component-skill-source-filter`，编码前置补组件 spec）
3. 安装成功自动收起（强约束）

### OUT [v0.0.198]
- 后端 API 变更（GET /skill 仍全量返回、install/toggle/delete/tree/file 不动）
- 后端 / 前端分页（limit/cursor、每页 N 条、滚动加载）—— 数据规模个位~几十，分页 no-op 无意义，已砍；未来规模真变大再议
- 来源筛选的「多选交集」（当前是单选精确匹配）
- skill 卡片视觉重构（`component-skill-item` 只接收 filter 后的列表，自身不变）
- 安装流程 UI 重构（`component-skill-drop-zone` 内部行为不变，仅外层可见性受控）

---

## 8. 对齐 overall 文档

`specs/prd/overall/06-skill.md` 需补充：
- §6.2.1 Skill 管理页（UI）：tab 栏追加「+」安装按钮说明；列表上方加来源筛选条
- §6.3 关键用户路径：路径 A（进 skill 页）补「+」按钮 + 来源筛选的交互细节
- §6.6 验收口径：加 v0.0.198 两项 UI 优化的验收维度

由 doc-modifier 在阶段 5 同步。

---

version: 0.2（v0.0.198 PRD version_log，纯前端 UI 优化两件套：安装弹层 + 来源筛选；v0.1 分页需求砍除——数据规模小分页 no-op）
