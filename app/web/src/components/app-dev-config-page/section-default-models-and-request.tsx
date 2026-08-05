/**
 * section-default-models-and-request — 模型 tab 第二+第三 group 渲染（v0.0.89 新增）
 * 参考: specs/ui/components/app-dev-config-page/section-default-models-and-request.md
 *       specs/prd/version_logs/v0.0.89/02-default-models-and-request.md §3
 *
 * 职责：模型 tab 下两个 KV group 的渲染区：
 *   1. playground 默认模型 group（default_models record，chat 行复用 chat/ModelPicker + 外层 x 清除）
 *   2. 请求设置 group（llm_request/default 暴露 stall_tool_s + max_attempts 子字段，number）
 *
 * 边界：不直接调 API（draft 由 useAppSettingsConfig 管理，本 section 纯展示 + 上抛变更）；
 *   不暴露 degradation/length/fallback_chain 等高级项（design-brief §6.3 硬约束）；
 *   record 不存在时 default_models 显「未配置」、llm_request 显默认值（120/3）由 hook 兜底。
 *
 * v0.0.158：删「默认压缩模型」列（chat/compact 同链后 default_models 只留 chat 一列）。
 * v0.0.230 验收返工：chat 行从 KeyModelPicker 改为复用统一的 `chat/ModelPicker`（squad 管理
 *   同款——无搜索、trigger/选项均 `provider / model` 风格）；清除交互在组件外层包 x 按钮
 *   （ModelPicker 本体只负责选项、不含清除——用户裁决 2026-07-31）。
 */
import { useTranslation } from 'react-i18next';
import { ModelPicker } from '../chat/ModelPicker';
import {
  useProviders,
  findProviderIdByModelId,
  type ModelSelection,
} from '../../lib/providers';
import type { DefaultModelsData } from './use-app-settings-config';
import { DEFAULT_LLM_REQUEST_SUBFIELDS } from './app-settings-config-defs';

interface SectionDefaultModelsAndRequestProps {
  /** default_models draft（chat 可空） */
  defaultModelsDraft: DefaultModelsData;
  /** default_models draft 变更（key='chat'；value undefined=清除） */
  onDefaultModelsChange: (key: 'chat', value: string | undefined) => void;
  /** llm_request 子字段 draft（stall_tool_s / max_attempts） */
  llmRequestDraft: { stall_tool_s: number; max_attempts: number };
  /** llm_request 子字段变更 */
  onLlmRequestChange: (key: 'stall_tool_s' | 'max_attempts', value: number) => void;
}

/** 模型 tab 第二+第三 group（playground 默认模型 + 请求设置） */
export function SectionDefaultModelsAndRequest({
  defaultModelsDraft,
  onDefaultModelsChange,
  llmRequestDraft,
  onLlmRequestChange,
}: SectionDefaultModelsAndRequestProps) {
  const { t } = useTranslation('app-dev-config');
  return (
    <>
      <DefaultModelsGroup
        draft={defaultModelsDraft}
        onChange={onDefaultModelsChange}
        t={t}
      />
      <RequestSettingsGroup
        draft={llmRequestDraft}
        onChange={onLlmRequestChange}
        t={t}
      />
    </>
  );
}

/** playground 默认模型 group（chat 行复用 chat/ModelPicker + 外层 x 清除；v0.0.158 起 summary 列已删） */
function DefaultModelsGroup({
  draft,
  onChange,
  t,
}: {
  draft: DefaultModelsData;
  onChange: (key: 'chat', value: string | undefined) => void;
  t: (k: string) => string;
}) {
  return (
    <div className="mt-8">
      <h3 className="text-[15px] font-semibold text-fg mb-3">{t('group.default_models.label')}</h3>
      <div className="flex flex-col">
        <ModelKeyRow
          keyName="chat"
          label={t('schema.default_models.chat.label')}
          desc={t('schema.default_models.chat.desc')}
          value={draft.chat}
          onChange={(v) => onChange('chat', v)}
        />
      </div>
    </div>
  );
}

