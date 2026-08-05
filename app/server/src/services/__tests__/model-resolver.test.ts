/**
 * model-resolver 单元测试 — 统一 resolve fallback 链（v0.0.158 简化：chat 单链）
 *
 * 参考:
 *   - PRD specs/tech/agent/providers_and_models/[P0]model_resolve.md §3（chat 单链 fallback 表）+ §4（ModelRef 复合）+ §5.1（错误契约）
 *   - services/model-resolver.ts 实现
 *   - specs/tech/version_logs/v0.0.158.compact_model_resolve/change_plan.md §A（resolve 简化 + INV-A5 收窄）
 *
 * v0.0.158 变更（相较 v0.0.155）：
 *   - 删 task 参数 + summary 分支：chat/compact 同链，resolver 只走 chat fallback 链
 *   - 删 bodyOverride 参数：body override 整删
 *   - 删 squad.summaryModelDefault* 字段：studio 只读 squad.modelDefault
 *   - ModelNotConfiguredError.detail 收窄为 {sessionType}（去 task 字段）
 *
 * 覆盖：chat 链（playground/studio squad/leader/mate）× fallback 步 + 保留字语义 + ModelRef 复合精确匹配
 *   + 错误体 schema + INV-A5 studio 不读 default_models 断言。
 * 文件系统隔离：mkdtempSync + afterEach rmSync，禁真实 ~/.oobt-desktop 路径。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigService } from '../../config/app-config-service';
import {
  resolveModel,
  ModelNotConfiguredError,
  type ResolveModelInput,
} from '../model-resolver';

let tmpRoot: string;
let appConfig: AppConfigService;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'mr-ut-'));
  appConfig = new AppConfigService({ root: tmpRoot });
  // 默认 fixture：两个 enabled providers，各有不同 modelId，覆盖跨 provider 反查
  appConfig.set('providers', 'prov-a', {
    id: 'prov-a', name: 'A', enabled: true, kind: 'mock',
    credential: {},
    models: [
      { modelId: 'a-chat', enabled: true },
      { modelId: 'a-summary', enabled: true },
      { modelId: 'a-disabled', enabled: false },
    ],
  });
  appConfig.set('providers', 'prov-b', {
    id: 'prov-b', name: 'B', enabled: true, kind: 'mock',
    credential: {},
    models: [{ modelId: 'b-chat', enabled: true }],
  });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

/** 配 default_models.chat（v0.0.158：删 summary 字段） */
function setDefaultModels(chat?: string): void {
  const data: Record<string, string> = {};
  if (chat !== undefined) data.chat = chat;
  appConfig.set('default_models', 'default', data);
}

describe('resolveModel — playground chat 链（PRD §3；v0.0.158 chat 单链）', () => {
  it('session.modelId 具体 → 命中', () => {
    const r = resolveModel({
      appConfigService: appConfig, sessionType: 'playground',
      sessionModelId: 'a-summary',
    });
    expect(r).toEqual({ providerId: 'prov-a', modelId: 'a-summary' });
  });

  it('session.modelId="default"（保留字）→ fallback 到 default_models.chat', () => {
    setDefaultModels('a-chat');
    const r = resolveModel({
      appConfigService: appConfig, sessionType: 'playground',
      sessionModelId: 'default',
    });
    expect(r).toEqual({ providerId: 'prov-a', modelId: 'a-chat' });
  });

  it('session.modelId="none"（保留字等价 default）→ fallback 到 default_models.chat', () => {
    setDefaultModels('b-chat');
    const r = resolveModel({
      appConfigService: appConfig, sessionType: 'playground',
      sessionModelId: 'none',
    });
    expect(r).toEqual({ providerId: 'prov-b', modelId: 'b-chat' });
  });

  it('session.modelId=undefined + default_models.chat 配 → 命中 default_models.chat', () => {
    setDefaultModels('b-chat');
    const r = resolveModel({
      appConfigService: appConfig, sessionType: 'playground',
    });
    expect(r).toEqual({ providerId: 'prov-b', modelId: 'b-chat' });
  });

  it('全空（无 session/modelId + 无 default_models）→ throw ModelNotConfiguredError', () => {
    expect(() =>
      resolveModel({
        appConfigService: appConfig, sessionType: 'playground',
      }),
    ).toThrow(ModelNotConfiguredError);
  });

  it('disabled modelId（a-disabled）→ 视为该步未命中，继续 fallback', () => {
    // session.modelId='a-disabled' (enabled:false) → 跳过；default_models.chat='a-chat' → 命中
    setDefaultModels('a-chat');
    const r = resolveModel({
      appConfigService: appConfig, sessionType: 'playground',
      sessionModelId: 'a-disabled',
    });
    expect(r).toEqual({ providerId: 'prov-a', modelId: 'a-chat' });
  });
});

