---
name: front-end-design-prompt
description: Generate a self-contained front-end design prompt for external design tools (v0 / bolt / Make / Claude). Use when the user wants to hand a UI redesign off to another tool — "生成前端设计 prompt", "我去其他工具设计", "出个设计稿 prompt". Emphasizes incremental changes vs. current state.
---

# Front-End Design Prompt

## Purpose

把一个 UI 改造需求，转成一份**自包含、贴合项目现状、强调增量、可直接喂给外部设计工具**（v0 / bolt / Make / Claude 等）的前端设计 prompt。

外部设计工具读不到本项目代码库。所以 prompt 必须自带全部上下文：技术栈、设计 token、现状布局、目标布局、mock 数据、交互约束。

## When to Use This Skill

当用户要把 UI 设计交给外部工具时：
- "帮我生成前端设计 prompt，我去其他工具设计"
- "出个 v0 / bolt 能用的设计稿 prompt"
- "描述一下这个页面，我要拿去设计"
- 任何"我要把 UI 改造外包给设计工具"的意图

**不要用于**：直接在本项目里实现 UI（那是 coder 的活）、生成给本项目 PRD/UI spec 的内容（那是 doc_specs / prd 的活）。

## 核心原则

1. **先理解现状再动手**（AGENTS.md 原则 10/11）：必须先读 `specs/ui/` + 前端代码 + design token，搞清楚现状。设计 prompt 永远是**相对现状的增量**，不是凭空发明。
2. **强调增量**：prompt 最醒目位置放「现状 → 目标」对照表，标注 🆕新增 / 🔁变更 / 🐛修复 / ♻️保留。设计工具据此知道改什么、留什么。
3. **自包含**：token 值、mock 数据、组件清单全部写进 prompt，设计工具无需读代码库。
4. **可交互**：关键交互（联动、独立保存、拖拽、单选互斥）必须写成硬约束 + 要求可演示。
5. **先全貌后增量**：先描述整个 app 的交互全貌（所有 view、整体骨架、统一设计语言），再把本次增量融入对应 view。外部设计工具需理解 app 整体才能产出风格协调的原型——只给增量片段会与整体脱节。每个 view 标注 ♻️现状保留 / ⚡本次增量。

## 流程（5 步）

### Step 1：读现状
- 读 `specs/ui/overall/` 了解页面契约、testid、布局描述
- 读对应前端组件（`app/web/src/components/`）看真实实现，**覆盖 app 全部 view**（含核心交互页如 chat，不只读要改的页）
- 读 `app/web/src/styles/tokens.css`（或 design_system.md）拿配色 / 圆角 / 字体 / 主题

### Step 2：提取设计语言
从 token 文件摘出：主色 + hover/浅底变体、辅助色、背景、边框、字体栈、圆角档位、主题切换方式。**直接抄 hex 值**，不要让设计工具自己配色。

### Step 3：梳理增量（核心）
产出「现状 → 目标」对照表，每行一个维度，标注类型：
- 🆕 新增（现状没有）
- 🔁 变更（现状有但要改）
- 🐛 修复（现状是 bug）
- ♻️ 保留（明确不变，避免设计工具误改）

### Step 4：填模板
用 `templates/design-prompt-template.md`，填入：增量对照表（放最前）+ 背景/技术栈 + 设计语言（token 值）+ 全局骨架（ASCII 线框）+ 逐页/逐区详细要求 + 数据 mock（JSON）+ 交互约束 + 交付要求。

### Step 5：自检
- [ ] 自包含：删掉项目代码库，prompt 还能让设计工具开工吗？
- [ ] 增量清晰：设计工具能一眼看出改什么、留什么吗？
- [ ] token 完整：有没有让设计工具自己配色 / 定圆角的地方？
- [ ] 交互可演示：联动 / 独立保存 / 拖拽 / 单选互斥，是否都有明确约束 + 可演示要求？
- [ ] mock 数据：每个需要渲染的列表 / 表单是否给了 JSON 示例？

## 输出位置

写到 `reqs/v{N}.{M}/design-prompt.md`（与该版本需求同级，方便用户拿走）。

## 设计 prompt 必备章节清单

1. **App 全貌**（app 是什么 + view 一览表，逐 view 标注 ♻️现状保留 / ⚡本次增量）
2. **设计语言**（token 值，全 app 统一）
3. **整体骨架**（AppShell ASCII 线框）
4. **逐 view 详细要求**：现状 view 简述保留即可；增量 view 含「现状→目标」对照表 + 新布局 + 数据 mock（JSON）
5. **交互约束**（硬约束，可演示：联动 / 独立保存 / 拖拽 / 单选互斥）
6. **交付要求**

> 顺序原则：**全貌在前，增量融入各 view**。先用 view 一览表让设计工具看到改了什么、留了什么，再逐 view 展开现状/目标。

## 反例（绝对禁止）

- ❌ 不读现状就写 prompt → 设计工具凭空发明，与项目脱节
- ❌ token 值缺失（只说"用主色"，不给 hex）→ 设计工具瞎猜配色
- ❌ 只描述功能，不描述交互约束（如"开关独立，不联动"）→ 设计工具无法体现关键行为
- ❌ 不给 mock 数据 → 设计工具不知道要渲染什么结构
- ❌ 把整页当全新设计，不标增量 → 设计工具把"保留"的东西也改了
- ❌ 在 prompt 里粘贴本项目源码 → 冗长且设计工具不需要
- ❌ 只给增量片段、不描述 app 全貌 → 设计工具产出与整体脱节、风格不协调

## 与开发阶段的衔接（组件化）

设计工具产出的是**一体 html 原型**（设计阶段不要求组件化）。组件化拆分是**开发阶段**的事——标准见 `specs/ui/components/_conventions.md`（粒度/命名/目录）、架构见 `specs/tech/app/frontend/[P0]component_architecture.md`，由 **coder 编码前置**产出每个组件的 `.md`+`.tsx` spec。**设计 prompt 无需描述组件化**，两者职责分离。

## 参考产出

`reqs/v0.0.4/design-prompt.md` 是本 skill 的一次完整实践（配置中心三栏重构 + 插件 / 扩展点管理）。
