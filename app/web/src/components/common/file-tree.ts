/**
 * file-tree — 通用文件树纯函数（扁平数组 → 嵌套树 + 首文件 + dir 全展开）
 * 参考: specs/api/overall/06-skill.md §6.2（SkillFileNode 扁平数组，path 相对根目录）
 *       specs/ui/components/common/component-file-tree.md
 *
 * 后端返回的文件树一律是**扁平数组**（每项含相对 path），前端需转成嵌套树递归渲染。
 * 复用方：skill 管理页预览弹层（GET /skill/:name/tree）+ academy skill browser
 *   （版本内容 content.skills[].files）——两处入参形状一致，故树逻辑提到 common/。
 */

/**
 * 扁平文件节点入参（结构性契约）。
 * 与 `lib/api-client SkillFileNode`（06-skill §6.2）及 academy 的
 * `AcademySkillFileNode`（多一个 hash 字段）结构兼容，故 common 层不绑定具体域类型。
 */
export interface FlatFileNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
}

/**
 * 嵌套文件树节点（前端渲染用，由扁平 FlatFileNode[] 转换而来）。
 */
export interface SkillFileTreeNode {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  /** dir 的子节点（已按 dir-在前/file-在后 + 字母序排好） */
  children: SkillFileTreeNode[];
}

/**
 * 把扁平文件节点数组转成嵌套树（前端递归渲染用）。
 *
 * 算法：按 path 拆段建 Trie；同层先 dir 后 file，各自字母序。
 * 空数组 / 根目录缺省 → 返回空 children 的虚拟根。
 *
 * @param flat 扁平文件节点数组（每项 path 相对根目录）
 * @returns 嵌套树根（name='' path='' type='dir'）
 */
export function buildFileTree(flat: FlatFileNode[]): SkillFileTreeNode {
  const root: SkillFileTreeNode = { name: '', path: '', type: 'dir', children: [] };
  // path → 节点引用 map（含虚拟根）
  const dirMap = new Map<string, SkillFileTreeNode>([['', root]]);

  // 先按 path 排序，保证父目录先于子路径创建（API 可能乱序）
  const sorted = [...flat].sort((a, b) => a.path.localeCompare(b.path));

  for (const node of sorted) {
    const parentPath = node.path.includes('/')
      ? node.path.slice(0, node.path.lastIndexOf('/'))
      : '';
    const parent = dirMap.get(parentPath) ?? root;
    const treeNode: SkillFileTreeNode = {
      name: node.name,
      path: node.path,
      type: node.type,
      size: node.size,
      children: [],
    };
    parent.children.push(treeNode);
    if (node.type === 'dir') dirMap.set(node.path, treeNode);
  }

  // 同层排序：dir 在前、file 在后；各自按 name 字母序（不区分大小写）
  const sortRec = (n: SkillFileTreeNode) => {
    n.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    n.children.forEach(sortRec);
  };
  sortRec(root);
  return root;
}

/**
 * 深度优先查找树中第一个 file 节点的 path（弹层默认选中项）。无文件 → null。
 */
export function findFirstFilePath(node: SkillFileTreeNode): string | null {
  for (const child of node.children) {
    if (child.type === 'file') return child.path;
    const found = findFirstFilePath(child);
    if (found) return found;
  }
  return null;
}

/**
 * 收集树中所有 dir 的 path（弹层默认全展开的初始 expanded map）。
 */
export function collectDirPaths(
  node: SkillFileTreeNode,
  acc: Record<string, boolean> = {},
): Record<string, boolean> {
  for (const child of node.children) {
    if (child.type === 'dir') {
      acc[child.path] = true;
      collectDirPaths(child, acc);
    }
  }
  return acc;
}
