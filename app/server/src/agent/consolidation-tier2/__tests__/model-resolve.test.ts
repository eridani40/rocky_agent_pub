/**
 * resolveConsolidationModel 单测（白盒 vitest）
 * 参考: specs/tech/agent/memory/[P0]consolidation_tier2.md §5.4
 *
 * 覆盖：configModelId 缺失 → null；modelId 设置但无 provider 承载 → null；
 *       modelId 命中某 enabled provider → 返回 {providerId, modelId}；
 *       provider 存在但 enabled=false（不进 listEnabledProviders）→ null。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigService } from '../../../config/app-config-service';
import { resolveConsolidationModel } from '../model-resolve';

let tmpRoot: string;
let appConfig: AppConfigService;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'rocky-t2-model-resolve-'));
  appConfig = new AppConfigService({ root: tmpRoot });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function seedProvider(overrides: { id?: string; enabled?: boolean; modelId?: string } = {}) {
  const id = overrides.id ?? 'prov-1';
  appConfig.set('providers', id, {
    id,
    name: 'anthropic_compatible',
    label: 'Test',
    baseUrl: 'https://api.example.com',
    credentials: { key: 'sk-test' },
    enabled: overrides.enabled ?? true,
    models: [
      {
        modelId: overrides.modelId ?? 'model-a',
        protocolId: 'anthropic_messages',
        contextWindow: 200000,
        maxOutputTokens: 4096,
        label: 'Model A',
        enabled: true,
      },
    ],
  });
}

describe('resolveConsolidationModel', () => {
  it('consolidation 配置 record 不存在 → null（未配置）', () => {
    expect(resolveConsolidationModel(appConfig)).toBeNull();
  });

  it('modelId 未设置（enabled=true 但 modelId 缺失）→ null', () => {
    appConfig.set('consolidation', 'default', { enabled: true, dailyTime: '04:00' });
    expect(resolveConsolidationModel(appConfig)).toBeNull();
  });

  it('modelId 设置但无任何 enabled provider 承载 → null（反查失败）+ console.warn 留痕区分两种 null', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    appConfig.set('consolidation', 'default', {
      enabled: true, dailyTime: '04:00', modelId: 'ghost-model',
    });
    expect(resolveConsolidationModel(appConfig)).toBeNull();
    // 「modelId 缺失」分支不应打印（无歧义，静默返回即可）；只有「配置了但反查不到」才留痕
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('ghost-model');
    warnSpy.mockRestore();
  });

  it('modelId 命中某 enabled provider → 返回 {providerId, modelId}', () => {
    seedProvider({ id: 'prov-1', modelId: 'model-a' });
    appConfig.set('consolidation', 'default', {
      enabled: true, dailyTime: '04:00', modelId: 'model-a',
    });
    expect(resolveConsolidationModel(appConfig)).toEqual({ providerId: 'prov-1', modelId: 'model-a' });
  });

  it('承载该 modelId 的 provider 是 enabled=false → null（listEnabledProviders 已过滤掉）', () => {
    seedProvider({ id: 'prov-disabled', modelId: 'model-a', enabled: false });
    appConfig.set('consolidation', 'default', {
      enabled: true, dailyTime: '04:00', modelId: 'model-a',
    });
    expect(resolveConsolidationModel(appConfig)).toBeNull();
  });

  it('不复用 resolveModel(): resolveConsolidationModel 不依赖 session/squad/member 语境即可工作', () => {
    seedProvider({ id: 'prov-2', modelId: 'model-b' });
    appConfig.set('consolidation', 'default', {
      enabled: true, dailyTime: '09:30', modelId: 'model-b',
    });
    const r = resolveConsolidationModel(appConfig);
    expect(r).toEqual({ providerId: 'prov-2', modelId: 'model-b' });
  });
});
