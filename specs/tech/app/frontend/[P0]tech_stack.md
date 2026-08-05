---
type: spec
title: Frontend Tech Stack（web/ 渲染层技术选型）
priority: P0
status: active
updated: 2026-06-30
since: v0.0.1
related: [[P0]design_system.md, [P0]component_architecture.md, ../package/[P0]tool_chain.md]
---

# Frontend Tech Stack（web/ 渲染层技术选型）

> 管什么：`app/web/` 渲染层的技术选型与集成契约——React 19 / Tailwind CSS / Zustand / Vite 各自在 web/ 里扮演什么角色、依赖怎么声明、Tailwind 怎么接入 Vite、与设计系统（`design_system.md`）怎么对接。
> 不管什么：IPC 契约（channel 名、payload schema → `app/protocols/`）；业务逻辑（agent/session/provider → `agent/` 与 `app/server/`）；设计 token 原值（→ `app/frontend/[P0]design_system.md`）；dev/测试工具链总表（→ `app/package/[P0]tool_chain.md`）；打包工具链（→ `app/package/[P0]packaging_toolchain.md`）。
> 边界归属规则见 [docs_guide.md](../../../docs_guide.md) §4。

## 1. 概述

`app/web/` 是 Electron 渲染进程的工作区（定义见 `app/package/[P0]package_structure.md` §2.1），构建目标为浏览器、运行在沙箱内，唯一与主进程的通道是 preload 暴露到 `window` 的 IPC 桥。

本文件锁定 **web/ 渲染层** 的技术栈：**React 19 + Tailwind CSS + Zustand + Vite**，并用 **TanStack Query** 承担流式 token / 会话列表拉取。设计 token（色彩/字体/圆角/组件词表）不是本文件职责，由 `design_system.md` 沉淀，本文件只约定「技术选型如何承载这些 token」。

一句话：**web/ 用 React 19 画 UI、Tailwind 写样式（消费 design_system 的 token）、Zustand 管会话/消息/流式 token 的本地状态、TanStack Query 把 IPC 调用与流式事件接成响应式数据、Vite 出浏览器目标构建产物**。

## 2. 选型总表

| 技术 | 角色 | 在 web/ 里的位置 |
|---|---|---|
| **React 19** | UI 渲染框架。组件树、JSX、并发渲染、Suspense | `app/web/src/components/**`、`app/web/src/App.tsx` |
| **Tailwind CSS** | 样式系统。utility-first，消费 `design_system.md` 的设计 token | `app/web/tailwind.config.ts` + 全局 `src/styles/tokens.css` |
| **Zustand** | 本地状态管理。聊天流、会话列表、流式 token 增量、UI 开关 | `app/web/src/store/**`（每个 slice 一个 store） |
| **Vite** | 构建工具。dev server + 浏览器目标生产产物 | `app/web/vite.config.ts`（归属见 `[P0]tool_chain.md` §2.1） |
| **TanStack Query** | IPC 数据获取 + 流式事件订阅的事实标准。把 `window.api.*` 调用包成 query/mutation，把 SSE/IPC 事件流接成 `query.data` 增量 | `app/web/src/lib/query-client.ts` + 各 feature hook |
| **react-i18next** `[v0.0.59]` | 国际化框架。提供 `useTranslation` / `changeLanguage` / `parseMissingKeyHandler` 等机制；承载 KKV 占位符协议（key × language → value）+ 兜底链 + 缺 key 报错 | `app/web/src/i18n/`（instance + init）+ `app/web/src/i18n/locales/`（bundle）+ `app/web/src/lib/locale-init.ts`（启动期 GET locale） |

> 上述五项均为「web/ 内的选型」，不影响 `electron/`、`server/`、`protocols/`。其余 workspace 不引入这些依赖。

## 3. 设计决策

### 3.1 渲染框架选 React 19

**结论**：`app/web/` 渲染层用 React 19（非 Vue、非 Svelte）。
**理由**：React ecosystem 最大；**shadcn/ui** 是 Tailwind 原生的「复制即用」组件范式（不是 npm 依赖、不锁版本），照 `design_system.md` 归纳的暖色线框（chat bubble / tool card / settings 表单 / sidebar-nav）能以最快速度搭出与设计稿一致的组件；TanStack Query 是流式 token 与会话拉取的社区事实标准，与 React 的 hook 模型契合；React 19 的并发渲染与 `useTransition` 适合「流式 token 增量到达 + UI 不卡顿」的场景。
**反例**：若用 Vue，则 shadcn-vue 欠成熟，照这套暖色线框要多手搭组件；若用 Svelte，虽然运行时更小，但生态与 shadcn 风格组件库更弱，开发速度反而下降。

### 3.2 样式选 Tailwind CSS（utility-first，非 CSS-in-JS）

