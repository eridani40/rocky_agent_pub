/**
 * v0.0.363 QuotaSyncService + QuotaStore UT — 周期/首轮/防重入/节流/SSE emit（change_plan §1.2/§1.4）
 * 覆盖：
 *   store：replaceAll 覆盖语义 / view 视图 / isEmpty / lastSyncedAt
 *   sync-service：启动首轮立即跑 + interval 周期 / inFlight 防重入 / 30s 节流 /
 *     collect → store 全量覆盖（含 error item）→ SSE emit / 失败 fail-silent 保上轮值 /
 *     start/stop 生命周期 / parseQuotaSyncIntervalMs env 解析
 * fake timers 驱动周期推进；collect 走真 collectQuotaSnapshots（真 AppConfigService 空/种子
 * provider + fake pluginManager impl stub——fetch 隔离不打真网）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { QuotaStore } from '../quota-store';
import {
  QuotaSyncService,
  parseQuotaSyncIntervalMs,
  DEFAULT_QUOTA_SYNC_INTERVAL_MS,
} from '../quota-sync-service';
import { AppConfigService } from '../../config/app-config-service';
import type { ProviderInstance } from '../../handlers/provider';
import type { LlmProvider } from '../provider';
import type { QuotaSnapshot } from '../provider-types';
import type { PluginManager } from '../../plugin/plugin-manager';

let tmpRoot: string;
let svcConfig: AppConfigService;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'oobt-quota-sync-'));
  svcConfig = new AppConfigService({ root: tmpRoot });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const snap = (pid: string, over: Partial<QuotaSnapshot> = {}): QuotaSnapshot => ({
  providerId: pid, providerLabel: pid, implId: 'kimi_coding_plan', kind: 'quota',
  fetchedAt: 1, ...over,
});

/** 落盘一个 native provider 实例（collect 真路径数据源） */
function seedProvider(id: string): void {
  svcConfig.set('providers', id, {
    id, name: 'kimi_coding_plan', label: `L-${id}`, protocolId: 'anthropic_messages',
    baseUrl: 'https://x.example.com', credentials: { key: 'sk-t' }, enabled: true, models: [],
  } as ProviderInstance);
}

/** fake pluginManager：按 implId 返回 queryQuota stub */
function fakePm(impls: Array<Partial<LlmProvider> & { implId: string }>): PluginManager {
  return { getExtensionImpls: () => impls as LlmProvider[] } as unknown as PluginManager;
}

/** 构造 service（真 svc + 可选 emit spy；不 start） */
function mkService(store: QuotaStore, opts: {
  pm?: PluginManager; emit?: (group: string, frame: unknown) => void; intervalMs?: number;
} = {}): QuotaSyncService {
  const bus = opts.emit
    ? ({ emit: opts.emit } as unknown as ConstructorParameters<typeof QuotaSyncService>[0]['bus'])
    : undefined;
  return new QuotaSyncService({
    svc: svcConfig,
    pluginManager: opts.pm ?? fakePm([]),
    store,
    bus,
    intervalMs: opts.intervalMs,
  });
}

describe('QuotaStore — 内存权威源', () => {
  it('replaceAll 全量覆盖（旧项清除）+ lastSyncedAt 推进', () => {
    const s = new QuotaStore();
    s.replaceAll([snap('p1'), snap('p2')], 100);
    expect(s.view().items.map((i) => i.providerId)).toEqual(['p1', 'p2']);
    s.replaceAll([snap('p3')], 200);
    const v = s.view();
    expect(v.items.map((i) => i.providerId)).toEqual(['p3']); // p1/p2 已清
    expect(v.lastSyncedAt).toBe(200);
    expect(s.lastSyncedAt).toBe(200);
  });

  it('isEmpty：初始空 → 写入后非空；空数组同步也推进时间', () => {
    const s = new QuotaStore();
    expect(s.isEmpty()).toBe(true);
    s.replaceAll([], 1); // 零 native provider 也是有效同步
    expect(s.isEmpty()).toBe(true); // 仍无 item
    expect(s.view().lastSyncedAt).toBe(1); // 但时间已推进
    s.replaceAll([snap('p1')], 2);
    expect(s.isEmpty()).toBe(false);
  });

  it('view 返回快照拷贝（外部 mutate 不污染内部 Map）', () => {
    const s = new QuotaStore();
    s.replaceAll([snap('p1')], 1);
    const v = s.view();
    v.items.push(snap('injected'));
    expect(s.view().items).toHaveLength(1); // 内部未受影响
  });
});

