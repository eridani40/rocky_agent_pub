# 前端组件化 spec 规范（_conventions）

> 管什么：`app/web/` 渲染层的**组件化开发契约**——组件粒度分层、命名规范、文件组织、spec 写法、视觉契约（§9）。
> 不管什么：设计 token 原值（→ `specs/ui/regulation/01-tokens.md`）；技术选型（→ `specs/tech/app/frontend/[P0]tech_stack.md`）；架构总纲（→ `[P0]component_architecture.md`）；页面结构与操作路径（→ `specs/ui/overall/`）。
> 消费者：**coder 开发前端时必读本目录**（含本文件 + 对应组件 spec）；**code-reviewer 审查前端时按本文件核对**；**doc-modifier 同步 specs/ui/ 时保持本目录一致**。

## 1. 为什么有这套规范

外部设计工具产出的 html 原型是**一体的**（设计阶段，不要求组件化）。但**开发阶段** `app/web/` 必须是**组件式架构**：每个组件独立文件、按粒度分层、统一命名，保证可复用、可测试、可维护。本目录是组件化的**契约源**，coder 按 spec 实现，`app/web/src/components/` 是实现。

## 2. 组件粒度分层

| 层级 | 前缀 | 含义 | 示例 |
|------|------|------|------|
| **primitive** | `primitive-` | 原子组件，最小可复用单元，不含业务语义 | `primitive-toggle-switch`、`primitive-key-input` |
| **component** | `component-` | 功能组件，组合 primitive，含业务语义 | `component-key-card`、`component-plugin-item` |
| **section** | `section-` | 页面内大区块，组合多个 component | `section-config-layout`、`section-group-list` |
| **page** | `page-` | 一个 view 的根，组合 section | `page-app-config`、`page-plugin-config` |
| **framework** | （自然名） | 全 app 框架级壳（shell/nav），非业务页面 | `app-shell`、`nav-rail` |

**组合方向**：`page` → `section` → `component` → `primitive`。**禁止跨层逆向依赖**（primitive 不得引用 component；component 不得引用 section）。

## 3. 命名规范

- 文件名 = 前缀 + kebab-case 标识符 + 扩展名
- 前缀即层级（见上表），framework 级用自然名不加前缀
- 标识符表达**职责**，不表达位置（`component-key-input` 而非 `component-settings-input`）

## 4. 目录组织（第一层平铺：framework + common + 一级页面）

第一层 = `framework/` + `common/`（跨页面复用）+ 各**一级页面**目录，扁平（无 `page/` 中间层）。结构一致的页面合并（app/dev config → `app-dev-config-page/`，共享 section/component）；plugin 特殊单独 `plugin-config-page/`；被 ≥2 个页面复用的 component/section 提升到 `common/`（如 group 列表，app-dev config 与 plugin 扩展点 tab 都用）。

```
specs/ui/components/
├─ _conventions.md            # 本文件
├─ framework/                 # 第一层：框架级（全 app 复用）
│  ├─ app-shell.md
│  ├─ nav-rail.md
│  └─ primitive-*.md          # toggle-switch / key-input / key-choice-cards / key-boolean / drag-handle
├─ common/                    # 第一层：跨页面复用的 component/section
│  ├─ section-group-list.md            # 通用 group 列表（app-dev config + plugin 扩展点共用）
│  └─ component-group-list-item.md
├─ app-dev-config-page/       # 第一层：app + dev config（结构一致，共享 section/component）
│  ├─ page-app-config.md
│  ├─ page-dev-config.md
│  ├─ section-config-layout.md         # 三栏布局（app/dev 复用）
│  └─ component-*.md                   # key-card / save-bar（key-input/choice-cards/boolean 是 primitive，在 framework/）
└─ plugin-config-page/        # 第一层：plugin config（特殊：tab + 扩展点）
   ├─ page-plugin-config.md
   ├─ section-plugin-list.md
   ├─ section-ext-point-area.md        # 复用 common/section-group-list
   └─ component-*.md                   # plugin-item / ext-impl-{radio,checkbox,ordered} / schema-config-modal
```

