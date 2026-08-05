/**
 * section-channel-list — 渠道 config 列表
 * 参考: specs/ui/components/channel-page/section-channel-list.md
 *       specs/ui/overall/06-channel.md §2/§3
 *
 * 受控组件：instances 由父级（page-channel）订阅后端 GET /config/channels 推回，
 * 本 section 只渲染双状态 + 派发 CRUD（toggle/edit/delete）。
 * 仿 section-browser-connector：switch + connection 双状态映射（见状态表）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ChannelConfig } from '../../lib/channel-api';
import { ToggleSwitch } from '../framework/primitives/toggle-switch';

interface Props {
  instances: ChannelConfig[];
  /** toggle on/off → PUT enabled（fire-and-forget，后端 connect/disconnect） */
  onToggle: (id: string, enable: boolean) => void;
  /** 编辑（父级打开编辑表单） */
  onEdit: (inst: ChannelConfig) => void;
  /** 删除（父级二次确认 + DELETE） */
  onDelete: (inst: ChannelConfig) => void;
}

/** 状态展示三元素：文案 + 色点 class + 文本颜色 class */
type StatusView = { text: string; dot: string; textCls: string };

/**
 * 由 enabled(switch) + connection 组合派生 status 展示（仿 connector 双状态机）。
 * - enabled=false：一律显「未启用」（不区分 connection）
 * - enabled=true：按 connection 显示
 */
function deriveStatus(inst: ChannelConfig, t: TFunction): StatusView {
  if (!inst.enabled) {
    return { text: t('state.disabled'), dot: 'bg-border-strong', textCls: 'text-muted' };
  }
  switch (inst.connection) {
    case 'disconnected':
      return { text: t('state.disconnected'), dot: 'bg-border-strong', textCls: 'text-muted' };
    case 'connecting':
      return { text: t('state.connecting'), dot: 'bg-gold', textCls: 'text-gold' };
    case 'connected':
      return { text: t('state.connected'), dot: 'bg-sage', textCls: 'text-sage' };
    case 'error':
      return { text: t('state.error'), dot: 'bg-danger', textCls: 'text-danger' };
  }
}

/** 渲染渠道 config 列表（每行卡片：name/type/switch/status/binding/edit/delete）。 */
export function SectionChannelList({ instances, onToggle, onEdit, onDelete }: Props) {
  const { t } = useTranslation('channel');

  if (instances.length === 0) {
    return (
      <div className="text-[13px] text-muted-2 font-mono py-6 text-center">
        {t('list.empty')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {instances.map((inst) => (
        <ChannelRow key={inst.id} inst={inst} onToggle={onToggle} onEdit={onEdit} onDelete={onDelete} t={t} />
      ))}
    </div>
  );
}

/** 单行 config 卡片 */
function ChannelRow({
  inst,
  onToggle,
  onEdit,
  onDelete,
  t,
}: {
  inst: ChannelConfig;
  onToggle: Props['onToggle'];
  onEdit: Props['onEdit'];
  onDelete: Props['onDelete'];
  t: TFunction;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const status = deriveStatus(inst, t);
  const isConnecting = inst.enabled && inst.connection === 'connecting';

  return (
    <div

      className="flex flex-col gap-2 px-4 py-3 rounded-[10px] bg-surface-2 border border-border"
    >
      {/* 顶行：name + implId 标签 + switch */}
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="text-[13.5px] font-semibold text-fg truncate">{inst.name}</div>
          <div className="mt-[2px] text-[11px] text-muted-2 font-mono">
            {inst.implId} · {t('list.bindingCount', { count: inst.bindingCount ?? 0 })}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <ToggleSwitch
            value={inst.enabled}
            onChange={(next) => {
              if (isConnecting) return; // connecting 中禁用防抖
              onToggle(inst.id, next);
            }}
            label={t('list.switchLabel', { name: inst.name })}
            actionKey="channel.instance.toggle"
          />
          {isConnecting && (
            <span className="inline-flex items-center gap-1 text-[11px] font-mono text-gold">
              <span className="inline-block w-[6px] h-[6px] rounded-full bg-gold animate-pulse" />
            </span>
          )}
        </div>
      </div>

      {/* status 行：色点 + 文案 */}
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={'inline-block w-[7px] h-[7px] rounded-full ' + status.dot + (isConnecting ? ' animate-pulse' : '')}
        />
        <span className={'text-[12px] font-mono ' + status.textCls}>
          {status.text}
        </span>
      </div>

      {/* error 态：原因（仅 enabled + connection=error 显示） */}
      {inst.enabled && inst.connection === 'error' && (
        <div

          className="text-[12px] font-mono text-danger leading-[1.5] px-3 py-2 rounded-md bg-danger-light"
        >
          {inst.errorDetail || t('state.errorDefault')}
        </div>
      )}

      {/* 操作行：编辑 + 删除（二次确认） */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-action-key="channel.instance.edit"
          onClick={() => onEdit(inst)}
          className="px-2 py-[3px] rounded text-[11px] font-semibold border border-border-2 text-fg hover:border-accent"
        >
          {t('list.edit')}
        </button>
        {confirmDelete ? (
          <>
            <button
              type="button"
              data-action-key="channel.instance.confirm-delete"
              onClick={() => onDelete(inst)}
              className="px-2 py-[3px] rounded text-[11px] font-semibold bg-danger text-white"
            >
              {t('list.deleteConfirm')}
            </button>
            <button
              type="button"
              data-action-key="channel.instance.cancel-delete"
              onClick={() => setConfirmDelete(false)}
              className="px-2 py-[3px] rounded text-[11px] font-semibold border border-border-2 text-muted"
            >
              {t('form.cancel')}
            </button>
          </>
        ) : (
          <button
            type="button"
            data-action-key="channel.instance.delete"
            onClick={() => setConfirmDelete(true)}
            className="px-2 py-[3px] rounded text-[11px] font-semibold border border-danger text-danger hover:bg-danger hover:text-white transition-colors"
          >
            {t('list.delete')}
          </button>
        )}
      </div>
    </div>
  );
}

export default SectionChannelList;
