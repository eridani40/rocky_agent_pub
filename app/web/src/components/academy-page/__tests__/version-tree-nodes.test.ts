/**
 * version-tree-nodes UT —— 版本树节点派生（模式文案 / 排序 / 挂载）
 * 参考: specs/ui/components/academy-page/component-version-tree.md（VersionNode 契约 + 可见文案）
 *
 * 核心防回归：过程版副文案的模式段必须取自 task.mode——
 *   曾写死 i18n 文案「多轮 · 已完成」，导致简单模式任务在版本树显示成「多轮」，
 *   与训练观察页顶栏「简单模式 · 学习优化」矛盾。
 * 文案用真实 zh-CN academy bundle（fake t 只做 {{var}} 插值），断言用户实际看到的字。
 */
import { describe, it, expect } from 'vitest';
import zhCNAcademy from '../../../i18n/locales/zh-CN/academy.json';
import type { StudentVersionEntity, TrainingTaskEntity } from '../../../lib/academy-api';
import { buildVersionNodes, cmpLabel, procSubtitle } from '../version-tree-nodes';

/** 按 dot.notation 从真实 bundle 取文案 + {{var}} 插值（等价 i18next 最小行为） */
function t(key: string, vars?: Record<string, unknown>): string {
  const raw = key.split('.').reduce<unknown>((cur, seg) => (cur as Record<string, unknown> | undefined)?.[seg], zhCNAcademy);
  if (typeof raw !== 'string') throw new Error(`missing i18n key: ${key}`);
  return raw.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars?.[name] ?? ''));
}

function task(over: Partial<TrainingTaskEntity> = {}): TrainingTaskEntity {
  return {
    id: 'task_1',
    classroomId: 'cls_1',
    studentId: 'stu_1',
    baseVersionId: 'ver_formal_1',
    taskSeq: 1,
    coachSessionId: 'ses_1',
    mode: 'simple',
    optimizeStyle: 'learning',
    status: 'paused',
    pausedReason: 'completed',
    ...over,
  };
}

function version(over: Partial<StudentVersionEntity> & Pick<StudentVersionEntity, 'id' | 'versionLabel' | 'type'>): StudentVersionEntity {
  return {
    classroomId: 'cls_1',
    studentId: 'stu_1',
    ...over,
  } as StudentVersionEntity;
}

describe('procSubtitle（过程版副文案 = 模式 · 状态）', () => {
  it('简单模式已暂停(completed) → 「简单 · 已完成 · 可续训」，不出现「多轮」', () => {
    const s = procSubtitle(task({ mode: 'simple', status: 'paused', pausedReason: 'completed' }), t);
    expect(s).toBe('简单 · 已完成 · 可续训');
    expect(s).not.toContain('多轮');
  });

  it('简单模式进行中 → 「简单 · 训练中」（单轮，不显示轮次进度）', () => {
    const s = procSubtitle(task({ mode: 'simple', status: 'running', currentTurn: 1 }), t);
    expect(s).toBe('简单 · 训练中');
    expect(s).not.toContain('多轮');
  });

  it('多轮模式进行中 + 已知 maxTurns → 「多轮 · 第 2/5 轮」', () => {
    expect(procSubtitle(task({ mode: 'multi', status: 'running', currentTurn: 2, maxTurns: 5 }), t))
      .toBe('多轮 · 第 2/5 轮');
  });

  it('多轮模式缺 maxTurns → 退化为「多轮 · 训练中」（不编造总轮次）', () => {
    expect(procSubtitle(task({ mode: 'multi', status: 'running', currentTurn: 3 }), t)).toBe('多轮 · 训练中');
  });

  it('paused 各 reason 显对应文案（maxturns=到顶 / stopped=手动 / earlystop=无提升）', () => {
    expect(procSubtitle(task({ mode: 'multi', status: 'paused', pausedReason: 'maxturns' }), t))
      .toBe('多轮 · 已到上限 · 调大后可续');
    expect(procSubtitle(task({ mode: 'multi', status: 'paused', pausedReason: 'stopped' }), t))
      .toBe('多轮 · 已手动暂停 · 可续训');
    expect(procSubtitle(task({ mode: 'multi', status: 'paused', pausedReason: 'earlystop' }), t))
      .toBe('多轮 · 连续无提升 · 可续训');
  });

  it('paused 缺 pausedReason → 退化为 task.paused 文案（不崩）', () => {
    expect(procSubtitle(task({ mode: 'simple', status: 'paused', pausedReason: undefined }), t)).toBe('简单 · 已暂停');
  });

  it('查不到任务实体（数据异常）→ 只显示「已完成」，不臆造模式', () => {
    expect(procSubtitle(undefined, t)).toBe('已完成');
  });
});

