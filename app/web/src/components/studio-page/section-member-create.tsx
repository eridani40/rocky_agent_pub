/**
 * section-member-create —— 成员创建页（占用主区，v0.0.169 弹层 → 主区页面迁移）
 * 参考: specs/ui/components/studio-page/member-create.md（视觉基线 + testid + 提交 body 语义）
 *       specs/ui/components/studio-page/member-panel.md（复用其 topbar/Card/输入基线）
 *       specs/api/overall/11a-squad-endpoints.md §2.1（hire body，v0.0.169 起含 workStyle）
 *
 * 职责：模式切换（Fresh / Derive choice-cards）；
 *   Fresh = profile Card（name/intro 必填 + workStyle 可空多行）+ skills Card（inherit/custom switch + 简化筛选器）；
 *   Derive = 父成员选择卡（非 leader）+ 可选覆盖 name/intro/workStyle（skills 继承父，不暴露）。
 *   底部常驻 创建/取消（创建语义，非 dirty FAB）；提交上抛父级（成功/取消均回首页 seats）。
 * 边界：valid = fresh(name+intro trim 非空) / derive(选中父成员)；submitting 防重。
 *   workStyle 直传/覆盖语义见 11a §2.1（trim 回写、空串=空串无 400）；UI 不提供 derive 清空父 workStyle（留空=继承）。
 */
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HireMemberBody, SquadDetail } from './squad-types';
import { ComponentMemberSkillFilter, type SkillFilterEntry } from './component-member-skill-filter';
import { SectionMemberCreateDeriveAcademy, type DeriveAcademySelection } from './section-member-create-derive-academy';
import { buildHireBody } from './member-create-hire-body';
import { ToggleSwitch } from '../framework/primitives/toggle-switch';
import { Icon, type StudioIconName } from './studio-icons';
import { useViewStore } from '../../store/view-store';
import { INPUT, FIELD_LABEL, FIELD_HINT, TEXTAREA, CHOICE_BASE, CHOICE_ON, CHOICE_OFF, BTN_SECONDARY, BTN_PRIMARY } from './studio-styles';

interface MemberCreateProps {
  detail: SquadDetail;
  /** 返回 / 取消 → 回首页 seats */
  onBack: () => void;
  /** 提交（page-studio 包装 handleHire + 成功回 seats） */
  onSubmit: (body: HireMemberBody) => Promise<void>;
}

/** section 卡片外壳（与 member-panel 同款：surface-2 + border + rounded-lg） */
function Card({ title, icon, children }: { title: string; icon: StudioIconName; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 p-[18px]">
      <div className="mb-3.5 flex items-center gap-1.5 text-[13px] font-bold text-fg">
        <Icon name={icon} size={14} /> {title}
      </div>
      {children}
    </div>
  );
}

