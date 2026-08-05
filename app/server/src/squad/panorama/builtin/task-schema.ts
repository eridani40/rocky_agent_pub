/**
 * panorama builtin task 实体/视图常量（v0.0.243 — panorama_builtin §2）.
 * 参考: specs/tech/squad/[P1]panorama_builtin.md §2（字段/状态机/view 全集）
 *       specs/tech/squad/[P1]panorama_dsl.md §5.0（view.filter）
 *
 * 设计：纯常量模块，无副作用；task 是普通 entity（落盘进 squad schema，和 book 平级），
 * 由 injectSystemEntities 在 schema-read / define-inject 时程序化写入（system:true 标记）.
 * system 标记三段闭环：parser 不识别 → checkSystemEntityImmutable 拒字段漂移 → inject 兜底覆盖.
 */
import type { EntityDef, KanbanViewDef } from '../dsl/types';

// ── 4 态状态值（panorama_builtin §2.2） ─────────────────────

export const TASK_STATUS = {
  TODO: 'todo',
  WAITING: 'waiting',
  IN_PROGRESS: 'in_progress',
  DONE: 'done',
} as const;
export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];

export const TASK_STATUSES: readonly TaskStatus[] = [
  TASK_STATUS.TODO, TASK_STATUS.WAITING, TASK_STATUS.IN_PROGRESS, TASK_STATUS.DONE,
];

// ── task EntityDef（panorama_builtin §2.1） ────────────────
//
// 字段决策（change_plan 模块 A 风险点 ①/②）：
//   - owner：用 `string` 而非 `ref → member`（member 不在 panorama DSL，ref 会触发
//     unknown_ref_target；reminder 层做软解析 join memberStore 取 name）.
//   - dependencies：用 `string + pattern`（DSL v1 无 ref[] 类型；hook.parseDeps split）.
export const TASK_ENTITY_DEF: EntityDef = {
  system: true,
  label: '任务',
  id_field: 'id',
  fields: {
    id: { type: 'string', required: true, label: 'ID' },
    title: { type: 'string', required: true, max: 200, label: '标题' },
    description: { type: 'string', max: 2000, label: '描述' },
    // owner = member id 字符串（跨实体软解析，dsl 校验层跳过存在性闭合）
    owner: { type: 'string', label: '负责人' },
    // dependencies = 逗号/空格分隔的 task id 列表（hook 解析 + 软校验存在性）
    dependencies: {
      type: 'string',
      max: 500,
      pattern: '^[a-z0-9_,\\s-]*$',
      label: '依赖',
    },
    status: {
      type: 'enum',
      required: true,
      values: [...TASK_STATUSES],
      label: '状态',
    },
    archived: { type: 'boolean', label: '已归档' },
  },
  states: {
    field: 'status',
    initial: TASK_STATUS.TODO,
    // waiting 仅由自动 hook 设置（依赖未满足）；用户不能手动 transition to:waiting.
    // transitions 用 longhand {to} 形式（DSL 类型要求 TransitionTarget[]；parser 同样归一化 shorthand）
    transitions: {
      [TASK_STATUS.TODO]: [{ to: TASK_STATUS.IN_PROGRESS }, { to: TASK_STATUS.WAITING }],
      [TASK_STATUS.WAITING]: [{ to: TASK_STATUS.TODO }],
      [TASK_STATUS.IN_PROGRESS]: [{ to: TASK_STATUS.DONE }],
    },
    terminal: [TASK_STATUS.DONE],
  },
  display: {
    // 配死中文 label（panorama_builtin §2.3 — task 是首个 builtin 直接配中文）
    status_labels: {
      [TASK_STATUS.TODO]: '未开始',
      [TASK_STATUS.WAITING]: '等待中',
      [TASK_STATUS.IN_PROGRESS]: '进行中',
      [TASK_STATUS.DONE]: '已结束',
    },
    status_colors: {
      [TASK_STATUS.TODO]: '#8b949e',
      [TASK_STATUS.WAITING]: '#d29922',       // amber（品牌警示色）
      [TASK_STATUS.IN_PROGRESS]: '#58a6ff',   // blue
      [TASK_STATUS.DONE]: '#3fb950',          // green
    },
  },
};

// ── task_kanban view（panorama_builtin §2.3） ──────────────

export const TASK_VIEW_DEF: KanbanViewDef = {
  id: 'task_kanban',
  label: '任务',
  entity: 'task',
  component: 'kanban',
  group_by: 'status',
  columns: [...TASK_STATUSES],
  // 默认隐藏归档（panorama_dsl §5.0 view.filter 首例；前端 archive 开关 override 时省略）
  filter: { archived: false },
  card: {
    title: '{title}',
    badges: ['owner', 'status'],
    footer: '依赖 {dependencies}',
  },
};
