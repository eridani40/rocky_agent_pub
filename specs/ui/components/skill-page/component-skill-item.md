# component-skill-item

> 层级: component
> 文件: app/web/src/components/skill-page/component-skill-item.tsx
> ：加第二个 toggle（`evolvable` 自进化开关，PRD §2.3）；改 badge 文案（删与 evolvable 相关冗余）；新增 onToggleEvolvable 回调。底层数据字段 `mutable → evolvable`。

## 职责
单个 skill 卡片。展示：logo（固定渐变星形）+ name + 状态 badge（已启用/已禁用）+ description（2 行省略）+ 操作区（**两个 toggle：enabled + evolvable** + 预览按钮 + 删除按钮）。受控组件，所有操作回调给父。
边界：不持有 enabled/evolvable 状态（受控，由父 page 持有 + 后端持久化）；不弹 modal（preview/delete 透传给 page 由 page 控制对应 modal）。
## Props
- id: string
- name: string
- description: string
- enabled: boolean
- evolvable: boolean;   // 新增
- marketRef?: string;   // 市场来源 ref（存在=市场安装，缺=本地）——驱动来源 badge
- marketSource?: string;// provider id（如 skills_sh）
- skill: SkillItem
- onToggle: (id: string) => void;                  // 切 enabled
- onToggleEvolvable: (id: string) => void;         // 切 evolvable（调 PATCH gover...
- onPreview: (skill: SkillItem) => void
- onDelete: (skill: SkillItem) => void

## 状态 / 交互
- 点 enabled toggle → `onToggle(skill.id)`（乐观切换，失败回滚由 page）
- 点「预览」按钮 → `onPreview(skill)`
- 点删除（trash）按钮 → `onDelete(skill)`（page 打开 delete modal）
- 卡片 hover → 边框 `var(--border-strong)`
- desc 两行省略（`-webkit-line-clamp: 2`）
- **布局稳定性**：evolvable toggle 空间预留（flex-shrink:0），切换 on/off 不导致 name/desc 位移

## 复用关系
- 被组合：`section-skill-list`
- 组合：可复用 `framework/primitive-toggle-switch`（toggle 视觉，两个 toggle 同 primitive）；图标

## 视觉基线
来源行段：`.skill-card` :96-97、`.skill-logo` :98、`.skill-info/.skill-name/.skill-desc` :99-101、`.skill-controls` :102、`.badge` :63-65、`.toggle` :50-53、`.btn-secondary` :58-59、`.del-btn` :67-68；DOM :443-454。
- **layout**：卡  横排  `gap 14px`，`padding 14px 16px`，。logo 38×38（`flex-shrink 0`）→ info（`flex 1` `min-width 0`，name 行 + desc 行）→ controls。
- **font**：name `.skill-name` 13.5px/600 `var(--fg)`，name 行 flex `gap 8px`（name + badge 同行）；desc `.skill-desc` 12px `var(--muted-2)` `line-height 1.5`，2 行省略（`-webkit-line-clamp:2`）。badge `.badge` 10px/600 `JetBrains Mono` `letter-spacing 0.03em`。按钮 `.btn` 12px/600。
- **双主题**：全 token；logo 渐变两色在 light/dark 一致。badge sage/bg-warm token 双主题都有定义。

## 消费方
- `app/web/src/components/skill-page/section-skill-list.tsx`
