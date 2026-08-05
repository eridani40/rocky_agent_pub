# v0.0.18 API 变更日志

> 概述：`/config/plugin` 端点两项增量（无新增端点）。
> 权威：`specs/api/overall/03-config-center.md` v1.2；设计：`states/v0.0.18/design.md`。

## 1. GET `/config/plugin` 响应增量

ext impl 节点新增三级 description 透传字段（代码硬编码，缺省空串）：

| 字段 | 来源 | 说明 |
|------|------|------|
| `description` | `ExtImpl.description` | impl 级 |
| `pointDescription` | `ExtensionPoint.description` | ext point 级（同 point 所有 impl 共享） |
| `pluginDescription` | `PluginManifest.description` | plugin 级（同 plugin 所有 impl 共享，与顶层 `plugins[].description` 同源） |

ext impl 节点 `order` 语义改：per-point 连续 **1..n**（从 1 开始）；无 record → 末尾补位（按 manifest 登记序）。原 priority 大数值不再出现。

## 2. PUT `/config/plugin` 新增 op

### `setPointOrders`（整 ext point 组批量保存 order，推荐）

```json
{
  "op": "setPointOrders",
  "pointId": "system_prompt_mapper",
  "orders": [
    { "implId": "identity", "order": 1 },
    { "implId": "rules",    "order": 2 }
  ]
}
```

落盘语义（详见 `specs/tech/config/[P0]plugin_config_service.md` §4.6）：
1. `orders[]` 每条 upsert ExtImplPolicyData.order（保留 enabled/configValues/exclusive）。
2. 同 point 但不在 orders[] 的 impl → 清掉其 order record（恢复默认 = 末尾补位）。
3. 单 point 原子（全成功/全失败）。
4. order 取值 per-point 连续 1..n。

### `setOrder`（deprecated）

单条 `{op:'setOrder', implId, order}` 保留向后兼容，UI 必须改用 setPointOrders。存在「只写一条」旧 bug。

## 3. AT 新增 case

- `setPointOrders` 整组持久化 + 刷新顺序不变
- 新 impl 无 record → 排末尾（effective order = max+1）
- 拖动后顺序持久化（重启 env 顺序不变）
- 三级 description 透传（节点三字段断言）

实际 case 由 `states/v0.0.18/verify/test-plan.md` 确定。

## 4. 文件清单

详见 `specs/api/overall/03-config-center.md` §5（v0.0.18 行）。
