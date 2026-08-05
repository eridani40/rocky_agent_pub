/**
 * section-version-chat —— 学生版本会话页（复用 playground-rocky 设计，design §8.3）
 * 参考: specs/ui/components/academy-page/section-version-chat.md
 *       specs/ui/components/academy-page/_overview.md §2（可拖宽列约定）
 *       demo 10-version-chat.html（conv-panel 220 + chat-col + ws-panel 300 + float-menu）
 *
 * 复用声明（MANDATORY）：chat 内核全部来自 chat-page（SectionChatSession 统一装配层：
 *   minimap/usage/float-menu/HITL/picker 全内置，按 chrome capabilities 门控）；academy 侧仅提供
 *   会话列表（GET /session?biz=academy 按 academyVersionId 过滤）+ 新建会话
 *   （POST version/:vid/session）+ academy-student tag。不发明新结构。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { startVersionSession } from '../../lib/academy-api';
import type { Session } from '../chat-page/types';
import { SectionChatSession } from '../chat-page/section-chat-session';
import { ComponentAcademyChatHeader } from './component-academy-chat-header';
import { ComponentColResizeHandle } from '../chat-page/component-col-resize-handle';
import { SectionWorkspacePanel } from '../chat-page/section-workspace-panel';
import { ACADEMY_COL } from './academy-col-widths';
import { usePersistentWidth } from '../common/use-persistent-width';
import { ICON_BTN } from './academy-styles';

interface Props {
  classroomId: string;
  studentId: string;
  versionId: string;
  /** 版本号（tag / placeholder 文案用，如 'v2.0'） */
  versionLabel: string;
  studentName: string;
  /** 该版本的会话列表（父级按 academyVersionId 过滤好） */
  sessions: Session[];
  /** 当前选中会话 id（route 驱动；缺省 = 列表首个） */
  sessionId?: string;
  onSelectSession: (sessionId: string) => void;
  /** 新建会话成功（父级刷新列表 + 选中） */
  onSessionCreated: (sessionId: string) => void;
  onBack: () => void;
}

/** 版本会话页（conv-panel + chat-col + ws-panel） */
export function SectionVersionChat({
  classroomId, studentId, versionId, versionLabel, studentName, sessions, sessionId, onSelectSession, onSessionCreated, onBack,
}: Props) {
  const { t } = useTranslation('academy');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // conv-panel 列宽（可拖 180~400，默认 240；persist localStorage academy-version-conv-width）
  const convCol = usePersistentWidth(ACADEMY_COL.versionConv);

  const activeSessionId = sessionId ?? sessions[0]?.id;

  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    setCreateError(null);
    try {
      const r = await startVersionSession(classroomId, studentId, versionId);
      onSessionCreated(r.sessionId);
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : t('versionChat.startFail'));
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden">
      {/* conv-panel：conv-head（学生名 + ＋）+ conv-list（该版本会话）+ 右缘拖宽手柄。
          relative 供 absolute 手柄定位；宽度受控（style width） */}
      <div
        style={{ width: convCol.width }}
        className="relative flex-shrink-0 flex flex-col border-r border-border bg-surface overflow-hidden"
      >
        <div className="flex items-center justify-between px-[14px] pt-[14px] pb-2.5 shrink-0">
          <span className="text-[13px] font-semibold text-fg truncate">{studentName} {versionLabel}</span>
          <button
            type="button"
            title={t('versionChat.newSession')}
            aria-label={t('versionChat.newSession')}
            disabled={creating}
            onClick={() => void handleCreate()}
            className={ICON_BTN}
          >
            ＋
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pb-3">
          {createError && <div className="px-2 pb-2 text-[11px] text-danger">{createError}</div>}
          {sessions.length === 0 && <div className="px-2 py-6 text-center text-[11.5px] text-muted">{t('versionChat.empty')}</div>}
          {sessions.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onSelectSession(s.id)}
              aria-current={s.id === activeSessionId ? 'page' : undefined}
              className={
                'w-full text-left px-2.5 py-2 rounded-lg cursor-pointer transition-colors ' +
                (s.id === activeSessionId ? 'bg-accent-light' : 'hover:bg-accent-light')
              }
            >
              <div className="text-[13px] font-medium text-fg truncate">{s.title}</div>
              <div className="text-[11px] text-muted truncate">{new Date(s.updatedAt).toLocaleString()}</div>
            </button>
          ))}
        </div>
        <ComponentColResizeHandle
          side="left"
          currentWidth={convCol.width}
          minWidth={convCol.minWidth}
          maxWidth={convCol.maxWidth}
          onResize={convCol.onResize}
          onResizeEnd={convCol.onResizeEnd}
          ariaLabel={t('resize.ariaLabel')}
          title={t('resize.title')}
        />
      </div>

      {/* chat-col（有选中会话才渲；内部 chrome 门控） */}
      {activeSessionId ? (
        <VersionChatLoaded
          sessionId={activeSessionId}
          versionLabel={versionLabel}
          studentName={studentName}
          placeholder={t('versionChat.placeholder', { name: studentName, label: versionLabel })}
        />
      ) : (
        <div className="flex-1 flex items-center justify-center text-[12.5px] text-muted bg-bg">{t('versionChat.empty')}</div>
      )}
    </div>
  );
}

/** 选中会话后的 chat-col + ws-panel（chat 能力全内置于 SectionChatSession；风险2：父级不回收 messages） */
function VersionChatLoaded({ sessionId, versionLabel, studentName, placeholder }: {
  sessionId: string; versionLabel: string; studentName: string; placeholder: string;
}) {
  const { t } = useTranslation('academy');

  return (
    <>
      {/* chat 列包装：水平 flex（非 flex-col）+ min-h-0 overflow-hidden——BaseChatPage 按 row
          子项 stretch 设计，垫 flex-col 会 min-height:auto 撑高致消息流失去滚动（_overview §2） */}
      <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden relative bg-bg">
        <SectionChatSession
          sessionId={sessionId}
          topbarLeft={() => (
            <ComponentAcademyChatHeader
              avatarText={studentName.slice(0, 1)}
              avatarBg="linear-gradient(135deg,#ec4899,#f97316)"
              title={`${studentName} · ${versionLabel}`}
              tag={t('versionChat.kindTag')}
            />
          )}
          placeholder={placeholder}
        />
      </div>
      {/* ws-panel 300px（demo 右栏工作区；复用 chat-page section-workspace-panel） */}
      <SectionWorkspacePanel sessionId={sessionId} />
    </>
  );
}

export default SectionVersionChat;
