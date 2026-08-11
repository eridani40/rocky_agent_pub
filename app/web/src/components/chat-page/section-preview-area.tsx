/**
 * section-preview-area —— 预览区容器（v0.0.320 D3；[老板试玩] + [老板第三批] 收起/展开+删右条+悬浮按钮）
 * 参考: specs/tech/version_logs/v0.0.320/change_plan.md D3（预览区容器 + Provider 契约）
 *
 * [老板第三批反馈②] 正文区悬浮操作按钮（只读=编辑 / 编辑=保存+撤销+格式化+校验），
 *   hover 正文区时浮现（group/pv-content group-hover:opacity-100）。
 *
 * [老板第三批反馈③] 预览区左缘分隔条加收起/展开竖条手柄：
 *   - 展开态：手柄 → 点击收起（编辑态守卫：mode='edit' → 容器自管 dirty modal 确认后再收起）
 *   - 收起态：预览区完全隐藏（collapsed=true → previewWidth=0），窄竖条+手柄 ← 展开
 *   - collapsed per session localStorage 持久化（hook 层管理，openTab/activateTab 成功后自动展开）
 *
 * [老板第三批补充] collapsed 下移到 hook 层（use-preview-tabs），收起态打开/切换文件自动展开。
 *   容器从 context 消费 collapsed/setCollapsed（不再本地 state）。
 *
 * [老板第三批反馈④] 删除 pv-resize-right（与工作区手柄争同一条缝，导致拖拽 bug）。
 *   预览宽度只由左缘 pv-resize-left 控制。
 *
 * [v0.0.329 门模型] 三态渲染（center 双把手 / left 粗线+▶ / right 现状）。
 *   [补修] renderPanelBody/renderModals 抽公共（left/center 共用，消重复 + 降行数 ≤300）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { usePreviewArea } from './preview-area-context';
import { ComponentPreviewTabBar } from './component-preview-tab-bar';
import { ComponentPreviewViewer } from './component-preview-viewer';
import { ComponentPreviewEditor, type PreviewEditorHandle } from './component-preview-editor';
import { ComponentPreviewFloatingActions } from './component-preview-floating-actions';
import { ComponentPreviewDirtyModal } from './component-preview-dirty-modal';
import { ComponentPreviewConflictModal } from './component-preview-conflict-modal';
import { ComponentColResizeHandle } from './component-col-resize-handle';
import { ComponentPreviewCollapseToggle } from './component-preview-collapse-toggle';
import { getCategory } from '../../lib/file-format';
import { openWorkspaceItem } from '../../lib/chat-api';
import {
  PV_WIDTH_DEFAULT,
  PV_WIDTH_MIN,
  PV_WIDTH_MAX,
} from '../../lib/layout-width-engine';
import { readColWidth, writeColWidth } from '../common/use-persistent-width';
import { BTN_SECONDARY } from '../academy-page/academy-styles';

interface SectionPreviewAreaProps {
  sessionId: string;
  renderWidth?: number;
  dragMaxWidth?: number;
  onLayoutChange?: (report: { settingWidth: number; collapsed: boolean }) => void;
  onDragModeChange?: (dragging: boolean) => void;
}

/** localStorage key 工厂（per session） */
export function pvLsKey(sid: string, kind: 'width' | 'collapsed'): string {
  return `pv-${kind}-${sid}`;
}

export function readPvWidth(sid: string): number {
  return readColWidth(pvLsKey(sid, 'width'), PV_WIDTH_DEFAULT, PV_WIDTH_MIN, PV_WIDTH_MAX);
}
export function writePvWidth(sid: string, v: number): void {
  writeColWidth(pvLsKey(sid, 'width'), v);
}

/**
 * 预览区容器。width per session localStorage。
 * [老板第三批补充] collapsed 从 context 消费（hook 层管理，openTab/activateTab 自动展开）。
 * [v0.0.329 门模型] door 从 context 消费，三态渲染（center/left/right）。
 */