> 新增一种结构不同的页面 → 新建一个一级页面目录（如未来 `chat-page/`）。结构相同的多个页面共用一个目录（多 page 根 + 共享 section/component）。

## 5. 每个组件的 spec = 单个 `.md` 文件

每个组件产出一个 **`{name}.md`**（设计要求：层级、职责、Props 接口、状态/交互、可见文案、复用关系、视觉基线）。实现直接在 `app/web/src/components/` 同名路径，不再要求配套独立 `.tsx` 示意文件。

## 6. `.md` 模板

> **testid 已废弃，E2E 以元素可见文案 + 位置定位**。组件 spec 必须写全可见文案（按钮名 / tooltip / 空态文案 / badge 文字），这是 E2E 的定位契约。

```markdown
# component-name（中文名）

> 层级: primitive | component | section | page | framework
> 文件: app/web/src/components/{一级目录}/{name}.tsx

## 职责
一句话说明做什么。边界：不做什么。

## Props（如有）
```ts
interface Props { ... }
```

## 状态 / 交互（如有，含按钮文案/tooltip 等可见文案——E2E 定位契约）
- 关键状态、用户交互、约束（如「开关独立不联动」）
- 可见文案：按钮文字 / tooltip / 空态提示 / badge 等（E2E 定位依据）

## 复用关系（如有，一行引用+位置）
- 被谁组合 / 组合了谁

## 视觉基线（如有）
- 设计稿来源：`reqs/v{N}.{M}/{原型}.html` 中的对应区块
- 字体：字体族 + 字号 + 字重（两族分工见 `specs/tech/app/frontend/[P0]design_system.md §5.2`——Inter + JetBrains Mono）
- 尺寸：关键宽高 / padding（如「卡片 padding 12px，圆角 8px」）
- 边框：边框/分隔线/圆角风格（如「1px var(--color-border) + rounded-lg」）
- 配色：背景/强调/状态色 token（如「选中态 border var(--color-accent)」）
> coder 实现时对齐此基线；e2e-verifier 用 `vision_check.py compare` 逐维度比对（见 §9）。
```

## 7. 与 `app/web/src/components/` 的映射

spec 目录与实现目录一一对应（spec 是契约，src 是实现，目录同名）：

| spec | 实现 |
|------|------|
| `specs/ui/components/framework/*` | `app/web/src/components/framework/` |
| `specs/ui/components/common/*` | `app/web/src/components/common/` |
| `specs/ui/components/app-dev-config-page/*` | `app/web/src/components/app-dev-config-page/` |
| `specs/ui/components/plugin-config-page/*` | `app/web/src/components/plugin-config-page/` |

目录结构总纲见 `[P0]component_architecture.md`。

## 9. 设计稿 = 视觉契约（MANDATORY）

外部 html 原型（`reqs/v{N}.{M}/*.html`）不仅是**交互参考**，更是**视觉契约**——它定义组件「长什么样」的权威基线。功能正确 ≠ 视觉还原；二者都是验收门槛。

**保真口径**：不要求像素级一致，但**整体风格基本一致**——字体（字体族/字号/字重）、尺寸（宽高/padding/圆角）、布局（栏数/结构/排列）、边框（边框/分隔线/圆角风格）、配色（token 基调）看上去基本一致。明显偏差（布局错位、字体迥异、该有的卡片/边框/品牌标识缺失、配色基调不符）= 不合格。

**职责分工**：
- **coder**：实现前对照设计稿填写组件 spec 的「视觉基线」字段；实现时对齐基线（优先复用 `tokens.css` 的 design token，不硬编码颜色/字号）。
- **code-reviewer**：审查时核对实现是否引用了 spec 标注的 token / 尺寸基线（结构层面，不看截图）。
- **e2e-verifier**：用 `vision_check.py compare <impl> <design>` 逐维度（layout/font/border/color）比对实现截图与设计稿，FAIL 项建 `BUG-xxx-[open].md` 标 `视觉保真`。

**流程接入**：版本带设计稿时，test-plan.md 必须为每个有设计稿的页面/组件列一组 compare checks（覆盖 layout/font/border/color 四基础维度），作为 E2E 视觉保真度最低覆盖要求。

