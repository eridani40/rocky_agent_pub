/**
 * app_config web group secret 占位 merge helper 单测。
 * 参考: specs/tech/config/[P0]app_config.md §3.10（web group：jinaApiKey secret 处理契约）
 *
 * 覆盖：
 *   1. isWebSecretKV：仅 (web, jinaApiKey) 命中；web 其他 key（jinaEnabled/jinaTimeoutMs）不命中
 *   2. mergeWebSecretPlaceholder：占位 '***' → 落盘原值；明文 → 入参；落盘缺失 → 空串
 *
 * 注：GET 已改为明文返回（不再 redact），redactWebSecret 已删；本 helper 仅 PUT 占位 merge 用。
 */
import { describe, it, expect } from 'vitest';
import {
  isWebSecretKV,
  mergeWebSecretPlaceholder,
  WEB_SECRET_REDACT_PLACEHOLDER,
  WEB_GROUP,
  WEB_JINA_API_KEY,
} from '../web-config-redact';

describe('isWebSecretKV', () => {
  it('(web, jinaApiKey) 命中', () => {
    expect(isWebSecretKV(WEB_GROUP, WEB_JINA_API_KEY)).toBe(true);
  });
  it('web group 其他 key 不命中（jinaEnabled / jinaTimeoutMs 非 secret）', () => {
    expect(isWebSecretKV(WEB_GROUP, 'jinaEnabled')).toBe(false);
    expect(isWebSecretKV(WEB_GROUP, 'jinaTimeoutMs')).toBe(false);
  });
  it('其他 group 不命中', () => {
    expect(isWebSecretKV('runtime', 'observability')).toBe(false);
    expect(isWebSecretKV('agent', WEB_JINA_API_KEY)).toBe(false);
  });
  it('null 安全', () => {
    expect(isWebSecretKV(null, WEB_JINA_API_KEY)).toBe(false);
    expect(isWebSecretKV(WEB_GROUP, null)).toBe(false);
  });
});

describe('mergeWebSecretPlaceholder', () => {
  it('占位 *** → 落盘原值（保留不改）', () => {
    const merged = mergeWebSecretPlaceholder(
      WEB_SECRET_REDACT_PLACEHOLDER,
      'jina-on-disk-real',
    );
    expect(merged).toBe('jina-on-disk-real');
  });
  it('占位 *** 且落盘缺失（undefined）→ 空串（防御性，避免误用）', () => {
    const merged = mergeWebSecretPlaceholder(WEB_SECRET_REDACT_PLACEHOLDER, undefined);
    expect(merged).toBe('');
  });
  it('用户填新明文（非占位）→ 直接入参落盘', () => {
    const merged = mergeWebSecretPlaceholder('jina-new-key-456', 'jina-old');
    expect(merged).toBe('jina-new-key-456');
  });
  it('用户主动清空（空串非占位）→ 空串落盘（区分占位）', () => {
    const merged = mergeWebSecretPlaceholder('', 'jina-old');
    expect(merged).toBe('');
  });
  it('落盘原值非 string（脏数据）→ 空串防御', () => {
    const merged = mergeWebSecretPlaceholder(WEB_SECRET_REDACT_PLACEHOLDER, 123);
    expect(merged).toBe('');
  });
});
