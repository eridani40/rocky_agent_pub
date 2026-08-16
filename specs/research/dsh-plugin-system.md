---
type: research
title: DSH 动态插件系统调研（对话中修改自身 / 动态加 UI 组件）
priority: P1
status: active
updated: 2026-08-15
source: deepseek-harness（packages/extensions/{tool-cordis,cordis-host-runner,cordis-client-runner,ui-cordis} + packages/client/modules + docs/cordis-primer.md + docs/subsystems/{extensions,client-modules}.md + examples/web-cordis）
related: [./rocky-upgrade-plan-2026-08-14.md]
---

# DSH 动态插件系统调研（动态 Cordis Plugins）

> 上游：老板 2026-08-15 口头需求「让 rocky 支持类似 DSH 的能力——通过对话改变自己，比如屏幕上加一个组件」。本调研只读 DSH 源码与文档（deepseek-harness checkout），不改 rocky 代码。
> 调研时间：2026-08-15 · 调研人：主 agent（直读，未委派）

## §0 一句话结论

**DSH 的动态插件（Dynamic Cordis Plugins）= 一套「模型面工具（5 个对话工具）+ 双半运行时（host 半 Node 沙箱 / client 半浏览器执行）+ 前端 Slot 挂载系统 + 用户审批 + 可逆生命周期」的完整闭环**，让 agent 在对话中现场定义、运行、停用、删除一个扩展，代码只活在当前进程内存、重启即失、不落盘不改仓库。rocky 要复刻它，**最难也最核心的是 client 半 + Slot 系统（对应「屏幕上加组件」）**；host 半可以复用 rocky 现有 EP/PluginManager 语义做最小闭环。安全立场明确：沙箱非安全边界，信任靠用户审批（rocky 已有 approval-manager 可复用）。

---

## §1 DSH 是怎么做到「对话里加一个组件」的

### 1.1 核心链路（一轮对话内完成）

```
用户："帮我加一个 X 组件"
  │
  ▼ agent 调 cordis_define    ← 定义：纯 JS 函数体（host 半 + client 半），只校验语法不运行
  ▼ agent 调 cordis_run       ← 激活：host 半在 Node 进程 vm 沙箱跑；client 半广播给所有打开的页面
  │                              └ 首次运行 client 半 → 页面弹出审批卡（单勾=本次授权，双勾=未来版本也授权）
  ▼ 页面收到 cordis/request-run → 用户点 Run → 浏览器执行 client 半 → 组件出现在 slot 里
  ▼ agent 调 cordis_stop / cordis_undefine  ← 停用/删除，所有副作用（effect）可逆回滚
```

### 1.2 双半模型（DSH 动态插件的核心抽象）

| 半 | 运行位置 | 能做什么 | 代码形态 |
|---|---|---|---|
| **Host 半** | DSH Node 进程（vm 沙箱） | 文件/网络/命令/内部服务、注册模型工具、监听事件、提供 JSON 方法给 client 调 | 纯 JS 函数体返回 Cordis Plugin（apply(ctx)），无 TS/JSX/import |
| **Client 半** | 浏览器页面 | 渲染 React UI（React.createElement，无 JSX）、主题、slot 注册、Tool 卡片 | 纯 JS 函数体，closure 求值，符号面 = {React, console, styles, host} |

通信：**Package-private JSON RPC**——client 半 `host.call(method, args)` → host 半 `harness.handle(method, handler)`；仅 lossless JSON，方向固定 Client→Host，参数缺省传 null。

### 1.3 模型面 = 5 个工具 + 1 个 Skill

