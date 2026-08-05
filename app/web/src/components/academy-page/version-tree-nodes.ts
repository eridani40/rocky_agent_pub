/**
 * version-tree-nodes —— 学生详情左栏版本树节点派生（纯函数）
 * 参考: specs/ui/components/academy-page/component-version-tree.md（VersionNode 契约 + 可见文案）
 *       specs/ui/components/academy-page/section-student-detail.md（平铺规范：formal 升序 + process 挂 parent）
 *
 * 关键约定：过程版副文案 = 「{模式} · {进度 | 状态}」，模式**必须**取自任务实体的 `mode`
 *   字段（simple → 「简单」/ multi → 「多轮」），不可写死文案——写死会让简单模式任务
 *   在版本树里显示成「多轮」（与训练观察页顶栏矛盾）。轮次进度只对 multi + 已知 maxTurns
 *   有意义（simple 单轮），故 simple 进行中只显示「训练中」。
 */
import type { StudentVersionEntity, TrainingTaskEntity } from '../../lib/academy-api';
import type { VersionNode } from './component-version-tree';

/** i18n 翻译函数最小形态（便于纯函数 UT 注入 fake t） */
export type TranslateFn = (key: string, vars?: Record<string, unknown>) => string;

/** label 数值化（'1.2.3' → [1,2,3]）供排序与「第 N 正式版」取段 */
export function labelParts(label: string): number[] {
  return label.split('.').map((s) => Number.parseInt(s, 10) || 0);
}

/** 版本号字面量按段数值比较（'1.10' > '1.9'） */
export function cmpLabel(a: string, b: string): number {
  const pa = labelParts(a);
  const pb = labelParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 任务是否在跑（pending 视为在跑：已创建待调度，UI 同「训练中」） */
function isRunning(task?: TrainingTaskEntity): boolean {
  return !!task && (task.status === 'running' || task.status === 'pending');
}

/** 取 label 的 major 段（'1.2.3' → '1'）；非数字段兜底返空串 */
function majorOf(label: string): string {
  const seg = label.split('.')[0];
  return seg && /\d+/.test(seg) ? seg : '';
}

/**
 * 过程版副文案：「{模式} · {进度 | 状态}」。
 * 三态机：paused 时显 pausedReason 细分文案（maxturns/completed/stopped/earlystop），
 * 比单一「已暂停」更有信息量（用户能看出是否可续训）；无对应任务实体时只显「已完成」不臆造模式。
 */
export function procSubtitle(task: TrainingTaskEntity | undefined, t: TranslateFn): string {
  const running = isRunning(task);
  const state = running
    ? task!.mode === 'multi' && task!.maxTurns
      ? t('versionTree.turn', { cur: task!.currentTurn ?? 0, max: task!.maxTurns })
      : t('badge.training')
    : task?.status === 'paused' && task.pausedReason
      ? t(`task.pausedReason.${task.pausedReason}`)
      : t(task ? `task.${task.status}` : 'task.done');
  if (!task) return state;
  const mode = t(task.mode === 'multi' ? 'versionTree.modeMulti' : 'versionTree.modeSimple');
  return `${mode} · ${state}`;
}

interface BuildArgs {
  versions: StudentVersionEntity[];
  /** 该学生的训练任务（提供 mode / 轮次 / 状态 / taskSeq） */
  tasks: TrainingTaskEntity[];
  currentFormalVersionId?: string;
  t: TranslateFn;
}

/**
 * 版本树节点派生。
 * formal 按 label 升序；process 按 label 升序，**parentFormalId 按 label major 段匹配**
 *   （round2+ fork base = 上一轮 candidate（process），parentFormalVersionId 实为 baseline id
 *   不再指向 formal——故按 `process.versionLabel.split('.')[0]===formal.versionLabel.split('.')[0]`
 *   找父 formal，formal major 唯一保证无歧义）。
 * formal 副标题：`adoptedFromProcessVersionId` 有值且能在 versions 查到对应 process → 显「采纳自 v{label}」；
 *   0.0 / 无字段 / 查不到降级（emptyFormal / 旧 task seq 兜底）。
 * process name 用 3 段 versionLabel（含 major.taskSeq.round，已是字段）。
 */
export function buildVersionNodes({ versions, tasks, currentFormalVersionId, t }: BuildArgs): VersionNode[] {
  const list: VersionNode[] = [];
  const formal = versions.filter((v) => v.type === 'formal').sort((a, b) => cmpLabel(a.versionLabel, b.versionLabel));
  for (const f of formal) {
    const isZero = f.versionLabel === '0.0';
    // 1c：采纳自溯源——查 adoptedFromProcessVersionId 对应 process 的 versionLabel
    let subtitle: string | undefined;
    if (isZero) {
      subtitle = t('versionTree.emptyFormal');
    } else {
      const adoptedFrom = f.adoptedFromProcessVersionId
        ? versions.find((v) => v.id === f.adoptedFromProcessVersionId)
        : undefined;
      if (adoptedFrom) {
        subtitle = t('versionTree.adoptedFromLabel', { label: adoptedFrom.versionLabel });
      } else {
        // 降级：旧 record 无 adoptedFromProcessVersionId → 仍按 createdFromTaskId 的 taskSeq 兜底
        const seq = f.createdFromTaskId ? tasks.find((tk) => tk.id === f.createdFromTaskId)?.taskSeq : undefined;
        subtitle = seq !== undefined ? t('versionTree.adoptedFrom', { n: seq }) : undefined;
      }
    }
    list.push({
      id: f.id,
      label: f.versionLabel,
      kind: 'formal',
      name: isZero ? t('versionTree.initial') : t('versionTree.formalN', { n: labelParts(f.versionLabel)[0] }),
      subtitle,
      isCurrent: f.id === currentFormalVersionId,
    });
  }
  const proc = versions.filter((v) => v.type === 'process').sort((a, b) => cmpLabel(a.versionLabel, b.versionLabel));
  for (const p of proc) {
    const task = p.createdFromTaskId ? tasks.find((tk) => tk.id === p.createdFromTaskId) : undefined;
    // 1b：按 label major 段匹配父 formal（不依赖 parentFormalVersionId，round2+ base=process 时该字段非 formal id）
    const procMajor = majorOf(p.versionLabel);
    const parentFormal = procMajor
      ? formal.find((f) => majorOf(f.versionLabel) === procMajor)
      : undefined;
    list.push({
      id: p.id,
      label: p.versionLabel,
      kind: 'process',
      name: t('versionTree.procName', { label: p.versionLabel }),
      subtitle: procSubtitle(task, t),
      status: isRunning(task) ? 'training' : 'done',
      parentVersionId: parentFormal?.id ?? p.parentFormalVersionId,
    });
  }
  return list;
}
