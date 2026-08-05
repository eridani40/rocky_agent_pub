/**
 * section-see-image-config — 应用设置 → 工具 → 看图理解 自渲染 section（v0.0.141 新增）
 * 参考: specs/ui/components/app-dev-config-page/section-see-image-config/_overview.md
 *       specs/tech/agent/tools/[P1]see_image_tool.md §7（see_image group 数据契约）
 *       specs/tech/agent/tools/[P1]see_image_tool.md §3/§4.1（see_image_provider list EP + type 路由）
 *
 * 职责：
 *   - 挂载 GET `/config/app?group=see_image&key=default` 拿草稿态 `{type, credentials}`
 *   - 挂载 GET `/config/plugin` inventory，提取 `see_image_provider` point 的 impls 作 type 下拉选项
 *   - 选中 impl 时动态渲染对应 credentials 字段（apiKey secret input）
 *   - saveMode='item'：自管 save/reset 按钮，PUT 整组提交；不复用 component-group-save-bar
 *
 * 与 section-web-search-config 完全同构（implId-agnostic，仅 group/pointId/testid 前缀不同），复刻自该组件。
 *
 * 边界：
 *   - 不消费 useAppSettingsConfig（自渲染，与 providers/observability 同范式）
 *   - 不进 app-settings-config-defs.ts 的 KV_GROUPS
 *   - type 未配置 / 无候选 impl → save 禁用
 */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { req, getPluginInventory, type PluginExtImpl } from '../../lib/api-client';
import { resolveI18nField } from '../../i18n/resolve-i18n-field';
import { SecretInput } from '../framework/primitives/secret-input';
import { ComponentChannelTypeDropdown } from '../channel-page/component-channel-type-dropdown';

/** see_image 配置 record（GET/PUT body 形状，对齐后端 app_config.see_image.default） */
interface SeeImageConfig {
  type: string;
  credentials: Record<string, { apiKey?: string }>;
}

/** 空 draft：record 缺失 / type 缺失时占位 */
const EMPTY_DRAFT: SeeImageConfig = { type: '', credentials: {} };

/** 看图理解自渲染 section */
export function SectionSeeImageConfig() {
  // app-dev-config ns：本 section 主文案（标题/描述/按钮/label）
  // plugin-config ns：解析 manifest `__MSG_plugin.builtin.see_image.*__` 占位符（impl.description）
  const { t } = useTranslation('app-dev-config');
  const { t: tPlugin } = useTranslation('plugin-config');
  const [baseline, setBaseline] = useState<SeeImageConfig>(EMPTY_DRAFT);
  const [draft, setDraft] = useState<SeeImageConfig>(EMPTY_DRAFT);
  const [impls, setImpls] = useState<PluginExtImpl[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  /** 挂载：并发 GET config + inventory */
  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cfgRes, inv] = await Promise.all([
        req<{ value: SeeImageConfig | null }>(
          '/config/app?group=see_image&key=default',
        ),
        getPluginInventory(),
      ]);
      const base = cfgRes.value ?? EMPTY_DRAFT;
      // 提取 see_image_provider point 的 impl 列表（嵌套 groups[].points[].impls[]）
      const list: PluginExtImpl[] = [];
      for (const g of inv.groups ?? []) {
        for (const p of g.points ?? []) {
          if (p.pointId === 'see_image_provider') {
            list.push(...(p.impls ?? []));
          }
        }
      }
      setImpls(list);
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

  /** dirty：draft 与 baseline 深比较（type 或 credentials 任意变化） */
  const dirty = JSON.stringify(draft) !== JSON.stringify(baseline);
  /** type 未配置或无候选 impl 时 save 禁用 */
  const canSave = dirty && draft.type !== '' && impls.some((i) => i.implId === draft.type);

  /** 选中 type T：切到 T 的 credentials 编辑区；保留 T 已有 apiKey，无则空 */
  const handleSelectType = (implId: string) => {
    setDraft((prev) => ({
      type: implId,
      credentials: { ...prev.credentials, [implId]: prev.credentials[implId] ?? {} },
    }));
  };

  /** 编辑 apiKey：写入 draft.credentials[type].apiKey */
  const handleApiKeyChange = (implId: string, value: string) => {
    setDraft((prev) => ({
      ...prev,
      credentials: {
        ...prev.credentials,
        [implId]: { ...(prev.credentials[implId] ?? {}), apiKey: value },
      },
    }));
  };

  /** 保存：整组 PUT `/config/app` body={group:'see_image', items:[{key:'default', data:draft}]} */
  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await req<{ ok: true }>('/config/app', {
        method: 'PUT',
        body: JSON.stringify({
          group: 'see_image',
          items: [{ key: 'default', data: draft }],
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
      {/* 顶部说明区（对齐 section-web-search-config：text-[11px] text-muted font-mono mt-0.5，
          无 h2 标题——group 标题 h3 由父 section-tab-panel.tsx 渲染） */}
      <div>
        <p className="text-[11px] text-muted font-mono mt-0.5">
          {t('seeImage.sectionDesc')}
        </p>
      </div>

      {/* type 选择下拉：无候选 → 空态；有候选 → ComponentChannelTypeDropdown */}
      {impls.length === 0 ? (
        <div className="text-sm text-muted">
          {t('seeImage.empty')}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-fg-2 font-medium">
            {t('seeImage.typeLabel')}
          </span>
          {/* 下拉选择器：impl 列表动态生成 options（implId-agnostic），value=implId，
              label=描述（resolveI18nField）或 implId */}
          <ComponentChannelTypeDropdown

            value={draft.type}
            options={impls.map((impl) => {
              // impl.description 是 manifest `__MSG_<key>__` 占位符，走 resolveI18nField 解析
              const desc = resolveI18nField(impl.description, tPlugin);
              return { value: impl.implId, label: desc || impl.implId };
            })}
            onChange={handleSelectType}
          />
        </div>
      )}

      {/* 选中 impl 的 credentials：两内置 impl（minimax_m3/zhipu_image）字段集相同，
          均仅 apiKey → 凭证区高度稳定不随切 type 跳动。
          value=已保存 apiKey（mask 展示）；onCommit=提交新值→handleApiKeyChange */}
      {draft.type && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-fg-2 font-medium">
            {t('seeImage.apiKeyLabel')}
          </span>
          <SecretInput
            value={draft.credentials[draft.type]?.apiKey ?? ''}
            onCommit={(next) => handleApiKeyChange(draft.type, next)}
            placeholder="sk-..."

          />
        </div>
      )}

      {/* save/reset toolbar（saveMode='item' 自管，无 component-group-save-bar） */}
      <div className="flex justify-end gap-2">
        <button
          type="button"

          onClick={handleReset}
          disabled={!dirty || saving}
          className="text-xs text-muted hover:text-fg-2 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {t('seeImage.reset')}
        </button>
        <button
          type="button"

          onClick={() => void handleSave()}
          disabled={!canSave || saving}
          className="text-xs px-3 py-1 rounded-md bg-accent text-surface disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? t('seeImage.saving') : t('seeImage.save')}
        </button>
      </div>
    </div>
  );
}

export default SectionSeeImageConfig;
