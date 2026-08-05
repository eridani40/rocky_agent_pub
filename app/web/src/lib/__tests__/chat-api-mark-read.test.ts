// @vitest-environment node
/**
 * chat-api.markSessionRead URL/方法契约单测（v0.0.27）
 * 参考: specs/api/overall/04-agent-session.md §2.3.1（POST /session/:id/read）
 *
 * 覆盖 acceptanceCriteria：
 *   - 进入会话触发 POST /session/:id/read 调用（URL 含 sid + POST 方法）
 *   - 成功响应 → {ok:true, session:{unread:false}}
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { markSessionRead } from '../chat-api';

afterEach(() => vi.restoreAllMocks());

describe('chat-api.markSessionRead（v0.0.27 POST /session/:id/read）', () => {
  it('请求 URL 含 sid 且方法 POST', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, session: { id: 's1', unread: false } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await markSessionRead('01KVXYZ', 'http://test');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe('http://test/session/01KVXYZ/read');
    expect((init as RequestInit).method).toBe('POST');
  });

  it('成功响应解析为 {ok:true, session:{unread:false}}', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ ok: true, session: { id: 's1', unread: false } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const r = await markSessionRead('s1', 'http://test');
    expect(r.ok).toBe(true);
    expect(r.session.unread).toBe(false);
  });

  it('404 抛错（session 不存在）', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'not found' }), { status: 404 }),
    );
    await expect(markSessionRead('nope', 'http://test')).rejects.toThrow();
  });

  it('sid 含特殊字符被 encodeURIComponent 转义', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, session: { unread: false } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await markSessionRead('a b/c', 'http://test');
    const [url] = fetchSpy.mock.calls[0]!;
    // 空格 → %20，/ → %2F
    expect(String(url)).toBe('http://test/session/a%20b%2Fc/read');
  });
});
