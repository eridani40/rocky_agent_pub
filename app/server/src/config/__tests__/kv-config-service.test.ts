/**
 * KvConfigService 内存读缓存单测（v0.0.302 T1）
 * 参考: specs/tech/version_logs/v0.0.302/change_plan.md T1（D2/D3/D4）
 *
 * 覆盖：
 *   - 缓存命中：首次 get 触发 store.query，第二次 get 不触发（零 fs）
 *   - set 后失效：get 填缓存 → set 写入 → 再 get 触发新 query
 *   - delete 后失效：get 填缓存 → delete 删除 → 再 get 触发新 query
 *
 * 策略：真实 tmp DATA_DIR 落盘（与 config-service.test.ts 一致）+ vi.spyOn(store, 'query') 计数。
 * store 是 protected 字段，同包测试可经 as any 访问。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { AppConfigService } from '../app-config-service';

let tmpRoot: string;
let app: AppConfigService;
let querySpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kv-cache-'));
  app = new AppConfigService({ root: tmpRoot });
  // spy CompositeStore.query（protected store 字段经 as any 访问）
  querySpy = vi.spyOn(
    (app as unknown as { store: { query: (...a: unknown[]) => unknown[] } }).store,
    'query',
  );
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('KvConfigService 内存读缓存 — 缓存命中（change_plan D3）', () => {
  it('首次 get 触发 store.query，第二次 get 不触发（零 fs）', () => {
    // 先写入一条数据
    app.set('logs', 'enableLlmRequestLog', true);
    // set 本身会调 query（findRecord）+ 写后 invalidate
    querySpy.mockClear();

    // 第一次 get：cache miss → ensureGroupCache → query
    const v1 = app.get('logs', 'enableLlmRequestLog');
    expect(v1).toBe(true);
    expect(querySpy).toHaveBeenCalledTimes(1);

    // 第二次 get：缓存命中 → 零 query
    const v2 = app.get('logs', 'enableLlmRequestLog');
    expect(v2).toBe(true);
    expect(querySpy).toHaveBeenCalledTimes(1); // 仍然是 1，没有增加
  });

  it('同 group 不同 key 第二次 get 也不触发 query（整 group 已缓存）', () => {
    app.set('logs', 'enableLlmRequestLog', true);
    app.set('logs', 'enableToolResultLog', false);
    querySpy.mockClear();

    // 第一次 get 某个 key → query 整 group 填缓存
    app.get('logs', 'enableLlmRequestLog');
    expect(querySpy).toHaveBeenCalledTimes(1);

    // 第二次 get 同 group 另一个 key → 缓存命中，不再 query
    app.get('logs', 'enableToolResultLog');
    expect(querySpy).toHaveBeenCalledTimes(1);
  });

  it('不同 group 各自独立首次 query（互不干扰）', () => {
    app.set('logs', 'enableLlmRequestLog', true);
    app.set('appearance', 'theme', 'dark');
    querySpy.mockClear();

    app.get('logs', 'enableLlmRequestLog');
    expect(querySpy).toHaveBeenCalledTimes(1);

    // 不同 group → 首次 miss → query
    app.get('appearance', 'theme');
    expect(querySpy).toHaveBeenCalledTimes(2);

    // 回到 logs → 缓存命中
    app.get('logs', 'enableLlmRequestLog');
    expect(querySpy).toHaveBeenCalledTimes(2);
  });
});

describe('KvConfigService 内存读缓存 — set 后失效（change_plan D4）', () => {
  it('get 填缓存 → set 写入 → 再 get 触发新 query（缓存已失效）', () => {
    app.set('logs', 'enableLlmRequestLog', true);
    querySpy.mockClear();

    // 第一次 get → 填缓存
    const v1 = app.get('logs', 'enableLlmRequestLog');
    expect(v1).toBe(true);
    expect(querySpy).toHaveBeenCalledTimes(1);

    // set 写入（findRecord 内部 query + 写后 invalidate）
    app.set('logs', 'enableLlmRequestLog', false);

    // 再 get → 缓存已失效 → 重新 query
    const v2 = app.get('logs', 'enableLlmRequestLog');
    expect(v2).toBe(false);
    // set 后 get 必须触发新 query（至少 1 次新 query）
    const queriesAfterSet = querySpy.mock.calls.length;
    expect(queriesAfterSet).toBeGreaterThan(1);
  });

  it('setGroup 写入后缓存失效，下次 get 重新 query', () => {
    app.set('logs', 'enableLlmRequestLog', true);
    querySpy.mockClear();

    // 填缓存
    app.get('logs', 'enableLlmRequestLog');
    expect(querySpy).toHaveBeenCalledTimes(1);

    // setGroup 写入
    app.setGroup('logs', [
      { key: 'enableLlmRequestLog', data: false },
      { key: 'enableToolResultLog', data: true },
    ]);

    // 再 get → 缓存已失效 → 重新 query
    const v = app.get('logs', 'enableLlmRequestLog');
    expect(v).toBe(false);
    expect(querySpy.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('KvConfigService 内存读缓存 — delete 后失效（change_plan D4）', () => {
  it('get 填缓存 → delete 删除 → 再 get 触发新 query（缓存已失效）', () => {
    app.set('logs', 'enableLlmRequestLog', true);
    querySpy.mockClear();

    // 第一次 get → 填缓存
    const v1 = app.get('logs', 'enableLlmRequestLog');
    expect(v1).toBe(true);
    expect(querySpy).toHaveBeenCalledTimes(1);

    // delete（findRecord 内部 query + 删后 invalidate）
    const deleted = app.delete('logs', 'enableLlmRequestLog');
    expect(deleted).toBe(true);

    // 再 get → 缓存已失效 → 返回 undefined + 触发新 query
    const v2 = app.get('logs', 'enableLlmRequestLog');
    expect(v2).toBeUndefined();
    expect(querySpy.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('KvConfigService 内存读缓存 — listGroup 也走缓存', () => {
  it('首次 listGroup 触发 query，第二次不触发', () => {
    app.set('logs', 'enableLlmRequestLog', true);
    app.set('logs', 'enableToolResultLog', false);
    querySpy.mockClear();

    const items1 = app.listGroup('logs');
    expect(items1.length).toBe(2);
    expect(querySpy).toHaveBeenCalledTimes(1);

    // 第二次 listGroup → 缓存命中
    const items2 = app.listGroup('logs');
    expect(items2.length).toBe(2);
    expect(querySpy).toHaveBeenCalledTimes(1);
  });
});