describe('resolveModel — studio squad/leader/mate chat 链（PRD §3；v0.0.158 chat 单链，同链）', () => {
  it('squad: session.modelId 具体 → 命中', () => {
    const r = resolveModel({
      appConfigService: appConfig, sessionType: 'studio',
      sessionModelId: 'a-summary', squad: { modelDefault: 'a-chat' },
    });
    expect(r).toEqual({ providerId: 'prov-a', modelId: 'a-summary' });
  });

  it('squad: session.modelId="default" → fallback squad.modelDefault', () => {
    const r = resolveModel({
      appConfigService: appConfig, sessionType: 'studio',
      sessionModelId: 'default', squad: { modelDefault: 'b-chat' },
    });
    expect(r).toEqual({ providerId: 'prov-b', modelId: 'b-chat' });
  });

  it('squad: 无 session.modelId → 直接命中 squad.modelDefault', () => {
    const r = resolveModel({
      appConfigService: appConfig, sessionType: 'studio',
      squad: { modelDefault: 'b-chat' },
    });
    expect(r).toEqual({ providerId: 'prov-b', modelId: 'b-chat' });
  });

  it('leader: 无 session + squad.modelDefault → 命中 squad.modelDefault（v0.0.155 后 leader/mate/squad 同链）', () => {
    const r = resolveModel({
      appConfigService: appConfig, sessionType: 'studio',
      squad: { modelDefault: 'a-summary' },
    });
    expect(r).toEqual({ providerId: 'prov-a', modelId: 'a-summary' });
  });

  it('mate: INV-A1 无 bodyOverride/session → fallback squad.modelDefault（不读 member.model）', () => {
    const r = resolveModel({
      appConfigService: appConfig, sessionType: 'studio',
      squad: { modelDefault: 'b-chat' },
    });
    expect(r).toEqual({ providerId: 'prov-b', modelId: 'b-chat' });
  });

  it('studio 全空（无 session/squad）→ throw', () => {
    expect(() =>
      resolveModel({
        appConfigService: appConfig, sessionType: 'studio',
      }),
    ).toThrow(ModelNotConfiguredError);
  });
});

describe('resolveModel — [v0.0.155] ModelRef 复合 providerIdHint 精确（INV-B1/B2）', () => {
  it('sessionModelId + sessionProviderId hint → 精确匹配该 provider（同名 model 跨 provider 时解歧义）', () => {
    // 加同名 model 到 prov-b（prov-a 已有 'shared-model'，prov-b 也有）
    appConfig.set('providers', 'prov-b', {
      id: 'prov-b', name: 'B', enabled: true, kind: 'mock',
      credential: {},
      models: [
        { modelId: 'b-chat', enabled: true },
        { modelId: 'shared-model', enabled: true },
      ],
    });
    appConfig.set('providers', 'prov-a', {
      id: 'prov-a', name: 'A', enabled: true, kind: 'mock',
      credential: {},
      models: [
        { modelId: 'a-chat', enabled: true },
        { modelId: 'shared-model', enabled: true },
      ],
    });
    // hint=prov-b → 精确命中 prov-b（即便 prov-a 也有同名）
    const r = resolveModel({
      appConfigService: appConfig, sessionType: 'playground',
      sessionModelId: 'shared-model', sessionProviderId: 'prov-b',
    });
    expect(r).toEqual({ providerId: 'prov-b', modelId: 'shared-model' });
    // hint=prov-a → 精确命中 prov-a
    const r2 = resolveModel({
      appConfigService: appConfig, sessionType: 'playground',
      sessionModelId: 'shared-model', sessionProviderId: 'prov-a',
    });
    expect(r2).toEqual({ providerId: 'prov-a', modelId: 'shared-model' });
  });

  it('hint 空 → 跨 provider 反查首个命中（back-compat 救存量）', () => {
    // 无 hint → 反查命中 prov-a（listGroup 顺序）
    const r = resolveModel({
      appConfigService: appConfig, sessionType: 'playground',
      sessionModelId: 'a-summary',
    });
    expect(r).toEqual({ providerId: 'prov-a', modelId: 'a-summary' });
  });

  it('hint 命中的 provider 不含该 modelId → 视为该步未命中继续 fallback', () => {
    setDefaultModels('a-chat');
    // hint=prov-b 但 prov-b 无 'a-disabled' → 跳过 → default_models.chat='a-chat' 命中
    const r = resolveModel({
      appConfigService: appConfig, sessionType: 'playground',
      sessionModelId: 'a-disabled', sessionProviderId: 'prov-b',
    });
    expect(r).toEqual({ providerId: 'prov-a', modelId: 'a-chat' });
  });

  it('squad.modelDefaultProviderId hint → 精确匹配该 provider', () => {
    // squad.modelDefault='a-chat' + providerId='prov-a' → 精确命中
    const r = resolveModel({
      appConfigService: appConfig, sessionType: 'studio',
      squad: { modelDefault: 'a-chat', modelDefaultProviderId: 'prov-a' },
    });
    expect(r).toEqual({ providerId: 'prov-a', modelId: 'a-chat' });
  });
});

