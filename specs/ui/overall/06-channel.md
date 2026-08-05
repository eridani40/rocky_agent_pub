# 06 渠道页

> 组件 spec：`specs/ui/components/channel-page/`
> API 契约：`specs/api/overall/17-channel.md`（CRUD config + 状态 + toggle + impl-types）
> 技术契约：`specs/tech/channel/`（ChannelManager 组合器 + 无状态 impl + 飞书 FeishuConnection）
> 无设计稿——视觉基线对齐 connector-page / skill-page 风格，不要求像素级。

## 1. 入口

- nav-rail 底部独立入口「渠道」（位置：SKILLS 之后、连接器之前），hover tooltip「渠道」
- 点 → 主区渲染 `<PageChannel />`

## 2. 页面结构

```
page-channel (main, flex-1 overflow-y-auto)
├── 页头：标题「渠道」+ mono 副标题（channel · IM 渠道接入层）
├── config-body 容器 (max-width 880px)
│   ├── 「+ 新建渠道」按钮（始终显示）
│   └── 渠道列表（空态显「暂无渠道」）
│       └── 渠道行卡片 × N
│           ├── 名称 + implId 类型标签（feishu→「飞书」，label 原始 __MSG_ 占位符渲染期解析）
│           ├── 启用开关（复用 primitive-toggle-switch）
│           ├── connection 状态文案 + 色点
│           ├── 错误原因（仅 error 态渲染，errorDetail；含 scope 门拒绝「未在 scope 'default' 激活」）
│           ├── binding 数（该 config 绑定的 session 数）
│           └── 编辑 / 删除按钮
└── 表单弹层（formOpen 时渲染：fixed inset-0 遮罩 + 居中 card）
    └── 新建/编辑表单
        ├── 类型下拉 trigger（自定义下拉，禁原生 select）→ 展开后 option
        │   （options 由后端 scope 激活集合派生：mount 一次性 GET /config/channels/impl-types，
        │    无前端硬编码类型表；label=__MSG_ 占位符渲染期 resolveI18nField(t, plugin-config ns)）
        │   【types 空态：impl-types 为空/获取失败 → 下拉 disabled + 显
        │     t('form.noImplTypes')「无可用渠道类型（channel impl 未在 default.yaml 激活）」
        │     + 提交 disabled；不阻断既有 config 列表展示与编辑】
        ├── 名称 input
        ├── appId input
        ├── appSecret（新建=password input / 编辑=SecretInput）
        ├── 飞书接入说明文档区（implId==='feishu' 时挂载：可折叠默认收起——
        │   只显示标题行，点击 toggle 行（或键盘 Enter/Space）展开/收起，
        │   展开时固定高度独立滚动、链接可点击新窗口打开；body 仅展开时渲染）
        └── 提交按钮
```

## 3. 关键交互（对齐 17-channel.md，双状态机仿 connector）

**switch 是双状态呈现**（switch=持久化 intent + connection=运行时实况，仿 connector）：

| UI 组合态 | toggle 视觉 | status 文本 | 触发 |
|---|---|---|---|
| switch=off, connection=disconnected | off | 「未启用」(灰) | 初始 / toggle off |
| switch=on, connection=disconnected | on | 「已启用（未连接）」(灰) | toggle on 后未连 |
| switch=on, connection=connecting | on（禁用防抖） | 「连接中…」(黄 spinner) | toggle on 触发后端 connect |
| switch=on, connection=connected | on | 「已连接」(绿) | connect 成功 |
| switch=on, connection=error | on | 「连接失败」(红) + errorDetail | connect 失败（3 次重试后）/ scope 门拒绝（impl 未激活，gate 不重试） |

- **点 toggle on**：立即 PUT enabled=true → 后端 connect（fire-and-forget）；前端轮询看 connecting→connected/error。
- **点 toggle off**：PUT enabled=false → 后端 disconnect → 收敛 disconnected。
- **error 态**：显 errorDetail；重连靠 off→on 重置（重试计数清零 + scope gate 重过）。
- **新建**：POST（enabled 默认 true → 建完即连 connecting）；implId 双段 400（未注册 / 已注册未激活，文案区分）。
- **编辑**：PUT（appSecret='***' 表示未改，后端 merge 原值）。
- **删除**：二次确认 → DELETE（disconnect + 清 binding + 清订阅 + 落盘删）。

## 4. 数据轮询

- 5s onTick GET /config/channels（connection 迁移由后端推动，无 SSE topic → 纯 poll 兜底，仿 connector）。
- **implTypes 一次性 Snapshot**（v0.0.206）：mount 一次性 `GET /config/channels/impl-types`（useEffect + AbortController，失败 catch 置 `[]`）——静态代码声明配置**不进** 5s poll 链；空数组 → 表单 types 空态（§2）。
- 提交/改/删/toggle 后立即 reload() 取后端稳态（唯一命令式口子）。

## 5. 边界

| 零件 | 归属 |
|---|---|
| 渠道页结构 + 交互态映射 | 本文 ✅ |
| 组件设计（page / list / form / 飞书说明文档区；impl-types 数据源拆解 + types 空态契约） | `specs/ui/components/channel-page/` |
| ChannelManager + 状态机 + 持久化 + scope 门 | `specs/tech/channel/` |
| nav-rail「渠道」项 | `specs/ui/components/framework/nav-rail.md` |
| HTTP facade（GET/POST/PUT/DELETE /config/channels + impl-types） | `specs/api/overall/17-channel.md` |