| 工具 | 作用 |
|---|---|
| `cordis_inspect_list` | 列出当前进程所有 Inspect Provider（平台/用途/只读方法/schema）——**先查契约再写代码，禁止猜 API** |
| `cordis_inspect_query` | 查询具体 Service 方法/Event 模式/Builtin 签名/Tool schema/主题 token/实时 Slot 树与 props |
| `cordis_inspect_self` | 只读查当前会话的 Plugin/Package/版本指针/源码/运行诊断（修复异步失败前必查） |
| `cordis_define` | 定义不可变 Package（pluginId=可变实例 + packageId=不可变版本；改代码=追加新版本，不覆盖旧版） |
| `cordis_run / stop / undefine` | 激活（首次 client 运行需审批）/ 停用（定义保留）/ 删除（定义+包全删） |

配套：
- **系统提示词段**（CORDIS_SYSTEM_PROMPT）：什么时候该用/不该用动态插件、工作流、高频错误清单（服务注入、纯 JS 约束、live data 不序列化、副作用必须可逆）
- **cordis-plugin-development Skill**：需求导航、能力组合、完整示例、故障排查
- **契约目录是生成式**（gen-cordis-catalog.ts / gen-client-catalog.ts 从 SlotMap 声明与调用点词法扫描），保证「模型读到的 = 代码实际有的」，freshness 由 doc-sync 门禁

### 1.4 UI 挂载 = Slot 系统（对应「屏幕上加组件」）

- 前端声明**命名槽位**（如 `sidebar.footer.action`、`tool.call.toolview`、`tool.view.cordis`），每个 slot 有注册契约（kind/scope/owner props/谁已占位）
- 动态 client 代码经 `ctx.slots.register` 挂到 slot；**禁止直接 return React 元素**
- `ctx.slots.inject(slotName, () => register(...))` 是挂载模式；`children` 字段可声明子 slot（如 run 卡片内的业务视图区）
- Slot 监督缝（`slots.onEntryError`）：渲染崩溃 → 上报 authoring 会话（模型可见）+ 页面行内诊断，双出口
- 主题覆盖（`theme` seat）按 package id 钉层，disposer 挂 fiber 上

### 1.5 审批与版本生命周期

- **审批**：client 半首次运行 → 页面审批卡（awaiting-approval）；单勾 = 本次 Package 授权，双勾 = 该 Plugin 未来版本也授权；拒绝后 agent 不得重复请求
- **版本指针**：currentPackageId（最近完全成功）/ nextPackageId（待批/尝试中/最近失败）；update 先停旧 run 再启目标；失败不自动回滚旧版，retry 走 update 或 rollback 走 run
- **失败自愈回路**：技术失败 → `cordis_inspect_self` 读源码+堆栈 → 修正同 Plugin → 重试（禁止静默另建 Plugin）；渲染期崩溃走 post-settle 诊断路径（run 已答 ok 后单独上报）

### 1.6 安全与生命周期哲学

- vm 沙箱隔离 globals（无 process/Buffer/window/document/fetch/require），但**官方明说「不是安全边界，等同 shell 访问」**——信任靠：用户审批 + 会话隔离（Package 只在本会话可见可控）+ 用户随时可停
- 动态包**只活在当前进程内存**：重启即失、不写仓库、不改 cordis.yml/配置、不装包、不自动转正；想长期保留走正常开发流程做成正式 Plugin
- 一切副作用可逆：`ctx.effect()` 返回 disposer，stop/update/undefine 全部回滚

---

## §2 rocky 现状 vs DSH 差距

| 能力 | DSH | rocky 现状 | 差距 |
|---|---|---|---|
| 动态代码定义+沙箱执行 | vm 沙箱跑模型写的 JS | ❌ 插件全静态（manifest 编译期声明 + import 类引用） | 缺动态代码运行时 |
| 浏览器 half / UI 扩展 | cordis-client-runner + slots | ❌ 无 slot 系统、无动态加载（web 无 React.lazy/remote） | 缺 client 半 + slot（最大缺口） |
| 模型面工具链 | 5 工具 + Skill + 引导 prompt | ❌ 无 | 缺 |
| 契约可查询（防猜 API） | inspect providers + 生成 catalog | ❌ 无 | 缺 |
| 运行时审批 | 页面审批卡 | ✅ **已有** approval-manager（审批卡 HITL，v0.0.354 刚验证 pending 链路） | 可复用 |
| 可逆生命周期 | effect disposer + 版本指针 | ⚠️ 部分（EP/PluginManager 静态框架语义可扩展） | 部分 |
| 实时下发通道 | client-modules bundle + broadcast | ⚠️ **SSE 通道**（v0.0.354 逐帧推送刚完成）可作下行载体 | 需扩展 |
| 动态包持久化/转正 | 明确不做（重启即失） | — | 设计决策需老板拍板 |

