---
type: spec
title: 内置 plugin 目录约定（P0 静态注册扫描点）
priority: P0
status: active
updated: 2026-07-23
since: v0.0.3
related: [[P0]plugin_manager_interface.md, [P0]ext_impl_and_manifest_interface.md, [P1]discovery_and_install_interface.md]
---

# 内置 plugin 目录约定（P0 静态注册扫描点）

## 1. 概述

本文件定义「**内置（native）plugin 放在仓库的哪个目录、manifest 文件叫什么名**」——让静态注册（`plugin_system/[P0]plugin_manager_interface.md` §3.4）有一个明确的扫描点。
**不管**：外部插件发现/安装/origin 信任（→ `[P1]discovery_and_install_interface.md`）、plugin manifest 字段定义（→ `[P0]ext_impl_and_manifest_interface.md`）、注册后如何被 get 实例化（→ `[P0]plugin_manager_interface.md`）。
**与外界交互**：扫描由 `app/server/src/plugin/builtin-loader.ts` 的 `BuiltinLoader.loadAll()` 完成；目录约定写在仓库结构里（`app/plugins/builtins/<pluginId>/plugin.json`）。

P0 静态内核只装**内置受信 plugin**（native，随宿主一同打包），不接外部插件（P1）。

一句话：**内置 plugin 放 `app/plugins/builtins/<pluginId>/`，manifest 文件名 `plugin.json`；启动时宿主扫描该目录，按 manifest 静态登记 ext impl 类（不跑代码、不实例化，get 时才实例化）。**

v0.0.3 的 plugin 静态内核（P0）只装**内置受信 plugin**（native，随宿主一同打包），不接外部插件（P1）。需要一个仓库内的固定目录 + 固定 manifest 文件名约定，让宿主启动时 `PluginManager` 能遍历该目录、读每个 plugin 的 manifest、把其 `extImpls` 登记进 registry。

一句话：**内置 plugin 放 `app/plugins/builtins/<pluginId>/`，manifest 文件名 `plugin.json`；启动时宿主扫描该目录，按 manifest 静态登记 ext impl 类（不跑代码、不实例化，get 时才实例化）。**

## 2. 目录结构约定

```
app/plugins/builtins/
├── llm_anthropic/                 # = pluginId（与 manifest.id 一致）
│   ├── plugin.json                # manifest（文件名固定）
│   ├── provider.ts                # impl 模块（default export class AnthropicCompatibleProvider implements LlmProvider）
│   ├── protocol.ts                # impl 模块（default export class AnthropicMessagesProtocol implements LlmProtocol）
│   ├── protocol-encode.ts         # impl 内部模块（encode 入口；manifest 只指向 provider/protocol 两个 entry，其余 .ts 是被 entry 引用的内部模块）
│   ├── protocol-encode-helpers.ts # impl 内部模块（encode 纯函数 helpers，v0.0.191 拆分）
│   ├── protocol-parse-stream.ts   # impl 内部模块（SSE 流式 parse）
│   └── __tests__/                 # 跟随被测代码迁入的 UT（v0.0.191 impl 物理迁 plugin 时一并迁入）
├── rocky_context/                 # context 引擎全套 ext impl（33 个，见 §2.3）
│   ├── plugin.json
│   ├── ingest/                    # context_ingest_handler impl（3）
│   ├── assemble/                  # context_assemble_mapper/reducer impl（4+5）
│   ├── prompt/                    # system_prompt_mapper/reducer impl（9+3）
│   └── reminder/                  # system_reminder impl（9）
├── zhipu_web_search/              # web_search_provider exclusive impl（zhipu）
├── skills/                        # 内置 OKF/teamwork skill md（非 plugin 类，仅静态资源）
└── <其他内置 plugin>/              # 未来 tool / MCP 等
    ├── plugin.json
    └── *.ts
```

> **impl 模块拆分自由**（v0.0.191）：manifest `ExtImpl.impl` 字段只指向 entry 模块（如 `./provider.ts` / `./protocol.ts`），default export 类被登记进 registry。entry 可自由 import 同目录其他内部模块（如 `llm_anthropic/protocol.ts` import `./protocol-encode.ts` + `./protocol-parse-stream.ts`）——这些内部模块**不在 manifest 登记**，不参与扫描，只是 entry 的代码组织。`__tests__/` 子目录是 UT 跟随被测代码迁入的位置（UT 既可留主干也可迁 plugin，看被测代码归属）。

