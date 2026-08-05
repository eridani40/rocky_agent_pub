/**
 * academy-assets-shared — assets handler 共享（json helper + DatasetItem 类型）
 * 参考: specs/api/overall/18-academy.md §3
 */

/** JSON Response 构造（与现有 handler 一致） */
export function json(status: number, body: unknown, allow?: string): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (allow) headers.allow = allow;
  return new Response(JSON.stringify(body), { status, headers });
}

/** DatasetItem 元素结构（spec §5） */
export interface DatasetItem {
  id: string;
  question: string;
  gradingCriteria?: string;
  expectedAnswer?: string;
}
