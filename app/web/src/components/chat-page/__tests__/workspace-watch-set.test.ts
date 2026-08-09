/**
 * workspace-watch-set 纯函数单测（v0.0.271 T1）
 * 参考: specs/tech/version_logs/v0.0.271/change_plan.md（裁决 R1：前端算完整集合推送）
 *       PRD §7 验收口径（关注集合 = 根 + 根一级 + 打开节点自身 + 一级子文件夹）
 *
 * 纯函数直测零 mock。覆盖 8 条用户路径的集合语义：
 *   1. 空 expanded → {根}
 *   2. rootTree 到后 → {根, 根一级子文件夹}
 *   3. 展开节点 → +{节点自身, 其一级子文件夹}
 *   4. childrenCache 未到 → 只自身（保守）
 *   5. childrenCache 到后 → +子一级（幂等）
 *   6. 路径去重
 *   7. 收起 → 移出（除非被其他 expanded 覆盖）
 *   8. 切目录 expanded 清空 → 只剩根 + 新根一级
 */
import { describe, it, expect } from 'vitest';
import { computeWatchSet, structuralRefetchTargets } from '../workspace-watch-set';
import type { WsTreeNode } from '../workspace-types';

const dir = (path: string, hasChildren = true): WsTreeNode => ({ name: path.split('/').pop() ?? path, path, type: 'dir', hasChildren });
const file = (path: string): WsTreeNode => ({ name: path.split('/').pop() ?? path, path, type: 'file', hasChildren: false });

describe('computeWatchSet', () => {
  it('空 expanded + 空 tree → 恒含根（空集合 → {根}）', () => {
    expect(computeWatchSet({ tree: [], expanded: {}, childrenCache: {} })).toEqual(['']);
  });

  it('rootTree 到后 → {根, 根一级子文件夹}（顶层 dir 节点全含，file 不含）', () => {
    const tree = [dir('src'), dir('docs'), file('readme.md')];
    expect(computeWatchSet({ tree, expanded: {}, childrenCache: {} })).toEqual(['', 'docs', 'src']);
  });

  it('展开节点 → +{节点自身, 其一级子文件夹}（childrenCache 筛 dir）', () => {
    const tree = [dir('src')];
    const expanded = { src: true };
    const childrenCache = { src: [dir('src/utils'), file('src/main.ts')] };
    expect(computeWatchSet({ tree, expanded, childrenCache })).toEqual(['', 'src', 'src/utils']);
  });

  it('childrenCache 未到 → 只 watch 自身（保守，不误伤）', () => {
    const tree = [dir('src')];
    const expanded = { src: true };
    // childrenCache 缺 src（GET 未完成）→ 集合只含自身
    expect(computeWatchSet({ tree, expanded, childrenCache: {} })).toEqual(['', 'src']);
  });

  it('childrenCache 到后 → 补子一级（两次 applyWatchSet 幂等：先自身后自身+子一级）', () => {
    const tree = [dir('src')];
    const expanded = { src: true };
    const before = computeWatchSet({ tree, expanded, childrenCache: {} });
    const after = computeWatchSet({ tree, expanded, childrenCache: { src: [dir('src/utils')] } });
    expect(before).toEqual(['', 'src']);
    expect(after).toEqual(['', 'src', 'src/utils']);
    // 幂等：同一输入再算结果相同
    expect(computeWatchSet({ tree, expanded, childrenCache: { src: [dir('src/utils')] } })).toEqual(after);
  });

  it('路径去重：展开节点自身与根一级重叠 → 只出现一次', () => {
    const tree = [dir('src')];
    // src 同时是根一级 + 展开节点 → 去重
    const expanded = { src: true };
    expect(computeWatchSet({ tree, expanded, childrenCache: { src: [dir('src/utils')] } })).toEqual(['', 'src', 'src/utils']);
  });

  it('收起 → 自身子一级移出，但父展开的一级子文件夹仍保留（覆盖语义）', () => {
    const tree = [dir('src')];
    // 展开 src + src/utils（嵌套）→ 全含
    const expandedBoth = { src: true, 'src/utils': true };
    const withBoth = computeWatchSet({ tree, expanded: expandedBoth, childrenCache: { src: [dir('src/utils')], 'src/utils': [dir('src/utils/lib')] } });
    expect(withBoth).toEqual(['', 'src', 'src/utils', 'src/utils/lib']);
    // 收起 src/utils（不再展开）→ 其子一级 src/utils/lib 移出；但 src/utils 自身仍作为「src 的一级子文件夹」保留（src 仍展开）
    const collapsedSub = computeWatchSet({ tree, expanded: { src: true }, childrenCache: { src: [dir('src/utils')], 'src/utils': [dir('src/utils/lib')] } });
    expect(collapsedSub).toEqual(['', 'src', 'src/utils']);
    // 收起 src（根一级）→ src 仍因根一级覆盖保留（R4 覆盖语义）；src/utils 不再是一级子文件夹（src 未展开）→ 移出
    const collapsedRoot = computeWatchSet({ tree, expanded: {}, childrenCache: { src: [dir('src/utils')] } });
    expect(collapsedRoot).toEqual(['', 'src']);
  });

  it('嵌套展开：父 + 子同时展开 → 子自身 + 子的一级也含（父的一级 = 子自身去重）', () => {
    const tree = [dir('src')];
    const expanded = { src: true, 'src/utils': true };
    const childrenCache = {
      src: [dir('src/utils'), file('src/main.ts')],
      'src/utils': [dir('src/utils/lib'), file('src/utils/helper.ts')],
    };
    expect(computeWatchSet({ tree, expanded, childrenCache })).toEqual(['', 'src', 'src/utils', 'src/utils/lib']);
  });

  it('切目录 expanded 清空 → 集合只剩根 + 新根一级（旧相对路径不进集合）', () => {
    // 旧目录展开过 src（childrenCache 残留模拟——实际切目录会清空，此处验证清空后集合）
    const tree = [dir('newroot')];
    const expanded = {}; // 切目录后 expanded 已清空
    const childrenCache = { src: [dir('src/utils')] }; // 残留缓存（实际也会清，验证即使残留也不进集合）
    expect(computeWatchSet({ tree, expanded, childrenCache })).toEqual(['', 'newroot']);
  });
});