describe('resolveModel — [v0.0.230] academy 两档链（session → classroom.defaultModel → throw）', () => {
  it('session.modelId 具体 → 第一档命中（不读 classroom/app 默认）', () => {
    const r = resolveModel({
      appConfigService: appConfig, sessionType: 'academy',
      sessionModelId: 'a-summary',
      classroom: { defaultModel: { modelId: 'b-chat' } },
    });
    expect(r).toEqual({ providerId: 'prov-a', modelId: 'a-summary' });
  });

  it('session="default"（保留字）→ 下探第二档 classroom.defaultModel', () => {
    const r = resolveModel({
      appConfigService: appConfig, sessionType: 'academy',
      sessionModelId: 'default',
      classroom: { defaultModel: { modelId: 'b-chat' } },
    });
    expect(r).toEqual({ providerId: 'prov-b', modelId: 'b-chat' });
  });

  it('session 不可用（disabled）→ 下探第二档 classroom.defaultModel', () => {
    const r = resolveModel({
      appConfigService: appConfig, sessionType: 'academy',
      sessionModelId: 'a-disabled',
      classroom: { defaultModel: { modelId: 'b-chat' } },
    });
    expect(r).toEqual({ providerId: 'prov-b', modelId: 'b-chat' });
  });

  it('classroom.defaultModel 保留字 → 两档跑空 → throw（不再下探 app 默认）', () => {
    setDefaultModels('a-chat');
    try {
      resolveModel({
        appConfigService: appConfig, sessionType: 'academy',
        classroom: { defaultModel: { modelId: 'default' } },
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ModelNotConfiguredError);
      const err = e as ModelNotConfiguredError;
      expect(err.detail).toEqual({ sessionType: 'academy' });
      expect(err.message).toBe('教室未配置默认模型，请先在教室设置中选择一个具体模型');
    }
  });

  it('classroom.defaultModel 不可用（not found）→ 两档跑空 → throw（不再下探 app 默认）', () => {
    setDefaultModels('a-chat');
    expect(() =>
      resolveModel({
        appConfigService: appConfig, sessionType: 'academy',
        sessionModelId: 'default',
        classroom: { defaultModel: { modelId: 'phantom-not-exist' } },
      }),
    ).toThrow(ModelNotConfiguredError);
  });

  it('classroom.defaultModel 带 providerId → 精确匹配该 provider（复合 hint）', () => {
    const r = resolveModel({
      appConfigService: appConfig, sessionType: 'academy',
      classroom: { defaultModel: { providerId: 'prov-b', modelId: 'b-chat' } },
    });
    expect(r).toEqual({ providerId: 'prov-b', modelId: 'b-chat' });
  });

  it('classroom 缺省（无 defaultModel）→ 链跑空 → throw（v0.0.230 去 app 默认档）', () => {
    setDefaultModels('b-chat');
    expect(() =>
      resolveModel({
        appConfigService: appConfig, sessionType: 'academy',
        sessionModelId: 'default',
      }),
    ).toThrow(ModelNotConfiguredError);
  });

  it('两档全空 → throw ModelNotConfiguredError（detail.sessionType="academy" + academy 引导文案）', () => {
    try {
      resolveModel({ appConfigService: appConfig, sessionType: 'academy' });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ModelNotConfiguredError);
      const err = e as ModelNotConfiguredError;
      expect(err.detail).toEqual({ sessionType: 'academy' });
      expect(err.message).toBe('教室未配置默认模型，请先在教室设置中选择一个具体模型');
    }
  });

  it('academy MUST NOT 读 app_config.default_models.chat（即使配了也不读）', () => {
    setDefaultModels('a-chat');
    // session 仅保留字 + 无 classroom → 仍 throw（v0.0.230 起 academy 不再下探 app 默认）
    expect(() =>
      resolveModel({
        appConfigService: appConfig, sessionType: 'academy',
        sessionModelId: 'default',
      }),
    ).toThrow(ModelNotConfiguredError);
  });

  it('academy MUST NOT 读 squad.modelDefault（即使误传也不读）', () => {
    // 无 session/classroom + 误传 squad → 仍 throw（squad 不进 academy 链）
    expect(() =>
      resolveModel({
        appConfigService: appConfig, sessionType: 'academy',
        squad: { modelDefault: 'b-chat' },
      }),
    ).toThrow(ModelNotConfiguredError);
  });
});

