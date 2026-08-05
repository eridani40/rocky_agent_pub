/**
 * cdp-ready 单元测试（白盒）
 * 参考: states/v0.0.23.1/bugs/BUG-001-browser-connectovercdp-timeout-[fixed].md
 *
 * 覆盖（BUG-001 第 4 块：就绪检测增强）：
 *   - 旧口径兼容：fetch 只返 {ok,status}（无 body/ws 字段）→ 200 即就绪
 *   - webSocketDebuggerUrl 显式非空 → 就绪
 *   - webSocketDebuggerUrl 显式空字符串 → 继续轮询 → 超时 cdp_timeout（僵尸 chrome）
 *   - body 含合法 JSON 且 webSocketDebuggerUrl 非空 → 就绪
 *   - body 含 JSON 但 webSocketDebuggerUrl 空 → 继续轮询 → 超时
 *   - body 非 JSON → 继续轮询 → 超时（不误判）
 *   - HTTP 非 200 → 继续轮询 → 超时
 *   - 抛 cdp_timeout 时 kind 正确
 */
import { describe, it, expect } from 'vitest';
import { waitForCdpReady } from '../cdp-ready';
import { BrowserError } from '../types';
import type { FetchFn } from '../cdp-ready';

/**
 * 构造"首次 fetch 后即超时"的 now + sleep 注入。
 * start=0；首次 fetch 后 now 返回 >= timeout → 立即 cdp_timeout（不依赖真实 sleep）。
 */
const TIMEOUT = 1000;
/** now：第 1 次（start）返 0；第 2 次（fetch 后判超时）返 >= timeout → 触发超时 */
function nowThatExpiresAfterStart() {
  let n = 0;
  return () => (n++ === 0 ? 0 : TIMEOUT);
}
/** sleep 立即 resolve（测试不真实等待） */
const sleepImmediate = () => Promise.resolve();

describe('waitForCdpReady：旧口径兼容（无 body/ws 字段）', () => {
  it('fetch 只返 {ok,status}（无字段）→ 200 即就绪', async () => {
    const fetch: FetchFn = async () => ({ ok: true, status: 200 });
    // 不注入 now/timeout（走默认 10s），首次即 200 应立即返回
    await waitForCdpReady(18800, { fetch });
  });
});

describe('waitForCdpReady：webSocketDebuggerUrl 显式字段', () => {
  it('webSocketDebuggerUrl 非空 → 就绪', async () => {
    const fetch: FetchFn = async () => ({
      ok: true,
      status: 200,
      webSocketDebuggerUrl: 'ws://127.0.0.1:18800/devtools/browser/abc',
    });
    await waitForCdpReady(18800, { fetch });
  });

  it('webSocketDebuggerUrl 空字符串 → 继续轮询 → cdp_timeout（僵尸 chrome）', async () => {
    const fetch: FetchFn = async () => ({
      ok: true,
      status: 200,
      webSocketDebuggerUrl: '', // 僵尸：HTTP 200 但 ws URL 空
    });
    let caught: unknown;
    await waitForCdpReady(18800, {
      fetch,
      timeoutMs: TIMEOUT,
      now: nowThatExpiresAfterStart(),
      sleep: sleepImmediate,
    }).catch((e: unknown) => {
      caught = e;
    });
    expect(caught).toBeInstanceOf(BrowserError);
    expect((caught as BrowserError).kind).toBe('cdp_timeout');
  });
});

describe('waitForCdpReady：body 解析', () => {
  it('body 合法 JSON + ws URL 非空 → 就绪', async () => {
    const body = JSON.stringify({
      Browser: 'Chrome/120',
      webSocketDebuggerUrl: 'ws://127.0.0.1:18800/devtools/browser/xyz',
    });
    const fetch: FetchFn = async () => ({ ok: true, status: 200, body });
    await waitForCdpReady(18800, { fetch });
  });

  it('body 合法 JSON 但 ws URL 空 → 继续轮询 → cdp_timeout', async () => {
    const body = JSON.stringify({ Browser: 'Chrome/120', webSocketDebuggerUrl: '' });
    const fetch: FetchFn = async () => ({ ok: true, status: 200, body });
    await expect(
      waitForCdpReady(18800, {
        fetch,
        timeoutMs: TIMEOUT,
        now: nowThatExpiresAfterStart(),
        sleep: sleepImmediate,
      }),
    ).rejects.toThrowError(BrowserError);
  });

  it('body 缺 webSocketDebuggerUrl 字段 → 继续轮询 → cdp_timeout', async () => {
    const body = JSON.stringify({ Browser: 'Chrome/120' }); // 无 ws 字段
    const fetch: FetchFn = async () => ({ ok: true, status: 200, body });
    await expect(
      waitForCdpReady(18800, {
        fetch,
        timeoutMs: TIMEOUT,
        now: nowThatExpiresAfterStart(),
        sleep: sleepImmediate,
      }),
    ).rejects.toThrowError(BrowserError);
  });

  it('body 非 JSON → 继续轮询 → cdp_timeout（不误判）', async () => {
    const fetch: FetchFn = async () => ({
      ok: true,
      status: 200,
      body: '<html>not json</html>',
    });
    await expect(
      waitForCdpReady(18800, {
        fetch,
        timeoutMs: TIMEOUT,
        now: nowThatExpiresAfterStart(),
        sleep: sleepImmediate,
      }),
    ).rejects.toThrowError(BrowserError);
  });
});

describe('waitForCdpReady：HTTP 状态', () => {
  it('HTTP 503 → 继续轮询 → cdp_timeout', async () => {
    const fetch: FetchFn = async () => ({ ok: false, status: 503 });
    await expect(
      waitForCdpReady(18800, {
        fetch,
        timeoutMs: TIMEOUT,
        now: nowThatExpiresAfterStart(),
        sleep: sleepImmediate,
      }),
    ).rejects.toThrowError(BrowserError);
  });

  it('fetch 抛异常 → 继续轮询 → cdp_timeout', async () => {
    const fetch: FetchFn = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(
      waitForCdpReady(18800, {
        fetch,
        timeoutMs: TIMEOUT,
        now: nowThatExpiresAfterStart(),
        sleep: sleepImmediate,
      }),
    ).rejects.toThrowError(BrowserError);
  });
});
