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
import { forwardRef, useCallback, useEffect, useImperativeHandle, useState, type ForwardedRef } from 'react';
import { useTranslation } from 'react-i18next';
import { req } from '../../lib/api-client';
import { ToggleSwitch } from '../framework/primitives/toggle-switch';
import type { SectionSaveHandle } from './use-tab-dirty-aggregator';

/** [v0.0.316-fix] section props：onDirtyChange 上报 dirty 变化给 tab aggregator */
interface SectionBashConfigProps {
  onDirtyChange?: (dirty: boolean) => void;
}

/** bash 配置 section（bash_seatbelt boolean toggle；forwardRef 暴露 save/reset 给 tab 级 aggregator） */
export const SectionBashConfig = forwardRef<SectionSaveHandle, SectionBashConfigProps>(function SectionBashConfig({ onDirtyChange }, ref: ForwardedRef<SectionSaveHandle>) {
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

  /** [v0.0.316-fix] dirty 变化上报 page（声明式通知，驱动 save bar 亮） */
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  /** [v0.0.316-fix] 暴露 save/reset 给 tab 级 aggregator（dirty 走 onDirtyChange 上报） */
  useImperativeHandle(ref, () => ({
    save: handleSave,
    reset: handleReset,
  }), [handleSave, handleReset]);

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
    </div>
  );
});

export default SectionBashConfig;
