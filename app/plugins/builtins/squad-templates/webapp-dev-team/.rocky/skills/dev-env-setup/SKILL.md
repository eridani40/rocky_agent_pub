---
name: dev-env-setup
description: 开发环境设计方法论——三环境隔离原则（dev=单实例开发调试 / test=多实例自动化测试 / prod=单实例正式版）+ test 环境多版本端口分配方案 + env.sh 启停生命周期。参考实现附后，项目按实际情况自行落地。可选接入。
---

# dev-env-setup — 开发环境管理设计方法论

> **定位**：本文是一套**设计方法论**，不是「必须照搬的脚本」。它讲清楚为什么需要三环境隔离、为什么只有 test 需要端口分配、端口方案怎么设计、env.sh 怎么管生命周期。附带给一套参考实现（`references/` + `templates/`），但项目接不接、怎么接、用不用这套端口方案——**项目自己决定**，最终固化到项目自己的代码/配置/脚本/agent 配置里。

## 核心问题：一台机器三套运行态，怎么不互相打架？

一台开发机器上同时跑三套运行态：dev（开发调试）、test（自动化测试）、prod（正式版）。打架的地方就两个：

1. **端口**——两个服务监听同一端口 → 启动失败
2. **数据**——两个环境共享数据目录 → dev 的脏数据污染 test 的断言

解法 = 三环境各管各的：**各用各的端口、各用各的数据目录**。

## 1. 三环境隔离

### 三个环境各是什么

| 环境 | 是什么 | 谁在用 | 实例数 | DATA_DIR | 端口策略 |
|------|--------|--------|--------|----------|----------|
| dev | 开发者在 IDE 跑开发分支，改代码、断点调试 | 开发者本人 | **单实例** | ~/.{app}_dev | 固定端口 |
| test | agent 在 worktree 跑自动化测试（AT/ET），不同版本同时跑多套 | agent / CI | **多实例并发** | ~/.{app}_test/{worktree}/ | **动态分配**（按版本号） |
| prod | 打包安装的正式版，用户日常使用 | 最终用户 | **单实例** | 默认 | 固定端口 |

### 为什么需要隔离

- **不串数据**：dev 的脏数据不污染 test 的断言；test 的测试数据不干扰 prod；prod 的用户数据不被 dev/test 误操作。
- **不抢端口**：三套同时运行时端口不冲突。dev/prod 单实例固定端口就够；test 多实例需要动态分配（见第 2 节）。

### 配置文件

项目根维护三个 env 文件，worktree 创建后复制过去：

```bash
cp {PROJECT_ROOT}/{dev,test,prod}.env {worktree}/
```

每个 env 文件定义该环境的 `APP_NAME`、`APP_ENV`、`DATA_DIR`、启动命令等。test.env 的 `DATA_DIR` 由 env.sh 按 worktree 隔离（不同版本不串数据）。

## 2. test 环境多版本端口分配

> **为什么只有 test 需要？** dev 和 prod 都是**单实例**——一台机器一个 dev、一个 prod，端口固定就行，不冲突。但 test 是**多实例并发**——同一台机器上可能同时跑 v0.0.314 的 AT + v0.0.315 的 ET，每个 worktree 一套服务。如果都用同一端口就打架。所以 **只有 test 需要按版本号自动分配端口**。

### 端口分配方案（参考实现）

端口号 = **服务段前缀（万位）** + **版本后三位（个百十位）**，凑成 5 位端口：

```
端口号 = PREFIX + VERSION_SUFFIX（patch 段 % 1000）

例: v0.0.215 → suffix=215
    AT API = 42000 + 215 = 42215
    AT WEB = 44000 + 215 = 44215
```

不同版本 → 不同后三位 → 天然不同端口 → 多套同时跑不撞。

### 服务段前缀（默认值，项目可改）

| 用途 | 前缀 | 范围 |
|------|------|------|
| AT API | 42000 | 42000-42999 |
| AT WEB | 44000 | 44000-44999 |
| ET API | 43000 | 43000-43999 |
| ET WEB | 45000 | 45000-45999 |
| ET CDP | 46000 | 46000-46999 |

- 版本后三位 = `package.json` version 的 patch 段（如 v0.0.215 → 215）
- worktree 目录名优先（会话版本真相），package.json 次之（开发期滞后）
- **容错窗口**：基址 + 0~19（基址被偶发占用时 `_port_pick_free` 回退）

### 全局注册表

跨 worktree 端口占用真相源（防 boot-race 抢端口）：

- 位置：`~/.{app}_test/_registry/`
- 每 env 一文件 `{kind}-{key}.env`（kind=at/et，key=worktree 名或 case_id）
- 字段：`worktree, kind, key, api_port, web_port, cdp_port, pid, started_at`
- **pid 死 → 自动清理 stale 行**
- 找空端口：注册表登记 + `lsof` 双校验

### AT/ET 串行约束

> AT 与 ET 共享端口注册表 + DATA_DIR → **必须串行，不可并发**。先停 AT 再起 ET（反之亦然）。

## 3. env.sh 启停生命周期

AT/ET 各一套 env.sh，管理 server + web 生命周期：

```
start: 算端口基址 → _port_pick_free 找空位 → 起 API → health check → 起 WEB → 注册
stop:  读 pidfile 拿 pid → _port_kill_tree 杀进程树 → 清端口 → 清注册表
```

核心原则：
- start 后必须 health check 确认服务就绪（不要假设启动即就绪）
- stop 用 pidfile 精确 kill 进程树（禁 `pkill -f` 宽匹配——会误杀兄弟 worktree）
- 清理要彻底：进程树 → 端口残留 → 注册表记录

详细参考实现见 `templates/env.sh.example`。

## 参考实现

### port_alloc.sh 函数清单（`references/port_alloc.sh`）

| 函数 | 用途 |
|------|------|
| `_port_version_suffix` | 版本后三位（0-999） |
| `_port_at_api_base` / `_port_at_web_base` | AT 端口基址 |
| `_port_et_api_base` / `_port_et_web_base` / `_port_et_cdp_base` | ET 端口基址 |
| `_port_pick_free <base> <max>` | 找空端口（注册表 + lsof 双校验） |
| `_port_register <api> <web> <pid> [mock_llm]` | AT env 登记 |
| `_port_et_register <cid> <api> <web> <cdp> <pid>` | ET case 登记 |
| `_port_free` | AT 清 .env_port + 注册表 |
| `_port_et_free <cid>` | ET case 清注册表 |
| `_port_kill_tree <pid> [marker]` | 杀 pid + 递归 descendants（marker 防误杀） |
| `_port_cleanup_check` | worktree 清理前检查残留 |

### 模板文件

| 文件 | 用途 |
|------|------|
| `templates/env.sh.example` | AT 启停脚本（start/stop 完整逻辑） |
| `templates/dev.env.example` | dev 环境配置 |
| `templates/test.env.example` | test 环境配置 |
| `templates/prod.env.example` | prod 环境配置 |
