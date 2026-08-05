---
type: interface
title: Channel Extension Point
priority: P0
status: active
updated: 2026-07-26
since: v0.0.103
related:
  - "[[P0]channel_impl_interface.md]"
  - "[[P0]channel_manager.md]"
  - "../plugin_system/[P0]extension_point_interface.md"
  - "../plugin_system/[P1]groups_meta_decl.md"
---

# Channel Extension Point

## 1. 概述

**channel EP** = IM 渠道接入层的扩展点。**与 `llm_provider` / `web_search_provider` 完全同构**（cardinality='list'，多 IM 平台并存）。

**不管**：channel impl 的内部契约（无状态 type+connect→ChannelHandle → `[P0]channel_impl_interface.md`）、ChannelManager 消费 EP 的方式（组合器/bootstrap/config/binding → `[P0]channel_manager.md`）、EP 框架本身（cardinality 三态语义 → `../plugin_system/[P0]extension_point_interface.md`）。
**与外界交互**：channel EP 由宿主在 `app/server/src/plugin/extension-point.ts` 定义常量 `ChannelPoint`，bootstrap 时随 `BUILTIN_EXTENSION_POINTS` 自动登记进 Registry；group 归属（新 group「渠道」）落 `app/plugins/groups.json` 唯一源。

## 2. EP 定义

```typescript
// app/server/src/plugin/extension-point.ts 新增：
import type { Channel } from '../../channel/types';  // 契约（TContract，类型非值）

/**
 * channel 扩展点：list cardinality，承载 IM 渠道接入层（与 client 对等的消息路径）。
 * 契约 Channel 见 specs/tech/channel/[P0]channel_impl_interface.md §2。
 * 多 IM 平台并存（飞书/未来微信/钉钉）；v0.0.206 起接入 scope 激活模型——
 * ChannelManager 经 getExtensionImpls(ChannelPoint,'default') 取无状态 impl（default.yaml 不配 = 关）。
 */
export const ChannelPoint: ExtensionPoint = {
  id: 'channel',
  cardinality: 'list',
  description: '__MSG_extpoint.channel.description__',  // i18n 占位符（plugin-config ns）
};

// BUILTIN_EXTENSION_POINTS 数组追加：
// ChannelPoint,
```

### cardinality 选型：list（不是 exclusive / ordered）

- **list**：多 IM 平台并存（飞书 + 微信 + 钉钉同时连）。一个用户可能同时配 5 份 feishu config（多 token）+ 2 份微信 config，每份独立 connect/binding。
- **不是 exclusive**：channel 不是「多选一」（用户可同时启用多个 IM）。
- **不是 ordered**：channel 之间无顺序语义（不串联、不优先级）。
- **config 级多份**：一个 impl（feishu）可对应多份 channel_config（ChannelConfig 纯数据，每份独立 credentials/connect/binding），存储形态参照 provider 多凭证池。

## 3. 设计决策

### 3.1 channel = EP（和 provider 同构可扩展）

**结论**：channel 不写成硬编码 `if (type === 'feishu')`，而是 EP（`point='channel'`, cardinality=`list`）。新 IM 平台 = 加一份 `app/plugins/builtins/<im>/plugin.json` + impl 类，**不动 ChannelManager / agent loop 任何代码**。
**理由**：与项目核心可扩展性原则对齐（plugin_system §3.1「所有可扩展配置归一」）；provider 已实证此模式可行（v0.0.3 起 provider list cardinality 多 LLM 厂商并存稳定运行）。
**反例**：若 channel 写成 enum/switch，每加一个 IM 都要改 ChannelManager + 配置页 + types，违反开闭原则。

### 3.2 复用 plugin_system 全套（不重新发明）