/** 成员创建页 */
export function MemberCreate({ detail, onBack, onSubmit }: MemberCreateProps) {
  const { t } = useTranslation(['studio', 'common']);
  // [v0.0.210] academy「派生到团队」预填（view-store 一次性消费；选中 mode=derive_academy + 预选教室/学生）
  const derivePrefill = useViewStore((s) => s.studioDerivePrefill);
  const setStudioDerivePrefill = useViewStore((s) => s.setStudioDerivePrefill);
  const [mode, setMode] = useState<'fresh' | 'derive' | 'derive_academy'>(derivePrefill ? 'derive_academy' : 'fresh');
  // fresh 必填基线 / derive 可选覆盖（两模式共用同一组输入；derive 留空 = 继承父）
  const [name, setName] = useState('');
  const [intro, setIntro] = useState('');
  const [workStyle, setWorkStyle] = useState('');
  // derive 专属
  const [deriveFrom, setDeriveFrom] = useState('');
  // derive_academy 专属（picker 选中态上抛）
  const [academySel, setAcademySel] = useState<DeriveAcademySelection | null>(null);
  // skills（仅 fresh）：off=inherit（提交不传 skillConfig）/ on=custom（R5 全量快照）
  const [skillMode, setSkillMode] = useState<'inherit' | 'custom'>('inherit');
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const [catalog, setCatalog] = useState<SkillFilterEntry[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const parents = detail.members.filter((m) => m.role !== 'leader');
  const valid =
    mode === 'fresh'
      ? name.trim().length > 0 && intro.trim().length > 0
      : mode === 'derive'
        ? deriveFrom.length > 0
        : academySel !== null && academySel.previewReady;

  const handleCatalog = useCallback((entries: SkillFilterEntry[]) => setCatalog(entries), []);
  const handleToggle = useCallback((n: string, next: boolean) => setOverrides((prev) => ({ ...prev, [n]: next })), []);
  // 取消/返回：清 academy 预填（一次性消费契约）
  const handleBack = useCallback(() => {
    setStudioDerivePrefill(null);
    onBack();
  }, [setStudioDerivePrefill, onBack]);

  const submit = async () => {
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(buildHireBody({ mode, name, intro, workStyle, skillMode, catalog, overrides, deriveFrom, academySel }));
      // 提交成功：清 academy 预填（一次性消费）
      setStudioDerivePrefill(null);
    } finally {
      setSubmitting(false);
    }
  };

  // profile 字段组（fresh=必填 / derive=可选覆盖共用；derive 时 placeholder 提示留空继承）
  const profileFields = (
    <>
      <div className="mb-3.5">
        <label className={FIELD_LABEL}>{mode === 'fresh' ? t('studio:memberCreate.nameLabel') : 'name'}</label>
        <input

          className={INPUT}
          value={name}
          placeholder={mode === 'derive' ? t('studio:memberCreate.overridePlaceholder') : undefined}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="mb-3.5">
        <label className={FIELD_LABEL}>{mode === 'fresh' ? t('studio:memberPanel.introLabel') : 'intro'}</label>
        <input

          className={INPUT}
          value={intro}
          placeholder={mode === 'derive' ? t('studio:memberCreate.overridePlaceholder') : t('studio:memberPanel.introPlaceholder')}
          onChange={(e) => setIntro(e.target.value)}
        />
      </div>
      <div>
        <label className={FIELD_LABEL}>{t('studio:memberPanel.workStyleLabel')}</label>
        <textarea

          className={TEXTAREA}
          value={workStyle}
          placeholder={mode === 'derive' ? t('studio:memberCreate.overridePlaceholder') : t('studio:memberPanel.workStylePlaceholder')}
          onChange={(e) => setWorkStyle(e.target.value)}
        />
      </div>
    </>
  );

  return (
    <main className="flex flex-1 flex-col animate-[fadeIn]">
      {/* topbar：返回（回首页 seats）+ 标题（与 member-panel 同款） */}
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface-2 px-6 py-3">
        <button
          type="button"

          onClick={handleBack}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-muted-2 transition-colors hover:bg-bg-warm hover:text-fg"
        >
          <Icon name="chevron-left" size={15} /> {t('common:action.back')}
        </button>
        <div className="text-sm font-semibold text-fg">{t('studio:memberCreate.title')}</div>
      </div>

      <div className="flex-1 overflow-y-auto px-8 pb-24 pt-6">
        <div className="mx-auto flex max-w-[680px] flex-col gap-4">
          {/* 模式切换（choice-cards 三选一；[v0.0.210] +derive_academy 从教室派生） */}
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              data-action-key="studio.member.select-mode-fresh"
              aria-pressed={mode === 'fresh'}
              onClick={() => setMode('fresh')}
              className={`${CHOICE_BASE} justify-center ${mode === 'fresh' ? CHOICE_ON : CHOICE_OFF}`}
            >
              {t('studio:memberCreate.modeFresh')}
            </button>
            <button
              type="button"
              data-action-key="studio.member.select-mode-derive"
              aria-pressed={mode === 'derive'}
              onClick={() => setMode('derive')}
              className={`${CHOICE_BASE} justify-center ${mode === 'derive' ? CHOICE_ON : CHOICE_OFF}`}
            >
              {t('studio:memberCreate.modeDerive')}
            </button>
            <button
              type="button"
              data-action-key="studio.member.select-mode-derive-academy"
              aria-pressed={mode === 'derive_academy'}
              onClick={() => setMode('derive_academy')}
              className={`${CHOICE_BASE} justify-center ${mode === 'derive_academy' ? CHOICE_ON : CHOICE_OFF}`}
            >
              {t('studio:memberCreate.modeDeriveAcademy')}
            </button>
          </div>

          {mode === 'fresh' ? (
            <>
              <Card title={t('studio:memberPanel.profileTitle')} icon="user">
                {profileFields}
              </Card>
              {/* skills Card（仅 fresh 暴露；off=inherit / on=custom 展开简化筛选器） */}
              <div>
                <Card title="skills" icon="wrench">
                  <div className="flex items-center gap-2.5">
                    <ToggleSwitch
                      actionKey="studio.member.toggle-custom-skills"
                      value={skillMode === 'custom'}
                      onChange={(next) => setSkillMode(next ? 'custom' : 'inherit')}
                      label={t('studio:memberPanel.skillsModeLabel')}
                    />
                    <span className="font-mono text-[11px] text-muted">
                      {skillMode === 'custom'
                        ? t('studio:memberPanel.skillsModeCustom')
                        : t('studio:memberPanel.skillsModeInherit')}
                    </span>
                  </div>
                  <ComponentMemberSkillFilter
                    open={skillMode === 'custom'}
                    overrides={overrides}
                    onToggle={handleToggle}
                    onCatalog={handleCatalog}
                  />
                </Card>
              </div>
            </>
          ) : mode === 'derive' ? (
            <>
              <Card title={t('studio:memberCreate.deriveFromLabel')} icon="squad">
                {parents.length === 0 ? (
                  <div className={FIELD_HINT}>
                    {t('studio:memberCreate.deriveFromEmpty')}
                  </div>
                ) : (
                  <div className="grid gap-2">
                    {parents.map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        data-action-key="studio.member.select-parent"
                        aria-pressed={deriveFrom === m.id}
                        onClick={() => setDeriveFrom(m.id)}
                        className={`${CHOICE_BASE} ${deriveFrom === m.id ? CHOICE_ON : CHOICE_OFF}`}
                      >
                        {m.name}
                      </button>
                    ))}
                  </div>
                )}
              </Card>
              <Card title={t('studio:memberCreate.overridesTitle')} icon="edit">
                <div className={FIELD_HINT + ' mb-3'}>{t('studio:memberCreate.overridesHint')}</div>
                {profileFields}
              </Card>
            </>
          ) : (
            // derive_academy（18-academy.md §5.1）：picker 本体在 academy-page 出，本页消费；
            // 选中态上抛（academySel）；确认/取消走底部统一操作条（picker embedded 无按钮）
            <>
              <Card title={t('studio:memberCreate.deriveAcademyTitle')} icon="squad">
                <SectionMemberCreateDeriveAcademy
                  squadId={detail.id}
                  initialClassroomId={derivePrefill?.academySource.classroomId}
                  initialStudentId={derivePrefill?.academySource.studentId}
                  onSelectionChange={setAcademySel}
                />
              </Card>
              <Card title={t('studio:memberCreate.overridesTitle')} icon="edit">
                <div className={FIELD_HINT + ' mb-3'}>{t('studio:memberCreate.deriveAcademyHint')}</div>
                {profileFields}
              </Card>
            </>
          )}

          {/* 底部常驻操作条（创建语义，非 dirty FAB；禁位移） */}
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={handleBack} className={BTN_SECONDARY}>
              {t('common:action.cancel')}
            </button>
            <button
              type="button"
              data-action-key="studio.member.hire"
              disabled={!valid || submitting}
              onClick={() => void submit()}
              className={BTN_PRIMARY}
            >
              <Icon name="plus" size={12} /> {submitting ? t('studio:memberCreate.submitting') : t('studio:memberCreate.submit')}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

export default MemberCreate;
