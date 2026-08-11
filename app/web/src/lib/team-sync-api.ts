/**
 * team-sync-api —— 团队同步 HTTP 客户端（v0.0.319，PRD specs/prd/v0.0.319-team-sync.md）
 *
 * 从 squad-api.ts 拆出（单文件 ≤300 行硬约束）：导出 zip 下载 + 两阶段导入（preview/execute）。
 * 与 squad-api 同 fetch 风格（resolveApiBase 拼 URL + 错误转异常 + status 透传）；
 * FormData 上传不复用 req()（其强制 content-type: application/json），直接 fetch。
 */
import { resolveApiBase } from './api-base';

/** 导出 manifest 预览结构（与后端 ManifestSchema 对齐，仅前端展示所需子集） */
export interface TeamSyncManifest {
  slug: string;
  name: string;
  description: string;
  leaderName: string;
  leaderIntro?: string;
  builtin: boolean;
  members: { name: string; intro: string; skillConfig: unknown }[];
}

/** 统一错误转换（与 squad-api.req 同语义：后端 error 文案 + status 透传） */
async function throwIfNotOk(res: Response): Promise<unknown> {
  const body = (await res.json().catch(() => null)) as ({ error?: string } & Record<string, unknown>) | null;
  if (!res.ok) {
    const err = new Error(body?.error ?? `HTTP ${res.status}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return body;
}

/**
 * 导出当前团队 zip：GET /squad/:id/export → <a href download> 触发浏览器下载。
 * 直接拼 URL 赋给隐藏 <a>，浏览器原生处理下载流（不经 fetch，避免大文件进内存）。
 */
export function exportSquad(squadId: string, base?: string): void {
  const a = document.createElement('a');
  a.href = `${resolveApiBase(base)}/squad/${encodeURIComponent(squadId)}/export`;
  a.download = ''; // 文件名由后端 Content-Disposition 决定
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

/**
 * 导入 preview：POST /squad/import?step=preview（FormData file）。
 * 后端解包校验 manifest → 返回 { importKey, manifest }（importKey 5min TTL）。
 */
export async function previewImport(
  file: File,
  base?: string,
): Promise<{ importKey: string; manifest: TeamSyncManifest }> {
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch(`${resolveApiBase(base)}/squad/import?step=preview`, {
    method: 'POST',
    body: fd,
  });
  return (await throwIfNotOk(res)) as { importKey: string; manifest: TeamSyncManifest };
}

/**
 * 导入 execute：POST /squad/import?step=execute（FormData importKey + name）。
 * 后端按 importKey 取临时目录建队 → 返回 { squadId, created, failed }。
 * sessionId 透传 x-session-id 请求头（后端据此继承当前 squad modelDefault）。
 */
export async function executeImport(
  importKey: string,
  name: string,
  sessionId?: string,
  base?: string,
): Promise<{ squadId: string; created: string[]; failed: string[] }> {
  const fd = new FormData();
  fd.append('importKey', importKey);
  fd.append('name', name);
  const headers: Record<string, string> = {};
  if (sessionId) headers['x-session-id'] = sessionId;
  const res = await fetch(`${resolveApiBase(base)}/squad/import?step=execute`, {
    method: 'POST',
    headers,
    body: fd,
  });
  return (await throwIfNotOk(res)) as { squadId: string; created: string[]; failed: string[] };
}
