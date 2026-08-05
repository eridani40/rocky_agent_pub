/**
 * component-skill-item — 单个 skill 卡片。
 * 参考 specs/ui/components/skill-page/component-skill-item.md。
 *
 * 受控组件：enabled / evolvable 由父持有 + 后端持久化，所有操作回调给父。
 * badge（只读状态文字）+ toggle（操作开关）都保留；双 toggle 正交独立可任意组合。
 * logo 走 IconBox primitive + hash-by-skill.name 8 色 palette（v0.0.165 regulation 02 §4）。
 * toggle 复用 framework/primitives/toggle-switch。
 *
 * 内置技能只读性（scope === 'builtin'）：内置技能随 app 发版，后端拒绝进化
 * （governance 端点对 builtin 返 400）与删除（DELETE 对 builtin 返 403），仅允许
 * 启用/禁用。故卡片对 builtin：evolvable toggle 与删除按钮 disabled 灰化 + hover 提示，
 * enabled toggle 保持可用。避免用户点了必被后端拒的操作。
 */
import type { SkillEntry } from '../../lib/api-client';
import { ToggleSwitch } from '../framework/primitives/toggle-switch';
import { PrimitiveTooltip } from '../common/primitive-tooltip';
import { IconBox } from '../common/component-icon-box';
import { useTranslation } from 'react-i18next';

interface SkillItemProps {
  /** skill 条目（name 即 id） */
  skill: SkillEntry;
  /** 切换 enabled */
  onToggle: (name: string) => void;
  /** 切换 evolvable（调 PATCH /skill/:name/governance） */
  onToggleEvolvable: (name: string) => void;
  /** 预览 */
  onPreview: (skill: SkillEntry) => void;
  /** 删除（打开 delete modal） */
  onDelete: (skill: SkillEntry) => void;
}

/**
 * 渲染单卡。视觉对齐设计稿 .skill-card：flex 横排 align-center gap-14px，
 * logo(38×38) → info(flex-1, name 行+desc 行) → controls(enabled toggle + evolvable toggle + 预览 + 删除)。
 * hover：border-strong。desc 两行省略（-webkit-line-clamp:2）。
 *
 * evolvable toggle 紧贴 enabled toggle 右侧（同行 controls 区，gap 8px），配色与 enabled 同。
 * 布局稳定性：两 toggle 均 shrink-0 + 静态 label 占位，切换 on/off 不导致 name/desc 位移。
 */