### 2.3 内置 `rocky_context`

`rocky_context` 是 context 引擎的 builtin plugin（id=`rocky_context`），贡献 **6 个 EP 共 33 个 ext impl**（全部 `group:"context"` `cardinality:"ordered"`）：

| EP | impl 数 | 契约出处 |
|---|---|---|
| `context_ingest_handler` | 3 | `agent/context/[P0]context_ingest_detail.md` §3 |
| `context_assemble_mapper` | 4 | `agent/context/[P0]context_assemble_detail.md` §3-§4 |
| `context_assemble_reducer` | 5 | 同上 §3/§5 |
| `system_prompt_mapper` | 9 | `agent/context/[P0]system_prompt.md` §3-§4 |
| `system_prompt_reducer` | 3 | 同上 §3 |
| `system_reminder` | 9 | `agent/context/[P0]system_reminder.md` §3 |

> 数量随版本演化（squad 子系统 v0.0.33.3 在 mapper/reminder 各加了若干 squad 专用 impl），最新以 `app/plugins/builtins/rocky_context/plugin.json` 为权威。

**完整 manifest 结构（impl 逐条 + 有 configSchema 的显式 JSON Schema 字段）见** `agent/context/[P0]extension point and implementations.md` §3-§5。

> 不在本文展开每条 manifest——manifest 是声明，索引归 context 子系统自己的整合 spec（`extension point and implementations.md`）；本目录约定只规定「rocky_context 放 `app/plugins/builtins/rocky_context/`，manifest 文件 `plugin.json`，扫描流程同 §3」。

### 2.1 路径与命名规则

| 项 | 取值 | 说明 |
|---|---|---|
| 根目录 | `app/plugins/builtins/` | 与 `app/web` / `app/server` 平级（package 结构见 `app/package/[P0]package_structure.md`）；归 app workspace |
| 子目录名 | `<pluginId>` | snake_case，与 `manifest.id` 一致；目录名是 manifest.id 的镜像，扫描时校验一致 |
| manifest 文件名 | `plugin.json` | 固定，不可改（扫描点按此名查找） |
| impl 模块路径 | manifest `ExtImpl.impl` 字段（相对 plugin 目录，如 `"./provider.ts"`） | 该模块 default export 一个**类**（非 activate 函数，见 `plugin_manager_interface.md` §3.4） |

> 选 `plugin.json` 而非 `manifest.json`：与 npm 生态（`package.json`）一致更直觉；与 refs/openclaw 的 `openclaw.plugin.json` 命名风格一致（见 `specs/research/v0.0.3-llm-plugin-chat.md` §3.1）。

### 2.2 manifest 示例（内置 `llm_anthropic`）

```jsonc
{
  "id": "llm_anthropic",
  "label": "Anthropic LLM",
  "description": "Anthropic Claude LLM provider + Messages wire protocol",
  "extImpls": [
    {
      "implId": "anthropic_compatible",
      "point": "llm_provider",
      "impl": "./provider.ts",
      "description": "Anthropic 鉴权 header 构造（x-api-key + anthropic-version）"
    },
    {
      "implId": "anthropic_messages",
      "point": "llm_protocol",
      "impl": "./protocol.ts",
      "description": "Anthropic Messages API wire 协议编解码（含 thinking_delta 流式）"
    }
  ]
}
```

> **manifest 无 `priority` 字段**（单一排序字段归 `ExtImplPolicyData.order`，见 `[P0]ext_impl_and_manifest_interface.md` §3.4）；ext impl 可带 `description?`（三级 description 之一，代码硬编码）。plugin 级 `label`/`description` 见 manifest interface §2。

- provider impl 类实现 `buildAuthHeaders(config) → { "x-api-key": ..., "anthropic-version": "2023-06-01" }`（见 `[P0]llm_provider_interface.md` §2）。
- protocol impl 类自承载 `path="/v1/messages"` / `contentType="application/json"` / `encode` / `parse` / `parseStream`（含 `thinking_delta` 变体产出，见 `[P0]llm_protocol_interface.md` §2 流式 + §3.6）。

