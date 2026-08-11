/**
 * component-preview-viewer —— 预览区 view 模式（内嵌非弹层）（v0.0.320 D6；[老板第三批] 删顶栏文件名行）
 * 参考: specs/tech/version_logs/v0.0.320/change_plan.md D6（viewer 契约）
 *
 * view 分流（复用 component-modal-md-editor 同款逻辑但非弹层内嵌渲染）：
 *   - category 'md' → PrimitiveMarkdownView（baseDir 派生 resolve relative 图片）
 *   - 'structured'/'plain'/'code' → <pre> 朴素渲染（无高亮无行号）
 *
 * [老板第三批反馈①] 删除顶部「文件路径 + 编辑按钮」整行——文件名高亮由激活 tab 承担，
 *   编辑入口迁移到正文区悬浮按钮（component-preview-floating-actions）。
 *
 * 约束（D6 MUST）：code 分类 = plain 行为（pre 渲染 + 无格式/校验按钮）。
 */
import type { PreviewTab } from './preview-tabs-types';
import { getCategory } from '../../lib/file-format';
import { PrimitiveMarkdownView } from '../common/primitive-markdown-view';
import { deriveBaseDir } from '../common/primitive-markdown-image';

interface ComponentPreviewViewerProps {
  tab: PreviewTab;
  /** 当前 session（md relative 图片 HTTP 读用） */
  sessionId: string;
}

/**
 * 预览区 view 模式。非弹层内嵌渲染（与 modal-md-editor 分流逻辑一致，但不走 Portal）。
 * loading/error 态由容器（section-preview-area）处理，本组件只渲染 loaded 内容。
 * [老板第三批反馈①] 顶部文件名+编辑按钮行删除；编辑入口 → 悬浮按钮。
 */
export function ComponentPreviewViewer({ tab, sessionId }: ComponentPreviewViewerProps) {
  const category = getCategory(tab.format);

  return (
    <div className="pv-viewer flex flex-col min-h-0 flex-1" data-testid="pv-viewer">
      {/* 内容区：md → PrimitiveMarkdownView；structured/plain/code → <pre> 朴素渲染 */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {category === 'md' ? (
          <div className="px-4 py-3 text-[13.5px] leading-[1.75] text-fg">
            <PrimitiveMarkdownView source={tab.content} baseDir={deriveBaseDir(tab.path)} sessionId={sessionId} />
          </div>
        ) : (
          <pre className="px-4 py-3 font-mono text-[13px] leading-[1.7] text-fg whitespace-pre-wrap break-words">
            {tab.content}
          </pre>
        )}
      </div>
    </div>
  );
}

export default ComponentPreviewViewer;
