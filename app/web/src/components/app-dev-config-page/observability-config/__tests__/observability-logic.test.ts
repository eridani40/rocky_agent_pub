/**
 * @vitest-environment jsdom
 * observability-config 纯逻辑单测：dirty 判定 / 必填校验 / id 生成
 * 参考: specs/ui/components/app-dev-config-page/observability-config/_overview.md §2
 *       specs/ui/components/app-dev-config-page/observability-config/section-observability-detail.md（dirty/必填）
 *
 * 覆盖点：
 *   - isObservabilityDirty：enabled 不计 dirty；其他字段变 → dirty
 *   - isObservabilityValid：4 必填字段；secretKey 非空即合法（明文 GET，SecretInput mask）
 *   - generateObsId：obs_ 前缀 + 时间戳
 *   - emptyObservabilityDraft：空壳形态
 */
import { describe, it, expect } from 'vitest';
import {
  isObservabilityDirty,
  isObservabilityValid,
  generateObsId,
  emptyObservabilityDraft,
  SECRET_REDACTED,
  type ObservabilityConfig,
} from '../types';

/** 构造一个完整有效配置（便于测试基线） */
function base(): ObservabilityConfig {
  return {
    id: 'obs_1',
    name: 'Production Tracing',
    type: 'langfuse',
    baseUrl: 'https://cloud.langfuse.com',
    publicKey: 'pk-lf-xxx',
    secretKey: 'sk-lf-yyy',
    enabled: true,
    desc: 'main',
    logPhysical: false,
  };
}

describe('isObservabilityDirty', () => {
  it('draft === saved → not dirty', () => {
    const c = base();
    expect(isObservabilityDirty(c, { ...c })).toBe(false);
  });

  it('enabled 变化不计 dirty（toggle 即时生效，spec 决策）', () => {
    const saved = base();
    const draft = { ...saved, enabled: !saved.enabled };
    expect(isObservabilityDirty(draft, saved)).toBe(false);
  });

  it('name 变化 → dirty', () => {
    const saved = base();
    const draft = { ...saved, name: 'Staging' };
    expect(isObservabilityDirty(draft, saved)).toBe(true);
  });

  it('secretKey 变化 → dirty（任何值变更均计 dirty）', () => {
    const saved = { ...base(), secretKey: 'sk-real' };
    const draft = { ...saved, secretKey: SECRET_REDACTED };
    expect(isObservabilityDirty(draft, saved)).toBe(true);
  });

  it('baseUrl / publicKey / desc 任一变 → dirty', () => {
    const saved = base();
    expect(isObservabilityDirty({ ...saved, baseUrl: 'x' }, saved)).toBe(true);
    expect(isObservabilityDirty({ ...saved, publicKey: 'x' }, saved)).toBe(true);
    expect(isObservabilityDirty({ ...saved, desc: 'x' }, saved)).toBe(true);
  });

  it('[v0.0.50] logPhysical 变化 → dirty（与 enabled 不同，需保存）', () => {
    const saved = base(); // logPhysical: false
    expect(isObservabilityDirty({ ...saved, logPhysical: true }, saved)).toBe(true);
    // 未改 → 不 dirty
    expect(isObservabilityDirty({ ...saved, logPhysical: false }, saved)).toBe(false);
  });
});

describe('isObservabilityValid', () => {
  it('全部必填非空 → valid', () => {
    expect(isObservabilityValid(base())).toBe(true);
  });

  it('name 空串 / 纯空白 → invalid', () => {
    expect(isObservabilityValid({ ...base(), name: '' })).toBe(false);
    expect(isObservabilityValid({ ...base(), name: '   ' })).toBe(false);
  });

  it('baseUrl 空串 → invalid', () => {
    expect(isObservabilityValid({ ...base(), baseUrl: '' })).toBe(false);
  });

  it('publicKey 空串 → invalid', () => {
    expect(isObservabilityValid({ ...base(), publicKey: '' })).toBe(false);
  });

  it('secretKey 空串 → invalid；非空字符串合法（包含 *** 旧哨兵兼容场景）', () => {
    expect(isObservabilityValid({ ...base(), secretKey: '' })).toBe(false);
    // 旧哨兵 '***' 非空，valid（向后兼容 PUT merge 语义）
    expect(isObservabilityValid({ ...base(), secretKey: SECRET_REDACTED })).toBe(true);
  });
});

describe('generateObsId / emptyObservabilityDraft', () => {
  it('generateObsId 返回 obs_<数字时间戳> 前缀', () => {
    const id = generateObsId();
    expect(id.startsWith('obs_')).toBe(true);
    // obs_ 后部分应为纯数字（Date.now()）
    const ts = id.slice('obs_'.length);
    expect(/^\d+$/.test(ts)).toBe(true);
  });

  it('emptyObservabilityDraft 生成空壳（仅 type/langfuse 固定，enabled=false）', () => {
    const d = emptyObservabilityDraft('obs_99');
    expect(d.id).toBe('obs_99');
    expect(d.name).toBe('');
    expect(d.type).toBe('langfuse');
    expect(d.baseUrl).toBe('');
    expect(d.publicKey).toBe('');
    expect(d.secretKey).toBe('');
    expect(d.enabled).toBe(false);
    expect(d.desc).toBe('');
  });
});
