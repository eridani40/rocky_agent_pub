/**
 * http-server bridge SSE 集成测试 — BUG-001 防回归
 * 参考: states/v0.0.8/bugs/BUG-001-sse-http-bridge-buffers-stream-body-[fixed].md
 *
 * BUG-001 根因：writeWebResponse 之前用 `await web.arrayBuffer()` 缓冲整个 body，
 * 对 SSE 长连接流（永不 done）会导致帧从不刷给客户端。SseChannel 单测绕过了桥，
 * 直接读 ReadableStream，故漏掉本层 bug。
 *
 * 本测试**经真实 node:http server + writeWebResponse 桥**验证：
 *   1. 流式 Response（模拟 SseChannel：chunk 异步 enqueue，流不立即关闭）
 *      客户端必须**增量收到帧**（不等流 close）。
 *   2. 普通 JSON Response 一次性读完也正确（pump 不破坏非流式）。
 *   3. null body 直接 end。
 *
 * 隔离：临时 server 用 OS 分配端口，afterEach 关闭；不碰 ~/.oobt-desktop。
 */
import { createServer, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeWebResponse } from '../http-server';

/** 起一个仅用 writeWebResponse 桥的临时 http server（不走 router，直接喂 Response） */
function startBridgeServer(handler: () => Response): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    // 消费掉 req body（避免 socket 挂起），然后桥接
    req.resume();
    void writeWebResponse(res as ServerResponse, handler()).catch((e) => {
      // eslint-disable-next-line no-console
      console.error('[test bridge] error:', e);
      res.writeHead(500);
      res.end();
    });
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

describe('writeWebResponse SSE bridge（BUG-001 防回归）', () => {
  let cleanup: (() => void) | null;

  beforeEach(() => {
    cleanup = null;
  });
  afterEach(() => {
    cleanup?.();
  });

  it('流式 SSE Response：客户端增量收到帧（不等流 close）', async () => {
    // 构造一个模拟 SseChannel 的流：异步分 3 次 enqueue 帧，间隔 50ms，
    // 最后 close。客户端应在每帧 enqueue 后立即收到（而非等到 close）
    const frames = ['data: frame-1\n\n', 'data: frame-2\n\n', 'data: frame-3\n\n'];
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        for (const f of frames) {
          await new Promise<void>((r) => setTimeout(r, 50));
          controller.enqueue(enc.encode(f));
        }
        controller.close();
      },
    });
    const { server, port } = await startBridgeServer(
      () =>
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    cleanup = () => server.close();

    // 用 node fetch 读流，按 chunk 累积，验证在第 1 帧 enqueue 后（~50ms）就能读到字节
    const r = await fetch(`http://127.0.0.1:${port}/`, { headers: { accept: 'text/event-stream' } });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/event-stream');
    expect(r.body).not.toBeNull();

    const reader = r.body!.getReader();
    const dec = new TextDecoder();
    let received = '';
    const firstChunkTime = { ms: -1 };
    const start = Date.now();

    // 读第 1 个 chunk —— 关键断言：必须在 < 200ms 内拿到（流远未 close，证明未缓冲）
    {
      const { done, value } = await reader.read();
      expect(done).toBe(false);
      expect(value).toBeDefined();
      received += dec.decode(value, { stream: true });
      firstChunkTime.ms = Date.now() - start;
      // 3 帧 enqueue 间隔 50ms，第 1 帧在 50ms 时；pump 应即时刷出。
      // 缓冲 bug 下会卡到全部 close（~150ms+）才有数据，甚至（无限流）永远无数据。
      expect(received).toContain('frame-1');
      expect(firstChunkTime.ms).toBeLessThan(200);
    }

    // 把剩余读完，断言 3 帧都到
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += dec.decode(value, { stream: true });
    }
    expect(received).toContain('frame-1');
    expect(received).toContain('frame-2');
    expect(received).toContain('frame-3');
  });

  it('普通 JSON Response：一次性读完内容正确（pump 不破坏非流式）', async () => {
    const payload = JSON.stringify({ ok: true, n: 42 });
    const { server, port } = await startBridgeServer(
      () => new Response(payload, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    cleanup = () => server.close();

    const r = await fetch(`http://127.0.0.1:${port}/`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; n: number };
    expect(body.ok).toBe(true);
    expect(body.n).toBe(42);
  });

  it('null body：直接 end（204）', async () => {
    const { server, port } = await startBridgeServer(() => new Response(null, { status: 204 }));
    cleanup = () => server.close();
    const r = await fetch(`http://127.0.0.1:${port}/`);
    expect(r.status).toBe(204);
    expect(await r.text()).toBe('');
  });
});
