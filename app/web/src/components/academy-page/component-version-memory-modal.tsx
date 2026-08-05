/**
 * component-version-memory-modal —— 版本 memory 只读弹层
 * 参考: specs/ui/components/chat-page/component-memory-modal.md（样式源——head + close + body 列表）
 *       specs/ui/overall/12-academy.md §4（学生详情 Memory 卡 → 本 modal）
 *
 * 与 chat-page ComponentMemoryModal 的区别：
 *   - **只读**——版本资产（.rocky/memory/*.md 摘要），不是 session 级 memory，无编辑/归档/新建。
 *   - 数据 = VersionContent.content.memory（MemoryEntrySummary[] = name/size/preview），
 *     由父（page-academy）从 versionContent 派生后下传，**不在本组件调 useMemoryCrud**（那是
 *     session 级读写，会错写 session 工作区）。
 * 样式对齐 chat-page memory modal：head（标题 + close）+ body 卡片列表（name mono + preview muted）。
 */
import { useTranslation } from 'react-i18next';
import { Portal } from '../../lib/portal';
import type { MemoryEntrySummary } from '../../lib/academy-api';
import { CARD } from './academy-styles';

export interface ComponentVersionMemoryModalProps {
  /** memory 条目（VersionContent.content.memory） */
  entries: MemoryEntrySummary[];
  /** 版本号（标题展示用，如「v1.0」） */
  versionLabel: string;
  /** 关闭弹层 */
  onClose: () => void;
}

/** 版本 memory 只读弹层 */
export function ComponentVersionMemoryModal({ entries, versionLabel, onClose }: ComponentVersionMemoryModalProps) {
  const { t } = useTranslation('academy');
  const { t: tCommon } = useTranslation('common');

  return (
    <Portal>
      {/* L3 modal：pointer-events-auto 显式声明（overlay-root 容器 pointer-events:none 可继承，漏写则整棵子树不接事件） */}
      <div
        className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[rgba(30,25,20,0.45)] backdrop-blur-sm pointer-events-auto"
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('versionMemory.title', { label: versionLabel })}
          onClick={(e) => e.stopPropagation()}
          className="flex max-h-[88vh] w-[520px] max-w-[92vw] flex-col rounded-[14px] border border-border-2 bg-surface shadow-2xl"
        >
          {/* head：标题 + close */}
          <div className="flex shrink-0 items-center gap-2 px-[22px] pt-[18px] pb-3">
            <span className="flex-1 text-[15px] font-bold text-fg">
              {t('versionMemory.title', { label: versionLabel })}
            </span>
            <button
              type="button"
              data-action-key="academy.memory.close"
              aria-label={tCommon('modal.close')}
              onClick={onClose}
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-bg-warm hover:text-fg"
            >
              ✕
            </button>
          </div>

          {/* body：memory 条目列表（只读） */}
          <div className="flex flex-col gap-2 overflow-y-auto px-[22px] pb-5">
            {entries.length === 0 ? (
              <div className="px-6 py-12 text-center text-muted">
                <div className="mb-1 text-[24px]" aria-hidden>🧠</div>
                <span className="text-[12px]">{t('tuple.memoryEmpty')}</span>
              </div>
            ) : (
              entries.map((entry) => (
                <div
                  key={entry.name}
                  data-testid="academy-version-memory-entry"
                  className={`${CARD} px-3.5 py-3 flex flex-col gap-1`}
                >
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[13px] font-semibold text-fg truncate">{entry.name}</span>
                    <span className="ml-auto shrink-0 font-mono text-[10.5px] text-muted">
                      {t('versionMemory.bytes', { size: entry.size })}
                    </span>
                  </div>
                  {entry.preview && (
                    <p className="m-0 font-mono text-[11.5px] leading-[1.5] text-muted-2 whitespace-pre-wrap break-words line-clamp-6">
                      {entry.preview}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}

export default ComponentVersionMemoryModal;