## 8. 新增组件流程

1. 判定层级（primitive/component/section/page/framework）→ 起名（前缀+kebab）
2. 定目录：framework 级 → `framework/`；跨 ≥2 页复用 → `common/`；否则 → 所属一级页面目录（如 `app-dev-config-page/`）
3. 建 `{name}.md`（设计要求，按 §6 模板）
4. 同步更新该目录的 `page-*.md` 组合关系
5. 实现到 `app/web/src/components/` 同名路径
6. 更新 `specs/ui/overall/{page}.md` 对应板块描述

## 8a. i18n 文案范式（MANDATORY）

> 技术权威：`specs/tech/i18n/` KB（`[P0]i18n_overview.md` + `[P1]manifest_i18n.md` + `index.md §⑥`）。本节是组件实现的最低要求。

**所有组件可见文本必须经 i18n**（一刀切原则：UI 上能看到 → i18n）。组件实现 `useTranslation(ns)` + `t(key)` 查 locale 表，禁硬编码中文字面（除非属于「硬边界」不翻译：LLM 回复 / 用户数据 / 动态自由文本）。

**通用范式**：
1. **本页 ns 优先**：组件顶部 `const { t } = useTranslation('<page-ns>')`；文案 key 走 `<scope>.<leaf>` camelCase，如 `t('chat.sendButton')` / `t('studio.squad.emptyHint')`。
2. **跨页通用词进 common ns**：confirm/cancel/save/saving/loading/delete/modal.{close,deleteTitle}/collapse/expand/refresh/error.{loadFail,saveFail,sendFail}/timeAgo.*/composer.placeholder/saveBar.* 等已落 `common.json`；用 `t('common:<key>')` 或 `t(key, { ns: 'common' })` 显式取（react-i18next v15 数组 ns **不**自动跨 ns fallback，需显式 ns；详见 `i18n/[P0] §5.3`）。
3. **type code 走映射**：可枚举 type 字段（如 `Run.stopReason` / `Session.state` / `Connector.connection` / `Board.taskStatus` 等）走通用 helper `localizedCode(code, t, '<keyPrefix>')`（`app/web/src/i18n/code-key.ts`），不直展 code 字面。详见 `i18n/index.md §⑥` 累积表。
4. **manifest 等产品代码字段走占位符 helper**：渲染 plugin/EP/impl 的 label/description 等 manifest 字段时，**禁**字面直展 `{description}`，必走 `resolveI18nField(value, t)`（`app/web/src/i18n/resolve-i18n-field.ts`）—— 识别 `__MSG_<key>__` 占位符 → `t()` 翻译；否则直展原文（兼容第三方/老 plugin）。详见 `i18n/[P1]manifest_i18n.md`。
5. **用户数据 / LLM 内容 / 自由文本直展**（硬边界）：squad.name / session.title（命名后）/ member name / provider label / board 工作项文本 / error_message / LLM 回复正文——**禁**翻译，原样展示。

**ns 划分**（与一级 page 目录一一对应）：chat / studio / providers / plugin-config / app-dev-config / skill / connector / framework / common / error（详见 `specs/tech/i18n/[P0] §4.1`）。

**E2E 定位契约 = 可见文案**：testid 已废弃，E2E 以元素可见文案 + 位置定位——i18n 文案即定位契约源，组件 spec 的「状态 / 交互」章节须写全可见文案。

## 10. 单选控件：禁用原生 `<select>`（硬规则）

**凡是单选（enum / 有限选项择一），禁止使用原生 `<select>` 元素**——包括 `appearance-none` 的「伪自定义」select（闭合态看着像自定义，点击仍弹出 OS 原生选项菜单，丑且不可控）。原生 select 在桌面/移动端表现不一致、无法统一视觉、无障碍与动画都受限。

