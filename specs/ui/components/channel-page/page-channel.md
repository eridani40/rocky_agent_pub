# page-channel

> 文件：app/web/src/components/channel-page/page-channel.tsx

## 职责
渠道配置页根：header（标题「渠道」+ desc）+ 列表区 + 新建/编辑表单弹层（modal）。
- 挂载 GET /config/channels 取初值；5s onTick 轮询感知 connection 迁移（后端推动，无 SSE topic）。
- 新建按钮打开表单弹层（modal；弹层模式不挡按钮 → new-btn 始终显示，符合 conventions §11 尺寸稳定性）；提交成功后 reload 取后端稳态。
- 删除二次确认（防误删）。
边界：不实现状态机（connection 迁移由 ChannelManager 后端推动，本组件只渲染 + 派发 CRUD）。

## 数据源拆解

| 数据 | 数据形 | 读 API | 触发 | 契约 |
|---|---|---|---|---|
| configs（channel config 列表） | Snapshot<ChannelConfig[]> | GET /config/channels | onInit + startTimer(5s) onTick | 字段/API 契约不变 |
| implTypes（渠道 impl 类型列表） | 一次性 Snapshot（组件本地 useState，**非 poll 非 SSE**） | GET /config/channels/impl-types → `{items:[{implId,label}]}` | mount 一次性（useEffect + AbortController；失败 catch 置 `[]`） | label 为原始 `__MSG_` 占位符；渲染期 `resolveI18nField(label, tPc)`（`tPc = useTranslation('plugin-config').t`）解析后传 SectionChannelForm |

- implTypes 由后端 scope 激活集合派生（default.yaml channel EP 配置驱动），**无前端硬编码类型表**；静态代码声明配置不进 useLifecycle 5s poll 链。

## 状态 / 交互
- 本地态：`formOpen`（表单弹层显隐，点 channel-new-btn 打开；提交/取消/Esc/点遮罩关闭）+ `editing`（编辑目标 config，null=新建）+ `implTypes`（见数据源拆解表）。
- onInit：GET /config/channels + startTimer(5s)；返 ChannelConfig[]。
- onTick：5s 重读 GET 返新列表（useLifecycle ref-latest 写回）。
- 提交（POST）/改（PUT）/删（DELETE）/toggle（PUT enabled）后 reload 命令式取稳态。
- 连接语义：toggle on → 后端 setEnabled(true) + connect（fire-and-forget）；前端轮询看 connecting→connected/error。

## 视觉基线
- 容器 max-width 880px 居中。
- 标题 20px/700，desc mono 12px muted。
- 列表 + 表单垂直堆叠，gap 适中。
- 表单以 modal 弹层渲染。

## 复用关系
- 被组合于：app-shell renderView