/** 单个 model key 行（label + 说明 + ModelPicker 复用 + 外层 x 清除） */
function ModelKeyRow({
  keyName,
  label,
  desc,
  value,
  onChange,
}: {
  keyName: 'chat';
  label: string;
  desc: string;
  value?: string;
  onChange: (v: string | undefined) => void;
}) {
  const { t } = useTranslation('app-dev-config');
  // 外层自拉一份 providers 做 value 反查适配（与 ModelPicker 内部同数据源；inFlight 并发去重合并请求）
  const { providers } = useProviders();
  // value 适配：default_models.chat 落盘 = 纯 modelId string，ModelPicker 收复合 ModelSelection。
  // 反查 providerId 组装复合；无值 / 反查不到（provider 被删/停用）→ null，组件显「选择 model」占位
  const providerId = value ? findProviderIdByModelId(providers, value) : null;
  const sel: ModelSelection | null = value && providerId ? { providerId, modelId: value } : null;
  const isEmpty = !value;
  return (
    <div

      className="border border-border rounded-lg py-[16px] px-[20px] mb-[8px] bg-surface-2 transition-colors hover:border-border-strong"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-fg">
            {label}
          </div>
          <div className="text-xs text-muted-2 mt-1.5 leading-relaxed">{desc}</div>
        </div>
        <div className="shrink-0 w-[280px]">
          <div className="flex items-center gap-2">
            {/* 复用 squad 管理同款 ModelPicker（无搜索、provider / model 风格）；
                onChange 适配：复合 ModelSelection → 只存 modelId（default_models.chat 落盘契约不变） */}
            <ModelPicker
              value={sel}
              onChange={(s) => onChange(s.modelId)}
              actionKey={`settings.default-models.select-${keyName}`}
            />
            {/* x 清除（组件外层包，ModelPicker 本体不动）：始终渲染固定占位，
                空态 visibility:hidden 不可见但占位 —— 布局稳定（组件规范 §11），禁条件渲染挤压 trigger */}
            <button
              type="button"
              data-action-key={`settings.default-models.clear-${keyName}`}
              aria-label={t('defaultModels.clear')}
              disabled={isEmpty}
              onClick={() => onChange(undefined)}
              className={
                'shrink-0 text-muted hover:text-fg text-sm px-1 ' +
                (isEmpty ? 'invisible' : '')
              }
            >
              ✕
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 请求设置 group（stall_tool_s + max_attempts number） */
function RequestSettingsGroup({
  draft,
  onChange,
  t,
}: {
  draft: { stall_tool_s: number; max_attempts: number };
  onChange: (key: 'stall_tool_s' | 'max_attempts', value: number) => void;
  t: (k: string) => string;
}) {
  return (
    <div className="mt-8">
      <h3 className="text-[15px] font-semibold text-fg mb-3">{t('group.llm_request.label')}</h3>
      <div className="flex flex-col">
        <NumberKeyRow
          keyName="stall_tool_s"
          label={t('schema.llm_request.stall_tool_s.label')}
          desc={t('schema.llm_request.stall_tool_s.desc')}
          unit={t('defaultModels.unitSeconds')}
          value={draft.stall_tool_s}
          defaultValue={DEFAULT_LLM_REQUEST_SUBFIELDS.stall_tool_s}
          onChange={(v) => onChange('stall_tool_s', v)}
        />
        <NumberKeyRow
          keyName="max_attempts"
          label={t('schema.llm_request.max_attempts.label')}
          desc={t('schema.llm_request.max_attempts.desc')}
          unit={t('defaultModels.unitTimes')}
          value={draft.max_attempts}
          defaultValue={DEFAULT_LLM_REQUEST_SUBFIELDS.max_attempts}
          onChange={(v) => onChange('max_attempts', v)}
        />
      </div>
    </div>
  );
}

/** 单个 number key 行（容器 testid=key-number-{key}，内含 input） */
function NumberKeyRow({
  keyName,
  label,
  desc,
  unit,
  value,
  defaultValue,
  onChange,
}: {
  keyName: string;
  label: string;
  desc: string;
  unit: string;
  value: number;
  defaultValue: number;
  onChange: (v: number) => void;
}) {
  const isDefault = value === defaultValue;
  return (
    <div
      className="border border-border rounded-lg py-[16px] px-[20px] mb-[8px] bg-surface-2 transition-colors hover:border-border-strong"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <div className="text-[13px] font-semibold text-fg">{label}</div>
          <div className="text-xs text-muted-2 mt-1.5 leading-relaxed">{desc}</div>
        </div>
        <div className="shrink-0 w-[280px]">
          {/* 容器 testid=key-number-{key}（ET 锚点），内含 input（ET focus 锚点：key-number-{key} input） */}
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
            <span className="text-xs text-muted-2 shrink-0">{unit}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default SectionDefaultModelsAndRequest;