describe('buildVersionNodes（版本树节点派生）', () => {
  const versions = [
    version({ id: 'v_1_0', versionLabel: '1.0', type: 'formal', createdFromTaskId: 'task_1' }),
    version({ id: 'v_0_0', versionLabel: '0.0', type: 'formal' }),
    version({ id: 'v_1_1', versionLabel: '1.1', type: 'process', taskSeq: 1, createdFromTaskId: 'task_1', parentFormalVersionId: 'v_0_0' }),
  ];

  it('简单模式任务的过程版节点显示「简单」而非「多轮」', () => {
    const nodes = buildVersionNodes({
      versions,
      tasks: [task({ id: 'task_1', mode: 'simple', status: 'paused', pausedReason: 'completed' })],
      currentFormalVersionId: 'v_1_0',
      t,
    });
    const proc = nodes.find((n) => n.id === 'v_1_1');
    // v0.0.219：过程版节点 name 改用 3 段 versionLabel（procName key）
    expect(proc?.name).toBe('v1.1');
    expect(proc?.subtitle).toBe('简单 · 已完成 · 可续训');
    expect(proc?.status).toBe('done');
  });

  it('formal 按版本号升序 + 0.0 特殊文案 + 当前标记', () => {
    const nodes = buildVersionNodes({
      versions,
      tasks: [task({ id: 'task_1', mode: 'multi', status: 'paused', pausedReason: 'completed' })],
      currentFormalVersionId: 'v_1_0',
      t,
    });
    const formal = nodes.filter((n) => n.kind === 'formal');
    expect(formal.map((n) => n.label)).toEqual(['0.0', '1.0']);
    expect(formal[0]).toMatchObject({ name: '初始版本', subtitle: '全空 · 正式版', isCurrent: false });
    // 1.0 无 adoptedFromProcessVersionId → 降级旧 task seq 文案（任务 #1 采纳）
    expect(formal[1]).toMatchObject({ name: '第 1 正式版', subtitle: '任务 #1 采纳', isCurrent: true });
  });

  it('进行中的过程版标 training 状态（供 gold「训练中」tag）', () => {
    const nodes = buildVersionNodes({
      versions,
      tasks: [task({ id: 'task_1', mode: 'multi', status: 'running', currentTurn: 1, maxTurns: 5 })],
      t,
    });
    expect(nodes.find((n) => n.id === 'v_1_1')).toMatchObject({ status: 'training', subtitle: '多轮 · 第 1/5 轮' });
  });
});