**按选项数量选控件**：
- **少量选项（≤ ~4）→ 选项卡片**：用 `primitive-key-choice-cards`——可点卡片，选中 = accent 边框 + 浅底 + 勾；dark/light 等主题选项自带预览色块。典型：theme（dark/light）、schema enum 字段、开关型枚举。
- **多选项（> ~4，卡片排不下）→ 自定义下拉**：尚未有此 primitive；需要时新建 `primitive-key-dropdown`（自定义 popover + 列表 + 键盘导航），**不得回退原生 select**。当前无此场景（chat 模型选择等已是非原生实现）。

**已落实**：`primitive-key-select`（原生 select）已**移除**；enum 路由统一走 `key-choice-cards`（theme + plugin schema 弹层 enum 字段）。

**code-reviewer 核对**：前端代码出现 `<select` 或 `KeySelect` → 直接 FAILED（违反本条）。

## 11. 组件尺寸稳定性：状态切换尺寸恒定（硬规则）

**组件在不同状态下尺寸（宽/高/占位）必须恒定**——条件内容只允许「出现/不出现」（`visibility:hidden` / `opacity-0` 占位 + `disabled`），**禁** `{cond && <X/>}` 条件渲染或 `display:none` 致布局位移。

**为什么**：状态切换时尺寸变化 → 布局抖动、视觉不稳、用户感知「跳」。规范要求占位恒定，状态只变内容/可见性，不变尺寸。用户强反馈：「只允许出现/不出现，不允许尺寸变化」。

**典型违反**（反例模式）：清空按钮用 `{!isEmpty && <button>✕</button>}` 条件渲染——空时按钮不渲染→trigger（flex-1）占满全宽；非空时按钮渲染→挤 trigger 变窄。trigger 宽度随有值/无值变化 = 违规。

**正确实现**：条件子元素**始终渲染** + 空态 `invisible`/`opacity-0` + `disabled`（不可见但占位），flex/grid 兄弟尺寸恒定。例：清空按钮始终渲染，`className={...(isEmpty ? 'invisible' : '')}` + `disabled={isEmpty}`。

**例外——自适应组件**（须在 spec **显式声明「自适应」**）：textarea 按内容增高、list 按条数变高、markdown 渲染区按内容变。未声明自适应的组件默认固定尺寸。

**code-reviewer 核对**：条件渲染 `{cond && <X/>}` 若 X 在 flex/grid 布局中占位（非 absolute/fixed 脱离流）→ 标 Major（违反尺寸稳定性）；除非该组件 spec 显式标「自适应」。关联 memory `component-size-must-not-change-on-state`。

## 12. data-action-key：可交互元素的稳定语义契约（开发实现约定）

> **定位（边界先讲清楚）**：本规范是**开发实现约定**——约束 coder 埋属性时的命名规范与覆盖范围。**不要求组件 spec 列 action-key 清单**（避免文档膨胀）、**不要求 case.md 标注 action-key**（case design 零成本，executor 自己判断元素有无 action-key）。仅约束开发埋属性时的命名与范围。
>
> testid 已废弃，E2E 曾靠「可见文案 + accessibility name」定位——但文案会随 i18n 变、accessibility name 随实现标签变，ET 脆弱根因在此。**data-action-key 是源头解**：给可交互元素埋稳定语义契约锚点，不随文案/i18n/实现标签变。

### 12.1 定位与属性
- **属性**：`data-action-key="{板块}.{entity}.{action}"`（HTML `data-*` 标准属性，零副作用，框架无关）。
- **消费者**：ET 自动化（playwright CSS 属性选择器原生支持）；不替代任何运行时逻辑。

### 12.2 命名规范

**首要硬性原则——语义自文档**：key 本身表达交互意图，人/AI 读到就懂，不用查表。这是命名空间式（相对扁平/数字 key）的核心价值，也是 action-key 唯一的开发成本——「起好名字」。executor 读 `academy.classroom.create` 直接懂意图，ET 定位又快又稳。

**格式**：`{板块}.{entity}.{action}`，全小写、action 多词用连字符（kebab-case）。

**action 用动词全拼**：create / edit / delete / start / stop / save / publish / accept / reject / send / open / close / invite / edit-version。多词用连字符（edit-version / publish-draft）。

