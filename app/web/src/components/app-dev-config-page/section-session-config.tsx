/**
 * section-session-config — 会话 tab 第一 group 渲染（v0.0.149 新增）
 * 参考: specs/ui/components/app-dev-config-page/section-session-config.md
 *       specs/prd/version_logs/v0.0.149.memory_opt/change_log.md §4.2
 *
 * 职责：会话 tab 下 session group 的渲染区（KV group `app_config/session`，单 record key=`default`）：
 *   - maxSkillInject：单次会话注入 skill 的最大条数（number，默认 50）
 *   - maxMemoryInject：单次会话注入 memory 的最大条数（number，默认 50）
 *
 * 边界：纯展示组件，draft 由父级 useAppSettingsConfig 管理；
 *   不直接调 API；testid 复用 key-number-* 模式（与 section-default-models-and-request 一致）。
 *   单文件 ≤ 200 行（PRD §4.2 硬约束）。
 */
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { DEFAULT_SESSION_SUBFIELDS } from './app-settings-config-defs';

/** session record 子字段 draft（maxSkillInject/maxMemoryInject，默认 50） */
export interface SessionDraft {
  maxSkillInject: number;
  maxMemoryInject: number;
}

interface SectionSessionConfigProps {
  /** session record 的 draft（默认 50/50） */
  sessionDraft: SessionDraft;
  /** session draft 变更（key='maxSkillInject'|'maxMemoryInject'，value=number） */
  onSessionChange: (key: 'maxSkillInject' | 'maxMemoryInject', value: number) => void;
}

/** 会话 tab 第一 group（会话注入数量上限） */
export function SectionSessionConfig({
  sessionDraft,
  onSessionChange,
}: SectionSessionConfigProps): ReactNode {
  const { t } = useTranslation('app-dev-config');
  return (
    <div>
      <h3 className="text-[15px] font-semibold text-fg mb-3 mt-0">{t('group.session.label')}</h3>
      <div className="flex flex-col">
        <NumberKeyRow
          keyName="session-maxSkillInject"
          label={t('schema.session.maxSkillInject.label')}
          desc={t('schema.session.maxSkillInject.desc')}
          value={sessionDraft.maxSkillInject}
          defaultValue={DEFAULT_SESSION_SUBFIELDS.maxSkillInject}
          onChange={(v) => onSessionChange('maxSkillInject', v)}
        />
        <NumberKeyRow
          keyName="session-maxMemoryInject"
          label={t('schema.session.maxMemoryInject.label')}
          desc={t('schema.session.maxMemoryInject.desc')}
          value={sessionDraft.maxMemoryInject}
          defaultValue={DEFAULT_SESSION_SUBFIELDS.maxMemoryInject}
          onChange={(v) => onSessionChange('maxMemoryInject', v)}
        />
      </div>
    </div>
  );
}

/** 单个 number key 行（容器 testid=key-number-{keyName}，内含 input） */
function NumberKeyRow({
  keyName,
  label,
  desc,
  value,
  defaultValue,
  onChange,
}: {
  keyName: string;
  label: string;
  desc: string;
  value: number;
  defaultValue: number;
  onChange: (v: number) => void;
}) {
  const isDefault = value === defaultValue;
  return (
    <div className="border border-border rounded-lg py-[16px] px-[20px] mb-[8px] bg-surface-2 transition-colors hover:border-border-strong">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-fg">{label}</div>
          <div className="text-xs text-muted-2 mt-1.5 leading-relaxed">{desc}</div>
        </div>
        <div className="shrink-0 w-[280px]">
          {/* 容器 testid=key-number-{keyName}（ET 锚点），内含 input（ET focus 锚点：key-number-{keyName} input） */}
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              className={
                'w-full rounded-md border border-border-2 bg-surface-2 px-3 py-2 text-[13px] text-fg outline-none transition-colors focus:border-accent hover:border-border-strong ' +
                (isDefault ? 'text-muted' : 'text-fg')
              }
              value={value}
              onChange={(e) => {
                const raw = e.target.value;
                onChange(raw === '' ? 0 : Number(raw));
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default SectionSessionConfig;
