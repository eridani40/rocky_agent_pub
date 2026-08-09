/**
 * section-bash-config — 应用设置 → 工具 → Bash 工具 自渲染 section（v0.0.296 新增）
 * 参考: specs/ui/components/app-dev-config-page/section-see-image-config/_overview.md（同构范式）
 *       specs/tech/version_logs/v0.0.296/change_plan.md
 *
 * 职责：
 *   - 挂载 GET `/config/app?group=runtime&key=bash_seatbelt` 拿 baseline（null → true）
 *   - ToggleSwitch 控制 draft（沙箱开关）
 *   - saveMode='item'：自管 save/reset，PUT `/config/app` body={group:'runtime', items:[...]}
 *   - save 后提示「重启生效」
 *
 * 边界：
 *   - 不消费 useAppSettingsConfig（自渲染，与 see_image/web_fetch 同范式）
 *   - 不进 app-settings-config-defs.ts 的 KV_GROUPS
 *   - baseline null/缺失 → 显示 true（安全默认）
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { req } from '../../lib/api-client';
import { ToggleSwitch } from '../framework/primitives/toggle-switch';

/** bash 配置 section（bash_seatbelt boolean toggle） */
export function SectionBashConfig() {
  const { t } = useTranslation('app-dev-config');
  const [baseline, setBaseline] = useState<boolean>(true);
  const [draft, setDraft] = useState<boolean>(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /** 挂载：GET config 读 baseline（null/缺失 → true） */
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await req<{ value: boolean | null }>(
        '/config/app?group=runtime&key=bash_seatbelt',
      );
      const base = res.value ?? true;
      setBaseline(base);
      setDraft(base);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** dirty：draft 与 baseline 不一致 */
  const dirty = draft !== baseline;

  /** 保存：PUT `/config/app` body={group:'runtime', items:[{key:'bash_seatbelt', data:draft}]} */
  const handleSave = async () => {
    if (!dirty) return;
    setSaving(true);
    setError(null);
    try {
      await req<{ ok: true }>('/config/app', {
        method: 'PUT',
        body: JSON.stringify({
          group: 'runtime',
          items: [{ key: 'bash_seatbelt', data: draft }],
        }),
      });
      setBaseline(draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await reload();
    } finally {
      setSaving(false);
    }
  };

  /** 重置：draft 回 baseline */
  const handleReset = () => {
    setDraft(baseline);
  };

  if (loading) {
    return (
      <div className="p-8 text-muted text-sm">
        {t('observability.loading')}
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-8">
        <div role="alert" className="text-sm text-accent">{error}</div>
        <button type="button" onClick={() => void reload()} className="mt-3 text-xs underline text-accent">
          {t('observability.retry')}
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 顶部说明区（对齐 section-see-image-config 范式） */}
      <div>
        <p className="text-[11px] text-muted font-mono mt-0.5">
          {t('bash.sectionDesc')}
        </p>
      </div>

      {/* toggle 行：沙箱开关 */}
      <div className="flex items-center gap-3">
        <ToggleSwitch
          value={draft}
          onChange={setDraft}
          label={t('bash.toggleLabel')}
          actionKey="bash-seatbelt-toggle"
        />
        <span className="text-xs text-fg-2">
          {t('bash.toggleLabel')}
        </span>
      </div>

      {/* 重启生效提示 */}
      {dirty && (
        <p className="text-[11px] text-muted">
          {t('bash.restartNotice')}
        </p>
      )}

      {/* save/reset toolbar（saveMode='item' 自管，无 component-group-save-bar） */}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={handleReset}
          disabled={!dirty || saving}
          className="text-xs text-muted hover:text-fg-2 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {t('bash.reset')}
        </button>
        <button
          type="button"
          data-testid="bash-config-save"
          onClick={() => void handleSave()}
          disabled={!dirty || saving}
          className="text-xs px-3 py-1 rounded-md bg-accent text-surface disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? t('bash.saving') : t('bash.save')}
        </button>
      </div>
    </div>
  );
}

export default SectionBashConfig;