**禁**（违背「可读」初衷）：
- ❌ 缩写：`btn` / `act` / `crt` / `del`
- ❌ 数字编码：`action-3` / `step-2`
- ❌ 无意义 id / 单字母：`a.b.c` / `x.y.z`
- ❌ 形容词代替动词：`academy.classroom.blue`（用动词 `create` / `select`）

人和 AI 都得猜的 key = 失败的命名。

**命名约束**：
- `{板块}` = 板块前缀（映射见下表），全小写
- `{entity}` = 业务实体名词（classroom / student / training / version / feedback / task），单数
- `{action}` = 动词或动词短语，kebab-case

**目录 → 板块前缀映射**（前缀共 11 个）：

| 组件所属一级目录 | 板块前缀 |
|------|---------|
| chat-page / studio-page / academy-page | `chat` / `studio` / `academy` |
| providers / skill / connector / channel | `providers` / `skill` / `connector` / `channel` |
| app-dev-config-page | `settings` |
| plugin-config-page | `plugin` |
| common/（跨页共享 component/section） | `common` |
| framework/（nav / shell / 全局 modal） | `framework` |

**板块 = 组件所属一级目录**：chat-page 基质组件（审批卡 / composer / picker 等）被 studio/academy 页 slot 复用时仍带 `chat.*` key——同一交互语义，key 不随消费页变。共享基质确需按消费方板块区分语义时（如顶栏返回键），走可选 `actionKey` prop 由消费方传（见 §12.8）。

**示例**（真实入口，命名粒度参考）：

| 板块 | 入口示例 |
|------|---------|
| academy | `academy.classroom.create` / `academy.student.edit-version` / `academy.training.start` / `academy.version.publish` / `academy.task.accept` |
| chat | `chat.message.send` / `chat.session.create` / `chat.approval.allow` |
| studio | `studio.squad.create` / `studio.member.hire` / `studio.member-chat.back`（发送按钮统一 `chat.message.send`——共享基质 key 不随消费页变，旧 `studio.message.send` 已退役） |

### 12.3 哪些元素必须埋
**所有可交互元素**——button / link / input / textarea / select / tab / icon-only button / 可点击卡片 / modal 触发器 / 行内操作图标。原则：用户能点 / 输入 / 切换的元素都埋。

### 12.4 与 aria-label 分工（**关键，不可合并**）
| 维度 | aria-label | data-action-key |
|------|-----------|-----------------|
| 给谁 | 人（screen reader） | 机器（ET 自动化） |
| 形态 | 自然语言名字（「新建教室」/「Create Classroom」） | 稳定语义契约（`academy.classroom.create`） |
| 是否随语言变 | **是**（i18n 翻译） | **否**（跨语言恒定） |

**两者并存**：
```tsx
<button aria-label="新建教室" data-action-key="academy.classroom.create">
  <PlusIcon /> 新建教室
</button>
```

**禁止**把 key 塞进 aria-label（如 `aria-label="academy.classroom.create"`）——screen reader 会念 "a.b.c"，破坏 a11y + i18n 自相矛盾。

### 12.5 ET 用法
playwright CSS 属性选择器原生支持，无需任何适配层：

```ts
// playwright
page.locator('[data-action-key="academy.classroom.create"]').click();
```
```bash
# playwright-cli
playwright-cli click "[data-action-key='academy.classroom.create']"
```

ET executor 优先用 action-key 定位（详 `.claude/agents/e2e-test-executor.md`）；没埋 action-key 的元素退回现有方式（aria-label / getByRole / 文案）。

**executor 可见 action-key（v0.0.218 起）**：playwright a11y snapshot 本身丢 `data-*`（包括 `data-action-key`），executor 主信息源 snapshot.yml 看不到——v0.0.211 铺的 action-key 曾对 ET 是死代码。v0.0.218 起 `tests/e2e/snapshot-with-keys.sh` eval 增强脚本：snapshot 后逐交互节点 eval `dataset.actionKey` 注入 `[action-key=X]` 到 snapshot 文本，executor 自动可见（不改二进制不污染 a11y）。executor 约定：留证 snapshot.yml 用增强版（带 action-key），定位优先 action-key 降级文案 name（详 `specs/tech/testing/et-framework.md §5.1`）。

