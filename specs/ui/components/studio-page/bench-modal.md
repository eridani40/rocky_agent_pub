# bench-modal

> 层级: component（弹层）
> 文件: app/web/src/components/studio-page/component-bench-modal.tsx

## 职责
下岗 member 弹层：填下岗原因 reason（必填）→ 确认 → 上抛 `onConfirm(reason)`。仅 mate 卡片可触发（leader 卡片无 bench 按钮，UI 双层拒，后端 403 兜底）。边界：reason 必填（API 空串返 400，UI 同步禁用确认按钮）；确认/关闭上抛父级，父级再调 `benchMember`（POST .../bench）。

## Props
- member: Member;                    // 被下岗成员（标题展示 name）
- onClose: () => void;               // 遮罩/取消/关闭按钮 → 父级关弹层
- onConfirm: (reason: string) => void; // reason 非空时确认 → 父级发 bench 请求

## 状态 / 交互
- 本地 `reason` 文本态；`valid` = reason.trim 非空；确认按钮 `disabled={!valid}`。
- 复用 `component-modal-shell`（420px 小弹层）；textarea `autoFocus`。
- **触发路径**：首页坐席卡「更多」菜单 → `seat-card-{memberId}-menu-bench`→ 父级 `page-studio` 开 `bench` 弹层。
  >  旧触发 = 成员 tab → `MemberCard` 的 `member-row-{memberId}-bench`。

## 视觉基线
- **弹层**：复用 `component-modal-shell`（**widthPx=420**，比 new-squad/hire 的 520 窄）；遮罩 + 卡片 （圆角对齐设计稿 .modal）。
- **字段**：label ；textarea 输入基线（surface-2 + border-2 + rounded-lg + focus accent），`autoFocus`，placeholder「为什么下岗？」。
- **foot**：取消 `btn-secondary`（描边）+ 确认下岗 `btn-danger`（danger 实底，disabled ）。

## 复用关系
- 被组合: `page-studio`（首页坐席卡菜单 bench 按钮触发；旧成员 tab 已解体）