export function ComponentSkillItem({ skill, onToggle, onToggleEvolvable, onPreview, onDelete }: SkillItemProps) {
  const { name, description, enabled } = skill;
  // evolvable 缺省视为 false（与 server frontmatter 默认一致）
  const evolvable = skill.evolvable ?? false;
  // [v0.0.167] 来源：marketRef 存在=从市场安装，否则=本地（拖拽/自建/builtin）
  const isFromMarket = Boolean(skill.marketRef);
  const { t } = useTranslation('skill');
  // 内置技能只读：进化 / 删除对 builtin 后端必拒 → UI 灰化 + hover 提示（文案走 skill ns i18n key）
  const isBuiltin = skill.scope === 'builtin';
  const evolveTitle = t('item.builtinNoEvolve');
  const deleteTitle = isBuiltin ? t('item.builtinNoDelete') : t('item.deleteTitle');
  return (
    <div

      className="group flex items-center gap-[14px] px-4 py-[14px] rounded-[10px] bg-surface-2 border border-border hover:border-border-strong transition-colors"
    >
      {/* logo：IconBox primitive + hash-by-skill.name 派生 8 色（v0.0.165 regulation 02 §4）
       *   size=34 略大于 default 32，接近原 38×38 视觉；shadow-sm 淡化原 shadow-md 更贴严肃基调 */}
      <IconBox

        hueBy={name}
        size={34}
        icon={<SkillStarIcon />}
        className="shadow-sm"
      />

      {/* info：name 行（name + badge 同行）+ desc 行（2 行省略） */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span

            className="text-[13.5px] font-semibold text-fg truncate"
          >
            {name}
          </span>
          {/* badge：只读状态文字（enabled=sage 底 / disabled=bg-warm 底，设计稿 .badge） */}
          <span

            className={
              'inline-flex items-center px-[7px] py-[2px] rounded text-[10px] font-semibold font-mono tracking-[0.03em] ' +
              (enabled ? 'bg-sage-light text-sage' : 'bg-bg-warm text-muted')
            }
          >
            {enabled ? t('item.enabled') : t('item.disabled')}
          </span>
          {/* [v0.0.167] 来源 badge：只读不可点，市场(info 色)/本地(中性)。始终渲染 + shrink-0 保占位恒定（_conventions §11） */}
          <span

            className="inline-flex items-center shrink-0 px-[7px] py-[2px] rounded text-[10px] font-semibold font-mono tracking-[0.03em]"
            style={
              isFromMarket
                ? { background: 'var(--info-bg)', color: 'var(--info)' }
                : { background: 'var(--bg-warm)', color: 'var(--muted-2)' }
            }
          >
            {isFromMarket ? t('source.market') : t('source.local')}
          </span>
        </div>
        <div

          className="mt-[3px] text-[12px] text-muted-2 leading-[1.5] overflow-hidden text-ellipsis"
          style={{
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
          }}
        >
          {description || t('item.emptyDesc')}
        </div>
      </div>

      {/* controls：enabled toggle + evolvable toggle + 预览 + 删除（设计稿 .skill-controls + v0.0.55 §3 双开关） */}
      <div className="flex items-center gap-2 shrink-0">
        {/* enabled toggle：附文字标签「启用」（设计稿 §3 每个 toggle 左侧带文字） */}
        <span className="text-[11px] text-muted-2 font-mono shrink-0">{t('item.enableLabel')}</span>
        <ToggleSwitch
          value={enabled}
          onChange={() => onToggle(name)}
          label={t('item.toggleAria', { name })}
          actionKey="skill.skill.toggle"
        />
        {/* [v0.0.55] evolvable toggle：附文字标签「自进化」（紧贴 enabled toggle 右侧）
            内置技能 disabled 灰化 + hover 提示（title 挂在包裹 span，disabled button 自身 hover 提示不稳定） */}
        <span className="text-[11px] text-muted-2 font-mono shrink-0 ml-1">{t('item.evolvableLabel')}</span>
        {isBuiltin ? (
          /* builtin：静态外观与普通卡一致（仅开关灰化）；hover 被拒开关（禁止光标处）
             → PrimitiveTooltip 在其旁展示拒绝理由（内层 pointer-events-none 让 hover
             落到 tooltip trigger，绕开 disabled button 吞事件）；title 由 tooltip 自动兜底 */
          <span className="inline-flex shrink-0 cursor-not-allowed">
            <PrimitiveTooltip content={evolveTitle}>
              <span className="pointer-events-none inline-flex">
                <ToggleSwitch
                  value={evolvable}
                  onChange={() => onToggleEvolvable(name)}
                  label={t('item.evolvableAria', { name })}
                  actionKey="skill.skill.toggle-evolvable"
                  disabled
                />
              </span>
            </PrimitiveTooltip>
          </span>
        ) : (
          <span className="inline-flex shrink-0">
            <ToggleSwitch
              value={evolvable}
              onChange={() => onToggleEvolvable(name)}
              label={t('item.evolvableAria', { name })}
              actionKey="skill.skill.toggle-evolvable"
            />
          </span>
        )}
        <button
          type="button"
          data-action-key="skill.skill.preview"
          onClick={() => onPreview(skill)}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md text-[12px] font-semibold border border-border-2 bg-surface-2 text-fg-3 hover:border-accent hover:text-accent transition-colors"
        >
          <EyeMiniIcon /> {t('item.previewBtn')}
        </button>
        <button
          type="button"
          data-action-key="skill.skill.delete"
          onClick={() => {
            // 内置技能不可删除（后端 403）；native disabled 已拦截，此处防御性再短路
            if (isBuiltin) return;
            onDelete(skill);
          }}
          disabled={isBuiltin}
          title={deleteTitle}
          aria-label={t('item.deleteAria', { name })}
          className={
            'w-[30px] h-[30px] rounded-[7px] border border-border-2 bg-transparent flex items-center justify-center text-muted-2 transition-colors shrink-0 ' +
            (isBuiltin
              ? 'opacity-50 cursor-not-allowed'
              : 'hover:border-danger hover:text-danger hover:bg-danger-light')
          }
        >
          <TrashIcon />
        </button>
      </div>
    </div>
  );
}

// —— 内联图标 ——
/** 四角星 skill icon（设计稿 Icon skill: M12 2L14 10 22 12 14 14 12 22 10 14 2 12 10 10Z） */
function SkillStarIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2L14 10 22 12 14 14 12 22 10 14 2 12 10 10Z" />
    </svg>
  );
}
function EyeMiniIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

export default ComponentSkillItem;