### 12.6 覆盖范围（现状）
- **全板块主路径已覆盖**（板块前缀见 §12.2 映射表：chat / studio / academy / providers / skill / connector / channel / settings / plugin / framework / common）：CRUD、发送、审批、开关、tab 切换、看板实体操作等主路径可交互元素均已埋。
- **次级配置位渐进补埋**：非主路径位（heartbeat 配置、app/dev config sections、key-card、cron-freq-picker、workspace 面板、skills 只读弹层等）按 ET 脆弱度优先补（follow-up 清单见对应版本 task-board）。缺 action-key 按 §12.7 定性 Minor，不阻塞。
- **新页面/新组件直接埋**：coder 实现新组件时按 §12.2 命名 + §12.8 实践约定埋，不留欠账。
- **defs 驱动的泛型设置项字段**（key-input / key-boolean / key-choice-cards）不逐字段埋 key——泛型组件无业务语义，ET 走 label 文案定位；如需可后续按 defs key 动态埋。
- **不强制 case.md 写 action-key**：case.md 仍自然语言，executor 自己判断元素有无 action-key 决定定位方式。

### 12.7 组件 spec 不强制清单（避免文档膨胀）
组件 spec **不要求**逐个列 action-key 清单。coder 实现组件时按 §12.2 命名规范自行埋属性；spec 作者可选地在「状态 / 交互」章节提一句「关键交互入口埋 action-key（命名见 _conventions §12）」作为 coder 提示，但**绝不强制全清单**——action-key 的消费者是 ET 自动化，不是 spec 读者。

**case.md 也不标注 action-key**：ET case.md 保持纯自然语言（「点新建教室」），executor snapshot 后看到元素带 `data-action-key` 属性就用 CSS selector 定位（见 `.claude/agents/e2e-test-executor.md`），case design 零成本。

**code-reviewer 核对**（只看代码实现，不查 spec 清单是否存在）：可交互元素代码缺 `data-action-key` 属性 → 标 Minor（不阻塞合并，记入 follow-up 补埋）；命名违反 §12.2 规范 → 标 Minor。

### 12.8 实践约定（埋点模式库）

- **下拉类分键**：trigger 与 popover 选项是同 DOM 共存的兄弟节点，必须分键——trigger=`{key}`、选项=`{key}-option`（如 board-selector-dropdown、token-stats CustomDropdown）。选项间同 key 靠文案消歧。ChoiceCards 类无独立 trigger（选项即控件）直接渲 `{key}`。
- **二段式操作（trigger → confirm modal）按同屏性定键**：入口与 modal 确认键**异屏互斥**（modal 打开时入口不可见/已卸载）→ 共用同一 key（如 `chat.session.clear`、`academy.student.create`）；入口与确认键**可同屏共存**（modal 不卸载入口按钮）→ 必须分键，确认键用 `confirm-{action}`（如 `studio.squad.delete` / `studio.squad.confirm-delete`）。同族操作即使异屏也可统一用 `confirm-*` 保持一致（如 `studio.member.confirm-bench`）。
- **动态 key 段 kebab 归一**：用运行时 id/enum 拼 key 段时（`{base}-{id}` 模板），id 含下划线或 camelCase 必须先归一 kebab——`id.replace(/_/g, '-')`（config groupId 如 `default_models`）、camelCase 转连字符（`cacheRate` → `cache-rate`）。动态段值域须来自受校验的权威源（shared enum / DSL id 校验），不拼自由文本。
- **不用不稳定实体名拼 key**：数据驱动的任意实体名（如 panorama DSL 实体）不进 key，收敛到固定家族（`studio.panorama.create-entity` / `open-entity` / `edit-field-{kebab(field)}`），保 key 跨数据稳定。
- **同 key 多实例**：同语义多入口（列表行、双视图、create 双入口）共用一 key，ET 结合文案 / 容器 scope / `.first()` 消歧——不为消歧发明 `-2` 类后缀（违 §12.2）。
- **共享 primitive 走可选 `actionKey` prop 透传**：封闭 primitive（不 spread props）需埋点时加 `actionKey?: string` 纯透传 prop，缺省 undefined → React 不渲染属性，存量消费方零影响。已支持：toggle-switch / secret-input / model-picker-trigger / ModelPicker / chat-topbar-back-btn（back-btn 由消费方按板块语义传，如 `studio.panorama.back` / `academy.chat.back`）。SecretInput 挂根容器（双态尺寸恒定），ET 需下钻内部 input。

