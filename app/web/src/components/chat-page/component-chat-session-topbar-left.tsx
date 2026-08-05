/**
 * component-chat-session-topbar-left —— 统一 chat 会话区缺省身份 header
 * 参考: specs/ui/components/chat-page/section-chat-session.md（topbarLeft 缺省渲染契约）
 *
 * 渲染：title(+tag) + readOnly 时 badge + model-tag。
 * titleOverride = 宿主注入实时标题（如 page-chat 用 store 列表标题保证 AI 自动命名
 * 即时可见——chrome 是 GET-once 快照，不订 SSE）。
 */
import { useTranslation } from 'react-i18next';
import type { SessionChromeView } from '../../lib/chat-api';
import { ComponentReadonlyBadge } from './component-readonly-badge';
import { useProviders, formatModelDisplay } from '../../lib/providers';

interface ChatSessionTopbarLeftProps {
  chrome: SessionChromeView;
  /** 实效只读（prop ∪ chrome.readOnly，由 SectionChatSession 算好传入）；缺省取 chrome.readOnly */
  readOnly?: boolean;
  /** 宿主注入实时标题（缺省用 chrome.title，空则 defaultTitle 占位） */
  titleOverride?: string;
}

/** 缺省身份 header：title(+tag) + readOnly 时 badge + model-tag（消费方可在 topbarLeft render-prop 内复用） */
export function ChatSessionTopbarLeft({
  chrome,
  readOnly = chrome.readOnly,
  titleOverride,
}: ChatSessionTopbarLeftProps) {
  const { t } = useTranslation('chat');
  const { providers } = useProviders();
  const modelTag = formatModelDisplay(chrome.sessionModel, providers);
  const modelTagTitle = chrome.sessionModel ? `${modelTag} · ${chrome.sessionModel.modelId}` : modelTag;
  return (
    <>
      <span className="text-[14px] font-semibold text-fg truncate">
        {titleOverride ?? (chrome.title || t('session.defaultTitle'))}
      </span>
      {chrome.tag && (
        <span className="rounded-xs bg-bg-warm px-2 py-0.5 font-mono text-[11px] text-muted">{chrome.tag}</span>
      )}
      {readOnly && <ComponentReadonlyBadge />}
      {readOnly && (
        <span
          title={modelTagTitle}
          className="text-[11px] text-muted font-mono bg-bg-warm px-2 py-0.5 rounded ml-2 max-w-[180px] whitespace-nowrap overflow-hidden text-ellipsis"
        >
          {modelTag}
        </span>
      )}
    </>
  );
}

export default ChatSessionTopbarLeft;