describe('resolveModel — 核心约束（不可偏离）', () => {
  it('INV-A5 收窄: studio MUST NOT 读 app_config.default_models（即使配了也不读）', () => {
    setDefaultModels('a-chat');
    // studio squad chat: session + squad 全空 → throw（即便 default_models 配了）
    expect(() =>
      resolveModel({
        appConfigService: appConfig, sessionType: 'studio',
      }),
    ).toThrow(ModelNotConfiguredError);
  });

  it('INV-A5: playground MUST NOT 读 squad.modelDefault（即使配了也不读）', () => {
    setDefaultModels('a-chat');
    // playground chat 无 session + 有 squad（squad 不应被读） → 命中 default_models.chat
    const r = resolveModel({
      appConfigService: appConfig, sessionType: 'playground',
      squad: { modelDefault: 'b-chat' },
    });
    expect(r).toEqual({ providerId: 'prov-a', modelId: 'a-chat' });
  });

  it('ModelNotConfiguredError 含 code/message/detail（HTTP 400 契约；v0.0.158 detail 无 task 字段）', () => {
    try {
      resolveModel({
        appConfigService: appConfig, sessionType: 'playground',
      });
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ModelNotConfiguredError);
      const err = e as ModelNotConfiguredError;
      expect(err.code).toBe('MODEL_NOT_CONFIGURED');
      expect(err.message).toBe('请配置模型后再发起会话');
      expect(err.detail).toEqual({ sessionType: 'playground' });
    }
  });

  it('ModelNotConfiguredError detail 区分 sessionType（playground/studio 两种）', () => {
    const cases: Array<{ input: ResolveModelInput; expected: { sessionType: 'playground' | 'studio' } }> = [
      { input: { appConfigService: appConfig, sessionType: 'playground' }, expected: { sessionType: 'playground' } },
      { input: { appConfigService: appConfig, sessionType: 'studio' }, expected: { sessionType: 'studio' } },
      { input: { appConfigService: appConfig, sessionType: 'studio' }, expected: { sessionType: 'studio' } },
    ];
    for (const c of cases) {
      try {
        resolveModel(c.input);
        throw new Error('should have thrown');
      } catch (e) {
        expect((e as ModelNotConfiguredError).detail).toEqual(c.expected);
      }
    }
  });

  it('具体 modelId 不存在（如 "phantom"）→ 视为该步未命中继续 fallback', () => {
    setDefaultModels('a-chat');
    const r = resolveModel({
      appConfigService: appConfig, sessionType: 'playground',
      sessionModelId: 'phantom-not-exist',
    });
    // phantom 跳过 → default_models.chat='a-chat' 命中
    expect(r).toEqual({ providerId: 'prov-a', modelId: 'a-chat' });
  });

  it('ModelRef 编码=纯 modelId string（resolve 输出不含 providerId:modelId 拼接）', () => {
    const r = resolveModel({
      appConfigService: appConfig, sessionType: 'playground',
      sessionModelId: 'a-summary',
    });
    expect(typeof r.modelId).toBe('string');
    expect(r.modelId).not.toContain(':');
    expect(r.modelId).toBe('a-summary');
  });
});