describe('QuotaSyncService — 生命周期与节流（fake timers）', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('start 立即跑首轮（不等 interval）+ interval 到点跑周期轮', async () => {
    seedProvider('p1');
    const store = new QuotaStore();
    const svc = mkService(store, {
      intervalMs: 60_000,
      pm: fakePm([{ implId: 'kimi_coding_plan', queryQuota: async () => snap('p1') }]),
    });
    svc.start();
    await vi.advanceTimersByTimeAsync(0); // 首轮 microtask 链 flush
    expect(store.lastSyncedAt).not.toBeNull(); // 首轮已写 store（不等 interval）
    const first = store.lastSyncedAt;
    await vi.advanceTimersByTimeAsync(60_000); // 推进一个 interval
    expect(store.lastSyncedAt!).toBeGreaterThan(first!); // 周期轮再跑
    svc.stop();
    expect(svc.hasTimer()).toBe(false);
  });

  it('stop 后 interval 不再触发', async () => {
    const store = new QuotaStore();
    const svc = mkService(store, { intervalMs: 50 });
    svc.start();
    await vi.advanceTimersByTimeAsync(0);
    const at = store.lastSyncedAt;
    svc.stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(store.lastSyncedAt).toBe(at); // 无新轮
  });

  it('triggerSync：接受触发；30s 内重复触发 → throttled；窗外再接受', async () => {
    const store = new QuotaStore();
    const svc = mkService(store);
    expect(svc.triggerSync()).toBeNull(); // 接受
    await vi.advanceTimersByTimeAsync(0); // flush 首轮 fire-and-forget 链完成
    expect(store.lastSyncedAt).not.toBeNull();
    vi.advanceTimersByTime(10_000);
    expect(svc.triggerSync()).toBe('throttled'); // 节流窗内（inFlight 已清，走节流分支）
    vi.advanceTimersByTime(25_000); // 累计 35s > 30s
    expect(svc.triggerSync()).toBeNull(); // 窗外再接受
    await vi.advanceTimersByTimeAsync(0);
    svc.stop();
  });

  it('syncOnce 防重入：collect 挂起期间并发 syncOnce/triggerSync → 第二次直接跳过', async () => {
    seedProvider('p1');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const store = new QuotaStore();
    const svc = mkService(store, {
      pm: fakePm([{ implId: 'kimi_coding_plan', queryQuota: () => gate.then(() => snap('p1')) }]),
    });
    const first = svc.syncOnce(); // 挂起（queryQuota 等 gate）
    expect(svc.isInFlight()).toBe(true);
    // 并发第二次：inFlight 互斥直接 return（不等第一轮）
    const second = svc.syncOnce();
    expect(svc.triggerSync()).toBe('in_flight'); // trigger 也被挡
    release(); // 放行第一轮
    await Promise.all([first, second]);
    expect(store.lastSyncedAt).not.toBeNull(); // 第一轮写入
    expect(svc.isInFlight()).toBe(false);
  });

  it('syncOnce：collect → store 覆盖（含 error item）→ SSE emit 恰一次', async () => {
    // p1 正常（kimi impl）+ p2 抛错（glm impl）→ error item 也进 store（错误态也是状态）
    svcConfig.set('providers', 'p1', {
      id: 'p1', name: 'kimi_coding_plan', label: 'K1', protocolId: 'anthropic_messages',
      baseUrl: 'https://x.example.com', credentials: { key: 'sk-t' }, enabled: true, models: [],
    } as ProviderInstance);
    svcConfig.set('providers', 'p2', {
      id: 'p2', name: 'glm_coding_plan', label: 'G1', protocolId: 'anthropic_messages',
      baseUrl: 'https://x.example.com', credentials: { key: 'sk-t' }, enabled: true, models: [],
    } as ProviderInstance);
    const store = new QuotaStore();
    const frames: Array<{ group: string; data: unknown; ts: string }> = [];
    const svc = mkService(store, {
      pm: fakePm([
        { implId: 'kimi_coding_plan', queryQuota: async () => snap('p1') },
        { implId: 'glm_coding_plan', queryQuota: async () => { throw new Error('boom'); } },
      ]),
      emit: (group, frame) => {
        const f = frame as { data: unknown; timestamp: string };
        frames.push({ group, data: f.data, ts: f.timestamp });
      },
    });
    await svc.syncOnce();
    expect(store.lastSyncedAt).not.toBeNull();
    expect(frames).toHaveLength(1); // 恰一次广播
    expect(frames[0]!.group).toBe('_all');
    const view = frames[0]!.data as { items: QuotaSnapshot[]; lastSyncedAt: number };
    expect(view.items).toHaveLength(2); // ok + error item 都进 store
    expect(view.items.find((i) => i.providerId === 'p2')!.error!.message).toBe('boom');
    expect(typeof frames[0]!.ts).toBe('string'); // ISO 字符串（app-task-lock 先例）
  });

  it('syncOnce 失败 fail-silent：保留上轮 store 值不推进', async () => {
    seedProvider('p1');
    const store = new QuotaStore();
    store.replaceAll([snap('old')], 111); // 上轮有效值
    // collect 整体炸：pluginManager 抛错（getExtensionImpls throw）
    const svc = new QuotaSyncService({
      svc: svcConfig,
      pluginManager: { getExtensionImpls: () => { throw new Error('pm boom'); } } as never,
      store,
    });
    await svc.syncOnce(); // 不抛（fail-silent）
    expect(store.lastSyncedAt).toBe(111); // 保留上轮
    expect(store.view().items[0]!.providerId).toBe('old');
  });
});

describe('parseQuotaSyncIntervalMs — env 解析', () => {
  it('undefined → 默认 5min', () => {
    expect(parseQuotaSyncIntervalMs(undefined)).toBe(DEFAULT_QUOTA_SYNC_INTERVAL_MS);
    expect(DEFAULT_QUOTA_SYNC_INTERVAL_MS).toBe(300_000);
  });
  it('合法数字字符串 → 解析取整', () => {
    expect(parseQuotaSyncIntervalMs('60000')).toBe(60_000);
    expect(parseQuotaSyncIntervalMs('1000.9')).toBe(1000);
  });
  it('非法值（NaN/非正）→ 回落默认', () => {
    expect(parseQuotaSyncIntervalMs('abc')).toBe(DEFAULT_QUOTA_SYNC_INTERVAL_MS);
    expect(parseQuotaSyncIntervalMs('0')).toBe(DEFAULT_QUOTA_SYNC_INTERVAL_MS);
    expect(parseQuotaSyncIntervalMs('-5')).toBe(DEFAULT_QUOTA_SYNC_INTERVAL_MS);
  });
});
