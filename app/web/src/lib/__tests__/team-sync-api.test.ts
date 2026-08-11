// @vitest-environment jsdom
/**
 * squad-api 团队同步函数单测（v0.0.319）
 * 参考: specs/tech/version_logs/v0.0.319/change_plan.md D7（squad-api 3 函数）
 *
 * 覆盖（test-plan §2 UT 组 4）：
 *   - exportSquad：<a href download> 触发（不经 fetch）
 *   - previewImport：POST /squad/import?step=preview + FormData(file)，返 {importKey, manifest}
 *   - executeImport：POST /squad/import?step=execute + FormData(importKey,name) + x-session-id 头
 *   - 错误路径：res.ok=false → throw 带后端 error 文案
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { exportSquad, previewImport, executeImport } from '../team-sync-api';

function resJson(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('exportSquad', () => {
  it('创建隐藏 <a href=/squad/:id/export download> 并 click（不经 fetch）', () => {
    const clickSpy = vi.fn();
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === 'a') el.click = clickSpy;
      return el;
    });

    exportSquad('SQUAD-1', 'http://api.test');
    expect(clickSpy).toHaveBeenCalledTimes(1);
    // 不经 fetch（浏览器原生下载流）
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('previewImport', () => {
  it('POST /squad/import?step=preview + FormData(file) → {importKey, manifest}', async () => {
    const manifest = { slug: 's', name: '团队', description: '', leaderName: 'L', builtin: false, members: [] };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      resJson({ importKey: 'KEY-1', manifest }),
    );
    const file = new File(['zip-bytes'], 'team.zip', { type: 'application/zip' });
    const r = await previewImport(file, 'http://api.test');

    expect(r.importKey).toBe('KEY-1');
    expect(r.manifest.leaderName).toBe('L');
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/squad/import?step=preview');
    expect((init as RequestInit).method).toBe('POST');
    // FormData body（content-type 由浏览器自动带 multipart boundary，不强制 json）
    expect((init as RequestInit).body).toBeInstanceOf(FormData);
  });

  it('res.ok=false → throw 带后端 error 文案 + status', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      resJson({ error: '文件已损坏，无法解压' }, 400),
    );
    await expect(previewImport(new File(['x'], 'a.zip'))).rejects.toThrow('文件已损坏，无法解压');
  });
});

describe('executeImport', () => {
  it('POST /squad/import?step=execute + FormData(importKey,name) + x-session-id 头', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      resJson({ squadId: 'NEW-1', created: ['coder'], failed: [] }),
    );
    const r = await executeImport('KEY-1', '新团队', 'SESSION-1', 'http://api.test');
    expect(r.squadId).toBe('NEW-1');
    expect(r.created).toEqual(['coder']);

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(String(url)).toBe('http://api.test/squad/import?step=execute');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['x-session-id']).toBe('SESSION-1');
  });

  it('不传 sessionId → 无 x-session-id 头', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      resJson({ squadId: 'NEW-2', created: [], failed: [] }),
    );
    await executeImport('KEY-2', '团队');
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const headers = ((init as RequestInit).headers ?? {}) as Record<string, string>;
    expect(headers['x-session-id']).toBeUndefined();
  });

  it('importKey 过期 → throw 带 error 文案', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      resJson({ error: 'import session expired' }, 400),
    );
    await expect(executeImport('BAD', 'x')).rejects.toThrow('import session expired');
  });
});
