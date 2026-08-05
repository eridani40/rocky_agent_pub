# v0.0.18 技术变更日志

> 概述：plugin ext point 排序连续化 + 拖拽 bug 根治 + 三级 description。**删 `ExtImpl.priority` 字段**（单一排序字段归 `ExtImplPolicyData.order`，消除 order/priority 双语义裂缝）；order 改 per ext point 组内连续 **1..n（从 1 开始）**；保存粒度改整个 ext point 组批量（`setPointOrders`，根治「拖动只写一条」bug）；运行时 ordered/exclusive 解析统一改读 effective order；新增三级 description（plugin/ext point/ext impl，代码硬编码）。
> 诊断权威：`states/v0.0.18/research.md`；设计权威：`states/v0.0.18/design.md`；锁定决策：`states/v0.0.18/task-board.md`「锁定设计决策」。
> PRD：本版本为 bugfix，无新 PRD（需求来自 `reqs/v0.0.18/bugs.md`）。

## 1. 锁定决策（用户确认，权威）

| # | 决策 | 落地 |
|---|------|------|
| 1 | 删 `ExtImpl.priority` 字段 | manifest.ts + 26 builtin impl + 2 llm_anthropic impl；spec `ext_impl_and_manifest_interface.md` §3.4 重写 |
| 2 | order = per-point 连续 1..n（从 1 开始） | `plugin_config.md` §2 ExtImplConfigRecord.order 语义改；`plugin_config_service.md` §3.1 effective order 算法 |
| 3 | 新/未知 impl（无 order record）→ 末尾补位 | `plugin_config_service.md` §3.1 末尾补位算法（按 manifest 登记序） |
| 4 | 保存粒度 = 整个 ext point 组 | `plugin_config_service.md` §2 新增 `setPointOrders` + §4.6 落盘语义 |
| 5 | 运行时也读 effective order | `plugin_manager_interface.md` §2/§3.1 ordered 改升序 |
| 6 | 修复含运行时（plugin-manager.ts:92-95 + 144-152） | `plugin_manager_interface.md` §3.5 exclusive 新机制 |
| 7 | exclusive 新机制：enabled 门 + effective order fallback | `plugin_manager_interface.md` §3.5 新增决策（P0 无 exclusive 内置 EP，契约准备） |
| 8 | dev 数据：重置脏 order，保留 enabled | design.md §5（脚本 `scripts/reset-dev-plugin-order.sh`，soft-delete 备份） |
| 9 | description 三级（代码硬编码，inventory 透传，UI 呈现） | `ext_impl_and_manifest_interface.md` §3.7 + `extension_point_interface.md` §3.9 + `plugin_config_service.md` §2 节点透传字段 |
| 10 | 排序依据 = manifest 定义序 | `plugin_config_service.md` §3.1（末尾补位按登记序） |

## 2. tech spec 改动清单

| spec | version | 改动摘要 |
|------|---------|---------|
| `plugin_system/[P0]ext_impl_and_manifest_interface.md` | 2.1 → 3.0 | ExtImpl 删 `priority?`、加 `description?`；§3.4 重写「单一排序字段 order」；§3.7 新增 impl 级 description 决策；§4 示例更新 |
| `plugin_system/[P0]extension_point_interface.md` | 2.4 → 2.5 | ExtensionPoint 加 `description?`；§2 cardinality 表 ordered/exclusive 默认规则改 effective order；§3.3 重写；§3.9 新增 ext point 级 description 决策；§4 示例 EP 加 description |
| `plugin_system/[P0]plugin_manager_interface.md` | 2.0 → 2.1 | ordered/exclusive 解析改读 effective order；§2 表更新；§3.5 新增 exclusive 新机制决策；§4 示例注释改 |
| `config/[P0]plugin_config.md` | 2.0 → 3.0 | ExtImplConfigRecord.order 语义改 per-point 连续 1..n |
| `config/[P0]plugin_config_service.md` | 2.2 → 3.0 | 新增 `setPointOrders` op（§2 + §4.6 落盘语义）；setOrder deprecated；§3.1 effective order 末尾补位算法；§2 ext impl 节点加三级 description 透传；§4.2 exclusive 改 enabled 门 + effective order fallback |
| `config/[P0]overview.md` | - | §6 默认表 order 行改「末尾补位」 |
| `plugin_system/[P0]builtin_plugins_directory.md` | - | §2.2 manifest 示例删 priority、加 label/description |

## 3. 核心设计原则（doc-modifier 须同步进 overall）

- **单一排序字段**：v0.0.18 起 ExtImpl 无 priority，排序/选择唯一字段是 `ExtImplPolicyData.order`。UI 写、运行时读，同源——根治 v0.0.5–v0.0.17 双语义脱节。
- **effective order = record ?? 末尾补位**：无 record 的 impl 按 manifest 登记序接到末尾（新代码不抢前位）。inventory 与运行时 `getExtensionImpls` 共用同一算法（抽 `computeEffectiveOrder` 公共函数避免漂移）。
- **保存粒度 = ext point 组**：`setPointOrders(pointId, orders[])` 整组全量替换 + 清旧 + 原子。根治单条 setOrder 的「只写一条导致 order 冲突」bug。
- **description 是代码定义属性，不进配置**：三级 description（plugin/ext point/ext impl）都是代码硬编码，inventory 透传给 UI 只读呈现。与 overlay 模型一致（树来自 registry 代码）。

## 4. 文件级变更清单（planner/coder 依据）

详见 `states/v0.0.18/design.md` §7（后端 12 项 + 前端 6 项 + 运维脚本 1 项 + 测试 6 项）。关键新增文件：
- `app/server/src/plugin/order-utils.ts`（computeEffectiveOrder 公共函数）
- `scripts/reset-dev-plugin-order.sh`（dev 数据重置脚本，soft-delete 备份）

## 5. 不在范围

- ui 组件 spec（component-*.md）—— 由 coder 编码前置产出（design.md §6 清单）
- multi-point 批量 setOrders —— 决策 4「甚至可多个 point 一起」的多 point 版本留 follow-up，v0.0.18 仅单 point
- exclusive 内置 EP —— P0 无，新机制是契约准备