describe('buildVersionNodes — v0.0.219 过程版按 label major 匹配父 formal（1b）', () => {
  it('round2+ base=process 时不再落 orphanProc：process parentVersionId 按 label major 段匹配 formal', () => {
    // 场景：1.0 formal 已采纳，2.0 formal 新建；过程版 2.1.1 / 2.1.2 base=2.0；
    // 故意把 parentFormalVersionId 设成 process id（模拟 round2+ base=process 的误导字段）
    const versions = [
      version({ id: 'vf_0', versionLabel: '0.0', type: 'formal' }),
      version({ id: 'vf_1', versionLabel: '1.0', type: 'formal' }),
      version({ id: 'vf_2', versionLabel: '2.0', type: 'formal' }),
      version({ id: 'vp_2_1_1', versionLabel: '2.1.1', type: 'process', taskSeq: 1, parentFormalVersionId: 'vp_2_1_prev' }),
      version({ id: 'vp_2_1_2', versionLabel: '2.1.2', type: 'process', taskSeq: 1, parentFormalVersionId: 'vp_2_1_1' }),
    ];
    const nodes = buildVersionNodes({ versions, tasks: [], t });
    // 2.x 过程版均挂到 vf_2（label major=2），不挂 vf_1，也不落 undefined
    expect(nodes.find((n) => n.id === 'vp_2_1_1')?.parentVersionId).toBe('vf_2');
    expect(nodes.find((n) => n.id === 'vp_2_1_2')?.parentVersionId).toBe('vf_2');
  });

  it('0.x 过程版挂到 0.0 formal', () => {
    const versions = [
      version({ id: 'vf_0', versionLabel: '0.0', type: 'formal' }),
      version({ id: 'vp_0_1_1', versionLabel: '0.1.1', type: 'process', taskSeq: 1, parentFormalVersionId: 'vf_0' }),
    ];
    const nodes = buildVersionNodes({ versions, tasks: [], t });
    expect(nodes.find((n) => n.id === 'vp_0_1_1')?.parentVersionId).toBe('vf_0');
  });
});

describe('buildVersionNodes — v0.0.219 formal「采纳自」溯源副标题（1c）', () => {
  it('formal 有 adoptedFromProcessVersionId 且能查到 process → 显「采纳自 v{label}」', () => {
    const versions = [
      version({ id: 'vf_0', versionLabel: '0.0', type: 'formal' }),
      version({ id: 'vp_1_2_3', versionLabel: '1.2.3', type: 'process', taskSeq: 2 }),
      version({ id: 'vf_1', versionLabel: '1.0', type: 'formal', adoptedFromProcessVersionId: 'vp_1_2_3' }),
    ];
    const nodes = buildVersionNodes({ versions, tasks: [], t });
    const formal1 = nodes.find((n) => n.id === 'vf_1');
    expect(formal1?.subtitle).toBe('采纳自 v1.2.3');
  });

  it('0.0 formal 不显「采纳自」（emptyFormal）', () => {
    const versions = [
      version({ id: 'vf_0', versionLabel: '0.0', type: 'formal', adoptedFromProcessVersionId: 'vp_x' }),
    ];
    const nodes = buildVersionNodes({ versions, tasks: [], t });
    expect(nodes.find((n) => n.id === 'vf_0')?.subtitle).toBe('全空 · 正式版');
  });

  it('adoptedFromProcessVersionId 查不到对应 version → 降级旧 task seq 文案', () => {
    const versions = [
      version({ id: 'vf_0', versionLabel: '0.0', type: 'formal' }),
      version({ id: 'vf_1', versionLabel: '1.0', type: 'formal', adoptedFromProcessVersionId: 'vp_missing', createdFromTaskId: 'task_2' }),
    ];
    const nodes = buildVersionNodes({
      versions,
      tasks: [task({ id: 'task_2', taskSeq: 2, status: 'paused', pausedReason: 'completed' })],
      t,
    });
    expect(nodes.find((n) => n.id === 'vf_1')?.subtitle).toBe('任务 #2 采纳');
  });
});

describe('cmpLabel（版本号按段数值比较）', () => {
  it('多位段按数值比（1.10 > 1.9）', () => {
    expect(cmpLabel('1.10', '1.9')).toBeGreaterThan(0);
  });
  it('段数不同时缺失段视为 0（1.0 > 1）', () => {
    expect(cmpLabel('1.0', '1')).toBe(0);
    expect(cmpLabel('1.0.1', '1.0')).toBeGreaterThan(0);
  });
});