**结论**：`app/web/` 样式用 Tailwind CSS（utility-first），设计 token 经 CSS 变量定义、Tailwind theme 引用变量（具体映射见 `design_system.md` §3）；不选 styled-components / emotion 等 CSS-in-JS。
**理由**：线框（`reqs/v0.0.1/easy-opc-wireframe-v2.html`）的精细 token（12 档灰阶 + terracotta accent + sage/gold/plum 辅助 + 三套字体 + 多档圆角）与 Tailwind 的 theme.extend 模型直球命中——把 token 写进 theme，组件侧直接 `bg-surface`、`text-fg-2`、`rounded-lg` 即可；shadcn/ui 也是基于 Tailwind，复用其 class 命名一致；运行时零 JS（不像 CSS-in-JS 要注入运行时），与 Vite 的产物体积目标一致。
**反例**：若用 CSS-in-JS，则 theme 与组件 class 两套体系，shadcn/ui 直接不可用；运行时还有样式注入开销，与 Electron 渲染层的首屏目标冲突。

### 3.3 状态管理选 Zustand（非 Redux Toolkit、非 Jotai）

**结论**：`app/web/` 本地状态用 Zustand；聊天流、会话列表、流式 token 增量、UI 开关各建 store slice。
**理由**：Zustand 轻（无 provider、无样板 boilerplate）、TS 友好（`create<State>()(set => ...)` 一行有类型）、**天然适配流式增量更新**——每个 token 到达时 `set(state => ({ messages: ...patch }))` 直接 patch 一条消息的一个 part，与「消息+part 为 key 查找更新」（见 `agent/agent_interface_and_loop` 的 ID 分配原则）一致；多 store slice 解耦各关注。
**反例**：若用 Redux Toolkit，样板多（slice/reducer/action 三件套）、对流式高频增量更新偏重（每 token 一次 dispatch + 不可变拷贝）；若用 Jotai，原子粒度对「整条消息流」这类聚合状态反而要拆很多原子、心智负担大。

### 3.4 数据获取与流式订阅用 TanStack Query

**结论**：IPC 调用（`window.api.session.list()` 等）用 TanStack Query 的 `useQuery`/`useMutation` 包装；流式 token、tool 事件等长事件流用 IPC 监听 + `queryClient.setQueryData` 或 Zustand store 增量写入。
**理由**：TanStack Query 把「请求 + 缓存 + 失效 + 重试」标准化，避免每个 hook 手写 `useEffect + useState + loading/error`；流式场景下，把事件流增量直接 patch 进 Zustand store，React 组件订阅 store 自动重渲染，避开「逐 token setState 触发整树重渲染」的陷阱（用 Zustand selector 精确订阅）。
**反例**：若直接在组件里 `useEffect` 拉数据，则缓存、并发去重、错误重试全要手写，跨组件共享缓存难；若把流式 token 也走 React state，则高频 setState 与并发模式配合易踩坑。

### 3.5 与 web/ workspace + Vite 的集成

**结论**：React/Tailwind/Zustand/TanStack Query 都是 `app/web/package.json` 的依赖；Vite 是 `app/web/` 的 dev/构建工具（归属见 `[P0]tool_chain.md` §2.1）；Tailwind 通过 **Vite 插件**（`@tailwindcss/vite`，Tailwind v4 形态）接入，不另起 PostCSS 链。
**理由**：Tailwind v4 的官方推荐就是 Vite 插件（编译期收 utility、产物极小），与 web/ 已是 Vite workspace 的事实一致；不再叠 PostCSS 配置减少一层。Zustand / TanStack Query 都是纯运行时库，与 Vite 无特殊集成需求。
**反例**：若仍走 PostCSS 链（`postcss.config.js + autoprefixer + tailwindcss` 三件套），则多一层配置、与 Tailwind v4 的 Vite 插件路径重复，且 dev server 重启更慢。

## 4. 示例

### 4.1 `app/web/package.json` 关键依赖片段（精简，不省略关键字段）

```jsonc
{
  "name": "@app/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "@app/protocols": "workspace:*",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "zustand": "^5.0.0",
    "@tanstack/react-query": "^5.0.0",  // 目标形态；当前 app/web/package.json 实际未引入（mock 计数/现状用裸 fetch）
    "i18next": "^23.0.0",               // [v0.0.59] 新引入：i18n 核心（KKV 协议 + 兜底链 + 缺 key 报错）
    "react-i18next": "^14.0.0"          // [v0.0.59] 新引入：React 绑定（useTranslation / I18nextProvider）
  },
  "devDependencies": {
    "vite": "^8.0.0",
    "@vitejs/plugin-react": "^6.0.0",
    "@tailwindcss/vite": "^4.0.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.5.0"
  }
}
```

> `electron` 不出现在依赖里——这是 `[P0]package_structure.md` §3.2「web 与 electron 分离」的编译期强制。
>
> **TanStack Query 当前未引入**：`app/web/package.json` 实际**不包含** `@tanstack/react-query`（仅 react/react-dom/zustand）。mock 计数/现状用裸 fetch；TanStack Query 是为流式 token / 会话列表拉取准备的目标形态（见 §3.4）。此处示例保留 `@tanstack/react-query` 行作「目标形态」，加注释标明当前取用子集。

