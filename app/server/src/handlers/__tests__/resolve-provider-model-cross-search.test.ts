/**
 * resolveProviderModel 跨 provider 搜索 UT（v0.0.33.2 round-3 BUG-3 修复验证）
 * 参考: specs/tech/version_logs/v0.0.33.2/change_log.md §2.B（studio session 无 providerId 激活）
 *
 * 验证：无 providerId 但有 modelId 时，跨 enabled providers 搜首个托管该 model 的 provider。
 *   修前只查 providers[0]（app_config 默认 provider）→ model 不在其列即 ModelNotFoundError
 *   → studio session（leader/mate 由 squad-service 建，无 providerId）经 a2a deliverTo 激活失败。
 *
 * 文件系统隔离：用 mkdtempSync 建临时 app_config，不读写真实路径。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigService } from '../../config/app-config-service';
import { resolveProviderModel } from '../session-provider-utils';

let tmpRoot: string;
let appConfig: AppConfigService;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-rpm-'));
  appConfig = new AppConfigService({ root: tmpRoot });
  // 两个 enabled provider：default-prov（默认，托管 default-model）+ minimax-prov（托管 MiniMax-M3）
  appConfig.set('providers', 'default-prov', {
    id: 'default-prov', name: 'default', enabled: true, kind: 'mock', credential: {},
    models: [{ modelId: 'default-model' }],
  });
  appConfig.set('providers', 'minimax-prov', {
    id: 'minimax-prov', name: 'minimax', enabled: true, kind: 'mock', credential: {},
    models: [{ modelId: 'MiniMax-M3' }],
  });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('[round-3 BUG-3] resolveProviderModel 跨 provider 搜索', () => {
  it('无 providerId + modelId 在非默认 provider → 命中该 provider（跨搜）', () => {
    // studio leader 激活场景：无 providerId，model=MiniMax-M3（在 minimax-prov 不在 default-prov）
    const r = resolveProviderModel(appConfig, undefined, 'MiniMax-M3', {});
    expect(r.providerId).toBe('minimax-prov');
    expect(r.modelId).toBe('MiniMax-M3');
  });

  it('无 providerId + modelId 在默认 provider → 命中默认 provider（兼容）', () => {
    const r = resolveProviderModel(appConfig, undefined, 'default-model', {});
    expect(r.providerId).toBe('default-prov');
    expect(r.modelId).toBe('default-model');
  });

  it('显式 providerId 优先（不跨搜）— [v0.0.36] model 不在该 provider 兜底到其首个 enabled model（不再抛）', () => {
    // 修前：model 不在显式 provider 即抛 ModelNotFoundError。
    // v0.0.36 运行时兜底：model miss 落到该 provider 的首个 enabled model（救活存量非法 modelDefault）。
    const r = resolveProviderModel(appConfig, 'default-prov', 'MiniMax-M3', {});
    expect(r.providerId).toBe('default-prov'); // 不跨搜到 minimax-prov
    expect(r.modelId).toBe('default-model'); // 兜底到 default-prov 的首个 enabled model
  });

  it('无 providerId + 无 modelId → providers[0] + 其首个 model（原行为不变，顺序无关）', () => {
    const r = resolveProviderModel(appConfig, undefined, undefined, {});
    // providers[0] 顺序由 listGroup 决定（非插入序），仅断言合法 provider + 命中 model
    expect(['default-prov', 'minimax-prov']).toContain(r.providerId);
    expect(['default-model', 'MiniMax-M3']).toContain(r.modelId);
  });

  it('无 providerId + modelId 全无 provider 托管 → [v0.0.36] 兜底 providers[0] 的首个 enabled model（不再抛）', () => {
    // 修前：跨搜无命中 → fallback providers[0] → model 仍 miss → 抛 ModelNotFoundError。
    // v0.0.36：model miss 兜底到 providers[0] 的首个 enabled model（救活存量非法 modelDefault）。
    const r = resolveProviderModel(appConfig, undefined, 'no-such-model', {});
    expect(['default-prov', 'minimax-prov']).toContain(r.providerId);
    // 兜底到该 provider 的首个 enabled model（每个 provider 各有一个 model）
    expect(['default-model', 'MiniMax-M3']).toContain(r.modelId);
  });

  it('session 持久 providerId + 无 body 覆盖 → 用 session provider（持久优先于跨搜）', () => {
    // 即便 model 在别的 provider，session 持久 providerId 权威（a2a 不该跨搜覆盖显式绑定）
    const r = resolveProviderModel(appConfig, undefined, undefined, {
      providerId: 'minimax-prov', modelId: 'MiniMax-M3',
    });
    expect(r.providerId).toBe('minimax-prov');
    expect(r.modelId).toBe('MiniMax-M3');
  });
});
