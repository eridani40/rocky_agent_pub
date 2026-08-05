---
type: spec
title: Isolation & Threat Model（隔离与威胁模型）
priority: P1
status: active
updated: 2026-06-30
since: v0.0.3
related: [[P1]discovery_and_install_interface.md, [P0]builtin_plugins_directory.md]
---

# Isolation & Threat Model（隔离与威胁模型）

## 1. 概述

本文件声明「插件代码的运行时隔离边界、威胁模型、安全三道防线、以及明确『不保护什么』」。
**不管**：发现/安装/扫描机制（→ `[P1]discovery_and_install_interface.md`）、配置管理面（→ `config/[P0]plugin_config_service.md` 的 `PluginConfigService`）。
**与外界交互**：威胁模型是**契约性约束**，约束所有 plugin 代码（`app/plugins/builtins/*` 未来扩展至 P1 外部插件）与宿主同进程裸跑；防线的「装前」环节由 P1 discovery/install 模块实现（当前 spec only），「启用前」环节由 `PluginConfigService`（`app/server/src/plugin/plugin-config-service.ts`）实现，「密钥隔离」由宿主日志/secret 解析层实现。

**插件代码与宿主同进程运行，无运行时沙箱。** 威胁模型是**可信运维（trusted operator）**：运维负责通过「装前扫描 + 来源标签 + 配置后台」控制「谁被装、谁被启用、谁被信任」。一旦某 ext impl 被 enabled 并被 get 实例化，即视为受信，其代码在进程内拥有与宿主同等的能力。

这是经过权衡的明确选择（同 OpenClaw `SECURITY.md`），而非疏漏。

## 2. 威胁模型

| 主体 | 是否受信 | 处理 |
|---|---|---|
| 内置（bundled）插件 | 受信 | 随宿主发布，默认启用 |
| 市场/官方源插件 | 受信（经审计） | 默认启用 |
| 三方（npm/git）插件 | **不受信，需运维启用** | 装前扫描 + 默认禁用 + 手动启用 |
| 本地开发插件 | 受信（开发者本人） | 默认禁用，开发者手动启用 |

**明确不在威胁模型内**：被 enabled 并实例化后的恶意插件（它已在进程内，可 `require('fs')` 读任意文件、发任意网络）。防线在「装前 + 启用前」，不在运行时。

## 3. 安全三道防线

### 3.1 装前扫描（install-time）

见 `[P1]discovery_and_install_interface.md` §2：依赖黑名单、symlink 逃逸、运维策略 exec（fail-closed）、before_install hook、来源标签。**任何环节失败即阻断安装。**

### 3.2 来源标签 + 配置后台控启用（enable-time）

见 `config/[P0]plugin_config_service.md`（PluginConfigService）：P0 native 默认全开；P1 三方来源（origin/TrustPolicy）默认禁用，运维在配置管理面显式审阅后启用。**「装上 ≠ 启用」**。

### 3.3 密钥隔离（secret isolation）

- **SecretRef 标记**：配置里只放非敏感标记，真实密钥由宿主运行时按需解析，不写进插件可自由读的配置。
- **按凭证分文件**：密钥存宿主管控的独立文件，不进共享配置包。
- **日志脱敏**：宿主日志对密钥/URL userinfo 脱敏。
- **限制**：这是「防泄漏」（配置/日志/prompt），**不是「防已加载插件读取」**——同进程内插件仍能 `require('fs')` 读到。威胁模型认此限制。

## 4. 设计决策

### 4.1 同进程、不沙箱

**结论**：插件代码同进程裸跑，无 worker/vm/WASM 隔离。
**理由**：agent 框架插件高频与宿主交互（注册工具、订阅 hook、共享类型），跨进程隔离的 IPC/序列化/调试成本远大于收益；自托管场景下「可信运维」是合理前提。
**反例**：OpenClaw 同此（`SECURITY.md:53`：装上后的恶意插件不在威胁模型内）。worker 隔离对 agent 框架通常过重。

### 4.2 安全靠装前 + 启用前，不靠运行时

**结论**：三道防线全在「装前扫描 + 来源标签 + 配置后台启用」，运行时不设防。
**理由**：既然运行时同进程、无法真正隔离，把安全资源集中投在「可控的入口闸门」（装/启用）是唯一有效的；运行时 capability 模型在无沙箱下只是建议、可被绕过，伪安全。
**反例**：若宣称运行时 capability 权限却无沙箱，给人虚假安全感，反而危险；不如明确声明边界。

### 4.3 明确写出「不保护什么」

**结论**：威胁模型显式声明「启用后的恶意插件不在保护范围」。
**理由**：让使用者清楚边界——安全责任在「选择信任谁」，而非「框架防住一切」；隐性边界比显性危险。
**反例**：含糊宣称「安全」会让运维误以为框架防恶意插件，放松装前/启用前审查。

## 5. 示例（威胁场景）

| 场景 | 是否防住 | 由谁防 |
|---|---|---|
| 装一个依赖含恶意包的插件 | ✅ | 装前依赖黑名单 |
| 装一个 symlink 逃逸的插件 | ✅ | 装前 symlink 扫描 |
| 三方插件装上自动跑 | ✅ | 默认禁用 + 配置后台（P1 origin 策略） |
| 密钥写进配置被日志打印 | ✅ | SecretRef + 脱敏 |
| **已启用的恶意插件读 `~/.host/credentials/`** | ❌ | 不在威胁模型（同进程） |

## 6. 边界

| 零件 | 归属 |
|---|---|
| 威胁模型、同进程决策、三道防线、不保护项 | 本文件 ✅ |
| 装前扫描的具体机制 | `[P1]discovery_and_install_interface.md` |
| 来源标签与启用策略（P1） | `config/[P0]plugin_config_service.md`（PluginConfigService） |
| impl 类实例化时注入的 config（已校验） | `[P1]plugin_lifecycle.md` |
