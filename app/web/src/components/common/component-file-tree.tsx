/**
 * component-file-tree — 通用递归文件树视图（dir 折叠 + file 选中）
 * 参考: specs/ui/components/common/component-file-tree.md
 *       视觉基线源: reqs/v0.0.21/easy-opc-skill-v10.html .pv-item/.pv-twisty/.pv-ico/.pv-name (:106-126)
 *
 * 纯结构组件：只渲染树、不含任何 i18n 文案、不持状态（expanded/selPath 由调用方持有）。
 * 复用方：skill 管理页预览弹层（component-skill-preview-modal）+ academy skill browser
 *   （component-skill-browser-modal）——两处树视觉一致，故提到 common/。
 */
import type { SkillFileTreeNode } from './file-tree';

interface Props {
  /** 顶层节点数组（一般传 buildFileTree(...).children） */
  nodes: SkillFileTreeNode[];
  /** dir 展开态（path → true） */
  expanded: Record<string, boolean>;
  /** 当前选中的 file path */
  selPath: string | null;
  /** 点 dir → 切换展开 */
  onToggleExpand: (path: string) => void;
  /** 点 file → 选中 */
  onSelect: (path: string) => void;
}

/** 递归文件树（顶层入口；每个节点由 FileTreeNodeView 渲染） */
export function ComponentFileTree({ nodes, expanded, selPath, onToggleExpand, onSelect }: Props) {
  return (
    <>
      {nodes.map((node) => (
        <FileTreeNodeView
          key={node.path}
          node={node}
          depth={0}
          expanded={expanded}
          selPath={selPath}
          onToggleExpand={onToggleExpand}
          onSelect={onSelect}
        />
      ))}
    </>
  );
}

/**
 * 文件树递归节点。
 * dir：twisty（chevron 旋转）+ folder/folderOpen 图标 + name，点 → toggle 展开。
 * file：file 图标 + name，点 → onSelect(path)；active 高亮。
 */
interface FileTreeNodeViewProps {
  node: SkillFileTreeNode;
  depth: number;
  expanded: Record<string, boolean>;
  selPath: string | null;
  onToggleExpand: (path: string) => void;
  onSelect: (path: string) => void;
}

function FileTreeNodeView({
  node,
  depth,
  expanded,
  selPath,
  onToggleExpand,
  onSelect,
}: FileTreeNodeViewProps) {
  const isDir = node.type === 'dir';
  const isOpen = !!expanded[node.path];
  const isActive = !isDir && selPath === node.path;
  // 缩进：dir paddingLeft = 6 + depth*14；file 多缩 14（设计稿 :529, :542）
  const padLeft = (isDir ? 6 : 6 + 14) + depth * 14;

  return (
    <div>
      <div
        role={isDir ? 'treeitem' : 'button'}
        aria-expanded={isDir ? isOpen : undefined}
        onClick={() => (isDir ? onToggleExpand(node.path) : onSelect(node.path))}
        className={
          'flex items-center gap-[5px] h-[26px] pr-2 rounded-md cursor-pointer ' +
          (isActive ? 'bg-accent-surface' : 'hover:bg-bg-warm')
        }
        style={{ paddingLeft: padLeft }}
      >
        {/* twisty（仅 dir 显示；file 留空占位对齐） */}
        {isDir ? (
          <span
            className={
              'w-[14px] h-[14px] flex items-center justify-center text-muted shrink-0 transition-transform ' +
              (isOpen ? 'rotate-90' : '')
            }
          >
            <ChevronMiniIcon />
          </span>
        ) : (
          <span className="w-[14px] h-[14px] shrink-0" aria-hidden />
        )}
        {/* 图标：dir gold（folder/folderOpen）/ file muted */}
        <span className={'inline-flex shrink-0 ' + (isDir ? 'text-gold' : 'text-muted')}>
          {isDir ? (isOpen ? <FolderOpenMiniIcon /> : <FolderMiniIcon />) : <FileMiniIcon />}
        </span>
        {/* name：active 时 accent */}
        <span
          className={
            'text-[12.5px] whitespace-nowrap overflow-hidden text-ellipsis ' +
            (isActive ? 'text-accent' : 'text-fg-2')
          }
        >
          {node.name}
        </span>
      </div>
      {/* dir 展开 → 递归渲染子节点 */}
      {isDir && isOpen &&
        node.children.map((child) => (
          <FileTreeNodeView
            key={child.path}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            selPath={selPath}
            onToggleExpand={onToggleExpand}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}

// —— 内联图标（树专用；skill 星形/关闭图标留在各自弹层） ——
function ChevronMiniIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}
function FolderMiniIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
    </svg>
  );
}
function FolderOpenMiniIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v1H3z" />
      <path d="M3 11h19l-2 7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}
function FileMiniIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

export default ComponentFileTree;