> **provider/model ext impl 不带 schemaConfig（架构原则）**：`anthropic_compatible`（point=llm_provider）与 `anthropic_messages`（point=llm_protocol）作为内置 ext impl **仅承载行为**（auth header 构造 / wire 协议编解码），**不携带 `schemaConfig`**。provider/model 的配置（label/baseUrl/apiKey/enabled + model 列表）归 **app_config providers group 实例**（见 `config/[P0]app_config.md` §3.2 + `api/overall/02-llm-chat.md` §5），通过 `/provider` + `/provider/:id/model` 端点管理。理由：ext impl 的 schemaConfig 语义是「impl 行为参数」（如温度、超时），provider 连接参数（apiKey/baseUrl）不是 impl 行为参数，而是 per-instance 实例数据，两者不能混。

## 3. P0 静态注册扫描流程

启动时（宿主 boot）：

1. **扫描** `app/plugins/builtins/*/plugin.json`，逐个读 manifest。
2. **校验**：目录名 == `manifest.id`；manifest 通过 `[P0]ext_impl_and_manifest_interface.md` §2 schema 形状校验。
3. **登记**：按 manifest 的 `extImpls[]`，把每个 `impl` 模块 **default export 的类**登记进 registry，按 `(point, implId)` 索引（同 implId 后者覆盖 + warning，见 `plugin_manager_interface.md` §3.3）。
4. **不实例化、不跑代码**：登记只存类的引用；实例化推迟到 `getExtensionImpls` 时按当前 config 进行（config 改 → next-get 反映，见 `plugin_manager_interface.md` §3.4）。

> P0 不接 `node_modules` / 用户家目录 / 远程插件源——扫描点**只有** `app/plugins/builtins/`。外部来源 + origin 信任是 P1（见 `[P1]discovery_and_install_interface.md`）。

> **packaged 加载（v0.0.108）**：`ExtImpl.impl`（如 `./provider.ts`）在 **dev** 是源码 `.ts`（bun `import()` 直跑），在 **packaged dmg** 是 build 期 bun build 出的自包含 `./provider.cjs`（Node `require`）。扫描目录在 packaged 位于 asar `node_modules/@app/plugins/builtins`（server→plugins 相对偏移与 dev 一致 → 路径解析不变），loader 按后缀选加载机制。manifest `impl` 字段**保持 `.ts` 不改**。详见 `[P0]packaged_plugin_loading.md`。

## 4. 设计决策

### 4.1 固定单一扫描点，P0 不参数化

**结论**：扫描路径硬编码为 `app/plugins/builtins/`，manifest 文件名硬编码为 `plugin.json`，P0 不暴露 env / config 让用户改扫描点。
**理由**：P0 是静态内核，扫描点是宿主实现细节，参数化徒增复杂度且无 P0 用例；P1 引入 discovery 时再考虑多源（npm/git/local）扫描。
**反例**：若 P0 让用户自定义扫描点，则需在 config 里维护路径列表 + 校验可信源，与「P0 全 native 受信、默认全开」原则冲突。

### 4.2 目录名 = manifest.id（镜像校验）

**结论**：内置 plugin 子目录名必须等于其 `manifest.id`；扫描时不一致即报错（拒绝登记）。
**理由**：目录名与 id 一致让 `ls app/plugins/builtins/` 一眼看到有哪些 plugin，且避免「目录名 vs id」两处真相源漂移。
**反例**：若允许目录名 ≠ id，则 debug 时需打开 manifest 才知道 id，且重命名目录会静默改 plugin 身份。

### 4.3 impl 模块路径相对 plugin 目录

**结论**：`ExtImpl.impl` 字段是相对该 plugin 目录的路径（如 `"./provider.ts"`），不是绝对路径、不是 npm 包名。
**理由**：内置 plugin 代码就在自己目录下，相对路径最自然；P0 不需要支持「impl 来自外部 npm 包」。
**反例**：若用绝对路径，则 plugin 目录搬迁要改 manifest；若用 npm 包名，则引入 P0 不需要的依赖解析。

## 5. 边界

| 零件 | 归属 |
|---|---|
| 内置 plugin 目录与 manifest 文件名约定、扫描流程 | 本文件 ✅ |
| manifest schema（id / extImpls / configSchema） | `[P0]ext_impl_and_manifest_interface.md` |
| 静态注册的登记语义（按 point+implId 索引、get 时实例化） | `[P0]plugin_manager_interface.md` §3.4 |
| 外部插件来源（npm/git/local）与 origin 信任 | `[P1]discovery_and_install_interface.md` |
| 各内置 plugin 的 impl 行为（provider/protocol/tool/search） | 各 `agent/providers_and_models/*` / `agent/tools/` |
