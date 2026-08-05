/**
 * build-diff-items —— 版本 diff 4 个卡的组装纯函数（system/memory/skills/model）
 * 参考: specs/ui/components/academy-page/component-diff-viewer.md（DiffItem 契约）
 *
 * 从 section 外移到此处的理由：组装是纯数据变换（无 fetch / 无 hook），
 * 外移后可直接 UT，且 section 只剩「取数据 + 编排异步」。
 *
 * 四项固定顺序：system（AGENTS.md 两侧全文）→ skills（两级 diff，已由调用方填好内容）
 * → memory（后端 content.memory 恒 [] → 恒显「未变」）→ model（version.json 的 model 对比）。
 * 文案一律走注入的 `t`（i18n ns=academy），不硬编码可见文案。
 */
import type { VersionContent } from '../../lib/academy-api';
import type { DiffItem, SkillDirDiff } from './component-diff-viewer';

/** 翻译函数（注入以保持纯函数可测） */
export type TranslateFn = (key: string, opts?: Record<string, unknown>) => string;

/** buildDiffItems 入参 */
export interface BuildDiffItemsInput {
  /** base 版本内容（只用 content 段；未取到 = null → 各项按空内容对比） */
  baseContent: Pick<VersionContent, 'content'> | null;
  /** 候选版本内容 */
  candContent: Pick<VersionContent, 'content'> | null;
  /** 两级 skill diff（内容已按需回填） */
  skillDirs: SkillDirDiff[];
  /** 变更文件数超上限 → summary 追加「文件较多，未加载全部行级 diff」 */
  skillsTruncated?: boolean;
  t: TranslateFn;
}

/** skills 卡 head 右侧摘要：按四态计数拼接，全不变则显「未变」 */
function skillsSummary(dirs: SkillDirDiff[], truncated: boolean, t: TranslateFn): string {
  const count = (k: SkillDirDiff['changeKind']) => dirs.filter((d) => d.changeKind === k).length;
  const parts: string[] = [];
  const added = count('added');
  const removed = count('removed');
  const modified = count('modified');
  if (added > 0) parts.push(`${t('diff.newSkill')} ${added}`);
  if (removed > 0) parts.push(`${t('diff.removedSkill')} ${removed}`);
  if (modified > 0) parts.push(`${t('diff.modSkill')} ${modified}`);
  const detail = parts.length > 0 ? parts.join(' · ') : t('diff.unchanged');
  const base = `${t('diff.skillsSummary')} · ${detail}`;
  return truncated ? `${base} · ${t('diff.filesTruncated')}` : base;
}

/**
 * 组装 4 个 diff 卡。默认展开 system + skills（改动主战场），memory / model 默认折叠。
 */
export function buildDiffItems({ baseContent, candContent, skillDirs, skillsTruncated = false, t }: BuildDiffItemsInput): DiffItem[] {
  const items: DiffItem[] = [];

  // system：AGENTS.md 全文行级 diff（缺失版本内容按空串，不报错）
  items.push({
    kind: 'system',
    icon: '📝',
    name: t('tuple.systemPrompt'),
    summary: t('diff.systemSummary'),
    defaultOpen: true,
    system: {
      baseContent: baseContent?.content.agentsMd ?? '',
      candContent: candContent?.content.agentsMd ?? '',
    },
  });

  // skills：两级 diff（目录 × 文件）
  items.push({
    kind: 'skills',
    icon: '🧩',
    name: t('tuple.skills'),
    summary: skillsSummary(skillDirs, skillsTruncated, t),
    defaultOpen: true,
    skills: { skills: skillDirs },
  });

  // memory：后端 content.memory 恒 [] → 未变
  items.push({
    kind: 'memory',
    icon: '🧠',
    name: t('tuple.memory'),
    summary: t('diff.unchanged'),
    memory: { baseEntries: [], candEntries: [] },
  });

  // model：version.json 的 providerId/modelId 任一不同即变化
  const bModel = baseContent?.content.versionJson?.model;
  const cModel = candContent?.content.versionJson?.model;
  const bText = bModel?.modelId ?? t('tuple.modelUnset');
  const cText = cModel?.modelId ?? t('tuple.modelUnset');
  const changed = (bModel?.providerId ?? '') !== (cModel?.providerId ?? '') || (bModel?.modelId ?? '') !== (cModel?.modelId ?? '');
  items.push({
    kind: 'model',
    icon: '🤖',
    name: t('tuple.model'),
    summary: changed ? t('diff.modelSummary') : t('diff.unchanged'),
    model: { baseText: bText, candText: cText, changed },
  });

  return items;
}
