/**
 * component-skills-modal —— skills 弹层（3 tab 只读）
 * 参考: specs/ui/components/chat-page/component-skills-modal.md（组件契约 + 可见文案）
 *       specs/ui/components/skill-page/component-skill-item.md（卡片视觉 token 复用源）
 *       specs/prd/version_logs/v0.0.205.t2_cons/change_log.md 定案 1（UC-S1~S7）
 *
 * 3 tab（session/group/global，默认 session）+ 只读卡片列表（IconBox 星形 logo + name +
 * 来源徽标 + desc 两行省略）。**只展示无开关**（不挂 enabled/evolvable toggle、无预览/删除），
 * 避免与 SKILLS 全局管理页职责重叠。
 *
 * catalog 由父（component-chat-float-menu）恒挂载后以 prop 下传——本组件不重新调用
 * useSkillsCatalog。弹层每次打开（挂载）调一次 catalog.refetch()（PRD UC-S7 重开刷新）。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CloseIcon } from './icons';
import { Portal } from '../../lib/portal';
import { IconBox } from '../common/component-icon-box';
import type { SkillEntry } from '../../lib/api-client';
import type { SkillsCatalog, SkillsCatalogGroups } from './use-skills-catalog';

export interface ChatSkillsModalProps {
  /** float-menu 恒挂载的 useSkillsCatalog 实例 */
  catalog: SkillsCatalog;
  /** 关闭弹层 */
  onClose: () => void;
}

type SkillsTab = keyof SkillsCatalogGroups;

const TAB_ORDER: SkillsTab[] = ['session', 'group', 'global'];

/** 四角星 skill icon（同 component-skill-item 的 SkillStarIcon，fill 风格供 IconBox 继承主色） */
function SkillStarIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2L14 10 22 12 14 14 12 22 10 14 2 12 10 10Z" />
    </svg>
  );
}

/** 只读 skill 卡片（无开关/无操作区；视觉 token 复用 component-skill-item：横排 gap14 + logo + name 行 + desc 两行省略） */
function SkillReadonlyCard({ skill }: { skill: SkillEntry }) {
  const { t } = useTranslation('chat');
  // 来源徽标配色：workspace/group=sage 底（会话/团队层贴近当前上下文），builtin/app=bg-warm 底（全局继承层）
  const nearScope = skill.scope === 'workspace' || skill.scope === 'group';
  return (
    <div className="flex items-center gap-[14px] px-4 py-[14px] rounded-[10px] bg-surface-2 border border-border hover:border-border-strong transition-colors">
      <IconBox hueBy={skill.name} size={34} icon={<SkillStarIcon />} className="shadow-sm" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[13.5px] font-semibold text-fg truncate">{skill.name}</span>
          <span
            className={
              'inline-flex items-center shrink-0 px-[7px] py-[2px] rounded text-[10px] font-semibold font-mono tracking-[0.03em] ' +
              (nearScope ? 'bg-sage-light text-sage' : 'bg-bg-warm text-muted')
            }
          >
            {t(`skillsModal.scope.${skill.scope}`)}
          </span>
        </div>
        <div
          className="mt-[3px] text-[12px] text-muted-2 leading-[1.5] overflow-hidden text-ellipsis"
          style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}
        >
          {skill.description || t('skillsModal.emptyDesc')}
        </div>
      </div>
    </div>
  );
}

export function ComponentSkillsModal({ catalog, onClose }: ChatSkillsModalProps) {
  const { t } = useTranslation('chat');
  const { t: tCommon } = useTranslation('common');
  const [tab, setTab] = useState<SkillsTab>('session');
  const { groups, loading, error, refetch } = catalog;

  // 弹层每次打开（挂载）刷新一次（PRD UC-S7：全局页装完新 skill 回会话重开可见）；
  // hook 本体恒挂载于 float-menu，不随开关重 GET——刷新只发生在打开这一刻
  useEffect(() => {
    void refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const items = groups[tab];

  // L3 modal（_layering.md §3A）：包 <Portal> 到 overlay-root，脱离 overlay 的 pointer-events:none 链
  return (
    <Portal>
      <div
        // z=`--z-modal`(1000)；pointer-events-auto 双保险（overlay-root 容器 none，modal 本体需 auto）
        className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[rgba(30,25,20,0.45)] backdrop-blur-sm pointer-events-auto"
        onClick={onClose}
      >
        <div
          onClick={(e) => e.stopPropagation()}
          className="flex max-h-[88vh] w-[520px] max-w-[92vw] flex-col rounded-[14px] border border-border-2 bg-surface shadow-2xl"
        >
          {/* head：标题 / 关闭 */}
          <div className="flex shrink-0 items-center gap-2 px-[22px] pt-[18px] pb-3">
            <span className="flex-1 text-[15px] font-bold text-fg">{t('skillsModal.title')}</span>
            <button
              type="button"
              aria-label={tCommon('modal.close')}
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-bg-warm hover:text-fg"
            >
              <CloseIcon size={16} />
            </button>
          </div>

          {/* tab 栏：视觉 token 同 component-skill-tabs（底 1px 分隔线 + 激活 accent 2px 下划线） */}
          <div className="flex shrink-0 gap-1 border-b border-border mx-[22px]">
            {TAB_ORDER.map((id) => {
              const isActive = id === tab;
              return (
                <div
                  key={id}
                  role="tab"
                  aria-selected={isActive}
                  tabIndex={0}
                  onClick={() => setTab(id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setTab(id);
                    }
                  }}
                  className={
                    'text-[13px] font-semibold px-[14px] py-2 border-b-2 -mb-px cursor-pointer transition-colors ' +
                    (isActive ? 'text-accent border-accent' : 'text-muted-2 border-transparent hover:text-fg-2')
                  }
                >
                  {t(`skillsModal.tab.${id}`)}
                </div>
              );
            })}
          </div>

          {/* body：loading / error / 空态 / 卡片列表 */}
          <div className="flex flex-col gap-2 overflow-y-auto px-[22px] py-4 pb-5">
            {loading && items.length === 0 ? (
              <div className="py-6 text-center font-mono text-[11px] text-muted">{t('skillsModal.loading')}</div>
            ) : error ? (
              <div role="alert" className="py-4 text-center text-[12px] text-[var(--danger)]">{error}</div>
            ) : items.length === 0 ? (
              <div className="px-6 py-12 text-center text-muted">
                <div className="mb-1 text-[24px]" aria-hidden>✨</div>
                <span className="text-[12px]">{t(`skillsModal.empty.${tab}`)}</span>
              </div>
            ) : (
              items.map((skill) => <SkillReadonlyCard key={skill.name} skill={skill} />)
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}

export default ComponentSkillsModal;
