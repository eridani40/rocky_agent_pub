/**
 * v0.0.363 provider-quota UT — collectQuotaSnapshots 聚合 + GET store 语义 + POST sync
 * 参考: specs/tech/version_logs/v0.0.363/change_plan.md §1.2/§1.3
 * 覆盖：
 *   collectQuotaSnapshots（350 决策⑦聚合面，自 handleProviderQuota 平移）：
 *     多 native 并发聚合 / 单渠道失败 error 不炸整体 / 零 native→[] /
 *     label 覆盖 + fetchedAt 统一 / impl 未注册→business error item
 *   GET /provider/quota（363 语义）：
 *     读 store 秒回 / store 空异步触发首轮不等待（返回空视图）/ 非 GET 405
 *   POST /provider/quota/sync：
 *     接受 202 {syncing:true} / inFlight 202 {syncing:false,reason} / 节流 202 / 非 POST 405
 * impl 层 stub（真实解析器矩阵在 quota-parsers.test.ts；fetch 隔离不打真网）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { AppConfigService } from '../../config/app-config-service';
import { collectQuotaSnapshots, handleProviderQuota, handleProviderQuotaSync } from '../provider-quota';
import { QuotaStore } from '../../llm/quota-store';
import { QuotaSyncService } from '../../llm/quota-sync-service';
import type { ProviderInstance } from '../provider';
import type { LlmProvider } from '../../llm/provider';
import type { QuotaSnapshot } from '../../llm/provider-types';
import type { PluginManager } from '../../plugin/plugin-manager';

let tmpRoot: string;
let svc: AppConfigService;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oobt-provider-quota-'));
  svc = new AppConfigService({ root: tmpRoot });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 落盘一个 provider 实例 */
function seedProvider(p: Partial<ProviderInstance> & { id: string; name: ProviderInstance['name']; label: string }): void {
  svc.set('providers', p.id, {
    protocolId: 'anthropic_messages', baseUrl: 'https://x.example.com',
    credentials: { key: 'sk-test' }, enabled: true, models: [],
    ...p,
  } as ProviderInstance);
}

/** stub pluginManager：按需返回 fake impls（getExtensionImpls 单参 ≡ default） */
function fakePluginManager(impls: Array<Partial<LlmProvider> & { implId: string }>): PluginManager {
  return {
    getExtensionImpls: () => impls as LlmProvider[],
  } as unknown as PluginManager;
}

const okSnapshot = (pid: string): QuotaSnapshot => ({
  providerId: pid, providerLabel: pid, implId: 'kimi_coding_plan', kind: 'quota',
  tiers: [{ window: 'five_hour', usedPercent: 10 }], fetchedAt: 1,
});

/** 构造最小 syncService（stub collect 依赖；不 start） */
function fakeSyncService(store: QuotaStore): QuotaSyncService {
  return new QuotaSyncService({
    svc: undefined as unknown as AppConfigService,
    pluginManager: fakePluginManager([]),
    store,
  });
}

describe('collectQuotaSnapshots — 聚合 + 错误隔离（350 决策⑦平移）', () => {
  it('多 native 并发聚合：label 覆盖 + fetchedAt 统一填充', async () => {
    seedProvider({ id: 'p1', name: 'kimi_coding_plan', label: 'Kimi 主力' });
    seedProvider({ id: 'p2', name: 'deepseek_api', label: 'DS' });
    seedProvider({ id: 'p3', name: 'anthropic_compatible', label: '通用（不参与）' });
    const pm = fakePluginManager([
      { implId: 'kimi_coding_plan', queryQuota: async () => okSnapshot('p1') },
      { implId: 'deepseek_api', queryQuota: async () => ({ providerId: 'p2', providerLabel: 'p2', implId: 'deepseek_api', kind: 'balance', balance: { currency: 'CNY', total: 9122.69 }, isAvailable: true, fetchedAt: 1 }) },
    ]);
    const items = await collectQuotaSnapshots(svc, pm);
    expect(items).toHaveLength(2); // anthropic_compatible 过滤
    const kimi = items.find((i) => i.providerId === 'p1')!;
    expect(kimi.providerLabel).toBe('Kimi 主力'); // 实例 label 覆盖 impl 占位
    expect(kimi.fetchedAt).toBeGreaterThan(1); // 聚合端点统一填充
    const ds = items.find((i) => i.providerId === 'p2')!;
    expect(ds.balance!.total).toBe(9122.69);
  });

  it('单渠道失败 → item.error 不炸整体（其余渠道正常返回）', async () => {
    seedProvider({ id: 'p1', name: 'kimi_coding_plan', label: 'K1' });
    seedProvider({ id: 'p2', name: 'glm_coding_plan', label: 'G1' });
    const pm = fakePluginManager([
      { implId: 'kimi_coding_plan', queryQuota: async () => { throw new Error('boom'); } },
      { implId: 'glm_coding_plan', queryQuota: async () => okSnapshot('p2') },
    ]);
    const items = await collectQuotaSnapshots(svc, pm);
    expect(items).toHaveLength(2);
    const failed = items.find((i) => i.providerId === 'p1')!;
    expect(failed.error).toEqual({ kind: 'business', message: 'boom' });
    expect(items.find((i) => i.providerId === 'p2')!.tiers).toBeDefined();
  });

  it('queryQuota 返回 null（无额度能力）→ business error item', async () => {
    seedProvider({ id: 'p1', name: 'kimi_coding_plan', label: 'K1' });
    const pm = fakePluginManager([
      { implId: 'kimi_coding_plan', queryQuota: async () => null },
    ]);
    const items = await collectQuotaSnapshots(svc, pm);
    expect(items[0]!.error!.kind).toBe('business');
  });

  it('impl 未注册（find 不命中）→ business error item 不炸整体', async () => {
    seedProvider({ id: 'p1', name: 'minimax_coding_plan', label: 'M1' });
    const items = await collectQuotaSnapshots(svc, fakePluginManager([])); // 空 impls
    expect(items[0]!.error!.message).toContain('未注册');
  });

  it('零 coding plan provider → items:[]', async () => {
    seedProvider({ id: 'p1', name: 'anthropic_compatible', label: '通用' });
    const items = await collectQuotaSnapshots(svc, fakePluginManager([]));
    expect(items).toEqual([]);
  });
});

