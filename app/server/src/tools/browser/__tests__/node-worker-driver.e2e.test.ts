/**
 * NodeWorkerDriver 真机端到端验证（v0.0.23.1 BUG-001 核心验证）
 * 参考: states/v0.0.23.1/bugs/BUG-001-browser-connectovercdp-timeout-[reopen].md
 *
 * 目的：证明 node worker 子进程成功绕开 Bun playwright connectOverCDP bug。
 * 真机 spawn 真 chrome，通过 NodeWorkerDriver.executeOnce 跑：
 *   - navigate（验证 connectOverCDP + page.goto 链路）
 *   - snapshot（验证 connectOverCDP + ariaSnapshot）
 *   - screenshot（验证 connectOverCDP + page.screenshot base64）
 *   - evaluate（验证 connectOverCDP + page.evaluate）
 *
 * click/type 不验（pre-existing refs 限制：跨 executeOnce lastRefs 重置）。
 *
 * 进程清理（MANDATORY，memory: test-process-cleanup-or-crash）：
 *   - userDataDir 用唯一标记前缀 rocky-verify-bug001-，afterEach pkill -9 -f 'user-data-dir=.*<标记>'
 *   - 只杀自己标记的 chrome，绝不碰用户日常 chrome
 *
 * 默认 skip（无 chrome / CI 环境时），手动 `ROCKY_E2E_BROWSER=1 npx vitest run` 启用。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { NodeWorkerDriver } from '../node-worker-driver';

/** 唯一标记前缀（pkill 用，绝不与用户 chrome 冲突） */
const VERIFY_MARK = 'rocky-verify-bug001-';

/** 是否启用真机 e2e（默认 skip：需显式 ROCKY_E2E_BROWSER=1） */
const E2E_ENABLED = process.env.ROCKY_E2E_BROWSER === '1';

/** afterEach 清理：pkill 自己标记的 chrome（防孤儿崩 IDE） */
function cleanupMyChrome(): void {
  try {
    execFileSync('pkill', ['-9', '-f', `user-data-dir=.*${VERIFY_MARK}`], {
      stdio: 'ignore',
    });
  } catch {
    /* 无匹配进程 pkill 返非 0，忽略 */
  }
}

/** 跳过 helper（E2E_ENABLED=false 时整个 describe skip） */
const maybeDescribe = E2E_ENABLED ? describe : describe.skip;

maybeDescribe('NodeWorkerDriver 真机 e2e（node worker + 真 chrome）', () => {
  afterEach(() => {
    cleanupMyChrome();
  });

  /** 构造标记过的临时 userDataDir */
  function markedTmpDir(): string {
    return mkdtempSync(join(tmpdir(), VERIFY_MARK));
  }

  it('navigate → 真 chrome + connectOverCDP（绕开 Bun bug）', async () => {
    const driver = new NodeWorkerDriver({ dataDir: '/tmp/rocky-verify-bug001' });
    const r = await driver.executeOnce(
      { headless: true, userDataDir: markedTmpDir() },
      'navigate',
      { url: 'https://example.com' },
    );
    expect(r.ok).toBe(true);
    expect(r.text).toContain('navigated to https://example.com');
  }, 60_000);

  it('snapshot → connectOverCDP + ariaSnapshot', async () => {
    const driver = new NodeWorkerDriver({ dataDir: '/tmp/rocky-verify-bug001' });
    // 先 navigate（独立 worker，因 executeOnce 一次性）
    await driver.executeOnce(
      { headless: true, userDataDir: markedTmpDir() },
      'navigate',
      { url: 'https://example.com' },
    );
    // snapshot 在新 worker 跑（chrome 是 about:blank，但能取 snapshot 证明 connectOverCDP 通）
    const r = await driver.executeOnce(
      { headless: true, userDataDir: markedTmpDir() },
      'snapshot',
      {},
    );
    expect(r.ok).toBe(true);
    // snapshot 文本非空（about:blank 也有 minimal a11y tree）
    expect(typeof r.text).toBe('string');
    expect(r.text!.length).toBeGreaterThan(0);
  }, 60_000);

  it('screenshot → connectOverCDP + page.screenshot base64', async () => {
    const driver = new NodeWorkerDriver({ dataDir: '/tmp/rocky-verify-bug001' });
    const r = await driver.executeOnce(
      { headless: true, userDataDir: markedTmpDir() },
      'screenshot',
      {},
    );
    expect(r.ok).toBe(true);
    expect(typeof r.text).toBe('string');
    // text 是 JSON.stringify({mime, data:base64})，解析验 data 非空
    const parsed = JSON.parse(r.text!);
    expect(parsed.mime).toBe('image/png');
    expect(typeof parsed.data).toBe('string');
    expect(parsed.data.length).toBeGreaterThan(100); // base64 png 至少几百字节
  }, 60_000);

  it('evaluate → connectOverCDP + page.evaluate', async () => {
    const driver = new NodeWorkerDriver({ dataDir: '/tmp/rocky-verify-bug001' });
    const r = await driver.executeOnce(
      { headless: true, userDataDir: markedTmpDir() },
      'evaluate',
      // playwright page.evaluate 接受表达式字符串（非函数体字符串）；与 tool.ts dispatchAction 口径一致
      { text: '1 + 2' },
    );
    expect(r.ok).toBe(true);
    expect(r.text).toBe('3');
  }, 60_000);
});
