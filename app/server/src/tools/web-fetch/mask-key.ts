/**
 * mask-key — server 侧敏感 key 脱敏工具
 * 参考: app/web/src/components/framework/primitives/secret-input.tsx（maskSecret，保持规则完全一致）
 *
 * 规则（与前端 maskSecret 完全一致，不跨包引前端组件）：
 *   - len === 0 → ''
 *   - len ≤ 4   → '*'.repeat(len)
 *   - 4 < len ≤ 8 → 首 1 + '*'.repeat(len-2) + 末 1
 *   - len > 8   → 首 4 + '*'.repeat(len-8) + 末 4
 */

/**
 * 脱敏 API key 为展示文本。
 * 规则同前端 `maskSecret`（secret-input.tsx），不依赖前端包。
 */
export function maskKey(value: string): string {
  const len = value.length;
  if (len === 0) return '';
  if (len <= 4) return '*'.repeat(len);
  if (len <= 8) return value[0] + '*'.repeat(len - 2) + value[len - 1];
  return value.slice(0, 4) + '*'.repeat(len - 8) + value.slice(-4);
}
