---
type: spec
title: component-panorama-idle — 全景「更多」tab 引导卡（提醒让 leader 搭看板）
priority: P2
status: active
updated: 2026-08-04
since: v0.0.243
---

> 定位：全景「更多」固定 tab 激活时渲的**白卡引导**——提醒用户可以让 leader 搭看板，引导指向「一步开干」（跳 leader 单聊 + composer 预填搭看板模板文本）而非「配置」。
> v0.0.243 恢复：v0.0.240 引入 builtin task 通道时曾删掉 idle 组件 + 「更多」tab（builtin 保证 schema 永不空，认为不需要 idle 兜底）。v0.0.243 按用户原话恢复——「更多」tab 永远在最右，提醒用户可以用这个功能；点击渲本引导卡。
> 组件源码：`app/web/src/components/studio-page/component-panorama-idle.tsx`。

## 职责
「更多」tab（`PANORAMA_MORE_TAB_ID = 'more'`）激活时的**空态引导页**。核心产品决策：**业务全景由 leader 搭建，用户不写 DSL**——空态（用户没看到自己想看的 view）的下一步是「说话」不是「配置」：点击「找 leader 搭看板」按钮 → 触发 `onAtLeader` 回调（跳 leader 单聊 + composer 预填搭看板模板文本 `帮我搭建一个看板，展示…`，模板填空、预填待发不自动 send）。

边界：纯展示组件 + `onAtLeader` 回调；不持状态、不调 API；跳转 + 预填逻辑在外层 `page-studio.tsx`（找 leader member → 建 leader 单聊 ChatNode → setMainView chat + prefill 字符串模板）。

## Props
```typescript
interface PanoramaIdleProps {
  squadId: string;
  onAtLeader: () => void;   // 跳 leader 单聊 + composer 预填「帮我搭建一个看板，展示…」模板（page-studio 组装 ChatNode + prefill string）
}
```

- `onAtLeader` **required**：「更多」tab 引导的唯一交互出口；非 optional——v0.0.243 恢复时 onAtLeader 链路完整接线（PanoramaIdle → PanoramaRoute → SeatsPanel → page-studio handler）。Props 签名 `(squadId, onAtLeader) => void` 锁定，handler 内部跳转目标 + 预填内容由外层决定（v0.0.248 改：群聊 @leader → leader 单聊 + 文本模板）。

## 视觉结构
居中白卡（`rounded-xl border bg-surface`）含：
- 顶部 `IconBox hue="violet" size=32` + 全景四象限 grid glyph（svg 4 个圆角方块）。
- 标题（`panorama.idle.title`，15px font-semibold）+ 副标题（`panorama.idle.subtitle`，12px muted）。
- 描述段（`panorama.idle.desc`，12.5px text-fg-2 leading-relaxed）。
- 主按钮「找 leader 搭看板」（`BTN_PRIMARY`，左 icon=chat + `panorama.idle.atLeaderBtn` 文案：zh「找 leader 搭看板」/ en「Ask leader to build a board」），`data-action-key="studio.panorama.ask-leader"`（对齐「Ask leader」语义；v0.0.248 follow-up 从 `mention-leader` 重命名）。

i18n key（`studio:panorama.idle.*`）：v0.0.243 恢复组件时直接复用；v0.0.248 仅改 `atLeaderBtn` 文案 value + `desc` 去群聊字眼（不新增 key，zh/en 双语同步）。

## 复用关系
- 被 `component-panorama-route.tsx` 在 `activeTab === 'more'` 时渲染（固定「更多」tab 永远在最右，`PANORAMA_MORE_TAB_ID='more'`）。
- 不组合子组件；图标走 `<IconBox>`（common）+ `<Icon name="chat">`（studio-icons）。

## 消费方

- `app/web/src/components/studio-page/component-panorama-route.tsx`
