# Counter UI（mock 计数器页面协议）

> ⚠️ **DEPRECATED v0.0.3**：counter UI 已删除（`app/web/src/App.tsx:5-6` 注释「v0.0.3 替换 counter demo 为 AppShell，counter-store 保留向后兼容不再渲染」；app/web/src 已无任何 counter 组件 / data-testid）。本篇仅作历史参考，不再作为 ET 依据。已移至 `specs/ui/overall/_archive/`。

> version: 1.0 · 设计稿 2026-06-19
> 管什么：计数器页面的 UI 契约——页面结构、`data-testid` 锚点、视觉断言来源（引用 design_system token）、交互链路与数据流、布局稳定性约定、e2e vision_checks 模板。
> 不管什么：组件实现代码（JSX / hook 行为 → 代码层 `app/web/`）；设计 token 原值（→ `app/frontend/[P0]design_system.md`）；后端 HTTP 契约（→ `specs/api/overall/01-counter.md`）；端口与 DATA_DIR（→ `app/envs/[P0]environments.md`）。
> 边界归属规则见 [docs_guide.md](../../tech/docs_guide.md) §4。

## 1. 概述

v0.0.1 渲染层只落地**一个计数器卡片**，作为端到端验证载体：显示当前计数值 + 「+1」主按钮 + 「刷新」次按钮。视觉风格遵循暖色 design_system token（terracotta 主色、JetBrains Mono 计数字体、米色背景、圆角档位），**不照抄线框中的聊天界面**（PRD §2.1 / §7.2）。e2e-verifier 依据本文件的 testid + vision_checks 做截图判定，**不看代码**。

一句话：**一个暖色卡片 = 数字（mono）+ 主按钮（terracotta +1）+ 次按钮（secondary 刷新）；点 +1 → POST /counter/inc → 刷新；点刷新 → GET /counter → 刷新**。

### 1.1 页面入口与数据流

```
浏览器 / Playwright
  │  打开 http://127.0.0.1:${WEB_PORT}    （test 8787 / dev 8788）
  ▼
Vite web dev server（渲染层，app/web）
  │  页面挂载时 / 点「刷新」时 / 点「+1」后
  │  fetch http://127.0.0.1:${API_PORT}/counter[_|/inc]   （test 3700 / dev 3710）
  ▼
app/server (node:http) → ${DATA_DIR}/counter.json
```

- WEB_PORT 与 API_PORT 分离（见 `app/envs/[P0]environments.md` §4.5）：ET 驱动 `WEB_PORT`，渲染层在浏览器内 fetch `API_PORT`。
- 页面挂载即触发一次 GET（首屏有值），点击 +1 后用 POST 返回值刷新显示，点击刷新用 GET 返回值刷新显示。

## 2. 页面结构（接口定义）

### 2.1 计数器卡片 DOM 锚点

```
[counter-card]（卡片容器 · surface 底 · rounded-md · border）
├── [counter-value]      当前计数值文字（font-mono · fg）
├── [counter-inc-btn]    「+1」按钮（button-primary · accent 底 · surface 文字）
└── [counter-refresh-btn]「刷新」按钮（button-secondary · surface 底 · border-strong）
```

