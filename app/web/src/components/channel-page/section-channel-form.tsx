/**
 * section-channel-form — 渠道新建/编辑表单
 * 参考: specs/ui/components/channel-page/section-channel-form.md
 *       specs/ui/overall/06-channel.md §2/§3
 *       specs/api/overall/17-channel.md §3/§4
 *
 * 受控表单：提交回调由父级（page-channel）处理（POST/PUT + reload + 关表单）。
 *
 * appSecret 双形态（见 spec §「appSecret 字段实现」）：
 *   - 新建（editing=null）：<input type="password"> 直接 mask 输入（E2E type action 要求 input）
 *   - 编辑（editing 有值）：appSecret 初始值 = 后端返回明文（editing.config.appSecret），
 *     由 primitive-secret-input maskSecret 展示成 `ax****yz`（与其他 key/secret 字段一致）；
 *     不编辑 → 提交原明文 → 后端存原值；点✎重输 → 提交新值
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SecretInput } from '../framework/primitives/secret-input';
import { ComponentChannelTypeDropdown } from './component-channel-type-dropdown';
import { ComponentFeishuSetupDoc } from './component-feishu-setup-doc';
import type { ChannelFormInput, ChannelConfig } from '../../lib/channel-api';

/** 类型选项（后端 scope 激活集合派生，page-channel 经 GET /config/channels/impl-types 供给） */
export interface ChannelImplType {
  implId: string;
  label: string;
}

interface Props {
  /** null/undefined=新建；有值=编辑（回显 name/appId/appSecret，appSecret 走 SecretInput mask 展示） */
  editing?: ChannelConfig | null;
  /** 渠道 impl 类型列表（label 已经父级 resolveI18nField 解析；空=后端无激活 impl/获取失败 → 空态） */
  types: ChannelImplType[];
  /** 提交回调（父级 POST/PUT + reload + 关表单） */
  onSubmit: (input: ChannelFormInput) => Promise<void> | void;
  /** 取消（关表单） */
  onCancel: () => void;
}

/**
 * 渲染渠道表单。新建用 password input；编辑用 SecretInput（mask 既有 appSecret）。
 * implId 新建时可选（取 types 首项），编辑时锁定不可改（改 implId = 删旧建新）。
 * types 空态：select/提交 disabled + noImplTypes 提示（不阻断既有 config 列表/编辑）。
 */
export function SectionChannelForm({ editing, types, onSubmit, onCancel }: Props) {
  const { t } = useTranslation('channel');
  const isEdit = !!editing;
  const typesEmpty = types.length === 0;

  const [implId, setImplId] = useState(editing?.implId ?? types[0]?.implId ?? '');
  const [name, setName] = useState(editing?.name ?? '');
  const [appId, setAppId] = useState(editing?.config?.appId ?? '');
  // 编辑态：appSecret 初始 = 后端明文（SecretInput 会 mask 成 ax****yz，与其他 key 统一）；新建态空串
  const [appSecret, setAppSecret] = useState(editing?.config?.appSecret ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // 类型下拉 options：types 空 → 空数组（无任何前端兜底项，不伪造类型）
  const typeOptions = useMemo(
    () => types.map((tp) => ({ value: tp.implId, label: tp.label })),
    [types],
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !appId.trim() || (!isEdit && !appSecret.trim())) {
      setErr(t('form.errRequired'));
      return;
    }
    setSubmitting(true);
    setErr(null);
    try {
      const input: ChannelFormInput = {
        implId,
        name: name.trim(),
        appId: appId.trim(),
        // 编辑态：未改提交原明文（后端存原值）；用户点✎重输则提交新值。新建直接传明文
        appSecret: isEdit ? appSecret : appSecret.trim(),
      };
      await onSubmit(input);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form

      onSubmit={handleSubmit}
      className="flex flex-col gap-3 px-4 py-3 rounded-[10px] bg-surface-2 border border-border"
    >
      {/* 类型选择：自定义下拉（禁原生 select，conventions §10；编辑时锁定不可改；types 空态 disabled） */}
      <label className="flex flex-col gap-1">
        <span className="text-[12px] text-muted font-mono">{t('form.impl')}</span>
        <ComponentChannelTypeDropdown

          value={implId}
          options={typeOptions}
          onChange={setImplId}
          disabled={isEdit || typesEmpty}
        />
        {typesEmpty && (
          <span className="text-[12px] text-muted font-mono">{t('form.noImplTypes')}</span>
        )}
      </label>

      {/* 名称 */}
      <label className="flex flex-col gap-1">
        <span className="text-[12px] text-muted font-mono">{t('form.name')}</span>
        <input
          data-action-key="channel.instance.input-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('form.namePlaceholder')}
          className="border border-border-2 rounded-md px-[12px] py-[8px] bg-surface text-fg text-[13px] outline-none focus:border-accent"
        />
      </label>

      {/* appId */}
      <label className="flex flex-col gap-1">
        <span className="text-[12px] text-muted font-mono">{t('form.appId')}</span>
        <input
          data-action-key="channel.instance.input-app-id"
          type="text"
          value={appId}
          onChange={(e) => setAppId(e.target.value)}
          placeholder={t('form.appIdPlaceholder')}
          autoComplete="off"
          spellCheck={false}
          className="border border-border-2 rounded-md px-[12px] py-[8px] bg-surface text-fg text-[13px] font-mono outline-none focus:border-accent"
        />
      </label>

      {/* appSecret：新建=password input / 编辑=SecretInput */}
      <label className="flex flex-col gap-1">
        <span className="text-[12px] text-muted font-mono">{t('form.appSecret')}</span>
        {isEdit ? (
          <SecretInput
            actionKey="channel.instance.input-app-secret"
            value={appSecret}
            onCommit={(next) => setAppSecret(next)}
            desc={t('form.appSecretEditHint')}
          />
        ) : (
          <input
            data-action-key="channel.instance.input-app-secret"
            type="password"
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
            placeholder={t('form.appSecretPlaceholder')}
            autoComplete="off"
            spellCheck={false}
            className="border border-border-2 rounded-md px-[12px] py-[8px] bg-surface text-fg text-[13px] font-mono outline-none focus:border-accent"
          />
        )}
      </label>

      {err && <div className="text-[12px] text-danger font-mono">{err}</div>}

      {/* 飞书接入说明文档：implId==='feishu' 时展开（固定高度独立滚动，避免与 modal 整体滚动嵌套） */}
      {implId === 'feishu' && <ComponentFeishuSetupDoc />}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          data-action-key="channel.instance.save"
          disabled={submitting || typesEmpty}
          className="px-3 py-[6px] rounded-md text-[12px] font-semibold bg-accent text-white hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? t('form.submitting') : t('form.submit')}
        </button>
        <button
          type="button"
          data-action-key="channel.instance.cancel"
          onClick={onCancel}
          disabled={submitting}
          className="px-3 py-[6px] rounded-md text-[12px] font-semibold border border-border-2 text-fg hover:border-accent disabled:opacity-50"
        >
          {t('form.cancel')}
        </button>
      </div>
    </form>
  );
}

export default SectionChannelForm;
