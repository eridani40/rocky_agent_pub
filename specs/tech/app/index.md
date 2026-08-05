---
type: index
title: App 子系统总起（应用编排层）
priority: P0
updated: 2026-07-30
---

# App 子系统总起（应用编排层）

## ① 是什么

app = **应用编排层**——把 `agent/` / `session/` 等业务子系统组装成可运行的桌面应用的全部「外壳 + 工具链 + 环境」契约。本 KB 不实现业务逻辑（在 `agent/` 与 `app/server/`），只回答「`app/` 物理怎么组织、跑哪些环境、渲染层怎么搭、启动时怎么清理」。下分 4 个子 KB，各管一域。

| 核心概念 | 一句话 |
|---|---|
| **5 workspace 包** | `app/{electron,web,server,protocols,shared}`，Bun workspaces + 编译器强制依赖边界 |
| **三环境** | test（自动化）/ dev（开发者）/ prod（发布者），按执行主体划分；三份独立 `.env` |
| **渲染层** | `app/web/` React 19 + Tailwind + Zustand + Vite + TanStack Query；技术选型 + 设计 token + 组件分层 + SSE 桥 |
| **electron-builder** | mac 出 dmg / win 出 nsis exe；workspaces 下 asar 显式列 server/protocols/web 产物 |
| **startup reconcile** | bootstrap 启动时一次性扫残留 running/interrupting 态 → idle（五态 + summaryTask 两路正交） |

## ② 边界

| 管 | 不管（→ 别的 KB） |
|---|---|
| `app/` 物理布局 + workspace 边界 + 进程边界 + 打包工具链 | agent/session 业务逻辑（→ `../agent/`） |
| 三环境语义 + `.env` schema + `scripts/` 人工入口契约 | 自动化测试启停 run_all/env_start（→ `tests/`） |
| web/ 渲染层技术选型 + 设计 token + 组件分层架构 + SSE 桥 | 单组件 testid/props 契约（→ `specs/ui/components/`） |
| 启动清理流程 + bootstrap 接入点 + 顺序约束 | 五态/summaryTask reconcile 实现 SQL/CAS（→ `../agent/session/`） |
| Bun + vitest + tsconfig 工具链选型与配置归属 | IPC channel schema 业务字段（→ `app/protocols/`） |

## ③ 与系统的关系

```
                          ┌── agent/                (AgentLoop 本体 + session 状态机 + event-hub)
                          │
   app KB  ───────────────┼── app/server            (业务大脑；零 electron 依赖；启动 reconcile 接入点)
   (本目录, 编排层)         │
                          ├── app/{web,electron}    (渲染层 + 主进程壳；preload IPC 是唯一通道)
                          │
                          ├── app/protocols         (跨进程类型唯一源：IPC schema + DTO)
                          │
                          └── specs/ui/components   (单组件契约，由 frontend token/词表抽象链路输入)
```

**对外协作点**：业务大脑落 `app/server/src/`（含 `bootstrap.ts` 启动接入点）；渲染层落 `app/web/src/`；装配壳落 `app/electron/src/`；契约落 `app/protocols/`；脚本/环境落项目根 `scripts/` + 三份 `.env`。

## ④ 核心设计原则（跨文件不变量）

1. **Bun workspaces + 编译器守边界**——web 误 `import electron` 编译期失败；server 去 electron 化由不声明 `electron` 依赖强制。→ `package/index.md §④-1`
2. **server 是纯业务大脑，原生能力靠注入**——server 不 `import electron`，单测可纯 Node 跑、未来可拆独立 CLI。→ `package/index.md §④-3`
3. **环境按执行主体划分，按 env 隔离数据目录与端口**——同机可跑多环境；`API_PORT`/`WEB_PORT` 双键各自按 env 互不相同。→ `envs/index.md §④-1/§④-3`
4. **暖色系 + token 经 CSS 变量 + 组件式架构**——线框是设计唯一权威源；token 单一物理源、未来主题切换零成本；五层分层单向组合。→ `frontend/index.md §④-1/§④-2/§④-3`
5. **reconcile 必须在 API 监听前完成，两路正交**——五态机 + summaryTask 旁路 CAS 独立；都扫、互不影响。→ `start_up/index.md §④-1/§④-2`

## ⑤ 本目录导航（4 子 KB）

| 子 KB | 管什么（一句话） | 入口 |
|---|---|---|
| **envs/** | 三环境语义（test/dev/prod）+ `.env` schema + `scripts/` 三人工入口脚本契约 | [link](envs/index.md) |
| **frontend/** | web/ 渲染层技术选型（React 19/Tailwind/Zustand/Vite）+ 设计 token + 组件分层 + SSE 桥 | [link](frontend/index.md) |
| **package/** | 5 workspace 物理布局 + Bun workspaces + electron-builder 打包 + Bun/vitest/tsconfig 工具链 | [link](package/index.md) |
| **start_up/** | app 启动清理（五态 reconcile + summaryTask reconcile，两路正交）+ bootstrap 接入点 | [link](start_up/index.md) |

本级 spec 文件：

| 文档 | 管什么（一句话） | 链接 |
|---|---|---|
| `feature_gate.md` | feature gate 机制（vite define 编译期常量，仅管前端呈现；首个用例 `__FEATURE_OKR__` 默认关） | [link]([P1]feature_gate.md) |

> 变更历史见 `log.md`（本级）+ 各子 KB 的 `log.md`；跨版本发布说明见 `specs/tech/version_logs/vX.Y/change_log.md`。