### 4.2 `app/web/` 目录骨架（按线框组件词表组织）

```
app/web/
├── package.json
├── vite.config.ts            # @vitejs/plugin-react + @tailwindcss/vite
├── tailwind.config.ts        # theme.extend（见 design_system.md §3）
├── tsconfig.json             # extends ../../tsconfig.base.json（见 [P0]tool_chain.md §4.3）
├── index.html
└── src/
    ├── App.tsx
    ├── main.tsx              # ReactDOM.createRoot + QueryClientProvider
    ├── styles/
    │   └── tokens.css        # CSS 变量定义（design_system.md §3 的源头）
    ├── components/           # 组件按线框词表分目录，对应 design_system.md §4
    │   ├── app-shell/        # 三栏 shell：sidebar-nav / conv-panel / chat-area / func-panel
    │   ├── chat/             # message-row / chat-bubble / tool-card / chat-input
    │   ├── settings/         # submenu / provider-card / model-item / breadcrumb
    │   └── primitives/       # badge / button (primary/secondary/ghost) / avatar
    ├── store/                # Zustand slices
    │   ├── session-store.ts  # 会话列表
    │   ├── message-store.ts  # 消息 + part 增量（按 message+part key 更新）
    │   └── ui-store.ts       # 面板开关、当前选中
    ├── lib/
    │   ├── query-client.ts   # QueryClient 实例 + 默认 staleTime/retry
    │   └── ipc.ts            # window.api 类型化封装（类型来自 @app/protocols）
    └── hooks/                # useSessions / useSendMessage / useStreamToken 等
```

### 4.3 Tailwind 经 Vite 插件接入（配置归属示意，非实现）

```typescript
// app/web/vite.config.ts （契约示意，非实现）
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // base / build.target 等按 packaging_toolchain 需求定
});
```

```css
/* app/web/src/styles/tokens.css （CSS 变量源头，design_system.md §3 引用） */
@import "tailwindcss";

@theme {
  --color-bg: #F5F4F0;
  --color-bg-warm: #F0EEE6;
  --color-surface: #FAF9F6;
  --color-surface-2: #FFFFFF;
  --color-fg: #1A1A1A;
  --color-accent: #D97757;
  /* 完整 token 列表见 design_system.md §3，此处只示意接入点 */
}
```

> 完整 token 与 theme.extend 映射在 `design_system.md` §3；本文件只锁定「Tailwind 经 Vite 插件接入、token 经 CSS 变量定义、Tailwind theme 引用变量」这一集成形态。

### 4.4 与 `[P0]tool_chain.md` 的衔接（不重复工具链总表）

| 跑什么 | 怎么跑 | 出处 |
|---|---|---|
| web/ 单测 | `bun run test`（vitest，`environmentMatchGlobs` 让 `app/web/**` 用 jsdom，见 `[P0]tool_chain.md` §4.1） | `[P0]tool_chain.md` §2.3/§4.1 |
| web/ typecheck | `bun run typecheck`（仓库根 `tsc -b`，跨所有 workspace） | `[P0]tool_chain.md` §2.2 |
| web/ dev server | `app/web/` 内 `vite`（被 `scripts/run-dev.sh` 调起的子进程之一） | `[P0]scripts.md` §3.2 + `[P0]tool_chain.md` §4.4 |
| web/ 生产构建 | `app/web/` 内 `vite build`（被 `scripts/build-dmg.sh` 链上的 electron-builder 消费） | `[P0]packaging_toolchain.md` |

> 本文件**不重复**这些命令的契约；只确认 React/Tailwind 等依赖与上述工具链兼容（vite v8 + @vitejs/plugin-react v6 + @tailwindcss/vite v4 是已验证组合）。

## 5. 边界

| 零件 | 归属 |
|---|---|
| web/ 渲染层技术选型（React/Tailwind/Zustand/Vite/TanStack Query）、依赖声明、Tailwind 接入 Vite 的形态、web/ 目录骨架契约 | 本文件 ✅ |
| 设计 token 原值（色彩/字体/圆角/间距）、token → Tailwind theme.extend 的完整映射、组件词表 | `app/frontend/[P0]design_system.md` |
| web/workspace 边界、依赖方向、sandbox/IPC 收发 | `app/package/[P0]package_structure.md` §2.1/§2.2 |
| Vite / vitest / tsconfig 配置归属、`bun run test` vs `bun test` 红线 | `app/package/[P0]tool_chain.md` |
| 三脚本契约（`run-dev.sh` 怎么把 vite dev 拉起来） | `app/envs/[P0]scripts.md` §3.2 |
| 打包工具链（electron-builder 如何消费 web/ 产物） | `app/package/[P0]packaging_toolchain.md` |
| IPC channel 名、payload schema、DTO 类型 | `app/protocols/` |
| 组件实现代码（JSX/函数体）、具体业务 hook 行为 | 代码层（未来 `specs/ui/`） |
| 跨模块零件通用归属规则 | [docs_guide.md](../../../docs_guide.md) §4 |