describe('handleProviderQuota — GET 读 store 语义（363 §1.3）', () => {
  it('store 有数据：读视图秒回 {items, lastSyncedAt}', async () => {
    const store = new QuotaStore();
    const snap = { ...okSnapshot('p1'), providerLabel: 'K1' };
    store.replaceAll([snap], 12345);
    const resp = handleProviderQuota('GET', store, fakeSyncService(store));
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ items: [snap], lastSyncedAt: 12345 });
  });

  it('store 空（启动空窗）：异步触发首轮不等待 + 立即返回空视图', async () => {
    const store = new QuotaStore();
    const svc0 = new QuotaSyncService({
      svc: undefined as unknown as AppConfigService,
      pluginManager: fakePluginManager([]),
      store,
    });
    // 未 start 的服务：triggerSync 也应被调用（POST/GET 共用入口）
    const t0 = Date.now();
    const resp = handleProviderQuota('GET', store, svc0);
    expect(Date.now() - t0).toBeLessThan(50); // 秒回不等 collect
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ items: [], lastSyncedAt: null });
    // 节流标记已推进（证明 triggerSync 被触发过）
    expect(svc0.lastTriggeredAt).toBeGreaterThan(0);
  });

  it('store 空但已在 30s 节流窗内：不重复触发（返回仍秒回空）', async () => {
    const store = new QuotaStore();
    const svc0 = new QuotaSyncService({
      svc: undefined as unknown as AppConfigService,
      pluginManager: fakePluginManager([]),
      store,
    });
    svc0.triggerSync(); // 第一次触发（进节流窗）
    const before = svc0.lastTriggeredAt;
    const resp = handleProviderQuota('GET', store, svc0);
    expect(resp.status).toBe(200);
    expect(await resp.json()).toEqual({ items: [], lastSyncedAt: null });
    expect(svc0.lastTriggeredAt).toBe(before); // 节流命中不更新
  });

  it('非 GET → 405', async () => {
    const store = new QuotaStore();
    const resp = handleProviderQuota('POST', store, fakeSyncService(store));
    expect(resp.status).toBe(405);
  });
});

describe('handleProviderQuotaSync — POST 触发增量（363 §1.3）', () => {
  it('接受触发 → 202 {syncing:true, lastTriggeredAt}', async () => {
    const store = new QuotaStore();
    const svc0 = new QuotaSyncService({
      svc: undefined as unknown as AppConfigService,
      pluginManager: fakePluginManager([]),
      store,
    });
    const resp = handleProviderQuotaSync('POST', svc0);
    expect(resp.status).toBe(202);
    const body = (await resp.json()) as { syncing: boolean; lastTriggeredAt?: number };
    expect(body.syncing).toBe(true);
    expect(body.lastTriggeredAt).toBeGreaterThan(0);
    svc0.stop(); // 清理 inFlight promise 链（collect stub 同步空）
  });

  it('节流命中 → 202 {syncing:false, reason:"throttled"}', async () => {
    const store = new QuotaStore();
    const svc0 = new QuotaSyncService({
      svc: undefined as unknown as AppConfigService,
      pluginManager: fakePluginManager([]),
      store,
    });
    await svc0.syncOnce(); // 直接等第一轮完成（lastTriggeredAt 已设、inFlight 已清——隔离节流分支）
    const resp = handleProviderQuotaSync('POST', svc0);
    expect(resp.status).toBe(202);
    const body = (await resp.json()) as { syncing: boolean; reason?: string };
    expect(body.syncing).toBe(false);
    expect(body.reason).toBe('throttled');
    svc0.stop();
  });

  it('非 POST → 405', async () => {
    const store = new QuotaStore();
    const resp = handleProviderQuotaSync('GET', fakeSyncService(store));
    expect(resp.status).toBe(405);
  });
});
