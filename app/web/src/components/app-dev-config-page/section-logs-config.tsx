/**
 * section-logs-config — 可观测性 tab → logs group section（v0.0.317 新增）
 * 参考: section-bash-config.tsx（同构 forwardRef + aggregator 范式）
 *       specs/tech/version_logs/v0.0.317/change_plan.md
 *
 * 职责：
 *   - 挂载 GET `/config/app?group=logs` 拿 baseline（7 个 toggle，缺省 false）
 *   - ComponentKeyCard 控制 draft（toggle 变化只改 draft，不调 API）
 *   - saveMode='item'：自管 save/reset，PUT `/config/app` body={group:'logs', items:[...]}
 *   - forwardRef 暴露 { save, reset } 给 observability tab aggregator
 *
 * 边界：
 *   - 不消费 useAppSettingsConfig（自渲染，与 bash/web_search 同范式）
 *   - 从 KV_GROUPS 拿 logs group 的 key 定义（type/desc/labelKey）
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useState, type ForwardedRef } from 'react';
import { ComponentKeyCard, type KeyInfo } from './component-key-card';
import { getConfigGroup, putConfigGroup } from '../../lib/api-client';
import { KV_GROUPS, defaultFor, shallowDiff, structuredCloneSafe } from './app-settings-config-defs';
import type { SectionSaveHandle } from './use-tab-dirty-aggregator';

/** logs group key 定义（type/desc/labelKey，来自 KV_GROUPS） */
const LOGS_DEF = KV_GROUPS.find((d) => d.groupId === 'logs')!;

/** section props：onDirtyChange 上报 dirty 变化给 tab aggregator */
interface SectionLogsConfigProps {
  onDirtyChange?: (dirty: boolean) => void;
}

/** logs 配置 section（7 个 boolean toggle；forwardRef 暴露 save/reset 给 tab 级 aggregator） */
export const SectionLogsConfig = forwardRef<SectionSaveHandle, SectionLogsConfigProps>(function SectionLogsConfig({ onDirtyChange }, ref: ForwardedRef<SectionSaveHandle>) {
  /** baseline：已持久化的值（GET 回填） */
  const [baseline, setBaseline] = useState<Record<string, unknown>>({});
  /** draft：用户编辑中的值 */
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** 挂载：GET `/config/app?group=logs` 读全部 toggle baseline */
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const items = await getConfigGroup('app', 'logs');
      const base: Record<string, unknown> = {};
      for (const k of LOGS_DEF.keys) {
        const hit = items.find((i) => i.key === k.key);
        base[k.key] = hit?.data ?? defaultFor(k.type);
      }
      setBaseline(base);
      setDraft(structuredCloneSafe(base));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** dirty：draft 与 baseline shallow 不一致 */
  const dirty = shallowDiff(draft, baseline);

  /** 保存：PUT `/config/app` body={group:'logs', items:[{key, data}, ...]} */
  const handleSave = async () => {
    if (!dirty) return;
    setError(null);
    try {
      const items = LOGS_DEF.keys.map((k) => ({ key: k.key, data: draft[k.key] }));
      await putConfigGroup('app', 'logs', items);
      setBaseline(structuredCloneSafe(draft));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await reload();
    }
  };

  /** 重置：draft 回 baseline */
  const handleReset = () => {
    setDraft(structuredCloneSafe(baseline));
  };

  /** dirty 变化上报 page（声明式通知，驱动 save bar 亮） */
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  /** 暴露 save/reset 给 tab 级 aggregator */
  useImperativeHandle(ref, () => ({
    save: handleSave,
    reset: handleReset,
  }), [handleSave, handleReset]);

  if (loading) {
    return <div className="p-4 text-muted text-sm">Loading…</div>;
  }
  if (error) {
    return (
      <div className="p-4">
        <div role="alert" className="text-sm text-accent">{error}</div>
        <button type="button" onClick={() => void reload()} className="mt-3 text-xs underline text-accent">
          Retry
        </button>
      </div>
    );
  }

  /** 构建 KeyInfo[]（draft 值注入，供 ComponentKeyCard 受控渲染） */
  const keys: KeyInfo[] = LOGS_DEF.keys.map((k) => ({
    key: k.key,
    type: k.type,
    value: draft[k.key] as KeyInfo['value'],
    desc: k.desc,
    labelKey: k.labelKey,
    options: k.options,
  }));

  return (
    <div className="flex flex-col">
      {keys.map((k) => (
        <ComponentKeyCard
          key={k.key}
          keyInfo={k}
          onChange={(next) => setDraft((prev) => ({ ...prev, [k.key]: next }))}
        />
      ))}
    </div>
  );
});

export default SectionLogsConfig;
