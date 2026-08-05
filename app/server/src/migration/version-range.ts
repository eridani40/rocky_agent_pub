/**
 * semver range 比较（极简版）—— 仅支持 `<X.Y.Z` 前缀形式。
 * 参考: specs/tech/version_logs/v0.0.150/change_plan.md §A（version-range 自实现约束）
 *
 * 约束：
 *   - 仅支持 `<X.Y.Z` 形式（够用且简单；其他形式 throw）
 *   - 数字段（major/minor/patch）独立数值比较，不混 string 比较（避免 '10' < '9' 字典序坑）
 *   - 不引 semver 库（减依赖，无新 npm 包）
 */

/** 解析 `X.Y.Z` 为 [major, minor, patch] 三段数字；非法段抛错 */
function parseVersion(v: string): [number, number, number] {
  const parts = v.split('.');
  if (parts.length !== 3) {
    throw new Error(`version-range: 版本号 "${v}" 非三段 X.Y.Z 形式`);
  }
  const parse = (p: string): number => {
    const n = Number.parseInt(p, 10);
    if (!Number.isFinite(n) || n < 0 || String(n) !== p) {
      throw new Error(`version-range: 版本号段 "${p}" 非非负整数`);
    }
    return n;
  };
  return [parse(parts[0]!), parse(parts[1]!), parse(parts[2]!)];
}

/**
 * 判定 version 是否满足 range。
 * 当前仅支持 `<X.Y.Z` 形式：version 必须**严格小于** range 中的版本。
 *
 * @param version 待判定版本（如 '0.0.150'）
 * @param range range 表达式（如 '<0.0.151'）
 * @throws range 不以 `<` 开头或后续版本号非法时抛错
 */
export function satisfiesRange(version: string, range: string): boolean {
  if (!range.startsWith('<')) {
    throw new Error(`version-range: 仅支持 "<X.Y.Z" 形式，收到 "${range}"`);
  }
  const bound = range.slice(1).trim();
  const [vMaj, vMin, vPat] = parseVersion(version);
  const [bMaj, bMin, bPat] = parseVersion(bound);
  // 数字段比较（不混 string）
  if (vMaj !== bMaj) return vMaj < bMaj;
  if (vMin !== bMin) return vMin < bMin;
  return vPat < bPat;
}