export function SectionPreviewArea({
  sessionId, renderWidth, dragMaxWidth, onLayoutChange, onDragModeChange,
}: SectionPreviewAreaProps) {
  const [width, setWidth] = useState<number>(() => readPvWidth(sessionId));
  const editorRef = useRef<PreviewEditorHandle>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  // 收起守卫：容器自管 dirty modal（编辑态点收起 → 确认后再收起）
  const [collapseGuard, setCollapseGuard] = useState(false);

  const preview = usePreviewArea();

  // collapsed 从 context 消费（hook 层管理 + localStorage 持久化）
  const collapsed = preview?.collapsed ?? false;
  // [v0.0.329 门模型] 门三态（缺 Provider/tabs 时缺省 center）
  const door = preview?.door ?? 'center';
  // 引擎 preview 槽真实显隐：door=right（preview 被遮）→ 上报 collapsed=true（宽 0 两侧回收）；
  //   door=left/center → preview 显示，上报 collapsed=false（left 态 preview 吞并门框由引擎 chatCollapsed 决定）
  const previewHidden = door === 'right';

  useEffect(() => {
    onLayoutChange?.({ settingWidth: width, collapsed: previewHidden });
  }, [width, previewHidden, onLayoutChange]);

  // 收起/展开切换（走 hook 层 setCollapsed，含 localStorage 持久化）
  const toggleCollapsed = useCallback(() => {
    preview?.setCollapsed(!collapsed);
  }, [preview, collapsed]);

  // 收起守卫确认回调（容器自管 dirty modal）
  const handleCollapseGuardResolve = useCallback(
    async (action: 'save-switch' | 'discard' | 'cancel') => {
      if (!preview || !collapseGuard || !preview.activeTabId) {
        setCollapseGuard(false);
        return;
      }
      if (action === 'cancel') {
        setCollapseGuard(false);
        return;
      }
      const tabId = preview.activeTabId;
      setCollapseGuard(false);
      if (action === 'discard') {
        // 放弃修改 → 回 view + draft 重置为 content
        const tab = preview.tabs.find((t) => t.id === tabId);
        if (tab) {
          preview.setDraft(tabId, tab.content);
          preview.setMode(tabId, 'view');
        }
        preview.setCollapsed(true);
      } else {
        // save-switch：保存成功才收起
        setEditorSaving(true);
        try {
          await preview.saveTab(tabId);
          preview.setCollapsed(true);
        } catch {
          setCollapseGuard(true);
        } finally {
          setEditorSaving(false);
        }
      }
    },
    [preview, collapseGuard],
  );

  // 收起入口：编辑态 → 弹守卫 modal；非编辑态 → 直接收起
  const handleCollapseClick = useCallback(() => {
    const cur = preview?.tabs.find((t) => t.id === preview.activeTabId);
    if (cur?.mode === 'edit') {
      setCollapseGuard(true);
    } else {
      toggleCollapsed();
    }
  }, [preview, toggleCollapsed]);

  if (!preview) return null;

  const { tabs, activeTabId, dirtyPending, conflictPending, closeTab, activateTab, saveTab, resolveDirty, resolveConflict, setDraft, setMode, retryLoad } = preview;

  if (tabs.length === 0) return null;

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // ── [v0.0.329 补修] 公共渲染：TabBar + 内容区（left/center 共用，DOM 结构零变化） ──
  const renderPanelBody = () => (
    <>
      <ComponentPreviewTabBar tabs={tabs} activeTabId={activeTabId} onActivate={activateTab} onClose={closeTab} />
      {/* 内容区 + 悬浮按钮 */}
      <div className="pv-content group/pv-content flex-1 min-h-0 flex flex-col relative">
        {!activeTab ? (
          <div data-testid="pv-empty" className="flex-1 flex items-center justify-center text-[12.5px] text-muted" />
        ) : activeTab.loadState === 'loading' ? (
          <div data-testid="pv-loading" className="flex-1 flex items-center justify-center">
            <span className="inline-block w-[14px] h-[14px] border-2 border-border-strong border-t-accent rounded-full animate-spin" />
          </div>
        ) : activeTab.loadState === 'error' ? (
          <div data-testid="pv-error" className="flex-1 flex flex-col items-center justify-center gap-2 text-[12.5px] text-muted">
            <span>{activeTab.errorMsg ?? '打开失败'}</span>
            <button type="button" data-testid="pv-error-retry" onClick={() => retryLoad(activeTab.id)} className={BTN_SECONDARY + ' px-2.5 py-1 text-[12px]'}>
              重试
            </button>
          </div>
        ) : activeTab.mode === 'edit' ? (
          <ComponentPreviewEditor
            ref={editorRef}
            tab={activeTab}
            onSave={async () => { setEditorSaving(true); try { await saveTab(activeTab.id); } finally { setEditorSaving(false); } }}
            onCancel={() => setMode(activeTab.id, 'view')}
            onDraftChange={(draft) => setDraft(activeTab.id, draft)}
          />
        ) : (
          <ComponentPreviewViewer tab={activeTab} sessionId={sessionId} />
        )}
        {/* [老板第三批②] 正文区悬浮操作按钮 */}
        {activeTab && activeTab.loadState === 'loaded' && (
          <ComponentPreviewFloatingActions
            mode={activeTab.mode}
            saving={editorSaving}
            isStructured={getCategory(activeTab.format) === 'structured'}
            isHtml={activeTab.format === 'code' && /\.(html?|htm)$/i.test(activeTab.path)}
            onEdit={() => setMode(activeTab.id, 'edit')}
            onSave={() => editorRef.current?.save()}
            onUndo={() => setMode(activeTab.id, 'view')}
            onFormat={() => editorRef.current?.format()}
            onValidate={() => editorRef.current?.validate()}
            onOpenInBrowser={() => {
              if (activeTab.source === 'workspace') {
                openWorkspaceItem(sessionId, { path: activeTab.path, kind: 'file' })
                  .catch((e) => console.warn('openWorkspaceItem failed:', e));
              } else if (typeof window !== 'undefined' && window.rockyShell) {
                window.rockyShell.openPath(activeTab.path)
                  .catch((e) => console.warn('openPath failed:', e));
              }
            }}
          />
        )}
      </div>
    </>
  );

  // ── [v0.0.329 补修] 公共渲染：dirty/conflict modal（left/center 共用；collapseGuard 仅 center 独有） ──
  const renderModals = () => (
    <>
      {/* dirty 守卫 modal（tab 切换/关闭/打开触发——走状态机 resolveDirty） */}
      {dirtyPending && (
        <ComponentPreviewDirtyModal
          fileName={tabs.find((x) => x.id === dirtyPending.tabId)?.fileName ?? ''}
          onResolve={resolveDirty}
        />
      )}
      {/* 409 冲突 modal */}
      {conflictPending && (
        <ComponentPreviewConflictModal
          fileName={tabs.find((x) => x.id === conflictPending.tabId)?.fileName ?? ''}
          onResolve={resolveConflict}
        />
      )}
    </>
  );

  // ── 门滑最右（遮3露2，door=right）：= 现状 collapsed 路径原样，右缘粗线 + ◀贴左 → 回居中 ──
  if (door === 'right') {
    return <ComponentPreviewCollapseToggle collapsed={true} onToggle={toggleCollapsed} />;
  }

  // ── 门滑最左（遮2露3，door=left）：preview 占满门框，aside 左缘贴门框左缘（chat 槽被顶层隐藏）。
  //   门框左缘粗线 rail（pv-collapsed-rail 形态零改，仅摆放左缘）+ ▶贴粗线右 → 回居中。
  //   无 resizer：门滑到边后不可拖拽调宽（PRD §13，与 right 态 collapsed 行为一致）。 ──
  if (door === 'left') {
    return (
      <>
        {/* 门框左缘粗线 rail + ▶贴粗线右（rail 形态零改，direction='right' 仅覆盖 chevron 方向与贴线侧） */}
        <ComponentPreviewCollapseToggle collapsed={true} onToggle={() => preview.setDoor('center')} direction="right" tooltipKey="workspace.preview.doorCenter" testid="pv-door-center" />
        <aside
          data-testid="pv-panel"
          style={{ width: renderWidth ?? width }}
          className="pv-panel shrink-0 bg-surface flex flex-col relative min-w-0"
        >
          {renderPanelBody()}
        </aside>
        {renderModals()}
      </>
    );
  }

  // ── 门居中（默认，door=center）：2/3 共存，细线（门=aside 左缘 border-l + pv-resize-left）左贴 ◀、右贴 ▶ 双把手 ──
  return (
    <>
      <aside
        data-testid="pv-panel"
        style={{ width: renderWidth ?? width }}
        className="pv-panel shrink-0 bg-surface border-l border-border flex flex-col relative min-w-0"
      >
        {/* 左分隔条：side='right'（拖左→预览变宽），posSide='left'（细线形态/拖拽零改） */}
        <ComponentColResizeHandle
          testid="pv-resize-left"
          side="right"
          posSide="left"
          currentWidth={renderWidth ?? width}
          minWidth={PV_WIDTH_MIN}
          maxWidth={Math.min(PV_WIDTH_MAX, dragMaxWidth ?? PV_WIDTH_MAX)}
          onResize={setWidth}
          onDragStart={() => onDragModeChange?.(true)}
          onResizeEnd={() => { writePvWidth(sessionId, width); onDragModeChange?.(false); }}
        />
        {/* 左把手 ◀ 贴细线左侧（direction='left' → chevron ◀ + -left-[7px] 骑线左凸）：门滑最左（遮 chat） */}
        <ComponentPreviewCollapseToggle collapsed={false} onToggle={() => preview.setDoor('left')} floating={true} direction="left" tooltipKey="workspace.preview.doorLeft" testid="pv-door-left" />
        {/* 右把手 ▶ 贴细线右侧（direction='right' → chevron ▶ + left-0 贴线右）：门滑最右（遮 preview），走 edit 态守卫 */}
        <ComponentPreviewCollapseToggle collapsed={false} onToggle={handleCollapseClick} floating={true} direction="right" tooltipKey="workspace.preview.doorRight" testid="pv-door-right" />
        {renderPanelBody()}
      </aside>
      {renderModals()}
      {/* [老板第三批③] 收起守卫 modal（容器自管——编辑态点收起触发，仅 center 态有收起把手） */}
      {collapseGuard && activeTab && (
        <ComponentPreviewDirtyModal
          fileName={activeTab.fileName}
          onResolve={handleCollapseGuardResolve}
        />
      )}
    </>
  );
}

export default SectionPreviewArea;
