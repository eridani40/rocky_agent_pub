# section-classroom-list（左 sidebar 教室列表）

> 层级: section
> 文件: app/web/src/components/academy-page/section-classroom-list.tsx

## 职责
Academy 板块的常驻左 sidebar：教室单行列表（点行切详情）+ 顶部「新建教室」按钮 + 底部 foot 文案。

边界：不显示教室内部内容（学生/任务/数据集/评估器等归 section-classroom-detail）；不创建资源（新建教室走 sidebar「+」，资产迭代走教室详情 head 对话）。

## Props
```ts
interface Props {
  classrooms: ClassroomEntity[];
  statsOf: (classroomId: string) => { studentCount: number; activeTaskCount: number };
  selectedId?: string;
  onSelect: (classroomId: string) => void;
  onCreated: () => void;
  /** 创建教室（父级调 POST /academy/classroom 后 onCreated 刷新）；defaultModel 必选（群体级必须选具体模型） */
  onCreateClassroom: (name: string, defaultModel: ModelSelection) => Promise<void>;
  /** 命名输入展开态（父级受控） */
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
}
```

## 状态 / 交互
- **教室行**（`component-classroom-card`）：30×30 logo + 13px/500 名 + 11px muted「N 学生 · M 任务中」；hover/active `bg-accent-light`。
- **「+」按钮**（顶部 icon-btn）：切换 `createOpen` 展开简易创建表单（name input + 默认模型必选）。
- **创建表单（[v0.0.230]）**：name input 下方加「默认模型」必选 `chat/ModelPicker`（对齐 squad wizard `modelDefault` required；无继承选项——群体级必须选具体模型）；未选模型提交被表单层拦截（`classroom.createRequireModel` 错误提示，不调父级回调），选中后 `onCreateClassroom(name, defaultModel)` → 父级 `POST /academy/classroom`（建教室自动带班主任，design §3）。
- **foot 文案**：「academy · 培养专家的地方」11px muted-2。
- **可见文案**（E2E）：侧栏标题「教室」/「新建教室」tooltip（+ 按钮 title）/「默认模型」label /「请选择默认模型」错误提示 /「academy · 培养专家的地方」。

## 复用关系
- 组合 `component-classroom-card` × N（教室行）。
- 与 `studio-sidebar` 模式平行（同属一级 page 的左 sidebar）。

## 视觉基线
- 设计稿来源：`demo/01-classroom-list.html`（空态 + sidebar 完整结构）+ `demo/02-classroom-detail.html`（sidebar 选中态）。
- 尺寸：宽 220px（固定，flex-shrink:0）+ 右 1px border。
- 字体：sidebar-title 13.5px/600；classroom-item 名 13px/500；副 11px muted。
- 边框：行 hover 无边框变化（仅底色 `bg-accent-light`）；激活态同色（无 accent 边）。
- 配色：白底。
