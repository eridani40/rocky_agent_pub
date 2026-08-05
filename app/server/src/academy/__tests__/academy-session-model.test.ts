/**
 * academy-session-model 单元测试 — 创建链三档 fallback（薄委托 resolveModel academy 链）
 *
 * 参考:
 *   - academy/academy-session-model.ts（resolveAcademySessionModel 实现）
 *   - services/model-resolver.ts academy 三档链（v0.0.216 change_plan B 段）
 *
 * 覆盖：explicit → classroomDefault 两档下探（保留字/不可用继续）+ 全空 throw（v0.0.230 去 app 默认档）。
 * 文件系统隔离：mkdtempSync + afterEach rmSync，禁真实数据目录。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppConfigService } from '../../config/app-config-service';
import {
  resolveAcademySessionModel,
  ModelNotConfiguredError,
} from '../academy-session-model';

let tmpRoot: string;
let appConfig: AppConfigService;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'asm-ut-'));
  appConfig = new AppConfigService({ root: tmpRoot });
  appConfig.set('providers', 'prov-a', {
    id: 'prov-a', name: 'A', enabled: true, kind: 'mock',
    credential: {},
    models: [
      { modelId: 'a-chat', enabled: true },
      { modelId: 'a-disabled', enabled: false },
    ],
  });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolveAcademySessionModel — 两档链（explicit → classroomDefault → throw）', () => {
  it('explicit 具体 → 第一档命中', () => {
    const r = resolveAcademySessionModel(
      appConfig,
      { providerId: 'prov-a', modelId: 'a-chat' },
      { modelId: 'a-disabled' },
    );
    expect(r).toEqual({ providerId: 'prov-a', modelId: 'a-chat' });
  });

  it('explicit 保留字 → 下探 classroomDefault', () => {
    const r = resolveAcademySessionModel(
      appConfig,
      { modelId: 'default' },
      { providerId: 'prov-a', modelId: 'a-chat' },
    );
    expect(r).toEqual({ providerId: 'prov-a', modelId: 'a-chat' });
  });

  it('explicit 不可用（disabled）→ 下探 classroomDefault（v0.0.216 起与运行时链一致）', () => {
    const r = resolveAcademySessionModel(
      appConfig,
      { modelId: 'a-disabled' },
      { modelId: 'a-chat' },
    );
    expect(r).toEqual({ providerId: 'prov-a', modelId: 'a-chat' });
  });

  it('explicit + classroomDefault 均空 → throw ModelNotConfiguredError（v0.0.230 去 app 默认兜底）', () => {
    appConfig.set('default_models', 'default', { chat: 'a-chat' });
    expect(() =>
      resolveAcademySessionModel(appConfig, undefined, undefined),
    ).toThrow(ModelNotConfiguredError);
  });

  it('两档全空 → throw ModelNotConfiguredError（caller 转 400）', () => {
    expect(() =>
      resolveAcademySessionModel(appConfig, undefined, undefined),
    ).toThrow(ModelNotConfiguredError);
  });
});
