/**
 * model-validation 单测（v0.0.36 写入校验 fail-fast）
 * 参考: specs/api/overall/02-llm-chat.md §5（provider/model enabled 语义）
 *
 * 覆盖 validateModelId：合法命中 / 非法 modelId / provider disabled / model disabled / 无 provider。
 * 文件系统隔离：mkdtempSync 建临时 app_config。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigService } from '../../config/app-config-service';
import { validateModelId } from '../model-validation';

let tmpRoot: string;
let appConfig: AppConfigService;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-mv-'));
  appConfig = new AppConfigService({ root: tmpRoot });
  // 两个 enabled provider：prov-a（default-model + disabled-m）+ prov-b（b-model）
  appConfig.set('providers', 'prov-a', {
    id: 'prov-a', name: 'a', enabled: true, kind: 'mock', credential: {},
    models: [
      { modelId: 'default-model', enabled: true },
      { modelId: 'disabled-m', enabled: false },
    ],
  });
  appConfig.set('providers', 'prov-b', {
    id: 'prov-b', name: 'b', enabled: true, kind: 'mock', credential: {},
    models: [{ modelId: 'b-model', enabled: true }],
  });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('[v0.0.36] validateModelId（modelDefault/model 写入校验）', () => {
  it('命中 prov-a default-model → ok', () => {
    expect(validateModelId(appConfig, 'default-model')).toEqual({ ok: true });
  });

  it('命中 prov-b b-model（跨 provider）→ ok', () => {
    expect(validateModelId(appConfig, 'b-model')).toEqual({ ok: true });
  });

  it('非法 modelId（claude-sonnet）→ ok=false + 清晰错误', () => {
    const r = validateModelId(appConfig, 'claude-sonnet');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('claude-sonnet');
      expect(r.error).toContain('不是任何已启用 provider 的合法 modelId');
    }
  });

  it('modelId 存在但 disabled → ok=false（disabled model 不算合法）', () => {
    const r = validateModelId(appConfig, 'disabled-m');
    expect(r.ok).toBe(false);
  });

  it('provider disabled → 其 model 不算合法', () => {
    appConfig.set('providers', 'prov-c', {
      id: 'prov-c', name: 'c', enabled: false, kind: 'mock', credential: {},
      models: [{ modelId: 'c-model', enabled: true }],
    });
    expect(validateModelId(appConfig, 'c-model').ok).toBe(false);
  });

  it('无任何 enabled provider → ok=false（错误提示无已启用 provider）', () => {
    const tmp2 = mkdtempSync(join(tmpdir(), 'oobt-mv-empty-'));
    try {
      const empty = new AppConfigService({ root: tmp2 });
      const r = validateModelId(empty, 'any');
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('无已启用的 provider');
    } finally {
      rmSync(tmp2, { recursive: true, force: true });
    }
  });
});
