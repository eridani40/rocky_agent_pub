/**
 * scope 矩阵对称校验 UT（validateMainScopeMatrix）
 * 参考: specs/tech/agent/session/[P0]session_type_profile.md §6（矩阵完整性）
 *
 * 与 profile 侧 SessionTypeProfileValidator.validateMainMatrix 对称（profile 侧查 profile 文件，
 * 本侧查 scope 文件）：每个 `<prefix>:main` scope 必须有对应 `<prefix>:summary` +
 * `<prefix>:consolidate` scope，否则启动硬失败（防仅靠 resolveSourceScope 运行时 throw 晚暴露）。
 *
 * 覆盖（对称 profile 侧 4 条）：
 *   1. main 缺 summary scope → throw
 *   2. main 缺 consolidate scope → throw
 *   3. 基座（default/summary/consolidate，无冒号 id）不触发矩阵校验
 *   4. 完整矩阵（main + summary + consolidate 齐备）→ 通过
 */
import { describe, it, expect } from 'vitest';
import { ScopeConfigValidator } from '../scope-config-validator';
import type { ScopeConfig } from '../scope-config-loader';
import { Registry } from '../registry';

/** 最小 ScopeConfig fixture（空 activatedPoints/impls——矩阵校验与 registry 内容无关） */
function mkScope(scopeId: string): ScopeConfig {
  return { scopeId, name: scopeId, activatedPoints: [], impls: {} };
}

/** 空 registry validator（矩阵校验不触 registry 路径） */
function mkValidator(): ScopeConfigValidator {
  return new ScopeConfigValidator({ registry: new Registry(), groups: [] });
}

describe('ScopeConfigValidator — scope 矩阵对称校验（对称 profile 侧 validateMainMatrix）', () => {
  it('main 缺 summary scope → throw（消息含缺失 scopeId）', () => {
    const configs = [mkScope('playground-rocky:parent:main'), mkScope('playground-rocky:parent:consolidate')];
    expect(() => mkValidator().validateAll(configs)).toThrow(
      /main scope "playground-rocky:parent:main" 缺对应 summary scope "playground-rocky:parent:summary"/,
    );
  });

  it('main 缺 consolidate scope → throw（消息含缺失 scopeId）', () => {
    const configs = [mkScope('playground-rocky:parent:main'), mkScope('playground-rocky:parent:summary')];
    expect(() => mkValidator().validateAll(configs)).toThrow(
      /main scope "playground-rocky:parent:main" 缺对应 consolidate scope "playground-rocky:parent:consolidate"/,
    );
  });

  it('基座（default/summary/consolidate，无冒号 id）不触发矩阵校验', () => {
    const configs = [mkScope('default'), mkScope('summary'), mkScope('consolidate')];
    expect(() => mkValidator().validateAll(configs)).not.toThrow();
  });

  it('完整矩阵（main + summary + consolidate 齐备）→ 通过', () => {
    const configs = [
      mkScope('default'),
      mkScope('playground-rocky:parent:main'),
      mkScope('playground-rocky:parent:summary'),
      mkScope('playground-rocky:parent:consolidate'),
    ];
    expect(() => mkValidator().validateAll(configs)).not.toThrow();
  });
});