describe('structuralRefetchTargets（v0.0.275 结构刷新 refetch 目标）', () => {
  it('根一级：P 为空串（顶层目录增删）→ refetch root tree（空串保留）', () => {
    expect(structuralRefetchTargets(new Set(['']))).toEqual(['']);
  });

  it('深层：P=t1 → refetch parentOf=t1 为空串（root tree）', () => {
    // t1 里建 t2 → P='t1' → refetch ''（root tree 刷新 t1 node.hasChildren）
    expect(structuralRefetchTargets(new Set(['t1']))).toEqual(['']);
  });

  it('深层：P="src/utils" → refetch parentOf="src"（src 的 children 层）', () => {
    // src/utils 里建 t3 → P='src/utils' → refetch 'src'（childrenCache['src'] 刷新 src/utils.hasChildren）
    expect(structuralRefetchTargets(new Set(['src/utils']))).toEqual(['src']);
  });

  it('同层去重：多个 P 同一 parentOf → 一次 refetch', () => {
    // P={'t1/a','t1/b'} → parentOf 都 't1' → 去重一次；P={'t2/a'} → 't2'
    const input = new Set(['t1/a', 't1/b', 't2/a']);
    expect(structuralRefetchTargets(input)).toEqual(['t1', 't2']);
  });

  it('排序：parentOf 字典序（可预测性）', () => {
    const input = new Set(['zzz/x', 'aaa/y', 'mmm/z']);
    expect(structuralRefetchTargets(input)).toEqual(['aaa', 'mmm', 'zzz']);
  });

  it('空集 → []', () => {
    expect(structuralRefetchTargets(new Set())).toEqual([]);
  });
});
