/**
 * observability 占位 merge helper 单测（GET 无域特化——secretKey 明文透传由通用 KV 走，无需专测）。
 * 参考: tests/api/observability/dev_config_observability_crud_tc1（AT case 断言口径）
 *       specs/tech/config/[P0]app_config.md §3.9（secretKey 处理契约）
 *
 * 覆盖：
 *   1. mergeObservabilityPlaceholderSecrets：占位 '***' → 落盘原值；明文 → 用入参；新增项误送占位 → 空串
 *   2. isObservabilityKV：仅 (runtime, observability) 命中
 */
import { describe, it, expect } from 'vitest';
import {
  isObservabilityKV,
  mergeObservabilityPlaceholderSecrets,
  SECRET_REDACT_PLACEHOLDER,
} from '../observability-redact';
import type { ObservabilityConfigItem } from '../../observability/observability-manager';

// helper: 构造一个完整 item（默认 enabled=true）
const makeItem = (over: Partial<ObservabilityConfigItem> = {}): ObservabilityConfigItem => ({
  id: '01J',
  name: 'self-host',
  type: 'langfuse',
  baseUrl: 'http://localhost:3000',
  publicKey: 'pk-lf-real',
  secretKey: 'sk-lf-real',
  enabled: true,
  ...over,
});

describe('isObservabilityKV', () => {
  it('(runtime, observability) 命中', () => {
    expect(isObservabilityKV('runtime', 'observability')).toBe(true);
  });
  it('其他 group/key 不命中', () => {
    expect(isObservabilityKV('runtime', 'maxParallelTools')).toBe(false);
    expect(isObservabilityKV('agent', 'observability')).toBe(false);
    expect(isObservabilityKV(null, 'observability')).toBe(false);
    expect(isObservabilityKV('runtime', null)).toBe(false);
  });
});

describe('mergeObservabilityPlaceholderSecrets', () => {
  it('secretKey === *** 视为不改 → 用同 id 落盘原值', () => {
    const existing = [makeItem({ id: 'a', secretKey: 'sk-real-123', name: 'Old' })];
    const incoming = [
      makeItem({ id: 'a', secretKey: SECRET_REDACT_PLACEHOLDER, name: 'Updated' }),
    ];
    const merged = mergeObservabilityPlaceholderSecrets(incoming, existing);
    expect(merged[0]!.secretKey).toBe('sk-real-123'); // 落盘原值
    expect(merged[0]!.name).toBe('Updated'); // 其他字段正常覆盖
  });

  it('secretKey 非 *** （用户新填明文）→ 直接落盘', () => {
    const existing = [makeItem({ id: 'a', secretKey: 'sk-old' })];
    const incoming = [makeItem({ id: 'a', secretKey: 'sk-new-456' })];
    const merged = mergeObservabilityPlaceholderSecrets(incoming, existing);
    expect(merged[0]!.secretKey).toBe('sk-new-456');
  });

  it('新增项（id 落盘不存在）+ 占位 → 空串（防御：不应误用历史值）', () => {
    const existing = [makeItem({ id: 'a', secretKey: 'sk-real' })];
    const incoming = [
      makeItem({ id: 'b', secretKey: SECRET_REDACT_PLACEHOLDER, name: 'new' }),
    ];
    const merged = mergeObservabilityPlaceholderSecrets(incoming, existing);
    expect(merged[0]!.secretKey).toBe('');
    expect(merged[0]!.id).toBe('b');
  });

  it('新增项 + 明文 → 明文落盘', () => {
    const existing: ObservabilityConfigItem[] = [];
    const incoming = [makeItem({ id: 'new1', secretKey: 'sk-fresh' })];
    const merged = mergeObservabilityPlaceholderSecrets(incoming, existing);
    expect(merged[0]!.secretKey).toBe('sk-fresh');
  });

  it('混合：多项部分占位部分明文', () => {
    const existing = [
      makeItem({ id: 'a', secretKey: 'sk-a' }),
      makeItem({ id: 'b', secretKey: 'sk-b' }),
    ];
    const incoming = [
      makeItem({ id: 'a', secretKey: SECRET_REDACT_PLACEHOLDER }), // 占位 → 落盘 sk-a
      makeItem({ id: 'b', secretKey: 'sk-b-new' }), // 明文 → 直接落
      makeItem({ id: 'c', secretKey: 'sk-c-new' }), // 新增 → 直接落
    ];
    const merged = mergeObservabilityPlaceholderSecrets(incoming, existing);
    expect(merged[0]!.secretKey).toBe('sk-a');
    expect(merged[1]!.secretKey).toBe('sk-b-new');
    expect(merged[2]!.secretKey).toBe('sk-c-new');
  });

  it('原 incoming 对象不被 mutate（merge 不可变）', () => {
    const existing = [makeItem({ id: 'a', secretKey: 'sk-real' })];
    const incoming = [makeItem({ id: 'a', secretKey: SECRET_REDACT_PLACEHOLDER })];
    mergeObservabilityPlaceholderSecrets(incoming, existing);
    expect(incoming[0]!.secretKey).toBe(SECRET_REDACT_PLACEHOLDER);
  });

  it('删除语义：incoming 不含的 existing id 不会出现在 merged（整组覆盖语义）', () => {
    const existing = [
      makeItem({ id: 'a', secretKey: 'sk-a' }),
      makeItem({ id: 'b', secretKey: 'sk-b' }),
    ];
    // 整组只留 a（删除 b）
    const incoming = [makeItem({ id: 'a', secretKey: SECRET_REDACT_PLACEHOLDER })];
    const merged = mergeObservabilityPlaceholderSecrets(incoming, existing);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.id).toBe('a');
    expect(merged[0]!.secretKey).toBe('sk-a');
  });
});