**rocky 可复用资产**：EP/ExtImpl/PluginManager 静态框架（概念层）、approval-manager 审批流、SSE 通道、configSchema 单一源（动态包配置可用同一 schema 底座）。

---

## §3 落地分期建议（若立项）

**P1 — host 半最小闭环（低风险，后端 only）**：模型面工具（inspect/define/run/stop/undefine）+ vm 沙箱执行 host 半 + 副作用可逆注册到现有 EP 体系。验收：「对话中加一个后端工具/能力」全链路走通。改动全在 `app/server/src/`。

**P2 — client 半 + Slot 系统（核心，对应「加组件」）**：前端 slot 系统（起步 1-2 槽位：对话流卡片区 + 侧栏按钮区）+ client 半下发执行（SSE 或 bundle）+ 复用审批卡 + 渲染失败诊断回路。工作量最大，也是 DSH 经验最值得抄的部分。

**P3 — 模型引导与治理**：inspect 契约目录（生成式）+ Skill + 系统提示词段 + 失败自愈回路 + 版本指针语义。

---

## §4 需要老板拍板的决策点

| # | 问题 | 选项 |
|---|---|---|
| Q1 | 动态包是否支持「转正」为正式插件？ | DSH：不自动转正，手动走正常开发流程（推荐对齐） |
| Q2 | 安全水位 | 接受 DSH「沙箱非安全边界、等同 shell、信任靠审批」立场，还是 rocky 要更强隔离（P1 isolation 三道防线） |
| Q3 | UI 范围 | 第一期只做 host 半（后端扩展），还是必须带 client 半（屏幕上组件）？带 UI 需先设计 slot 系统 |
| Q4 | 审批复用 | 复用现有 approval-manager 审批卡（推荐）还是动态包独立审批流 |

---

## §5 证据清单（DSH 侧源码位置）

- `packages/extensions/tool-cordis/src/index.ts`：5 个模型面工具注册 + CORDIS_SYSTEM_PROMPT（`src/prompt.ts`）
- `packages/extensions/tool-cordis/README.md`：Trust stance（沙箱非安全边界）、生成 client slot catalog、模型体验（token/KV cache 影响）
- `packages/extensions/cordis-host-runner`：host 半 vm 沙箱 + 注册表 + 生命周期（`ctx.dynamicCordisRunner`）
- `packages/extensions/cordis-client-runner/README.md`：浏览器半 closure 求值、guard facade、request-run 编排、render-failure 双出口
- `packages/extensions/ui-cordis/src/client/{index.ts,slots.ts,dynamic-port.ts}`：slot 声明（tool.view.cordis 等）+ 注册模式 + 面板
- `packages/client/modules/src/client/manifest.ts`：client-modules 扫描/引导图（window.__DSH_BOOT__）/bundle 路由
- `docs/cordis-primer.md`：Cordis 五概念（Plugin/Context/inject/Events/可逆注册）
- `docs/subsystems/extensions.md` + `client-modules.md`：子系统总起（生成式 Cordis API 目录）
- `examples/web-cordis/cordis.yml`：自举 demo 组合方式（webserver 3081 + cordis-host-runner + tool-cordis）
- `docs/postmortem/0003-web-agent-gui-feedback-loop.md`：教训（agent 必须知道当前 GUI 身份/URL/运行模式才能改自己）
