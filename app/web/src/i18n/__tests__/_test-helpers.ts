/**
 * i18n 测试公共 helper（仅测试用，不打包到生产）
 * 参考: specs/tech/i18n/[P0]i18n_overview.md §4.1（bundle 物理结构）
 *
 * 用途：消除 collectLeaves 在 chat/providers/studio-ns.test.ts 与 keys-aligned.test.ts
 *       4 处的重复（T4 reviewer 备注）。
 */
import { i18n } from '../index';

/**
 * 把 bundle 对象的叶子 key 路径扁平化为 dot.notation 字符串集合。
 * 例如 `{ a: { b: 1 } }` → `Set(['a.b'])`。
 * 仅收集叶子（string / number / boolean），不收集中间对象路径。
 */
export function collectLeafKeys(obj: unknown, prefix = ''): Set<string> {
  const out = new Set<string>();
  if (obj === null || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object') {
      for (const key of collectLeafKeys(v, path)) out.add(key);
    } else {
      out.add(path);
    }
  }
  return out;
}

/**
 * 比较某 ns 的 zh-CN 与 en key 集合是否一致；返回 diff 描述（空字符串表示一致）。
 * 用于各 ns 结构单测 + keys-aligned 总览测试。
 */
export function diffNsKeys(ns: string): { onlyInZh: string[]; onlyInEn: string[] } {
  const zh = i18n.getResourceBundle('zh-CN', ns);
  const en = i18n.getResourceBundle('en', ns);
  const zhKeys = collectLeafKeys(zh);
  const enKeys = collectLeafKeys(en);
  return {
    onlyInZh: [...zhKeys].filter((k) => !enKeys.has(k)),
    onlyInEn: [...enKeys].filter((k) => !zhKeys.has(k)),
  };
}
