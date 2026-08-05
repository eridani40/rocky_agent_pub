/**
 * session usage handler UT — GET /session/:id/usage（v0.0.16 T2）
 * 参考: specs/api/overall/04-agent-session.md §6（GET /session/:id/usage 契约）
 *       specs/tech/agent/session/[P0]session_usage.md §8（SessionUsageView）
 *
 * 覆盖：
 *   - 200 + SessionUsageView 全字段（7 字段 ContextWindowUsage + 三分区 + 4 cacheRate）
 *   - 404 session 不存在
 *   - 405 非 GET
 *   - 旧 record normalize 兜底（无 usage 字段 → 零分区 + 4 cacheRate=0）
 *
 * 走真实 router + bootstrap（fs engine + tmpdir），确保 router 分发 + handler 集成。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleRequest } from '../../router';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import { ulid } from '../../config/ulid';
import {
  SessionSchema,
  MessageSchema,
  SummarySchema,
  RunSchema,
} from '../../agent/schema_defs';
import type { ContextWindowUsage } from '../../message/types';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-session-usage-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 构造最小可用 providers 配置（router bootstrap 时 AppConfigService 读） */
function writeAppConfig(dataDir: string): void {
  const fs = require('node:fs');
  const path = require('node:path');
  const providersDir = path.join(dataDir, 'app_config', 'providers', 'app_config');
  fs.mkdirSync(providersDir, { recursive: true });
  fs.writeFileSync(
    path.join(providersDir, 'p1.json'),
    JSON.stringify({
      id: 'p1',
      group: 'providers',
      key: 'p1',
      data: {
        id: 'p1',
        name: 'mock',
        kind: 'mock',
        enabled: true,
        credentials: {},
        models: [{ modelId: 'm1', contextWindow: 100000 }],
      },
    }),
  );
  fs.mkdirSync(path.join(dataDir, 'dev_config'), { recursive: true });
}

/** 直连 store 创建 session（绕开 router，便于预设状态） */
async function createSessionViaStore(
  dataDir: string,
  sid: string,
): Promise<SessionStore> {
  const fs = new FsCrudStore({ root: dataDir });
  const crud = new CompositeStore()
    .mount('session', fs)
    .mount('transcript', fs)
    .mount('summary', fs)
    .mount('runs', fs);
  const store = new SessionStore({ crud, fsRoot: dataDir });
  await store.createSession({ id: sid, title: 'test' });
  return store;
}

/** 解析 Response body 为 JSON */
async function body(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

// ============================================================
// GET /session/:id/usage — 200 全字段
// ============================================================

describe('GET /session/:id/usage — 200 + SessionUsageView 全字段', () => {
  it('新 session（无 usage 累计）→ 零分区 + 4 cacheRate=0 + ratio=1.0', async () => {
    writeAppConfig(tmpRoot);
    const sid = ulid();
    await createSessionViaStore(tmpRoot, sid);

    const res = await handleRequest(
      new Request(`http://x/session/${sid}/usage`, { method: 'GET' }),
      tmpRoot,
    );
    expect(res.status).toBe(200);
    const v = await body(res);
    // 三分区 Record 形态：新 session 只有 llmCallCount=0（emptyPartition）
    expect(v.current).toEqual({ llmCallCount: 0 });
    expect(v.sub).toEqual({ llmCallCount: 0 });
    expect(v.forked).toEqual({ llmCallCount: 0 });
    expect(v.total).toEqual({ llmCallCount: 0 });
    expect(v.ratio).toBe(1.0);
    // 4 cacheRate 派生字段（分母 0 返 0）
    expect(v.currentCacheRate).toBe(0);
    expect(v.subCacheRate).toBe(0);
    expect(v.forkedCacheRate).toBe(0);
    expect(v.totalCacheRate).toBe(0);
  });

  it('累计 current 分区 + contextWindowUsage → cacheRate 派生 + cw 透传', async () => {
    writeAppConfig(tmpRoot);
    const sid = ulid();
    const store = await createSessionViaStore(tmpRoot, sid);
    // current 分区累计一次 LLM 调用（cache_read=80, input_total=200）
    await store.accumulateUsage(sid, 'current', {
      input_cache_read: 80,
      input_total_tokens: 200,
      inputCharCount: 1000,
    } as any);
    // 写入 contextWindowUsage（7 字段）
    const cw: ContextWindowUsage = {
      systemTokens: 100,
      messageTokens: 700,
      toolTokens: 200,
      totalTokens: 1000,
      maxOutputTokens: 20000,
      tokenLimit: 200000,
      remainingTokens: 200000 - 1000 - 20000,
    };
    await store.updateContextWindowUsage(sid, cw);

    const res = await handleRequest(
      new Request(`http://x/session/${sid}/usage`, { method: 'GET' }),
      tmpRoot,
    );
    expect(res.status).toBe(200);
    const v = await body(res);
    // current 分区含 cache_read / input_total
    expect(v.current.input_cache_read).toBe(80);
    expect(v.current.input_total_tokens).toBe(200);
    expect(v.current.llmCallCount).toBe(1);
    // total = current（其他分区空）
    expect(v.total.input_cache_read).toBe(80);
    // cacheRate 派生：current=0.4, sub=0, forked=0, total=0.4
    expect(v.currentCacheRate).toBeCloseTo(0.4, 6);
    expect(v.subCacheRate).toBe(0);
    expect(v.forkedCacheRate).toBe(0);
    expect(v.totalCacheRate).toBeCloseTo(0.4, 6);
    // contextWindowUsage 7 字段透传
    expect(v.contextWindowUsage).toEqual(cw);
  });
});

// ============================================================
// 404 / 405
// ============================================================

describe('GET /session/:id/usage — 错误码', () => {
  it('404 session 不存在', async () => {
    writeAppConfig(tmpRoot);
    const res = await handleRequest(
      new Request(`http://x/session/${ulid()}/usage`, { method: 'GET' }),
      tmpRoot,
    );
    expect(res.status).toBe(404);
    const b = await body(res);
    expect(b.error).toMatch(/not found/);
  });

  it('405 非 GET（POST）+ Allow: GET', async () => {
    writeAppConfig(tmpRoot);
    const sid = ulid();
    await createSessionViaStore(tmpRoot, sid);
    const res = await handleRequest(
      new Request(`http://x/session/${sid}/usage`, { method: 'POST' }),
      tmpRoot,
    );
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET');
  });
});
