/**
 * section-member-panel —— 角色面板（占用主区，2 section + 右下悬浮保存 + 左上返回）
 * 参考: specs/ui/components/studio-page/member-panel.md（视觉基线 + testid + skills switch 语义）
 *       specs/prd/version_logs/v0.0.113/2-member-skills-mechanism.md（R1-R6 叠加快照）
 *       specs/ui/components/studio-page/component-member-skill-filter.md（简化筛选器）
 *       设计稿: reqs/[done] v0.0.33.1/role-panel.html（topbar 返回 + card + .save-fab）
 *
 * 职责：编辑某 member 配置。占用主区（非弹层），左上「返回」回 squad 面板。
 *   2 section 纵向：姓名介绍（name + intro + workStyle）/ skills（inherit/custom）。
 *   intro（[v0.0.114]）渲染进 Team Roster 花名册，可编辑（走 PATCH member；提供空串后端 400）。
 *   workStyle（[v0.0.142]）多行文本，仅注入该成员自己个人 session prompt（不进 Team Roster）；
 *     可空、提供空串即清空回写（无 400，区别于 intro）。
 *   member 改动后右下角悬浮保存（PATCH member）；保存后悬浮消失（基线重置）。
 *
 * [v0.0.169] 当前任务占位区已移除（member-section-tasks + member-tasks-placeholder-banner——长期无实际功能）。
 * [v0.0.116] 心跳 section 已移除（迁 autowork-tab squad 级；member-section-heartbeat 不再渲染）。
 * 边界：member.model 由对话界面 picker 编辑，非此面板。
 */
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Member, MemberSkillConfig, PatchMemberBody } from './squad-types';
import { ComponentMemberSkillFilter, type SkillFilterEntry } from './component-member-skill-filter';
import { ToggleSwitch } from '../framework/primitives/toggle-switch';
import { Icon, type StudioIconName } from './studio-icons';
import { INPUT, FIELD_LABEL, TEXTAREA } from './studio-styles';

interface MemberPanelProps {
  member: Member;
  onBack: () => void;
  /** 保存 member 改动（PATCH /squad/:id/member/:mid）；成功后面板重置基线 */
  onSave: (memberId: string, patch: PatchMemberBody) => Promise<void>;
  /** activeWindow 跟 squad.timezone（显示用） */
  squadTimezone?: string;
  squadEnableHeartBeat?: boolean;
}

/** member.skillConfig 归一（旧数据无该字段 → 默认 inherit） */
function normSkillConfig(m: Member): MemberSkillConfig {
  return m.skillConfig ?? { mode: 'inherit', overrides: {} };
}

/** overrides map 浅比（键集 + 各值相等） */
function sameOverrides(a: Record<string, boolean>, b: Record<string, boolean>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => a[k] === b[k]);
}

/** section 卡片外壳（surface-2 + border + rounded-lg） */
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

/** 角色面板 */
export function MemberPanel({ member, onBack, onSave }: MemberPanelProps) {
  const { t } = useTranslation(['studio', 'common']);
  const [base, setBase] = useState(member);
  const [name, setName] = useState(member.name);
  const [intro, setIntro] = useState(member.intro ?? '');
  const [workStyle, setWorkStyle] = useState(member.workStyle ?? '');
  const initSC = normSkillConfig(member);
  const [skillMode, setSkillMode] = useState<'inherit' | 'custom'>(initSC.mode);
  const [overrides, setOverrides] = useState<Record<string, boolean>>({ ...initSC.overrides });
  const [catalog, setCatalog] = useState<SkillFilterEntry[]>([]);
  const [saving, setSaving] = useState(false);

  const baseSC = normSkillConfig(base);
  const scDirty = skillMode !== baseSC.mode || (skillMode === 'custom' && !sameOverrides(overrides, baseSC.overrides));
  const dirty =
    name !== base.name || intro !== (base.intro ?? '') || workStyle !== (base.workStyle ?? '') || scDirty;

  const handleCatalog = useCallback((entries: SkillFilterEntry[]) => setCatalog(entries), []);
  const handleToggle = useCallback((n: string, next: boolean) => setOverrides((prev) => ({ ...prev, [n]: next })), []);

  const save = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      const patch: PatchMemberBody = {};
      if (name !== base.name) patch.name = name;
      if (intro !== (base.intro ?? '')) patch.intro = intro;
      // workStyle 可空清空：不 trim 判空，允许提交空串（区别 intro）
      if (workStyle !== (base.workStyle ?? '')) patch.workStyle = workStyle;
      let savedSC: MemberSkillConfig | undefined;
      if (scDirty) {
        if (skillMode === 'inherit') {
          savedSC = { mode: 'inherit', overrides: {} };
        } else {
          const snap: Record<string, boolean> = {};
          for (const e of catalog) {
            snap[e.name] = overrides[e.name] ?? e.enabled;
          }
          savedSC = { mode: 'custom', overrides: snap };
        }
        patch.skillConfig = savedSC;
      }
      await onSave(member.id, patch);
      setBase({ ...base, name, intro, workStyle, skillConfig: savedSC ?? base.skillConfig });
      if (savedSC) {
        setSkillMode(savedSC.mode);
        setOverrides({ ...savedSC.overrides });
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <main className="flex flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border bg-surface-2 px-6 py-3">
        <button
          type="button"

          onClick={onBack}
          className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[13px] font-medium text-muted-2 transition-colors hover:bg-bg-warm hover:text-fg"
        >
          <Icon name="chevron-left" size={15} /> {t('common:action.back')}
        </button>
        <div className="text-sm font-semibold text-fg">{base.name}</div>
        <span className="rounded-xs bg-bg-warm px-2 py-0.5 font-mono text-[11px] text-muted">
          {member.role} · {member.state}
        </span>
      </div>

      <div className="flex-1 overflow-y-auto px-8 pb-24 pt-6">
        <div className="mx-auto flex max-w-[680px] flex-col gap-4">
          <Card title={t('studio:memberPanel.profileTitle')} icon="user">
            <div className="mb-3.5">
              <label className={FIELD_LABEL}>name</label>
              <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="mb-3.5">
              <label className={FIELD_LABEL}>{t('studio:memberPanel.introLabel')}</label>
              <input

                className={INPUT}
                value={intro}
                placeholder={t('studio:memberPanel.introPlaceholder')}
                onChange={(e) => setIntro(e.target.value)}
              />
            </div>
            <div>
              <label className={FIELD_LABEL}>{t('studio:memberPanel.workStyleLabel')}</label>
              <textarea

                className={TEXTAREA}
                value={workStyle}
                placeholder={t('studio:memberPanel.workStylePlaceholder')}
                onChange={(e) => setWorkStyle(e.target.value)}
              />
            </div>
          </Card>

          {/* skills section：inherit/custom 开关 + custom 展开简化筛选器 */}
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
        </div>
      </div>

      {/* 右下悬浮保存：仅 dirty 时显示（fixed 脱离文档流） */}
      {dirty && (
        <button
          type="button"
          data-action-key="studio.member.save"
          onClick={() => void save()}
          className="fixed bottom-6 right-8 z-50 flex items-center gap-1.5 rounded-lg bg-accent px-[18px] py-2.5 text-[13px] font-semibold text-white shadow-xl hover:bg-accent-hover"
        >
          <Icon name="check" size={14} /> {saving ? t('common:status.saving') : t('common:action.save')}
        </button>
      )}
    </main>
  );
}

export default MemberPanel;
