# section-channel-list

> 层级：section
> 文件：app/web/src/components/channel-page/section-channel-list.tsx

## 职责
渲染 channel config 列表。
- switch 派发 PUT enabled（fire-and-forget，后端 connect/disconnect）。
- 编辑打开表单（父级 page 控制 formOpen + editing target）。
- 删除二次确认后 DELETE。
**数据源**：REST CRUD 无 SSE——本组件是受控展示，instances/toggle/edit/delete 均上抛父级 `page-channel`（走 `GET/PUT/DELETE /config/channels`，详见 page spec）。
边界：纯受控（instances 由父级订阅后端推回），只渲染 + 派发 CRUD。

## Props
- instances: ChannelConfig[];            // GET /config/channels items
- onToggle: (id: string, enable: boolean) => void;  // PUT enabled
- onEdit: (inst: ChannelConfig) => void;           // 打开编辑表单
- onDelete: (id: string) => void;                    // DELETE（含二次确认）

## 状态映射（connection 4 态，switch 双状态机仿 connector）
| connection | switch | status 文案 | 色点 |
|---|---|---|---|
| disconnected | off | 「未启用」 | 灰 |
| disconnected | on | 「已启用（未连接）」 | 灰 |
| connecting | on | 「连接中…」 | 黄 |
| connected | on | 「已连接」 | 绿 |
| error | on | 「连接失败」+ errorDetail | 红 |
- switch=off 一律显「未启用」（不区分 connection）。

## 视觉基线
- 行卡片：padding 12px、rounded-lg、1px border，仿 browser-connector-card。
- 状态色点 7px 圆，用 design token（bg-sage/bg-gold/bg-danger/bg-border-strong）。
- switch 复用 primitive-toggle-switch（testId=`channel-switch-{id}-{on|off}`）。

## 复用关系
- 组合：
- 被组合于：`page-channel`
