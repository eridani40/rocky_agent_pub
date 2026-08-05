/**
 * component-tuple-cards —— 学生详情四元组卡（System Prompt / Skills / Memory / Model）
 * 参考: specs/ui/components/academy-page/component-tuple-cards.md
 *       specs/ui/components/academy-page/section-student-detail.md（四元组区）
 *       demo 03-student-detail.html `.tuple-card`（head 灰底 + body）
 *
 * 从 section-student-detail 拆出（保 section ≤300 行）：只渲 4 张卡（v0.0.219 移除 Tools 卡）。
 * AGENTS.md 的查看编辑经 onOpenMdEditor 上抛（父级组装 MdEditorTarget）；
 * Skills 卡走 onOpenSkillBrowser 打开 skill browser 弹层——skill 是「目录 + 文件」，
 *   不能塞进 md 编辑器（曾把目录名列表当 AGENTS.md 提交而覆盖 system prompt）；
 * Memory 卡显条目数 + 「查看」开版本 memory modal（只读，对齐 chat-page memory modal 样式）；
 * 模型卡复用 InputModelPicker。
 * 注：version.json.tools 数据字段保留（装配链 resolveToolSet 仍用），仅 UI 不展示入口。
 */
import { useTranslation } from 'react-i18next';
import { InputModelPicker } from '../chat-page/component-input-model-picker';
import type { ModelSelection } from '../../lib/providers';
import type { VersionContent } from '../../lib/academy-api';
import type { MdEditorOpenArgs } from './section-student-detail';
import { AVATAR_BASE, BTN_GHOST, BTN_SM, CARD } from './academy-styles';

interface Props {
  studentName: string;
  /** 当前选中版本 label（md-editor subtitle 用） */
  selLabel: string;
  /** formal 可编辑 / process 只读 */
  selectedIsFormal: boolean;
  /** GET version content（skills = 目录 + 文件树；memory = .rocky/memory/*.md 摘要） */
  content: VersionContent['content'] | undefined;
  modelSel: ModelSelection | null;
  onOpenMdEditor: (args: MdEditorOpenArgs) => void;
  /** 打开 Skills 浏览弹层（Skills 不经 md 编辑器通道） */
  onOpenSkillBrowser: () => void;
  /** 打开版本 memory 弹层（只读；target 由 section 组装，state 归 page-academy） */
  onOpenMemoryModal: () => void;
  onModelChange: (sel: ModelSelection) => void;
}

/** 四元组卡组 */
export function ComponentTupleCards({ selLabel, selectedIsFormal, content, modelSel, onOpenMdEditor, onOpenSkillBrowser, onOpenMemoryModal, onModelChange }: Props) {
  const { t } = useTranslation('academy');
  const skills = content?.skills ?? [];
  const skillFileCount = skills.reduce((n, s) => n + s.fileCount, 0);
  const memoryEntries = content?.memory ?? [];
  return (
    <div className="flex flex-col gap-3">
      {/* System Prompt 卡 */}
      <TupleCard
        icon="📝" title={t('tuple.systemPrompt')} sub="AGENTS.md"
        actionLabel={selectedIsFormal ? t('tuple.viewEdit') : t('tuple.view')}
        onAction={() => onOpenMdEditor({ fileName: 'AGENTS.md', field: 'system prompt', value: content?.agentsMd ?? '', saveKind: 'agentsMd' })}
      >
        <div className="font-mono text-[12px] leading-[1.65] text-fg-2 whitespace-pre-wrap break-words max-h-[170px] overflow-y-auto">
          {content?.agentsMd?.trim() ? content.agentsMd : t('tuple.emptyAgents')}
        </div>
      </TupleCard>

      {/* Skills 卡（目录 + 文件树 → chip 展示；查看 = 开 skill browser 弹层，不走 md 编辑器） */}
      <TupleCard
        icon="🧩" title={t('tuple.skills')}
        sub={`.rocky/skills/ · ${t('tuple.skillsSub', { skills: skills.length, files: skillFileCount })}`}
        actionLabel={t('tuple.view')}
        onAction={onOpenSkillBrowser}
      >
        <div>
          {skills.map((s) => (
            <span key={s.name} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 border border-border rounded-md text-[12px] mr-2 mb-2 bg-surface">
              🧩 {s.name}
              <span className="text-[11px] text-muted font-mono">{t('tuple.skillFileCount', { count: s.fileCount })}</span>
            </span>
          ))}
          {skills.length === 0 && <span className="text-[12px] text-muted">{t('common.empty')}</span>}
        </div>
      </TupleCard>

      {/* Memory 卡（.rocky/memory/*.md 摘要 → 显条目数 + 「查看」开只读 modal） */}
      <TupleCard
        icon="🧠" title={t('tuple.memory')}
        sub={`.rocky/memory/ · ${t('tuple.memoryCount', { count: memoryEntries.length })}`}
        actionLabel={memoryEntries.length > 0 ? t('tuple.memoryView') : undefined}
        onAction={memoryEntries.length > 0 ? onOpenMemoryModal : undefined}
      >
        <div className="text-[12.5px] text-muted">
          {memoryEntries.length > 0 ? t('tuple.memoryCount', { count: memoryEntries.length }) : t('tuple.memoryEmpty')}
        </div>
      </TupleCard>

      {/* 模型卡（InputModelPicker 复用；formal 可换，process 只读展示） */}
      <div className={`${CARD} overflow-hidden`}>
        <div className="flex items-center gap-[9px] px-[15px] py-[11px] border-b border-border bg-bg-warm">
          <span className="text-[15px]">🤖</span>
          <span className="text-[13px] font-semibold text-fg">{t('tuple.model')}</span>
          <span className="ml-auto text-[11px] text-muted">version.json · v{selLabel}</span>
          {selectedIsFormal && (
            <InputModelPicker model={modelSel} onChange={onModelChange} />
          )}
        </div>
        <div className="px-[15px] py-[13px] flex items-center gap-[9px]">
          <span className={`${AVATAR_BASE} w-7 h-7 text-[12px]`} style={{ background: 'var(--color-indigo)' }}>M</span>
          <div>
            <div className="text-[13px] font-medium text-fg">
              {modelSel?.modelId ?? t('tuple.modelUnset')}
            </div>
            <div className="text-[11px] text-muted">{modelSel?.providerId ? `provider: ${modelSel.providerId}` : ''}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 五元组卡外壳（demo .tuple-card：head 灰底 + body） */
function TupleCard({ icon, title, sub, actionLabel, onAction, children }: {
  icon: string; title: string; sub: string; actionLabel?: string; onAction?: () => void; children: React.ReactNode;
}) {
  return (
    <div className={`${CARD} overflow-hidden`}>
      <div className="flex items-center gap-[9px] px-[15px] py-[11px] border-b border-border bg-bg-warm">
        <span className="text-[15px]">{icon}</span>
        <span className="text-[13px] font-semibold text-fg">{title}</span>
        <span className="ml-auto text-[11px] text-muted">{sub}</span>
        {actionLabel && onAction && (
          <button type="button" data-action-key="academy.version.edit" onClick={onAction} className={`${BTN_GHOST} ${BTN_SM}`}>
            {actionLabel}
          </button>
        )}
      </div>
      <div className="px-[15px] py-[13px]">{children}</div>
    </div>
  );
}

export default ComponentTupleCards;
