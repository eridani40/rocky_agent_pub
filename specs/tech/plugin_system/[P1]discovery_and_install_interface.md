---
type: spec
title: Discovery & Install Interface
priority: P1
status: draft
updated: 2026-06-30
since: v0.0.3
related: [[P1]plugin_lifecycle.md, [P1]isolation_and_threat_model.md, [P0]ext_impl_and_manifest_interface.md]
---

# Discovery & Install Interface

## 1. 概述

本文件定义「插件怎么被『找到』（discovery）和『装上』（install），以及装前安全扫描」——P1 外部/动态扩展。
**不管**：生命周期流程（→ `[P1]plugin_lifecycle.md`）、配置管理面策略（→ `config/[P0]plugin_config_service.md` 的 `PluginConfigService`）、manifest 字段（→ `[P0]ext_impl_and_manifest_interface.md`）。
**与外界交互**：**当前为 spec only，未落地**（P0 native 注册路径见 `[P0]builtin_plugins_directory.md`，扫描点 `app/plugins/builtins/`）；落地后扫描路径/安装源将走 `BuiltinLoader` 之外的 P1 discovery 模块（设计待定）。

- **discovery**：启动时扫描一组按优先级排序的路径，凭 **manifest 标记文件**是否存在判定「这是个插件」（具体文件名待定/可配置），读出声明。**绝不实例化 impl 类**（见 `[P1]plugin_lifecycle.md`）。**P0 无此相**（native 代码注册）。
- **install**：把三方插件装进宿主管控的目录。安装源分 npm / 本地目录 / git / 市场；npm 源**只认精确版本或 dist-tag**，禁止语义化范围。
- **装前扫描**：安装前做依赖黑名单、symlink 逃逸、来源标签、运维策略、before_install hook 等检查，失败即阻断。

## 2. 接口定义

### discovery 扫描路径（优先级高 → 低）

| 优先级 | 来源 | 典型路径 |
|---|---|---|
| 1 | 配置显式 | `plugins.load.paths` |
| 2 | 工作区 | `<workspace>/.host/extensions/` |
| 3 | 内置（bundled） | 宿主随包自带 |
| 4 | 全局 | `~/.host/extensions/` |

- **判定规则**：目录含 manifest 标记文件即视为插件候选；同一路径首个声明来源胜出（去重）。
- **安全门**：拒绝 world-writable 目录、属主异常、symlink 逃逸出根的路径。

### install 源与版本规则

| 源 | spec 形式 | 约束 |
|---|---|---|
| npm | `pkg@x.y.z` 或 `pkg@dist-tag` | **禁止** URL、`git/file` 协议、语义化范围（`^` `~` `*`） |
| 本地目录 | `./dir` 或绝对路径 | 校验无路径穿越（无 `..`、无跨界 `\`） |
| git | `git:<url>` 或 GitHub 简写 | 优先钉到不可变 commit ref |
| 市场 | 市场名 + id | 一等源，转发到 npm/local |

### 装前扫描（返回 `{ blocked?: { code, reason } }`）

- **依赖黑名单**：遍历包元数据的依赖树（依赖声明文件，具体形式待定/可配置），命中黑名单包名 → 阻断。
- **symlink 逃逸**：node_modules 符号链接指向安装根之外 → 阻断。
- **来源标签**：标 `{ bundled/market = 宿主权威, npm/git = 三方, local = 用户 }`，驱动信任决策。
- **运维策略**：若启用，spawn 运维自配的扫描命令，解析 `{ findings, blocked }`，**任何错误/空输出即 fail-closed**。
- **before_install hook**：第三方可挂的拦截 hook，失败即阻断（`code: "security_scan_failed"`）。

## 3. 设计决策

### 3.1 discovery 凭 manifest 存在判定，绝不实例化

**结论**：发现只读 manifest 标记文件，不实例化任何 impl 类。
**理由**：见 `[P1]plugin_lifecycle.md` §3.1——禁用/坏插件/未触发都不应因发现而执行。
**反例**：OpenClaw `discovery.ts:1019` 同此（仅 stat + 读 manifest）。

### 3.2 扫描路径按优先级、首源胜出

**结论**：四类路径按优先级扫描，同路径首个声明来源胜出（去重）。
**理由**：让「配置显式 > 工作区 > 内置 > 全局」的覆盖顺序确定，便于本地覆盖全局。
**反例**：若全合并不去重，同插件多份副本冲突；若后源覆盖先源，本地覆盖不可预测。

### 3.3 npm 只认精确版本/dist-tag，禁语义化范围

**结论**：npm 安装只接受 `pkg@x.y.z` 或 `pkg@dist-tag`，拒绝 `^`/`~`/`*`/URL/git-in-npm-spec。
**理由**：可复现 + 安全——浮动版本会在任意时刻拉到不同代码，破坏可复现性并放大供应链风险。
**反例**：OpenClaw `npm-registry-spec.ts:108` 同此约束。语义化范围的「方便」远不抵供应链与可复现的代价。

### 3.4 装前扫描 fail-closed

**结论**：装前扫描任一环节失败/异常 → 阻断安装（fail-closed），不降级放行。
**理由**：三方代码进进程（见 `[P1]isolation_and_threat_model.md`），装前是最后一道可控闸门；放行即把不可信代码引入可信进程。
**反例**：若扫描异常即放行，则坏掉的扫描器 = 无扫描器。

### 3.5 来源标签驱动信任

**结论**：每个插件标来源标签（宿主权威 / 三方 / 用户），作为信任与默认启用的依据。
**理由**：运行时不沙箱（见威胁模型），信任只能在「装前 + 配置后台」表达；来源标签是信任决策的输入。
**反例**：无来源标签则配置后台无法做「三方默认禁用、需手动启用」这类策略。

## 4. 示例

安装命令（用户侧）：
```bash
# 精确版本（推荐）
npx host-plugin install @acme/memory-lancedb@0.4.1
# dist-tag
npx host-plugin install @acme/memory-lancedb@beta
# 本地开发
npx host-plugin install ./my-plugins/memory-lancedb
```

装前扫描阻断示例：
```json
{ "blocked": { "code": "security_scan_failed", "reason": "dependency denylist hit: malicious-pkg" } }
```

## 5. 边界

| 零件 | 归属 |
|---|---|
| 扫描路径/优先级/安全门、安装源/版本规则、装前扫描 | 本文件 ✅ |
| 发现后的生命周期流程 | `[P1]plugin_lifecycle.md` |
| 启用/禁用/信任的策略（消费来源标签，P1） | `config/[P0]plugin_config_service.md`（PluginConfigService） |
| 运行时信任边界（为什么不沙箱） | `[P1]isolation_and_threat_model.md` |
