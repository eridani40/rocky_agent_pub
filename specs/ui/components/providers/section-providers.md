# section-providers

> 层级: section
> 文件: app/web/src/components/providers/section-providers.tsx
> 参考: specs/ui/components/providers/_overview.md §3-§4

## 职责
providers group 内容区根：持 view 状态机（list | detail）+ draft/snapshot + save diff。
加载 `GET /provider` 时同时取 `protocols: ProtocolMeta[]`（响应顶层附带）cache 给 component-provider-fields 作下拉选项 + 拼接地址 path 来源。
一次加载全程共享（不随 detail 切换重拉）。
边界：自管理；父级在 providers group 时渲染它。通过 `onViewLevelChange` 上抛 view level（含挂载初始 `list`），供父级在 detail 二级页时隐藏同 tab 其余 group。

## 状态 / 交互
- `providers: ProviderInstance[]`（来自 GET /provider items）
- **`protocols: ProtocolMeta[]`**（来自 GET /provider 顶层 protocols 字段）
- list → detail：点 provider 卡 / 添加提供商
- detail → list：面包屑返回 / 保存成功后

## 复用关系
- 被组合：page-app-config（providers group 时渲染）
- 组合了：component-provider-list-card × N / component-provider-detail / 新增 provider
