# component-quota-entry-modal

> 层级: component
> 文件: app/web/src/components/chat-page/component-quota-entry-modal.tsx（125 行）
> 引入版本: v0.0.356

## 职责
余额查询 L3 弹层壳。只读弹层：方案信息栏 + provider 卡列表 + 底部脚注。开即拉四源、关即停轮询。

## Props
- `planId: string` — 当前 squad 挂载的方案 id（由 `component-chat-float-menu` 从 SquadStatusContext.detail.modelRoutingPlanId 透传，已保证非空）
- `onClose: () => void` — 关闭弹层

## 渲染结构
- Portal + 遮罩 `rgba(30,25,20,0.45)` + `backdrop-blur-sm`
- 内容壳：w-[720px] / rounded-[14px] / head（标题 `chat:quotaModal.title`「模型方案额度」15px bold + 关闭钮 `common:modal.close`）+ body `overflow-y-auto`
- 顶部方案信息栏：当前方案名 + 四色图例（🟢 `chat:quotaModal.legendWorking` / 🔴 `chat:quotaModal.legendOpen` / 🟠 `chat:quotaModal.legendHalf` / ⚪ `chat:quotaModal.legendOff`）
- 中部：`ComponentQuotaProviderCard` 列表（默认全部收起）；空态 `chat:quotaModal.empty`
- 底部脚注：`chat:quotaModal.refreshHint`（「上次更新 HH:mm · 每 5 分钟自动刷新 · 失败保留上次成功值」）+ `chat:quotaModal.lastUpdated`

## 数据
- 内部挂载 `useSquadQuota(planId)`：四源组合 + 5min 轮询 + 1s tick + lastGood + 卸载清理（见 `use-squad-quota.md`）
- 无 badge，浮层关闭即卸载 hook（与 float-menu 恒挂载模式不同）

## 复用关系
- 被组合：`component-chat-float-menu.md`（v0.0.356 第 6 项，点击打开）
- 组合：`use-squad-quota.md` + `component-quota-provider-card.md`

## i18n
chat ns 新增：`quotaModal.title/plan/legendWorking/legendOpen/legendHalf/legendOff/empty/lastUpdated/refreshHint`