| 元素 | data-testid | 标签 | 视觉契约来源（design_system §4 组件词表） |
|------|-------------|------|------------------------------------------|
| 卡片容器 | `counter-card` | （无） | `surface` 底 + `border` + `rounded-md`(8px) + 卡片内边距 12–16px |
| 当前值 | `counter-value` | （数字本身） | `font-mono`（JetBrains Mono） + `text-fg` + 大字号（如 `text-4xl`） |
| 自增按钮 | `counter-inc-btn` | `+1` | `button-primary`：`bg-accent`(#D97757) + hover `bg-accent-hover` + 文字 `text-surface` + `rounded-sm`(6px) |
| 刷新按钮 | `counter-refresh-btn` | `刷新` | `button-secondary`：`bg-surface` + `border border-border-strong` + `text-fg` + `rounded-sm`(6px) |

> testid 是 Playwright 的唯一稳定定位锚点；e2e-verifier 不得依赖文本内容（数字会变）或 CSS class 名（实现可变）做主要定位，testid 是契约。

### 2.2 视觉契约（vision_checks 的断言来源）

下表所有视觉值**引用 design_system token，不重列 hex**（hex 唯一来源是 `app/frontend/[P0]design_system.md` §2）。

| 视觉项 | 期望（引用 token） | vision 判定锚点 |
|--------|-------------------|-----------------|
| 页面背景 | `bg`（米色 #F5F4F0） | 截图整体色调为暖米色 |
| 卡片表面 | `surface`（白偏暖 #FAF9F6） | 卡片与背景对比，比 bg 更亮 |
| 主按钮（+1）底色 | `accent`（terracotta #D97757） | 存在一颗橙红色（terracotta）实心按钮 |
| 主按钮文字 | `surface`（#FAF9F6），标 `+1` | terracotta 按钮上有白色 `+1` 文字 |
| 次按钮（刷新） | `surface` 底 + `border-strong` 边框，标 `刷新` 或 `Refresh` | 存在一颗浅色描边按钮 |
| 计数字体 | `font-mono`（JetBrains Mono） | 数字呈等宽字体（与按钮标签 sans 区分） |
| 圆角 | 按钮 `rounded-sm`(6px)、卡片 `rounded-md`(8px) | 元素四角为圆角非直角 |
| 主色家族 | terracotta 主 + sage/gold 仅在 badge 等场景出现（计数器卡片无 badge） | 不应出现大量蓝色/紫色 |

> design_system 是视觉契约的**唯一权威来源**；本文件只声明「计数器卡片用到哪些 token」，hex 不在此重列。token → Tailwind 映射见 `app/frontend/[P0]design_system.md` §3。

### 2.3 交互契约

| 触发 | 行为 | 网络 | UI 期望 |
|------|------|------|---------|
| 页面挂载 | 自动 GET 一次 | `GET /counter` | `counter-value` 显示返回的 `value` |
| 点击 `counter-inc-btn` | 自增 1 | `POST /counter/inc` | `counter-value` 更新为响应 `value`（应比点击前 +1） |
| 点击 `counter-refresh-btn` | 重新拉取 | `GET /counter` | `counter-value` 更新为响应 `value`（与服务端一致） |
| inc 请求 in-flight 期间 | 防止重复点击触发竞态 | （禁用按钮或忽略并发，二选一） | 详见 §3.4 决策 |

> API 响应 schema 与端点定义见 `specs/api/overall/01-counter.md` §2.2 / §2.3，本文件不重复。

### 2.4 布局稳定性（MANDATORY）

引用 PRD §2.2：按钮只有「始终可见」或「hover 出现」两态，**出现/消失不得导致其他元素位移**。计数器卡片在 v0.0.1 的落地约束：

- `counter-inc-btn` 与 `counter-refresh-btn` **始终可见**（非 hover 触发），无显隐切换 → 不引入位移风险。
- 若实现选择「inc in-flight 时禁用按钮」，禁用态用 `disabled`（视觉变灰、保留占位）或 `aria-busy`，**不得**用 `display: none` 让按钮消失导致相邻元素跳位。
- 数字从 `0` → `10` → `100`（位数变化）允许宽度变化（等宽字体下可预测），但**不得**导致按钮位置跳动；推荐给 `counter-value` 容器预留 `min-width` 或 `tabular-nums`。

## 3. 设计决策

### 3.1 落地最小子集，不抄聊天界面

**结论**：v0.0.1 渲染层只实现一个计数器卡片（数字 + 主按钮 + 次按钮），**不**实现线框中的 sidebar-nav / conv-panel / chat-area / message-row / tool-card 等聊天界面组件。
**理由**：PRD §2.1 / §7.2 明确「只参考视觉风格、不照抄内容」；v0.0.1 的目标是验证「前后端链路 + 设计系统接入 + ET 截图判定」走通，一个卡片足以覆盖这三个目标。聊天界面推迟到 agent loop / session 上线后（PRD §8 下一版本预告）。
**反例**：若把线框聊天界面全部抄来，则需引入消息 store、流式 token、会话列表等尚未存在的后端能力，v0.0.1 范围爆炸；且这些组件在 v0.0.1 无对应后端，会留下空壳 UI 误导后续版本。

### 3.2 用 data-testid 作 ET 锚点，非文本/class

**结论**：所有需被 Playwright 定位的元素必须挂 `data-testid`（见 §2.1 表），ET 用 `page.getByTestId(...)` 定位；不得依赖数字文本（会变）、不得依赖 Tailwind class（实现可变）做主定位。
**理由**：计数器的核心断言是「数字会增加」，数字本身在变，不能作定位锚；Tailwind class 名是实现选择（coder 可能用 `bg-accent` 也可能用 inline style 引用 CSS 变量），不应锁进契约。testid 是与实现解耦的稳定契约层。
**反例**：若 ET 用 `page.getByText('0')` 定位计数，则点击 +1 后文本变 `1`、定位失效；若用 `.bg-\\[#D97757\\]` 这类 class 选择器，则 coder 改用 CSS 变量后选择器失效。

### 3.3 视觉契约引用 design_system token，不重列 hex

**结论**：本文件 §2.2 视觉表只写「主按钮底色 = `accent`」，不写 `#D97757`；hex 唯一来源是 `app/frontend/[P0]design_system.md` §2.1。
**理由**：PRD §6.3 / design_system §5.4 要求「token 唯一来源」，hex 出现在两份文档会漂移（如 design_system 改了 accent，本文件忘了同步）。vision_checks 的 prompt 写「terracotta 橙红色实心按钮」即可让 MCP vision 判定，不必给 hex（vision 是语义判定非像素比对）。
**反例**：若本文件也列 hex，则 design_system 改色后两份文档不一致，coder 无所适从、verifier 按错值判定。

### 3.4 并发请求处理：禁用按钮防竞态（决策留实现，契约只锁结果）

**结论**：inc 请求 in-flight 期间，实现可选择「禁用按钮」或「忽略并发 inc」，**契约只锁结果**：连续两次点击 inc 后，最终 `counter-value` 比最初 +2（不丢请求、不重复 +1）。
**理由**：v0.0.1 不规定具体并发策略（禁用 vs 忽略），只规定可观测结果；这给 coder 实现自由，同时给 verifier 一个清晰可断言的不变量。布局稳定性（PRD §2.2）要求即使禁用也不能让按钮消失导致位移（见 §2.4）。
**反例**：若契约硬锁「必须禁用按钮」，则 coder 不能用「乐观更新 + 去重」方案；若契约不锁结果只锁策略，则 verifier 无法判定并发正确性。

## 4. 示例

### 4.1 vision_checks 模板（e2e-verifier 复用）

e2e-verifier 截图后调 `mcp__MiniMax__understand_image`，prompt 用结构化 JSON。以下为计数器页面的 checks 模板（per screenshot step 一份）：

```jsonc
// 截图 1：首屏（点击 +1 之前）
{
  "screenshot": "counter-initial.png",
  "vision_checks": [
    { "id": "v1", "check": "页面整体背景为暖米色（terracotta/sand 色调，非蓝灰企业配色）" },
    { "id": "v2", "check": "存在一颗 terracotta（橙红色）实心按钮，文字为 '+1'" },
    { "id": "v3", "check": "存在一颗浅色描边次按钮，文字为 '刷新' 或 'Refresh'" },
    { "id": "v4", "check": "有一个显著数字显示，字体为等宽（mono），与按钮标签的 sans 字体明显不同" },
    { "id": "v5", "check": "主按钮与次按钮四角为圆角，非直角" }
  ]
}
```

```jsonc
// 截图 2：点击 +1 之后
{
  "screenshot": "counter-after-inc.png",
  "vision_checks": [
    { "id": "v6", "check": "数字比截图 1 增加 1（如从 0 变 1，或从 5 变 6）" },
    { "id": "v7", "check": "terracotta 主按钮仍在原位，未因点击发生位移" },
    { "id": "v8", "check": "页面背景与卡片表面色调与截图 1 一致（暖色未变）" }
  ]
}
```

> MCP vision 调用形式见 CLAUDE.md「MiniMax Vision MCP」章节：`understand_image(image_source, prompt)`，prompt 要求返回 `[{ "id", "pass", "note" }]`。verifier 据 `pass` 汇总。

### 4.2 交互断言（Playwright 侧，非视觉）

```jsonc
// UC-3.4.2 链路：dev 启动 → 打开页面 → 点 +1 → 计数刷新
{
  "steps": [
    { "id": "p1", "act": "page.goto(http://127.0.0.1:${WEB_PORT})" },
    { "id": "p2", "assert": "page.getByTestId('counter-value') 可见且为数字 N" },
    { "id": "p3", "act": "page.getByTestId('counter-inc-btn').click()" },
    { "id": "p4", "assert": "page.getByTestId('counter-value') 文本 == N+1" },
    { "id": "p5", "act": "page.getByTestId('counter-refresh-btn').click()" },
    { "id": "p6", "assert": "page.getByTestId('counter-value') 文本 == N+1（刷新不改变值）" }
  ],
  "checks": [
    { "expr": "p2.pass && p4.pass && p6.pass", "desc": "+1 后数字 +1，刷新后保持一致" }
  ]
}
```

### 4.3 视觉契约自查（design_system 引用清单）

计数器卡片用到的 design_system 零件：

| design_system 零件 | 出处 | 计数器用途 |
|--------------------|------|-----------|
| `bg` | §2.1 背景层 | 页面底色 |
| `surface` | §2.1 背景层 | 卡片表面 |
| `accent` / `accent-hover` | §2.1 主色 | 主按钮底 / hover |
| `border` / `border-strong` | §2.1 边框 | 卡片边 / 次按钮边 |
| `fg` / `surface` 文字 | §2.1 文字 | 数字色 / 主按钮文字色 |
| `font-mono`（JetBrains Mono） | §2.2 字体 | 计数字体 |
| `font-sans`（Inter） | §2.2 字体 | 按钮标签字体 |
| `rounded-sm`(6px) / `rounded-md`(8px) | §2.3 圆角 | 按钮 / 卡片 |
| `button-primary` / `button-secondary` | §4 组件词表 | +1 / 刷新 |

## 5. 边界

| 零件 | 归属 |
|------|------|
| 计数器页面结构、testid、视觉契约引用、交互链路、布局稳定性落地约束、vision_checks 模板 | 本文件 ✅ |
| 设计 token 原值（色彩/字体/圆角 hex）、token → Tailwind theme 映射、组件词表 | `app/frontend/[P0]design_system.md` §2 / §3 / §4 |
| 渲染层技术选型（React/Tailwind/Zustand/Vite）、目录骨架 | `app/frontend/[P0]tech_stack.md` |
| 后端 HTTP 契约（端点/schema/错误/持久化） | `specs/api/overall/01-counter.md` |
| `WEB_PORT` / `API_PORT` / `DATA_DIR` 取值与 env schema | `app/envs/[P0]environments.md` |
| 组件实现代码（JSX / props / hook 行为） | 代码层 `app/web/` |
| 包边界（web 沙箱、server 零 electron） | `app/package/[P0]package_structure.md` |
| 跨模块零件通用归属规则 | [docs_guide.md](../../tech/docs_guide.md) §4 |

## 6. 版本

version: 1.0
