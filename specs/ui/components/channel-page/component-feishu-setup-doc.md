# component-feishu-setup-doc

> 层级: component
> 文件: app/web/src/components/channel-page/component-feishu-setup-doc.tsx

## 职责
飞书接入说明文档区。当选中渠道类型为 feishu 时在表单字段之下、提交按钮之上挂载。**默认收起**（只显示标题行），用户点击标题行切换展开/收起；展开后正文区显示飞书开放平台建机器人指南（中英双语 md，中文在上英文在下）。
边界：
- **纯只读展示**，唯一交互是标题行点击展开/收起（链接除外，target=_blank 新窗口打开）
- **默认收起**（初始 `open=false`）：避免一选中飞书就展开长文档挤压表单
- **展开时正文区固定 max-h + 内部独立滚动**，不与外层 modal card 的  双层嵌套

## 状态 / 交互
**内部状态 （useState，默认 `false`）**：
| 态 | 标题行（toggle）视觉 | 正文区（body） |
|---|---|---|
| `open=false`（默认/收起） | chevron 朝下（v）+ 标题 + desc | **不挂载 DOM** |
| `open=true`（展开） | chevron rotate-180 朝上（^）+ 标题 + desc | 渲染 PrimitiveMarkdownView，max-h-[300px] + overflow-y-auto 独立滚动 |
- 点击 toggle 行任意位置 → `setOpen(v => !v)`
- 键盘 Enter / Space（toggle 行 `tabIndex=0` + `role="button"`）→ 同样切换（可访问性）

## 复用关系
- 组合 common：（支持 link/heading/ordered-list/blockquote）
- 被组合于：`section-channel-form`（implId==='feishu' 时挂载）

## 视觉基线
无设计稿，对齐渠道表单 design token 风格：

## 消费方
- `app/web/src/components/channel-page/section-channel-form.tsx`
