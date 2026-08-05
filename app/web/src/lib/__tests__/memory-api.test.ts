// @vitest-environment jsdom
/**
 * memory-api 单测（v0.0.55 T5 · v0.0.112 scope 对外统一 global）
 * 参考: specs/api/overall/15-memory-ui.md §3-§6
 *
 * 覆盖：
 *   - listMemory('global') → GET /memory/global（无 sessionId query）
 *   - listMemory('session', {sessionId}) → GET /memory/session?sessionId=...
 *   - listMemory('session') 缺 sessionId → 抛错（前端护栏）
 *   - writeMemory global/session → POST URL + body 形态正确（session 含 sessionId body 字段）
 *   - patchMemory global/session → PATCH URL + body（含 evolvable 透传）
 *   - archiveMemory global/session → DELETE URL
 *   - 错误响应（!res.ok）→ 抛 Error（走 req() 统一错误处理）
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  listMemory,
  writeMemory,
  patchMemory,
  archiveMemory,
  type MemoryWriteInput,
} from '../memory-api';

/** 构造 fetch Response 桩 */
function resJson(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const ENTRY_INPUT: MemoryWriteInput = {
  name: 'prefer-vitest',
  intro: 'desc',
  type: 'feedback',
  body: 'body',
  why: 'why',
  howToApply: 'how',
};

describe('memory-api', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('listMemory global → GET /memory/global（无 sessionId query）', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      resJson({ entries: [{ name: 'a' }] }),
    );
    const r = await listMemory('global');
    expect(r).toEqual([{ name: 'a' }]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('/memory/global');
    expect(String(url)).not.toContain('sessionId');
    expect(init?.method).toBeUndefined(); // GET
  });

  it('listMemory session → GET /memory/session?sessionId=X', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(resJson({ entries: [] }));
    await listMemory('session', { sessionId: 'sid-1' });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('/memory/session?sessionId=sid-1');
  });

  it('listMemory session 缺 sessionId → 抛错', async () => {
    await expect(listMemory('session')).rejects.toThrow(/sessionId/);
  });

  it('listMemory includeArchived=true → query 含 includeArchived', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(resJson({ entries: [] }));
    await listMemory('session', { sessionId: 's1', includeArchived: true });
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('includeArchived=true');
  });

  it('writeMemory global → POST /memory/global，body 无 sessionId 字段', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      resJson({ entry: { name: 'a' } }),
    );
    await writeMemory('global', ENTRY_INPUT);
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toMatch(/\/memory\/global$/);
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string);
    expect(body.sessionId).toBeUndefined();
    expect(body.entry).toEqual(ENTRY_INPUT);
  });

  it('writeMemory session → POST /memory/session?sessionId=X，body 含 sessionId', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      resJson({ entry: { name: 'a' } }),
    );
    await writeMemory('session', ENTRY_INPUT, 'sid-9');
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toContain('/memory/session?sessionId=sid-9');
    const body = JSON.parse(init?.body as string);
    expect(body.sessionId).toBe('sid-9');
    expect(body.entry).toEqual(ENTRY_INPUT);
  });

  it('patchMemory global → PATCH /memory/global/:name，无 sessionId', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      resJson({ entry: { name: 'a' } }),
    );
    await patchMemory('global', 'my-entry', { intro: 'new' });
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toMatch(/\/memory\/global\/my-entry$/);
    expect(String(url)).not.toContain('sessionId');
    expect(init?.method).toBe('PATCH');
    const body = JSON.parse(init?.body as string);
    expect(body.entry).toEqual({ intro: 'new' });
  });

  it('patchMemory 透传 evolvable → body.entry.evolvable', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      resJson({ entry: { name: 'a' } }),
    );
    await patchMemory('global', 'my-entry', { body: 'x', evolvable: true });
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const body = JSON.parse(init?.body as string);
    expect(body.entry).toEqual({ body: 'x', evolvable: true });
  });

  it('patchMemory session → PATCH /memory/session/:name?sessionId=X', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      resJson({ entry: { name: 'a' } }),
    );
    await patchMemory('session', 'entry-1', { body: 'new' }, 's2');
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toMatch(/\/memory\/session\/entry-1\?sessionId=s2$/);
  });

  it('archiveMemory global → DELETE /memory/global/:name', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      resJson({ ok: true, archivedAt: 't' }),
    );
    await archiveMemory('global', 'entry-x');
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toMatch(/\/memory\/global\/entry-x$/);
    expect(init?.method).toBe('DELETE');
  });

  it('archiveMemory session → DELETE /memory/session/:name?sessionId=X', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      resJson({ ok: true, archivedAt: 't' }),
    );
    await archiveMemory('session', 'entry-y', 's3');
    const [url] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toMatch(/\/memory\/session\/entry-y\?sessionId=s3$/);
  });

  it('!res.ok → 抛 Error（msg 取 body.error）', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      resJson({ error: 'boom' }, false, 500),
    );
    await expect(listMemory('global')).rejects.toThrow(/boom/);
  });
});
