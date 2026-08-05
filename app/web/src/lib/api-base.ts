/**
 * API base 前缀解析（共享 helper）
 * 参考: specs/tech/app/package/[P0]tool_chain.md（vite proxy / packaged 两种模式）
 *
 * - dev：VITE_API_BASE 未设 → '' → fetch 相对路径 → 走 vite proxy
 * - packaged build：VITE_API_BASE=http://127.0.0.1:${API_PORT} → 绝对 URL（跨域，需 server CORS）
 *
 * vite 在 build 期把 import.meta.env.VITE_API_BASE 内联进产物（需 VITE_ 前缀）。
 * 测试/SSR 下 import.meta.env 可能 undefined，故 try/catch + ?? '' 兜底。
 * @param explicit 显式传入的 base（测试用）；undefined 表示读 import.meta.env
 */
export function resolveApiBase(explicit?: string): string {
  if (explicit !== undefined) return explicit;
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    return env?.VITE_API_BASE ?? '';
  } catch {
    return '';
  }
}
