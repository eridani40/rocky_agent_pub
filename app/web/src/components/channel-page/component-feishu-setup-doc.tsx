/**
 * component-feishu-setup-doc —— 飞书接入说明文档区（可折叠，默认收起）
 * 参考: specs/ui/components/channel-page/component-feishu-setup-doc.md
 *       specs/ui/components/_conventions.md §11（markdown 渲染区属自适应例外）
 *
 * 当渠道类型为 feishu 时在表单下方挂载。默认收起（只显示标题行），点击标题行
 * 切换展开/收起，展开后正文区 max-h-[300px] 内部独立滚动（避免与 modal 整体
 * overflow-y-auto 双层滚动嵌套）。文档 md 用 vite `?raw` import（packaged asar 可用）。
 *
 * 双语文案：标题/desc 走 i18n key（channel.setupDoc.*）；长文档正文走 md 内嵌双语
 * （中文在上、英文在下），不拆 i18n key（太碎）。展开/收起指示用纯 chevron 图标
 * （避免新增 i18n key——遵循 _conventions §8a「两语言都加」，纯图标则无需）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PrimitiveMarkdownView } from '../common/primitive-markdown-view';
// vite `?raw` import：把 md 当字符串读入（packaged asar 可用，避开 docs/ 不在 web root 的限制）
import feishuSetupDoc from './feishu-setup-doc.md?raw';

/** 展开/收起 chevron 图标（v 形向下；展开时 rotate-180 翻成 ^ 向上） */
function ChevronIcon({ size = 12, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/**
 * 渲染飞书接入说明文档区。
 * 默认收起；toggle 行点击切换 open 态。展开时正文区 max-h-[300px] + overflow-y-auto
 * 独立滚动，不与外层 modal 滚动嵌套。
 */
export function ComponentFeishuSetupDoc() {
  const { t } = useTranslation('channel');
  // 默认收起：避免一选中飞书就展开长文档挤压表单
  const [open, setOpen] = useState(false);

  return (
    <section

      aria-label={t('setupDoc.title')}
      className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-2 px-3 py-2.5"
    >
      {/* 标题行：整行点击切换展开/收起（role=button + aria-expanded 可访问性） */}
      <div
        data-action-key="channel.setup-doc.toggle-expand"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls="channel-feishu-setup-doc-body"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        className="flex items-center gap-1.5 cursor-pointer select-none text-fg hover:text-accent transition-colors"
      >
        <ChevronIcon
          size={12}
          className={'shrink-0 transition-transform ' + (open ? 'rotate-180' : '')}
        />
        <h3 className="text-[13px] font-semibold">{t('setupDoc.title')}</h3>
        <span className="text-[12px] text-muted font-mono truncate">{t('setupDoc.desc')}</span>
      </div>
      {/* 仅 open 时渲染正文区（收起时不挂载 DOM）；PrimitiveMarkdownView 内容自适应性已在 spec 声明 */}
      {open && (
        <div
          id="channel-feishu-setup-doc-body"

          className="max-h-[300px] overflow-y-auto rounded-md border border-border bg-surface px-3 py-2 text-[13px] text-fg-2"
        >
          <PrimitiveMarkdownView source={feishuSetupDoc} />
        </div>
      )}
    </section>
  );
}

export default ComponentFeishuSetupDoc;
