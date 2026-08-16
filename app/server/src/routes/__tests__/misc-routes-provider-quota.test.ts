/**
 * v0.0.363 路由顺序 UT — /provider/quota + /provider/quota/sync 不被 /provider/:id 正则吞
 * 参考: app/server/src/routes/misc-routes.ts（两分支 MUST 置于 providerMatch 前；350 S6 同理）
 *
 * 判定原理：若顺序颠倒，path='/provider/quota' 会命中 :id 正则 → handleProviderItem(id='quota')
 * → 404 Not Found。到达 quota handler 的标志 = 200 {items,lastSyncedAt} / 405 / 202。
 * [v0.0.363] GET 读 store 秒回（空窗异步触发首轮）——dispatch 层断言同步该语义。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AppConfigService } from '../../config/app-config-service';
import { dispatchMiscRoutes } from '../misc-routes';
import { QuotaStore } from '../../llm/quota-store';
import { QuotaSyncService } from '../../llm/quota-sync-service';
import type { BootstrapResult } from '../../bootstrap';
import type { PluginManager } from '../../plugin/plugin-manager';

let tmpRoot: string;
let svc: AppConfigService;
let dataDir: string;
let quotaStore: QuotaStore;
let quotaSyncService: QuotaSyncService;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oobt-quota-route-'));
  svc = new AppConfigService({ root: tmpRoot });
  dataDir = tmpRoot;
  quotaStore = new QuotaStore();
  quotaSyncService = new QuotaSyncService({
    svc: undefined as unknown as AppConfigService,
    pluginManager: { getExtensionImpls: () => [] } as unknown as PluginManager,
    store: quotaStore,
  });
});

afterEach(() => {
  quotaSyncService.stop();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 最小 bs（363：quota 路由段消费 quotaStore + quotaSyncService） */
function fakeBs(): BootstrapResult {
  return {
    appConfig: svc,
    pluginManager: { getExtensionImpls: () => [] } as unknown as PluginManager,
    quotaStore,
    quotaSyncService,
  } as unknown as BootstrapResult;
}

function dispatch(method: string, pathname: string): Promise<Response | null> {
  const req = new Request(`http://x${pathname}`, { method });
  return dispatchMiscRoutes(req, new URL(req.url), method, pathname, fakeBs(), dataDir);
}

describe('misc-routes — GET /provider/quota 路由顺序 + store 秒回（S6 + 363 §1.3）', () => {
  it('store 有数据：GET → 200 store 视图（到达 handler；未被 :id 正则吞）', async () => {
    quotaStore.replaceAll(
      [{
        providerId: 'p1', providerLabel: 'DS', implId: 'deepseek_api', kind: 'balance',
        balance: { currency: 'CNY', total: 1 }, fetchedAt: 1,
      }],
      777,
    );
    const resp = await dispatch('GET', '/provider/quota');
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(200); // 若被 :id 正则吞会是 404
    const body = (await resp!.json()) as { items: unknown[]; lastSyncedAt: number | null };
    expect(body.items).toHaveLength(1);
    expect(body.lastSyncedAt).toBe(777);
  });

  it('store 空（启动空窗）：GET → 200 {items:[],lastSyncedAt:null} 秒回', async () => {
    const resp = await dispatch('GET', '/provider/quota');
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(200);
    expect(await resp!.json()).toEqual({ items: [], lastSyncedAt: null });
  });

  it('POST /provider/quota → 405（quota handler 的 method 门，证明未被 :id 吞）', async () => {
    const resp = await dispatch('POST', '/provider/quota');
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(405);
  });

  it('对照：GET /provider/:id 既有语义不变（不存在 id → 404）', async () => {
    const resp = await dispatch('GET', '/provider/nonexistent-id');
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(404);
  });
});

describe('misc-routes — POST /provider/quota/sync 路由（363 §1.3 新增）', () => {
  it('POST → 202 {syncing:true, lastTriggeredAt}（未被 :id 吞）', async () => {
    const resp = await dispatch('POST', '/provider/quota/sync');
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(202); // 若被 :id 正则吞会是 404
    const body = (await resp!.json()) as { syncing: boolean; lastTriggeredAt?: number };
    expect(body.syncing).toBe(true);
    expect(body.lastTriggeredAt).toBeGreaterThan(0);
  });

  it('30s 节流窗内重复 POST → 202 {syncing:false, reason:"throttled"}', async () => {
    await dispatch('POST', '/provider/quota/sync'); // 首次（进节流窗）
    const resp = await dispatch('POST', '/provider/quota/sync');
    expect(resp!.status).toBe(202);
    const body = (await resp!.json()) as { syncing: boolean; reason?: string };
    expect(body.syncing).toBe(false);
    expect(body.reason).toBe('throttled');
  });

  it('GET /provider/quota/sync → 405（method 门）', async () => {
    const resp = await dispatch('GET', '/provider/quota/sync');
    expect(resp).not.toBeNull();
    expect(resp!.status).toBe(405);
  });
});
