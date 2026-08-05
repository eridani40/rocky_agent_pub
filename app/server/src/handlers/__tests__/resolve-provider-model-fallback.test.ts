/**
 * resolveProviderModel 运行时兜底 UT（v0.0.36 救活存量非法 modelDefault）
 * 参考: specs/api/overall/02-llm-chat.md §5（provider/model）
 *       specs/tech/squad/[P1]data_model.md（modelDefault/member.model）
 *
 * 背景：v0.0.36 写入校验上线前，存量 squad.modelDefault / member.model 可能是非法 modelId
 *   （UI 自由填名 'claude-sonnet' 等）。studio 激活 leader/mate/squadChat 时
 *   resolveProviderModel 精确匹配失败 → 修前直接抛 ModelNotFoundError → 激活全崩。
 *   v0.0.36：effectiveModelId 找不到时兜底到首个 enabled → 首个 model；仅 provider
 *   一个 model 都没有时才抛。跨 provider 搜逻辑（BUG-3）保留不变。
 *   [v0.0.143] per-model default 字段已删除，兜底不再优先 default model。
 *
 * 文件系统隔离：mkdtempSync 建临时 app_config，不读写真实路径。
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
  tmpRoot = mkdtempSync(join(tmpdir(), 'oobt-rpm-fb-'));
  appConfig = new AppConfigService({ root: tmpRoot });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('[v0.0.36] resolveProviderModel 运行时兜底（救活存量非法 modelDefault）', () => {
  it('effectiveModelId 非法（存量 claude-sonnet）→ 兜底到首个 enabled model', () => {
    // 单 enabled provider，托管 first-model + mini（均 enabled）
    appConfig.set('providers', 'prov-a', {
      id: 'prov-a', name: 'a', enabled: true, kind: 'mock', credential: {},
      models: [
        { modelId: 'first-model', enabled: true },
        { modelId: 'mini', enabled: true },
      ],
    });
    // 存量非法 modelDefault 'claude-sonnet' 不在 prov-a.models → 兜底首个 enabled（first-model）
    const r = resolveProviderModel(appConfig, undefined, 'claude-sonnet', {});
    expect(r.providerId).toBe('prov-a');
    expect(r.modelId).toBe('first-model');
  });

  it('多个 enabled model → 兜底到首个 enabled model', () => {
    appConfig.set('providers', 'prov-a', {
      id: 'prov-a', name: 'a', enabled: true, kind: 'mock', credential: {},
      models: [
        { modelId: 'm1', enabled: true },
        { modelId: 'm2', enabled: true },
      ],
    });
    const r = resolveProviderModel(appConfig, undefined, 'no-such-model', {});
    expect(r.providerId).toBe('prov-a');
    // 兜底取首个 enabled model（m1）
    expect(r.modelId).toBe('m1');
  });

  it('首个 model 被 disabled → 兜底到首个 enabled model（跳过 disabled）', () => {
    appConfig.set('providers', 'prov-a', {
      id: 'prov-a', name: 'a', enabled: true, kind: 'mock', credential: {},
      models: [
        { modelId: 'disabled-m', enabled: false },
        { modelId: 'enabled-m', enabled: true },
      ],
    });
    const r = resolveProviderModel(appConfig, undefined, 'no-such-model', {});
    expect(r.providerId).toBe('prov-a');
    // 首个 model 被 disabled → 跳过选首个 enabled（enabled-m）
    expect(r.modelId).toBe('enabled-m');
  });

  it('provider 一个 model 都没有 → 仍抛 ModelNotFoundError', () => {
    appConfig.set('providers', 'prov-a', {
      id: 'prov-a', name: 'a', enabled: true, kind: 'mock', credential: {},
      models: [],
    });
    expect(() => resolveProviderModel(appConfig, undefined, 'no-such-model', {})).toThrow();
  });

  it('合法 modelId 直接命中（不兜底，不回归）', () => {
    appConfig.set('providers', 'prov-a', {
      id: 'prov-a', name: 'a', enabled: true, kind: 'mock', credential: {},
      models: [
        { modelId: 'first-model', enabled: true },
        { modelId: 'mini', enabled: true },
      ],
    });
    const r = resolveProviderModel(appConfig, undefined, 'mini', {});
    expect(r.providerId).toBe('prov-a');
    expect(r.modelId).toBe('mini'); // 精确命中，不走兜底
  });

  it('显式 providerId + 非法 modelId → 兜底到该 provider 首个 enabled（不跨搜）', () => {
    // 验证兜底仅在最终 provider 选定后生效：显式 providerId 权威，model miss 落该 provider 首个 enabled
    appConfig.set('providers', 'prov-a', {
      id: 'prov-a', name: 'a', enabled: true, kind: 'mock', credential: {},
      models: [{ modelId: 'a-first', enabled: true }],
    });
    appConfig.set('providers', 'prov-b', {
      id: 'prov-b', name: 'b', enabled: true, kind: 'mock', credential: {},
      models: [{ modelId: 'b-first', enabled: true }],
    });
    const r = resolveProviderModel(appConfig, 'prov-a', 'no-such-model', {});
    expect(r.providerId).toBe('prov-a'); // 不跨搜到 prov-b
    expect(r.modelId).toBe('a-first'); // 兜底 prov-a 首个 enabled
  });
});

describe('[v0.0.56] resolveProviderModel 默认 provider 跳过零 model（防 E2E 占位 provider 阻塞全站）', () => {
  it('多个 enabled provider，首个零 model → 跳过选第二个有 model 的', () => {
    // 模拟 E2E 占位 provider（enabled=true, models=[]）
    appConfig.set('providers', 'prov-e2e', {
      id: 'prov-e2e', name: 'e2e-placeholder', enabled: true, kind: 'mock', credential: {},
      models: [],
    });
    appConfig.set('providers', 'prov-real', {
      id: 'prov-real', name: 'real', enabled: true, kind: 'mock', credential: {},
      models: [{ modelId: 'real-model' }],
    });
    // 无 providerId 无 modelId → 应跳过 prov-e2e（零 model）选 prov-real
    const r = resolveProviderModel(appConfig, undefined, undefined, {});
    expect(r.providerId).toBe('prov-real');
    expect(r.modelId).toBe('real-model');
  });

  it('默认路径（无 providerId 无 modelId），首个 provider 有 model → 直选（不回归）', () => {
    appConfig.set('providers', 'prov-a', {
      id: 'prov-a', name: 'a', enabled: true, kind: 'mock', credential: {},
      models: [{ modelId: 'a-model' }],
    });
    const r = resolveProviderModel(appConfig, undefined, undefined, {});
    expect(r.providerId).toBe('prov-a');
    expect(r.modelId).toBe('a-model');
  });

  it('所有 enabled provider 都零 model → 抛 ProviderNotFoundError（明确而非 ModelNotFoundError）', () => {
    appConfig.set('providers', 'prov-e2e', {
      id: 'prov-e2e', name: 'e2e', enabled: true, kind: 'mock', credential: {},
      models: [],
    });
    appConfig.set('providers', 'prov-another', {
      id: 'prov-another', name: 'x', enabled: true, kind: 'mock', credential: {},
      models: [],
    });
    // 全零 model → 应抛 ProviderNotFoundError（"no enabled provider with models"），非 ModelNotFoundError
    expect(() => resolveProviderModel(appConfig, undefined, undefined, {}))
      .toThrow(/no enabled provider with models/);
  });

  it('有效 modelId 跨搜：全零 model fallback → 跳到有 model 的 provider', () => {
    // 首个 provider 有 model 但不是目标 modelId；全零 provider 也要被跳过
    appConfig.set('providers', 'prov-e2e', {
      id: 'prov-e2e', name: 'e2e', enabled: true, kind: 'mock', credential: {},
      models: [],
    });
    appConfig.set('providers', 'prov-real', {
      id: 'prov-real', name: 'real', enabled: true, kind: 'mock', credential: {},
      models: [{ modelId: 'target-model' }],
    });
    const r = resolveProviderModel(appConfig, undefined, 'target-model', {});
    expect(r.providerId).toBe('prov-real');
    expect(r.modelId).toBe('target-model');
  });

  it('显式 providerId 指向零 model provider → 仍抛 ModelNotFoundError（尊重 caller 选择）', () => {
    appConfig.set('providers', 'prov-e2e', {
      id: 'prov-e2e', name: 'e2e', enabled: true, kind: 'mock', credential: {},
      models: [],
    });
    appConfig.set('providers', 'prov-real', {
      id: 'prov-real', name: 'real', enabled: true, kind: 'mock', credential: {},
      models: [{ modelId: 'real-model' }],
    });
    // 显式指定 prov-e2e → 尊重 caller，不跨到 prov-real
    expect(() => resolveProviderModel(appConfig, 'prov-e2e', undefined, {}))
      .toThrow(/provider prov-e2e has no model/);
  });
});
