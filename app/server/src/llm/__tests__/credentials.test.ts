/**
 * credentials 多 key 解析 + keyRef 选择器单测
 * 参考: specs/tech/agent/providers_and_models/[P0]llm_provider_interface.md §3.3
 *       specs/tech/agent/llm_caller/[P0]llm_request_config.md §3
 *
 * 覆盖：
 *   - resolveCredentials 单 key 向后兼容（等价 [{keyRef:"default", quotaScope:"per_key"}]）
 *   - resolveCredentials 多 key 透传
 *   - resolveKey 按 keyRef 选指定 key（精确匹配 / 未命中回退 default / 兜底首项）
 *   - isAccountWideQuota / isAllAccountWide quotaScope 判定
 *   - pickKeyValue 取 keyValue
 */
import { describe, it, expect } from 'vitest';
import {
  resolveCredentials,
  resolveKey,
  isAccountWideQuota,
  isAllAccountWide,
  pickKeyValue,
  DEFAULT_KEY_REF,
} from '../credentials';

describe('resolveCredentials 单 key 向后兼容（§3.3）', () => {
  it('单 key {key} → [{keyRef:"default", quotaScope:"per_key"}]', () => {
    const keys = resolveCredentials({ key: 'sk-ant-xxx' });
    expect(keys).toHaveLength(1);
    expect(keys[0]!.keyRef).toBe(DEFAULT_KEY_REF);
    expect(keys[0]!.keyValue).toBe('sk-ant-xxx');
    expect(keys[0]!.quotaScope).toBe('per_key');
  });

  it('多 key {keys[]} → 原样透传', () => {
    const keys = resolveCredentials({
      keys: [
        { keyRef: 'default', keyValue: 'k1', quotaScope: 'per_key' },
        { keyRef: 'backup', keyValue: 'k2', quotaScope: 'per_key' },
      ],
    });
    expect(keys).toHaveLength(2);
    expect(keys[0]!.keyRef).toBe('default');
    expect(keys[1]!.keyValue).toBe('k2');
  });

  it('undefined credentials → 空数组', () => {
    expect(resolveCredentials(undefined)).toEqual([]);
  });

  it('weight 字段保留（多 key 时可选权重）', () => {
    const keys = resolveCredentials({
      keys: [
        { keyRef: 'default', keyValue: 'k1', quotaScope: 'per_key', weight: 3 },
      ],
    });
    expect(keys[0]!.weight).toBe(3);
  });
});

describe('resolveKey 按 keyRef 选指定 key', () => {
  it('精确匹配 keyRef', () => {
    const key = resolveKey(
      {
        keys: [
          { keyRef: 'default', keyValue: 'k1', quotaScope: 'per_key' },
          { keyRef: 'backup', keyValue: 'k2', quotaScope: 'per_key' },
        ],
      },
      'backup',
    );
    expect(key?.keyValue).toBe('k2');
    expect(key?.keyRef).toBe('backup');
  });

  it('单 key 场景：keyRef 缺省 → 返 default', () => {
    const key = resolveKey({ key: 'sk-single' }, undefined);
    expect(key?.keyValue).toBe('sk-single');
    expect(key?.keyRef).toBe('default');
  });

  it('单 key 场景：keyRef="default" 显式 → 命中', () => {
    const key = resolveKey({ key: 'sk-single' }, 'default');
    expect(key?.keyValue).toBe('sk-single');
  });

  it('keyRef 未命中 → 回退到 default keyRef', () => {
    const key = resolveKey(
      {
        keys: [
          { keyRef: 'default', keyValue: 'k1', quotaScope: 'per_key' },
          { keyRef: 'backup', keyValue: 'k2', quotaScope: 'per_key' },
        ],
      },
      'nonexistent',
    );
    // 回退到 default
    expect(key?.keyValue).toBe('k1');
    expect(key?.keyRef).toBe('default');
  });

  it('多 key 无 default + keyRef 未命中 → 兜底返首个', () => {
    const key = resolveKey(
      {
        keys: [
          { keyRef: 'pool-1', keyValue: 'k1', quotaScope: 'per_key' },
          { keyRef: 'pool-2', keyValue: 'k2', quotaScope: 'per_key' },
        ],
      },
      undefined,
    );
    // 无 default，兜底返首个
    expect(key?.keyValue).toBe('k1');
  });

  it('空 credentials → undefined', () => {
    expect(resolveKey(undefined, 'default')).toBeUndefined();
  });
});

describe('isAccountWideQuota（§4 quotaScope 判定）', () => {
  it('account_wide key → true', () => {
    expect(
      isAccountWideQuota(
        {
          keys: [
            {
              keyRef: 'default',
              keyValue: 'k1',
              quotaScope: 'account_wide',
            },
          ],
        },
        'default',
      ),
    ).toBe(true);
  });

  it('per_key key → false', () => {
    expect(
      isAccountWideQuota(
        {
          keys: [
            { keyRef: 'default', keyValue: 'k1', quotaScope: 'per_key' },
          ],
        },
        'default',
      ),
    ).toBe(false);
  });

  it('单 key 向后兼容 → per_key（false）', () => {
    expect(isAccountWideQuota({ key: 'sk-xxx' }, 'default')).toBe(false);
  });

  it('混合 pool：选中的 keyRef 是 account_wide → true', () => {
    expect(
      isAccountWideQuota(
        {
          keys: [
            { keyRef: 'default', keyValue: 'k1', quotaScope: 'per_key' },
            {
              keyRef: 'enterprise',
              keyValue: 'k2',
              quotaScope: 'account_wide',
            },
          ],
        },
        'enterprise',
      ),
    ).toBe(true);
  });
});

describe('isAllAccountWide（整个 provider 是否全 account-wide）', () => {
  it('全 account_wide → true', () => {
    expect(
      isAllAccountWide({
        keys: [
          { keyRef: 'a', keyValue: 'k1', quotaScope: 'account_wide' },
          { keyRef: 'b', keyValue: 'k2', quotaScope: 'account_wide' },
        ],
      }),
    ).toBe(true);
  });

  it('混合 → false（有 per_key 可轮换）', () => {
    expect(
      isAllAccountWide({
        keys: [
          { keyRef: 'a', keyValue: 'k1', quotaScope: 'per_key' },
          { keyRef: 'b', keyValue: 'k2', quotaScope: 'account_wide' },
        ],
      }),
    ).toBe(false);
  });

  it('单 key 向后兼容 → false（per_key）', () => {
    expect(isAllAccountWide({ key: 'sk-xxx' })).toBe(false);
  });
});

describe('pickKeyValue', () => {
  it('单 key → keyValue', () => {
    expect(pickKeyValue({ key: 'sk-xxx' }, 'default')).toBe('sk-xxx');
  });

  it('多 key 按 keyRef 选 keyValue', () => {
    expect(
      pickKeyValue(
        {
          keys: [
            { keyRef: 'default', keyValue: 'k1', quotaScope: 'per_key' },
            { keyRef: 'backup', keyValue: 'k2', quotaScope: 'per_key' },
          ],
        },
        'backup',
      ),
    ).toBe('k2');
  });
});
