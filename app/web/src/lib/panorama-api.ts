/**
 * panorama-api —— 业务全景（Panorama）HTTP 客户端
 * 参考: specs/api/overall/14-panorama-endpoints.md（端点契约唯一依据）
 *       app/web/src/lib/squad-api.ts（fetch 风格同源）
 *
 * 仅暴露 Studio panorama 页用到的端点子集：schema 读 + 实体 CRUD + transition + events。
 * 错误时抛 Error（message 优先取 body.reason/message/error；附 status/code 便于调用方判定）。
 */
import { resolveApiBase } from './api-base';
import type { PanoramaEvent } from '../components/studio-page/panorama-types';

/** panorama 端点错误（附 status/code，transition 失败可读 reason） */
export class PanoramaApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 统一 fetch 封装（错误 body 取 reason/message/error 中最可读字段） */
async function preq<T>(path: string, init?: RequestInit, base?: string): Promise<T> {
  const res = await fetch(`${resolveApiBase(base)}${path}`, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const b = (typeof body === 'object' && body ? body : {}) as Record<string, unknown>;
    const msg = String(b.reason ?? b.message ?? b.error ?? `HTTP ${res.status}`);
    throw new PanoramaApiError(msg, res.status, typeof b.code === 'string' ? b.code : undefined);
  }
  return body as T;
}

function pbase(squadId: string): string {
  return `/squad/${encodeURIComponent(squadId)}/panorama`;
}

/** GET /squad/:id/panorama/schema —— 读 DSL 全文（null = 未定义 → idle 空态，§1.1） */
export async function getPanoramaSchema(squadId: string, base?: string): Promise<string | null> {
  const r = await preq<{ dsl: string | null }>(`${pbase(squadId)}/schema`, undefined, base);
  return r.dsl ?? null;
}

/** GET .../entities/:entity —— 查询实例列表（§2.1；filter/sort/limit query 透传）
 * v0.0.240：filter 支持 view.filter 透传（{ archived: false } → ?filter=archived:false） */
export async function listPanoramaEntities(
  squadId: string,
  entity: string,
  opts: { filter?: Record<string, unknown>; sort?: string; limit?: number } = {},
  base?: string,
): Promise<Record<string, unknown>[]> {
  const params = new URLSearchParams();
  if (opts.filter) {
    const parts: string[] = [];
    for (const [k, v] of Object.entries(opts.filter)) {
      if (v === undefined || v === null) continue;
      parts.push(`${k}:${String(v)}`);
    }
    if (parts.length > 0) params.set('filter', parts.join(','));
  }
  if (opts.sort) params.set('sort', opts.sort);
  if (opts.limit != null) params.set('limit', String(opts.limit));
  const qs = params.toString();
  const r = await preq<{ instances: Record<string, unknown>[] }>(
    `${pbase(squadId)}/entities/${encodeURIComponent(entity)}${qs ? '?' + qs : ''}`,
    undefined,
    base,
  );
  return r.instances ?? [];
}

/** POST .../entities/:entity —— 新建实例（§2.2，201 + { ok, id }） */
export async function createPanoramaEntity(
  squadId: string,
  entity: string,
  fields: Record<string, unknown>,
  base?: string,
): Promise<{ ok: boolean; id: string }> {
  return preq(`${pbase(squadId)}/entities/${encodeURIComponent(entity)}`, {
    method: 'POST',
    body: JSON.stringify({ fields }),
  }, base);
}

/** PATCH .../entities/:entity/:id —— 字段补丁更新（§2.4） */
export async function patchPanoramaEntity(
  squadId: string,
  entity: string,
  id: string,
  patch: Record<string, unknown>,
  base?: string,
): Promise<{ ok: boolean }> {
  return preq(`${pbase(squadId)}/entities/${encodeURIComponent(entity)}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ patch }),
  }, base);
}

/** POST .../entities/:entity/:id/transition —— 状态跃迁（§2.5；非法 400 + 可读 reason） */
export async function transitionPanoramaEntity(
  squadId: string,
  entity: string,
  id: string,
  to: string,
  base?: string,
): Promise<{ ok: boolean; from: string; to: string }> {
  return preq(
    `${pbase(squadId)}/entities/${encodeURIComponent(entity)}/${encodeURIComponent(id)}/transition`,
    { method: 'POST', body: JSON.stringify({ to }) },
    base,
  );
}

/** GET .../events —— 读事件流（§3.1；limit 默认 50） */
export async function listPanoramaEvents(
  squadId: string,
  limit = 20,
  base?: string,
): Promise<PanoramaEvent[]> {
  const r = await preq<{ events: PanoramaEvent[] }>(
    `${pbase(squadId)}/events?limit=${limit}`,
    undefined,
    base,
  );
  return r.events ?? [];
}
