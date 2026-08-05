# section-classroom-detail（教室详情：head 对话 + 学生网格）

> 层级: section
> 文件: app/web/src/components/academy-page/section-classroom-detail.tsx

## 职责
教室详情页：左可拖宽 head teacher 对话列（默认 480px，经 `chat-page/section-chat-session` 接入）+ 右 content-col（cls-head tab 栏 + 学生网格 / 数据集 / 评估器）。

边界：不管版本树（归 section-student-detail）；不管训练观察（归 section-training-observe）；点学生卡 → 路由到 student-detail（本 section 卸载）。

## Props
```ts
interface Props {
  classroomId: string;
  onOpenStudent: (studentId: string) => void;
  onAddStudent: () => void;
  onExpandHead: () => void; // 展开到独立教室会话页（可选）
}
```

## 状态 / 交互
- **cls-head**（顶部）：34×34 教室 logo + 16px/600 名 + 「N 学生」violet tag + 「⚙ 教室设置」ghost 按钮 + tab 栏（`primitive-academy-tab`：学生 / 数据集 / 评估器）。
- **cls-head 默认模型 slot**（[v0.0.230] `component-classroom-head` 渲染位，学生数 badge 之后、spacer 之前）：
  - 用 `chat/ModelPicker`（**无 `inheritLabel`/`onInherit`**）——下拉**没有「跟随应用默认」继承选项**，群体级默认模型必须选具体模型（对齐 squad manageTab 形态）。
  - `classroom.defaultModel` 复合 → `ModelSelection`；未配 → trigger 显既有 placeholder「选择 model」（不显继承项）。
  - 选中具体模型 → PATCH `classroom.defaultModel = {providerId, modelId}`（PATCH 语义不变，`lib/academy-api.ts:patchClassroom`）。
- **ht-col**（左，可拖宽：默认 480 / min 320 / max 720；右缘复用 `chat-page/component-col-resize-handle`（side='left'）拖拽，宽度经 `common/use-persistent-width` + `ACADEMY_COL.ht` 常量持久化 localStorage 全局 key `academy-ht-col-width`）：
  - chat 列 = `SectionChatSession sessionId={classroom.headTeacherSessionId}`（能力全开：HITL 两卡/abort/两 picker/enqueue/usage 三件套/minimap/悬浮菜单，`_overview §2`）。
  - topbarLeft 注入 `ComponentAcademyChatHeader`：32×32 avatar「班」+ 「班主任 · 林老师」+ 「● 在线 · 随时可聊」sage 色 + 展开按钮（切到独立教室会话页）。
  - usage 三件套 / Clear 确认 modal / 消息流 / 输入区全部由 SectionChatSession 内置（页面零接线）。
  - **placeholder**：「和班主任聊聊，让它帮你准备训练…」
  - **高度链**：行容器 `min-h-0`；ht-col 包装层为水平 flex + `min-h-0 overflow-hidden`（禁 flex-col 垫层，见 `_overview §2 宿主高度链约束`）。
- **content-col**（右）：
  - **学生 tab**：sec-head「学生（N）」+「＋ 添加学生」primary sm 按钮 + `student-grid`（repeat minmax(250px,1fr) / gap 14px）；末位「+ 添加学生」虚线卡（dashed border-2 + muted）。
  - **数据集 / 评估器 tab**：`res-table`（res-row：32×32 icon + 名 + 描述 + 操作）。
- **可见文案**（E2E）：教室名 / 「N 学生」/「教室设置」tooltip / tab 名「学生」「数据集」「评估器」/「学生（N）」/「＋ 添加学生」/ placeholder「和班主任聊聊…」。

## 复用关系
- 左侧经 `chat-page/section-chat-session` 接入（head teacher 是正经 academy-head_teacher session，design §8.1）+ topbarLeft 注入 `component-academy-chat-header`。
- 右侧组合 `primitive-academy-tab` + `component-student-card` × N。
- 视觉/SSE/run 态全部沿用 chat-page 内核（与 playground / studio 单聊同源）。

## 视觉基线
- 设计稿来源：`demo/02-classroom-detail.html`。
- 尺寸：ht-col 默认 480px（可拖 320~720，persist `academy-ht-col-width`）；content-col flex-1；ht-msgs p-16；msg max-w 78%；student-card 250px+ minmax；grid gap 14px；卡片 p-15。
- 字体：cls-title 16px/600；stu-name 13.5px/600；msg-bubble 13px/1.6；time 10.5px mono。
- 边框：cls-head bottom 1px border；ht-col right 1px border；student-card `rounded-xl` + border + hover `border-strong + shadow-md`；add-stu dashed border-2 + hover accent。
- 配色：msg.user `--accent` 黑底白字；msg.assistant `--surface-2` + border；send-btn `--accent`；「● 在线」`--color-sage`；tag-violet/bg 学生计数。
