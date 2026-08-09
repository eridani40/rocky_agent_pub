/**
 * scope extends 链 + 矩阵 resolve UT（v0.0.204 T2-B3 新增）
 * 参考: specs/tech/agent/session/[P0]session_type_profile.md §5（scope yaml extends 链）
 *
 * 覆盖：
 *   - 全量 scope yaml 加载（scopeId 全部 canonical id 形态）
 *   - extends 链解析（parentScopeId 正确 + default root 终点）
 *   - resolveSourceScope 沿链回退（playground-rocky:parent:main → default 链）
 *   - 关键路径：playground-rocky:parent:main Q3 治理（去 squad_* mappers）
 *   - summary/consolidate 基座 + 组合空文件继承
 */
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { ScopeConfigLoader } from '../scope-config-loader';
import { LoadedScopeConfigProvider } from '../scope-config-provider';

const SCOPES_DIR = join(__dirname, '../../../../plugins/scopes');

function loadProvider(): LoadedScopeConfigProvider {
  const configs = new ScopeConfigLoader(SCOPES_DIR).loadAll();
  return new LoadedScopeConfigProvider(configs);
}

describe('[v0.0.204 T2-B3] scope yaml 矩阵 + extends 链', () => {
  it('全量 scope yaml 加载（≥18 文件，scopeId 全部 canonical id 形态或 legacy 别名）', () => {
    const p = loadProvider();
    const ids = p.listScopes().map((s) => s.scopeId);
    // 三基座
    expect(ids).toContain('default');
    expect(ids).toContain('summary');
    expect(ids).toContain('consolidate');
    // main 类型（canonical id）
    expect(ids).toContain('playground-rocky:parent:main');
    expect(ids).toContain('studio-squad:parent:main');
    expect(ids).toContain('studio-leader:parent:main');
    expect(ids).toContain('studio-mate:parent:main');
    // subagent scope（2 个：playground-rocky/studio-mate；
    //   studio-leader/squad 不 spawn 故无 subagent profile/scope）
    expect(ids).toContain('playground-rocky:subagent:main');
    expect(ids).toContain('studio-mate:subagent:main');
    // v0.0.204：forked.yaml 已删（拆为 summary + consolidate 基座），不再断言 legacy forked 别名
  });

  it('extends 链：playground-rocky:parent:main extends default（parentScopeId 正确）', () => {
    const p = loadProvider();
    const meta = p.getScope('playground-rocky:parent:main');
    expect(meta?.parentScopeId).toBe('default');
  });

  it('extends 链：summary/consolidate extends default', () => {
    const p = loadProvider();
    expect(p.getScope('summary')?.parentScopeId).toBe('default');
    expect(p.getScope('consolidate')?.parentScopeId).toBe('default');
  });

  it('extends 链：组合空文件继承基座（playground-rocky:parent:summary extends summary）', () => {
    const p = loadProvider();
    expect(p.getScope('playground-rocky:parent:summary')?.parentScopeId).toBe('summary');
    expect(p.getScope('studio-leader:parent:consolidate')?.parentScopeId).toBe('consolidate');
  });

  it('extends 链：subagent scope extends default（persistent store + 主链）', () => {
    const p = loadProvider();
    expect(p.getScope('playground-rocky:subagent:main')?.parentScopeId).toBe('default');
    expect(p.getScope('studio-mate:subagent:main')?.parentScopeId).toBe('default');
  });

  it('default 自身无 parentScopeId（root 终点）', () => {
    const p = loadProvider();
    expect(p.getScope('default')?.parentScopeId).toBeUndefined();
  });
});

describe('[v0.0.204 T2-B3] resolveSourceScope extends 链回退', () => {
  it('playground-rocky:parent:main 激活 system_prompt_mapper → 本 scope 命中（Q3 治理独立 mapper 组）', () => {
    const p = loadProvider();
    const src = p.resolveSourceScope('playground-rocky:parent:main', 'system_prompt_mapper');
    expect(src).toBe('playground-rocky:parent:main');
  });

  it('playground-rocky:parent:main 未激活 session_store → 沿链回退到 default', () => {
    const p = loadProvider();
    const src = p.resolveSourceScope('playground-rocky:parent:main', 'session_store');
    expect(src).toBe('default');
  });

  it('playground-rocky:parent:summary 激活 context_assemble_reducer → 回退 summary（side_run_builder 在 summary 基座）', () => {
    const p = loadProvider();
    const src = p.resolveSourceScope('playground-rocky:parent:summary', 'context_assemble_reducer');
    expect(src).toBe('summary');
  });

  it('summary 激活 session_store → 本 scope 命中（in_memory_session_store 在 summary）', () => {
    const p = loadProvider();
    const src = p.resolveSourceScope('summary', 'session_store');
    expect(src).toBe('summary');
  });

  it('summary 未激活 web_search_provider → 沿链回退到 default', () => {
    const p = loadProvider();
    const src = p.resolveSourceScope('summary', 'web_search_provider');
    expect(src).toBe('default');
  });

  it('default 自身：任何 EP 都命中 default（root 短路）', () => {
    const p = loadProvider();
    expect(p.resolveSourceScope('default', 'system_prompt_mapper')).toBe('default');
    expect(p.resolveSourceScope('default', 'session_store')).toBe('default');
  });
});

describe('[v0.0.204 bug fix] resolveSourceScope 未注册 scopeId → throw', () => {
  it('入口 scopeId 未注册 → throw（不静默兜底 default）', () => {
    const p = loadProvider();
    // bogus-scope 不在 byId；旧逻辑静默返 default（对 summary/consolidate run = 真 compact → 递归爆炸）
    // 新逻辑：throw fail fast
    expect(() => p.resolveSourceScope('bogus-unregistered-scope', 'system_prompt_mapper')).toThrow(
      /unregistered scopeId "bogus-unregistered-scope"/,
    );
  });

  it('注册但 EP 未激活 → 合法 per-EP 回退 default（不变）', () => {
    const p = loadProvider();
    // playground-rocky:parent:main 已注册，但 web_search_provider 未在该 scope 激活 → 回退 default
    const src = p.resolveSourceScope('playground-rocky:parent:main', 'web_search_provider');
    expect(src).toBe('default');
  });

  it('default 入口短路：未注册的 EP 也返 default（不触发 throw）', () => {
    const p = loadProvider();
    expect(p.resolveSourceScope('default', 'bogus-point')).toBe('default');
  });
});

describe('[v0.0.204 T2-B3] Q3 治理：playground/studio 拆分', () => {
  it('playground-rocky:parent:main system_prompt_mapper 不含 squad_*/team_roster/memory_group/parent_task（Q3 治理）', () => {
    const configs = new ScopeConfigLoader(SCOPES_DIR).loadAll();
    const pg = configs.find((c) => c.scopeId === 'playground-rocky:parent:main');
    expect(pg).toBeDefined();
    // system_prompt_mapper 在 playground scope 的 activatedPoints 中
    expect(pg!.activatedPoints).toContain('system_prompt_mapper');
    // playground scope 的 system_prompt_mapper impls 不含 squad/group 相关
    // [v0.0.273] squad_agents_status = reachable_agents 继承者（a2a 通用对端 provider，subagent 需 [parent]），非 squad 专有 → 例外
    const squadImpls = Object.keys(pg!.impls).filter((id) =>
      (id.startsWith('squad_') && id !== 'squad_agents_status') || id === 'team_roster' || id === 'memory_group' || id === 'parent_task');
    expect(squadImpls).toEqual([]);
  });
});