## 13. L3 modal 不变式：Portal + 显式 `pointer-events-auto`（硬规则，全站）

> 全局单一落点（v0.0.135 Invariant A 的正式成文处）。跨板块的 modal 不变式以本节为准。
>
> **`chat-page/_layering.md` 现为 4 行存根待补**：v0.0.197「UI spec 瘦身」删掉了它 115 行中的 111 行，L0-L3 分类法 / z 标尺 / Invariant B 目前**无落点**（z token 数值另见 `specs/ui/regulation/01-tokens.md`）。代码里尚有 18 处注释（15 个文件，含 `lib/portal.tsx` / `lib/overlay-root.ts` / chat-page 各 modal 与 overlay）引用其**已不存在的** `§2` / `§3A` / `§3B`——追 Invariant A 一律读本节；Invariant B（L1/L2 `pointer-events` 仅覆盖 footprint）与分类法待后续版本回填 `_layering.md` 后再收敛引用。

**规则（两条同时满足，缺一即 bug）**：
1. **一律 `<Portal>` 到 overlay-root**（`app/web/src/lib/portal.tsx` + `lib/overlay-root.ts`）——脱离一切祖先 stacking context 与 `pointer-events` 门，与触发者在 DOM 树的位置无关。
2. **Portal 内根节点必须显式带 `pointer-events-auto`**——overlay-root 容器是 `pointer-events:none`（好让 modal 外的留白把 wheel/click 透传给下层），而 `pointer-events` **可继承**：根节点漏写 → 整棵子树都不接事件。

**漏写第 2 条的症状**（academy md 编辑弹层 / 发起训练弹层实际踩过）：弹层正常显示，但**所有按钮、遮罩点击全穿透**（视图切换、关闭都无反应），只有走 `window` keydown 的 ESC 还能关。`fixed` + 高 z-index **救不了**——那只管层叠顺序，不管命中测试。

**不做结构性加固**（不让 overlay-root 自己 `pointer-events:auto` 或由 `<Portal>` 代加）：留白透传依赖容器 none，且 invariant 保持显式才能被 UT/review 机械核对。

**UT 门禁（MANDATORY，新增 modal 必带）**：断言 Portal 根 div 的 `className` 含 `pointer-events-auto`。**jsdom 不做 hit-testing**，`fireEvent.click` 在 `pointer-events:none` 下照样触发回调——只断 click 抓不到此类 bug，必须直接断 className。参考 `academy-page/__tests__/component-modal-md-editor.test.tsx`。

**code-reviewer 核对**：新增/修改 modal 若 `<Portal>` 内根节点缺 `pointer-events-auto` → 标 **Critical**（整弹层不可交互）；modal 不走 `<Portal>`（内联在触发者子树）→ 标 Major。

**存量未收敛清单（已知债，勿当新回归）**：以下 6 个 modal 仍内联渲染（无 `<Portal>`），本节成文前即如此——`component-market-detail-modal` / `component-skill-delete-modal` / `component-skill-preview-modal`（skill-page）、`component-memory-editor-modal`（chat-page）、`component-obs-delete-modal`（app-dev-config-page/observability-config）、`component-modal-shell`（studio-page）。它们**当前不坏**：内联即不在 overlay-root 之下，不继承 `pointer-events:none`，故规则 2 的症状不适用；风险仅在祖先将来引入 `pointer-events` 门或 stacking context。**收敛口径 = 下次因功能改动碰到该文件时顺手迁 `<Portal>` + 补 `pointer-events-auto` + UT**，不为此单开重构版本。
