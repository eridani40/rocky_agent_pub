/**
 * fallback_key_selector 单测(v2.0 — 四元组 key)
 * 参考: specs/tech/agent/llm_caller/[P0]llm_request_config.md §1.4 + §3-§4
 *       specs/tech/agent/llm_caller/[P0]provider_health_registry.md §4(account-wide quota)
 *
 * [v0.0.25 rev2] pickFirstAvailableTarget(单遍)已移除,两遍扫描归 resolve_target.ts。
 *   本 UT 覆盖保留的 helper: isAccountWideSkip / probeHealth / selectKey / hasRotatableKey。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createProviderHealthRegistry,
  __resetProviderHealthRegistryForTest,
  type ProviderHealthRegistry,
} from '../provider_health_registry';
import {
  isAccountWideSkip,
  probeHealth,
  selectKey,
  hasRotatableKey,
} from '../fallback_key_selector';
import type { LlmProviderConfig } from '../../provider-types';

const SID = 'sess-a';
const PID = 'p1';
const MODEL = 'm1';
let health: ProviderHealthRegistry;
const NOW = 1_000_000;

beforeEach(() => {
  __resetProviderHealthRegistryForTest();
  health = createProviderHealthRegistry();
});

/** 构造最小 LlmProviderConfig（credentials 可单/多 key） */
function mkProvider(
  id: string,
  credentials: LlmProviderConfig['credentials'],
): LlmProviderConfig {
  return {
    id, name: 'anthropic_compatible', protocolId: 'anthropic_messages', baseUrl: 'https://api.example.com',
    credentials, pluginId: 'builtin.anthropic', enabled: true, models: [],
  };
}

describe('isAccountWideSkip（§4 account-wide quota 例外）', () => {
  it('per_key + healthy → 不跳过（返 false）', () => {
    const cred = { key: 'sk-perkey' };
    expect(isAccountWideSkip(cred, 'default', health, SID, PID, MODEL, NOW)).toBe(false);
  });

  it('account_wide + healthy → 不跳过（可用）', () => {
    const cred = {
      keys: [{ keyRef: 'default', keyValue: 'k1', quotaScope: 'account_wide' as const }],
    };
    expect(isAccountWideSkip(cred, 'default', health, SID, PID, MODEL, NOW)).toBe(false);
  });

  it('account_wide + dead → 跳过（不轮换，直接换 provider）', () => {
    const cred = {
      keys: [{ keyRef: 'default', keyValue: 'k1', quotaScope: 'account_wide' as const }],
    };
    health.markDead(SID, PID, 'default', MODEL, 'auth invalid', NOW);
    expect(isAccountWideSkip(cred, 'default', health, SID, PID, MODEL, NOW)).toBe(true);
  });

  it('per_key + dead → 不跳过（per-key 可轮换，由 decide 处理）', () => {
    const cred = { key: 'sk-perkey' };
    health.markDead(SID, PID, 'default', MODEL, 'auth invalid', NOW);
    // per_key + 不可用：isAccountWideSkip 返 false（不跳过，由 decide 决定 ROTATE_KEY）
    expect(isAccountWideSkip(cred, 'default', health, SID, PID, MODEL, NOW)).toBe(false);
  });
});

describe('probeHealth（叠加 account-wide 例外的健康探测）', () => {
  it('healthy → ok:true tier:healthy', () => {
    const cred = { key: 'sk-perkey' };
    const probe = probeHealth(cred, 'default', health, SID, PID, MODEL, NOW);
    expect(probe.ok).toBe(true);
    expect(probe.tier).toBe('healthy');
  });

  it('account_wide + dead → ok:false（account-wide 例外叠加,排除）', () => {
    const cred = {
      keys: [{ keyRef: 'default', keyValue: 'k1', quotaScope: 'account_wide' as const }],
    };
    health.markDead(SID, PID, 'default', MODEL, 'auth', NOW);
    const probe = probeHealth(cred, 'default', health, SID, PID, MODEL, NOW);
    expect(probe.ok).toBe(false);
  });
});

describe('selectKey', () => {
  it('取 keyValue + keyRef', () => {
    const selected = selectKey(
      {
        keys: [
          { keyRef: 'default', keyValue: 'k1', quotaScope: 'per_key' },
          { keyRef: 'backup', keyValue: 'k2', quotaScope: 'per_key' },
        ],
      },
      'backup',
    );
    expect(selected).toEqual({ keyValue: 'k2', keyRef: 'backup' });
  });

  it('空 credentials → undefined', () => {
    expect(selectKey(undefined, 'default')).toBeUndefined();
  });
});

describe('hasRotatableKey（同 provider 是否有 per_key 备用 key）', () => {
  it('多 per_key key → true', () => {
    expect(
      hasRotatableKey(
        {
          keys: [
            { keyRef: 'default', keyValue: 'k1', quotaScope: 'per_key' },
            { keyRef: 'backup', keyValue: 'k2', quotaScope: 'per_key' },
          ],
        },
        'default',
      ),
    ).toBe(true);
  });

  it('单 key → false（无备用）', () => {
    expect(hasRotatableKey({ key: 'sk-single' }, 'default')).toBe(false);
  });

  it('多 key 但全是 account_wide → false（account-wide 不轮换）', () => {
    expect(
      hasRotatableKey(
        {
          keys: [
            { keyRef: 'a', keyValue: 'k1', quotaScope: 'account_wide' },
            { keyRef: 'b', keyValue: 'k2', quotaScope: 'account_wide' },
          ],
        },
        'a',
      ),
    ).toBe(false);
  });

  it('混合：有其他 per_key key → false（仅 per_key 算可轮换）', () => {
    expect(
      hasRotatableKey(
        {
          keys: [
            { keyRef: 'a', keyValue: 'k1', quotaScope: 'per_key' },
            { keyRef: 'b', keyValue: 'k2', quotaScope: 'account_wide' },
          ],
        },
        'a',
      ),
    ).toBe(false); // 'b' 是 account_wide 不算可轮换
  });
});
