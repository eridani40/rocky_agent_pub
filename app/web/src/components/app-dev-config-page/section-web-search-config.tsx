/**
 * section-web-search-config — 应用设置 → 网络搜索 自渲染 section（v0.0.72 新增；v0.0.75 UI 对齐；v0.0.121 type 改下拉）
 * 参考: specs/ui/components/app-dev-config-page/section-web-search-config/_overview.md
 *       specs/tech/config/[P0]app_config.md §3.6（web_search group 数据契约）
 *       specs/tech/agent/tools/[P1]web_search_tool.md §3/§4（list EP + type 路由）
 *
 * 职责：
 *   - 挂载 GET `/config/app?group=web_search&key=default` 拿草稿态 `{type, credentials}`
 *   - 挂载 GET `/config/plugin` inventory，提取 `web_search_provider` point 的 impls 作 type 下拉选项
 *   - 选中 impl 时动态渲染对应 credentials 字段（zhipu: apiKey secret input）
 *   - saveMode='item'：自管 save/reset 按钮，PUT 整组提交；不复用 component-group-save-bar
 *
 * v0.0.121 type 选择控件改选择框（下拉 dropdown）：
 *   - 原 choice-cards 网格（按钮组）改为 ComponentChannelTypeDropdown 下拉选择器
 *   - 复用项目已有 channel-page/component-channel-type-dropdown（单选、键盘导航、外部点击关闭）
 *   - impl.description 仍走 resolveI18nField 作为 option label，保持 i18n 接线一致
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

/** web_search 配置 record（GET/PUT body 形状，对齐后端 app_config.web_search.default） */
interface WebSearchConfig {
  type: string;
  credentials: Record<string, { apiKey?: string }>;
}

/** 空 draft：record 缺失 / type 缺失时占位 */
const EMPTY_DRAFT: WebSearchConfig = { type: '', credentials: {} };

/** 网络搜索自渲染 section */
export function SectionWebSearchConfig() {
  // app-dev-config ns：本 section 主文案（标题/描述/按钮/label）
  // plugin-config ns：解析 manifest `__MSG_plugin.builtin.*__` 占位符（impl.description）
  const { t } = useTranslation('app-dev-config');
  const { t: tPlugin } = useTranslation('plugin-config');
  const [baseline, setBaseline] = useState<WebSearchConfig>(EMPTY_DRAFT);
  const [draft, setDraft] = useState<WebSearchConfig>(EMPTY_DRAFT);
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
        req<{ value: WebSearchConfig | null }>(
          '/config/app?group=web_search&key=default',
        ),
        getPluginInventory(),
      ]);
      const base = cfgRes.value ?? EMPTY_DRAFT;
      // 提取 web_search_provider point 的 impl 列表（嵌套 groups[].points[].impls[]，v0.0.71 D3）
      const list: PluginExtImpl[] = [];
      for (const g of inv.groups ?? []) {
        for (const p of g.points ?? []) {
          if (p.pointId === 'web_search_provider') {
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

  /** 保存：整组 PUT `/config/app` body={group:'web_search', items:[{key:'default', data:draft}]} */
  const handleSave = async () => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      await req<{ ok: true }>('/config/app', {
        method: 'PUT',
        body: JSON.stringify({
          group: 'web_search',
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
      {/* 标题区（v0.0.75 对齐 providers/user-memory 主流 section title 规格：
          text-[15px] font-semibold + text-[11px] text-muted font-mono mt-0.5；
          非 observability 的 20px bold heavy 变体。无 border-b，靠 gap-3 与下方内容隔开。
          左边缘不另加 padding，与父 config-area 的 py-6 px-8 对齐） */}
      <div>
        <p className="text-[11px] text-muted font-mono mt-0.5">
          {t('webSearch.sectionDesc')}
        </p>
      </div>

      {/* type 选择下拉：无候选 → 空态；有候选 → ComponentChannelTypeDropdown（v0.0.121 改选择框） */}
      {impls.length === 0 ? (
        <div className="text-sm text-muted">
          {t('webSearch.empty')}
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          {/* 字段 label：text-xs text-fg-2 font-medium，对齐 providers/component-provider-fields FieldRow */}
          <span className="text-xs text-fg-2 font-medium">
            {t('webSearch.typeLabel')}
          </span>
          {/* 下拉选择器：impl 列表动态生成 options，value=implId，label=描述（resolveI18nField）或 implId。
              当前选中项由 trigger label + option 的 aria-selected 反映（DOM 可断言），无需额外标记节点。 */}
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

      {/* 选中 impl 的 credentials：当前仅 zhipu → apiKey SecretInput。
          value=已保存 apiKey（mask 展示）；onCommit=提交新值→handleApiKeyChange
          （更新 draft.credentials → 标 dirty → 等 save 落库）。
          外层用 div（非 label）避免 label 点击与 SecretInput display 点击冲突。 */}
      {draft.type && (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-fg-2 font-medium">
            {t('webSearch.apiKeyLabel')}
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
          {t('webSearch.reset')}
        </button>
        <button
          type="button"

          onClick={() => void handleSave()}
          disabled={!canSave || saving}
          className="text-xs px-3 py-1 rounded-md bg-accent text-surface disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? t('webSearch.saving') : t('webSearch.save')}
        </button>
      </div>
    </div>
  );
}

export default SectionWebSearchConfig;