**结论**：channel EP 复用 plugin_system 的所有基础设施：
- **EP 定义 + cardinality 三态**：`../plugin_system/[P0]extension_point_interface.md`
- **ExtImpl + manifest + configSchema 单一源**：`../plugin_system/[P0]ext_impl_and_manifest_interface.md`
- **Registry + PluginManager（getExtensionImpls）**：`../plugin_system/[P0]plugin_manager_interface.md`
- **BuiltinLoader 扫描**：`app/plugins/builtins/<id>/plugin.json` 自动注册
- **scope 激活模型（v0.0.206 接入）**：impl 级启用 = scope membership（`default.yaml` channel point 配了 feishu 才可用，不配 = 关；plugin scope D6 default 短路已删）+ config 级开关 = `channel_config.enabled`（用户配置面）——两级正交
- **groups.json 元数据**：UI 分区归属（新 group「渠道」）
- **configSchema 唯一源**：feishu impl 的 `ExtImpl.configSchema` 驱动配置页表单 + 校验 + default

**理由**：plugin_system 是项目可扩展性基座（v0.0.3-v0.0.71 多版本沉淀），重发明 = 漂移 + 维护负担。
**反例**：openclaw 把 channel 写成独立 SDK `core.channel.*` 十几个子服务，与 plugin 体系并行 → 概念漂移。

### 3.3 group 归属：groups.json 新增 group「渠道」

**结论**：`app/plugins/groups.json` 新增 group：
```json
{
  "id": "channel",
  "label": "__MSG_group.channel.label__",
  "description": "__MSG_group.channel.description__",
  "extPoints": ["channel"]
}
```
**位置约定**：UI 入口 = 技能（skill）↔ 连接器（connector）之间（即 nav-rail NAV_BOTTOM 数组中 skill 之后、connector 之前插入「渠道」入口）。group 在 groups.json 数组中的相对位置决定 UI 显示序（D5 七组固定排序约定，本版扩为八组）。
**理由**：group 是 UI 概念（分区 + 显示序 + i18n 标签），归 groups.json 唯一源（plugin_system §3.6）；channel 是用户面向的运行时附件（与 connector 同类），独立 group 合理。
**不变量**：每 EP 必须在某个 group 的 `extPoints[]` 出现且仅一次（D6 启动校验硬失败，plugin_system §3.6）。

### 3.4 EP 是 contract（代码常量），无 point 级 config

**结论**（对齐 plugin_system §3.8）：channel EP 是契约常量（`id`/`cardinality`/`description`），不持久化、不进任何数据表、无 point 级 config record。需要配置走 ext impl 级（`ExtImpl.configSchema`，feishu 的 appId/appSecret）+ config 级（channel_config 域）。
**反例**：若 channel EP 进数据表，与「EP 是代码常量」矛盾，增加同步真相源。

### 3.5 EP description i18n 占位符

**结论**：`description: '__MSG_extpoint.channel.description__'`（v0.0.62 起 i18n 占位符约定，前端 `resolveI18nField(pointDescription, t)` 查 plugin-config ns 翻译）。需同步在 `app/web/src/i18n/locales/{zh-CN,en-US}/plugin-config.json` 加 `extpoint.channel.description` 键。

## 4. 与 provider EP 的对比（同构性证明）

| 维度 | llm_provider EP | channel EP |
|---|---|---|
| cardinality | list | list |
| 契约 | `LlmProvider` interface | `Channel` interface（5 方法） |
| 多 config | provider 多凭证池（app_config.llm_providers[]） | channel_config 多份 config（每份独立 credentials） |
| 默认 impl | llm_anthropic | feishu |
| groups.json | group「provider」 | group「channel」 |
| configSchema | （llm_anthropic 无，凭证在 app_config） | feishu 的 `{appId, appSecret}` |

**关键差异**：provider 的凭证落在 `app_config.llm_providers[]`（app 级权威值），channel 的凭证落在独立域 `channel_config`（用户面向运行时附件，类比 connector_config）。

## 5. 边界

| 零件 | 归属 |
|---|---|
| channel EP 定义（id/cardinality/description 常量）+ groups.json 登记约定 | 本文件 ✅ |
| EP 框架（cardinality 三态语义、registry 解析） | `../plugin_system/[P0]extension_point_interface.md` |
| channel impl 契约（Channel 无状态契约 + ChannelHandle + ChannelHandleBase abstract） | `[P0]channel_impl_interface.md` |
| ChannelManager 消费 EP（组合器/bootstrap/config/binding） | `[P0]channel_manager.md` |
| feishu impl 内部细节（WSClient/事件/发送 API） | `../../../app/plugins/builtins/feishu/` + `design-feishu.md` |
