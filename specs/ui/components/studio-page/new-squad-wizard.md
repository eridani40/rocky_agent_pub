# new-squad-wizard

> 层级: component（弹层）
> 文件: app/web/src/components/studio-page/component-new-squad-modal.tsx

## 职责

## Props
- onClose: () => void
- onCreate: (body: CreateSquadBody) => Promise<void>; // POST /squad

## 状态 / 交互
- **modelDefault 用 `ModelPicker`（下拉组件，复用 `chat/ModelPicker`）** 从已配置 provider/model 选，杜绝手填非法 modelId 入库（激活时 ModelNotFoundError）。选中存 `modelSel.modelId`。

## 视觉基线
- **弹层**：复用 `component-modal-shell`——遮罩 `rgba(30,25,20,0.45)` + `backdrop-blur`；卡片 ，宽 520px。卡片圆角严格对齐设计稿 `.modal border-radius:14px`（之前误用 =12px 偏小）；head/body/foot padding 22px 严格对齐设计稿（之前 20px）。
- **字段**：label ；input/textarea 输入基线；字段行间距 （对齐设计稿 `.f-row margin-bottom:18px`）。
- **foot**：取消 `btn-secondary`（描边）+ 创建 `btn-primary`（accent 实底，disabled `opacity-40`）。按钮基类 (8px) 对齐设计稿 `.btn border-radius:8px`。按钮圆角之前误用 =10px，已改 =8px。

## 复用关系
- 被组合: `page-studio`
