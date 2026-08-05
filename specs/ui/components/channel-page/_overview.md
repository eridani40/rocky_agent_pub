# channel-page 组件总览

> 层级：page 级组件群（page + 2 section + 1 component）
> 代码目录：app/web/src/components/channel-page/
> UI 协议：specs/ui/overall/06-channel.md
> API 契约：specs/api/overall/17-channel.md

## 数据源
REST CRUD 无 SSE——`GET/POST/PUT/DELETE /config/channels`（新建 POST / 编辑 PUT `:id` / 删除 DELETE `:id` / toggle PUT `:id` body={enabled}）；connection 迁移由后端 ChannelManager 推动无 SSE topic，page 用 `useLifecycle` 5s poll 兜底（`onTick` 重读 GET 列表）。

## 复用关系
- SectionChannelForm 组合 component：`component-channel-type-dropdown`（类型选择，v0.0.10
- ComponentFeishuSetupDoc 组合 common：（支持 link/heading/or
- 被组合于：app-shell renderView（`case 'channel'`）
- 仿 page-connector / section-browser-connector 结构（useLifecycle 轮询 + 受控 section）
