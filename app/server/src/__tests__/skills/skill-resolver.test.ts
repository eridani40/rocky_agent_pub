/**
 * SkillResolver 单测 — 双层扫描 + frontmatter 解析 + workspace 覆盖 app + enabledStore
 * 参考: specs/tech/agent/skills/[P0]skill_architecture.md §4
 *       test-plan §3（UT: scanner）
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import {
  SkillResolver,
  appSkillRoot,
  workspaceSkillRoot,
  builtinSkillRoot,
  groupSkillRoot,
  isValidSkillName,
} from '../../skills/resolver';
import { SkillEnabledStore } from '../../skills/enabled-store';
import { AppConfigService } from '../../config/app-config-service';

function writeSkillMd(dir: string, name: string, description: string, extra = ''): void {
  mkdirSync(dir, { recursive: true });
  const body = `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nbody\n`;
  writeFileSync(join(dir, 'SKILL.md'), body, 'utf8');
}

describe('SkillResolver', () => {
  let dataDir: string;
  let workspace: string;
  let appConfig: AppConfigService;
  let store: SkillEnabledStore;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-resolver-'));
    workspace = mkdtempSync(join(tmpdir(), 'rocky-ws-'));
    appConfig = new AppConfigService({ root: dataDir });
    store = new SkillEnabledStore(appConfig);
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  it('isValidSkillName: kebab-case + ≤64', () => {
    expect(isValidSkillName('demo-skill')).toBe(true);
    expect(isValidSkillName('a')).toBe(true);
    expect(isValidSkillName('Demo-Skill')).toBe(false); // 大写非法
    expect(isValidSkillName('demo_skill')).toBe(false); // 下划线非法
    expect(isValidSkillName('a'.repeat(65))).toBe(false); // 超 64
  });

  it('扫 app 层单 skill（解析 frontmatter name/description）', () => {
    writeSkillMd(join(appSkillRoot(dataDir), 'demo'), 'demo', '演示技能');
    const cat = SkillResolver.resolve(dataDir, undefined, store);
    expect(cat.entries).toHaveLength(1);
    expect(cat.entries[0]!.name).toBe('demo');
    expect(cat.entries[0]!.description).toBe('演示技能');
    expect(cat.entries[0]!.scope).toBe('app');
    expect(cat.entries[0]!.enabled).toBe(true); // fallback true
  });

  it('双层合并：workspace 同名覆盖 app', () => {
    writeSkillMd(join(appSkillRoot(dataDir), 'shared'), 'shared', 'app 版');
    writeSkillMd(join(workspaceSkillRoot(workspace), 'shared'), 'shared', 'workspace 版');
    const cat = SkillResolver.resolve(dataDir, workspace, store);
    const e = cat.entries.find((x) => x.name === 'shared');
    expect(e?.scope).toBe('workspace');
    expect(e?.description).toBe('workspace 版');
  });

  it('双层合并：不同名并存', () => {
    writeSkillMd(join(appSkillRoot(dataDir), 'a'), 'a', 'a desc');
    writeSkillMd(join(workspaceSkillRoot(workspace), 'b'), 'b', 'b desc');
    const cat = SkillResolver.resolve(dataDir, workspace, store);
    expect(cat.entries.map((e) => e.name).sort()).toEqual(['a', 'b']);
  });

  it('缺 SKILL.md 的目录跳过（不报错）', () => {
    mkdirSync(join(appSkillRoot(dataDir), 'empty-dir'), { recursive: true });
    writeSkillMd(join(appSkillRoot(dataDir), 'good'), 'good', 'g');
    const cat = SkillResolver.resolve(dataDir, undefined, store);
    expect(cat.entries).toHaveLength(1);
    expect(cat.entries[0]!.name).toBe('good');
  });

  it('frontmatter 缺 name 或非法 name 跳过', () => {
    // 缺 name
    mkdirSync(join(appSkillRoot(dataDir), 'bad1'), { recursive: true });
    writeFileSync(join(appSkillRoot(dataDir), 'bad1', 'SKILL.md'),
      '---\ndescription: no name\n---\nbody', 'utf8');
    // 非法 name（大写）
    mkdirSync(join(appSkillRoot(dataDir), 'bad2'), { recursive: true });
    writeFileSync(join(appSkillRoot(dataDir), 'bad2', 'SKILL.md'),
      '---\nname: BadName\ndescription: x\n---\nbody', 'utf8');
    const cat = SkillResolver.resolve(dataDir, undefined, store);
    expect(cat.entries).toHaveLength(0);
  });

  it('enabledStore 注入：disabled 的 entry.enabled=false', () => {
    writeSkillMd(join(appSkillRoot(dataDir), 'demo'), 'demo', 'd');
    store.setEnabled('demo', false);
    const cat = SkillResolver.resolve(dataDir, undefined, store);
    expect(cat.entries[0]!.enabled).toBe(false);
  });

  it('enabledStore fallback：无 record 视为 enabled', () => {
    writeSkillMd(join(appSkillRoot(dataDir), 'demo'), 'demo', 'd');
    const cat = SkillResolver.resolve(dataDir, undefined, store);
    expect(cat.entries[0]!.enabled).toBe(true);
  });

  it('enabledStore null：全 enabled', () => {
    writeSkillMd(join(appSkillRoot(dataDir), 'demo'), 'demo', 'd');
    const cat = SkillResolver.resolve(dataDir, undefined, null);
    expect(cat.entries[0]!.enabled).toBe(true);
  });

  it('lookup：workspace 优先 app fallback，返回 L1 全文', () => {
    writeSkillMd(join(appSkillRoot(dataDir), 'shared'), 'shared', 'app 版');
    const c1 = SkillResolver.lookup(dataDir, undefined, 'shared');
    expect(c1?.scope).toBe('app');
    expect(c1?.body).toContain('# shared');
    expect(c1?.skillDir).toBe(join(appSkillRoot(dataDir), 'shared'));

    // 加 workspace 同名 → 命中 workspace
    writeSkillMd(join(workspaceSkillRoot(workspace), 'shared'), 'shared', 'ws 版');
    const c2 = SkillResolver.lookup(dataDir, workspace, 'shared');
    expect(c2?.scope).toBe('workspace');
  });

  it('lookup 未命中 → undefined', () => {
    expect(SkillResolver.lookup(dataDir, undefined, 'nope')).toBeUndefined();
  });

  it('治理字段保留（source/production_method/evolvable）', () => {
    writeSkillMd(join(appSkillRoot(dataDir), 'demo'), 'demo', 'd',
      'source: user\nproduction_method: download\nevolvable: false\n');
    const cat = SkillResolver.resolve(dataDir, undefined, store);
    const e = cat.entries[0]!;
    expect(e.source).toBe('user');
    expect(e.productionMethod).toBe('download');
    expect(e.evolvable).toBe(false);
  });

  it('[v0.0.55] evolvable=true 从 frontmatter 正确解析（agent create 产出的 skill）', () => {
    writeSkillMd(join(appSkillRoot(dataDir), 'agent-skill'), 'agent-skill', 'd',
      'source: agent\nproduction_method: consolidation\nevolvable: true\n');
    const cat = SkillResolver.resolve(dataDir, undefined, store);
    const e = cat.entries[0]!;
    expect(e.source).toBe('agent');
    expect(e.productionMethod).toBe('consolidation');
    expect(e.evolvable).toBe(true);
  });

  it('[v0.0.55] frontmatter 缺 evolvable 字段 → 默认 false（§6.3 保守：immutable by default）', () => {
    // 不写 evolvable 字段
    writeSkillMd(join(appSkillRoot(dataDir), 'no-evo'), 'no-evo', 'd',
      'source: user\nproduction_method: handwritten\n');
    const cat = SkillResolver.resolve(dataDir, undefined, store);
    const e = cat.entries[0]!;
    expect(e.evolvable).toBe(false); // 缺省视为 false（保守 immutable by default）
  });

  it('[v0.0.149] 读 updatedAt frontmatter（优先 updatedAt 语义化字段）', () => {
    writeSkillMd(join(appSkillRoot(dataDir), 'ts'), 'ts', 'd',
      'updatedAt: 2026-07-15T00:00:00.000Z\n');
    const cat = SkillResolver.resolve(dataDir, undefined, store);
    expect(cat.entries[0]!.updatedAt).toBe('2026-07-15T00:00:00.000Z');
  });

  it('[v0.0.149] 读 updated 短形 frontmatter（回退兼容）', () => {
    writeSkillMd(join(appSkillRoot(dataDir), 'ts2'), 'ts2', 'd',
      'updated: 2026-06-01T00:00:00.000Z\n');
    const cat = SkillResolver.resolve(dataDir, undefined, store);
    expect(cat.entries[0]!.updatedAt).toBe('2026-06-01T00:00:00.000Z');
  });

  it('[v0.0.149] updatedAt 优先于 updated（两者并存取 updatedAt）', () => {
    writeSkillMd(join(appSkillRoot(dataDir), 'ts3'), 'ts3', 'd',
      'updated: 2026-01-01T00:00:00.000Z\nupdatedAt: 2026-07-01T00:00:00.000Z\n');
    const cat = SkillResolver.resolve(dataDir, undefined, store);
    expect(cat.entries[0]!.updatedAt).toBe('2026-07-01T00:00:00.000Z');
  });

  it('[v0.0.149] frontmatter 缺 updated/updatedAt → updatedAt=undefined（legacy/builtin 容忍）', () => {
    writeSkillMd(join(appSkillRoot(dataDir), 'legacy'), 'legacy', 'd');
    const cat = SkillResolver.resolve(dataDir, undefined, store);
    expect(cat.entries[0]!.updatedAt).toBeUndefined();
  });

  it('[v0.0.149] 合并层透传 updatedAt（workspace 命中层带戳胜出）', () => {
    // app 层无戳 + workspace 层带 updatedAt → 合并后 workspace 胜出且 updatedAt 透传
    writeSkillMd(join(appSkillRoot(dataDir), 'shared'), 'shared', 'app 无戳');
    writeSkillMd(join(workspaceSkillRoot(workspace), 'shared'), 'shared', 'ws 带戳',
      'updatedAt: 2026-07-15T00:00:00.000Z\n');
    const cat = SkillResolver.resolve(dataDir, workspace, store);
    const e = cat.entries.find((x) => x.name === 'shared');
    expect(e?.scope).toBe('workspace');
    expect(e?.updatedAt).toBe('2026-07-15T00:00:00.000Z');
  });

  it('[v0.0.55] L0 catalog 数据：resolve + filter(enabled) 后 disabled 不进 L0 + evolvable 字段传递', () => {
    // 模拟 session-config.ts 的 L0 catalog 构造逻辑（filter enabled）
    writeSkillMd(join(appSkillRoot(dataDir), 'enabled-evo'), 'enabled-evo', 'e',
      'source: agent\nevolvable: true\n');
    writeSkillMd(join(appSkillRoot(dataDir), 'disabled-evo'), 'disabled-evo', 'd',
      'source: agent\nevolvable: true\n');
    store.setEnabled('disabled-evo', false); // disabled
    const cat = SkillResolver.resolve(dataDir, undefined, store);
    // 模拟 session-config.ts L0 过滤：仅 enabled 进 catalog
    const l0 = cat.entries.filter((e) => e.enabled);
    expect(l0.map((e) => e.name)).toEqual(['enabled-evo']);
    expect(l0[0]!.evolvable).toBe(true); // evolvable 字段正确传递到 L0 catalog
    // disabled skill 仍在 resolveAll 全量（供 skill_manage.list 用），但 L0 catalog 不含
    expect(cat.entries.map((e) => e.name).sort()).toEqual(['disabled-evo', 'enabled-evo']);
  });
});

// ── [v0.0.33.3 T5] builtin 层（第三扫描路径）──
//   独立 describe + 自带 beforeEach：dataDir/workspace/store/builtinDir 各自隔离，
//   不依赖外层 describe 的 fixture（外层 beforeEach 已随其 describe 闭合）。
describe('SkillResolver builtin 层（v0.0.33.3）', () => {
  let dataDir: string;
  let workspace: string;
  let store: SkillEnabledStore;
  let builtinDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-resolver-builtin-'));
    workspace = mkdtempSync(join(tmpdir(), 'rocky-ws-builtin-'));
    const appConfig = new AppConfigService({ root: dataDir });
    store = new SkillEnabledStore(appConfig);
    // 每个用例用独立 tmp 目录作 builtin root（避免测试间污染 + 不扫真 builtins）
    builtinDir = mkdtempSync(join(tmpdir(), 'rocky-builtin-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
    rmSync(builtinDir, { recursive: true, force: true });
  });

  it('resolve 传 builtinDir → 扫 builtin 层（scope=builtin）', () => {
    writeSkillMd(join(builtinDir, 'b1'), 'b1', '内置技能');
    const cat = SkillResolver.resolve(dataDir, undefined, store, builtinDir);
    const e = cat.entries.find((x) => x.name === 'b1');
    expect(e).toBeTruthy();
    expect(e!.scope).toBe('builtin');
    expect(e!.description).toBe('内置技能');
  });

  it('合并优先级：workspace > app > builtin（同名高层胜出）', () => {
    writeSkillMd(join(builtinDir, 'shared'), 'shared', 'builtin 版');
    writeSkillMd(join(appSkillRoot(dataDir), 'shared'), 'shared', 'app 版');
    writeSkillMd(join(workspaceSkillRoot(workspace), 'shared'), 'shared', 'workspace 版');
    const cat = SkillResolver.resolve(dataDir, workspace, store, builtinDir);
    const e = cat.entries.find((x) => x.name === 'shared');
    expect(e?.scope).toBe('workspace');
    // 去掉 workspace 层 → app 胜出
    const cat2 = SkillResolver.resolve(dataDir, undefined, store, builtinDir);
    const e2 = cat2.entries.find((x) => x.name === 'shared');
    expect(e2?.scope).toBe('app');
    // 去掉 app + workspace → builtin 兜底
    const emptyData = mkdtempSync(join(tmpdir(), 'rocky-empty-'));
    try {
      const cat3 = SkillResolver.resolve(emptyData, undefined, store, builtinDir);
      const e3 = cat3.entries.find((x) => x.name === 'shared');
      expect(e3?.scope).toBe('builtin');
    } finally {
      rmSync(emptyData, { recursive: true, force: true });
    }
  });

  it('builtin 不传 builtinDir → 不扫（双层语义不变，测试隔离）', () => {
    writeSkillMd(join(builtinDir, 'only-builtin'), 'only-builtin', 'x');
    // 不传第 4 参 → catalog 不含 only-builtin
    const cat = SkillResolver.resolve(dataDir, undefined, store);
    expect(cat.entries.find((x) => x.name === 'only-builtin')).toBeUndefined();
  });

  it('lookup：workspace → app → builtin 逐层 fallback', () => {
    writeSkillMd(join(builtinDir, 'look'), 'look', '内置');
    // 仅 builtin 有 → 命中 builtin
    const c1 = SkillResolver.lookup(dataDir, undefined, 'look', builtinDir);
    expect(c1?.scope).toBe('builtin');
    // app 层补同名 → 命中 app（app > builtin）
    writeSkillMd(join(appSkillRoot(dataDir), 'look'), 'look', 'app 版');
    const c2 = SkillResolver.lookup(dataDir, undefined, 'look', builtinDir);
    expect(c2?.scope).toBe('app');
  });

  it('真实内置 okf-skill catalog 可解析', () => {
    // 验证随 app 发版的 squad 技能能被 builtinSkillRoot() 定位 + 解析（T5 核心：catalog 能解析）
    const root = builtinSkillRoot();
    const cat = SkillResolver.resolve(dataDir, undefined, null, root);
    const names = cat.entries.map((e) => e.name);
    expect(names).toContain('okf-skill');
    expect(names).toContain('task-based-squad-management');
    // scope 全为 builtin（dataDir/workspace 不含同名）
    for (const e of cat.entries) {
      if (['okf-skill', 'task-based-squad-management'].includes(e.name)) {
        expect(e.scope).toBe('builtin');
        expect(e.description.length).toBeGreaterThan(0);
      }
    }
  });
});

// ── group 层（第四扫描路径 + 合并优先级最高；v0.0.205 squad→group 改名 + .rocky 收口）──
//   独立 describe + 自带 beforeEach：dataDir/workspace/store/builtinDir/groupDir 各自隔离，
//   覆盖 4 层扫描 + 同名 group 覆盖 workspace + groupDir omit 向后兼容。
describe('SkillResolver group 层（v0.0.205）', () => {
  let dataDir: string;
  let workspace: string;
  let store: SkillEnabledStore;
  let builtinDir: string;
  // groupDir = group ws 根目录（squad 共享 ws），resolver 内部 join `.rocky/skills/` 派生
  let groupDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-resolver-group-'));
    workspace = mkdtempSync(join(tmpdir(), 'rocky-ws-group-'));
    const appConfig = new AppConfigService({ root: dataDir });
    store = new SkillEnabledStore(appConfig);
    builtinDir = mkdtempSync(join(tmpdir(), 'rocky-builtin-group-'));
    // 模拟 caller（session-config / skill handler）经 resolveGroupWsDir 派生的 groupDir：group ws 根本身
    // 结构 = <tmp>/grp-root/.rocky/skills/ （由 test 内 writeSkillMd 建）
    groupDir = mkdtempSync(join(tmpdir(), 'rocky-grp-root-'));
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
    rmSync(builtinDir, { recursive: true, force: true });
    rmSync(groupDir, { recursive: true, force: true });
  });

  it('groupSkillRoot(groupWsDir) 返回 <groupWsDir>/.rocky/skills/', () => {
    // 路径字面契约：与 group memory `.rocky/memory/` 同构（.rocky 收口）
    const p = groupSkillRoot('/tmp/data/squads/sq-abc');
    expect(p).toBe(join('/tmp/data/squads/sq-abc', '.rocky', 'skills'));
  });

  it('resolve 传 groupDir → 扫 group 层（scope=group）', () => {
    // group skill 目录：<groupDir>/.rocky/skills/<name>/SKILL.md
    writeSkillMd(join(groupDir, '.rocky', 'skills', 'sq1'), 'sq1', 'group 技能');
    const cat = SkillResolver.resolve(dataDir, undefined, store, undefined, groupDir);
    const e = cat.entries.find((x) => x.name === 'sq1');
    expect(e).toBeTruthy();
    expect(e!.scope).toBe('group');
    expect(e!.description).toBe('group 技能');
  });

  it('合并优先级：group > workspace > app > builtin（同名高层胜出）', () => {
    // 4 层同名 skill：'shared'
    writeSkillMd(join(builtinDir, 'shared'), 'shared', 'builtin 版');
    writeSkillMd(join(appSkillRoot(dataDir), 'shared'), 'shared', 'app 版');
    writeSkillMd(join(workspaceSkillRoot(workspace), 'shared'), 'shared', 'workspace 版');
    writeSkillMd(join(groupDir, '.rocky', 'skills', 'shared'), 'shared', 'group 版');

    // 全 4 层 → group 胜出
    const cat = SkillResolver.resolve(dataDir, workspace, store, builtinDir, groupDir);
    const e = cat.entries.find((x) => x.name === 'shared');
    expect(e?.scope).toBe('group');
    expect(e?.description).toBe('group 版');

    // 去掉 group 层（omit groupDir）→ workspace 胜出（原三层行为等价）
    const cat2 = SkillResolver.resolve(dataDir, workspace, store, builtinDir);
    const e2 = cat2.entries.find((x) => x.name === 'shared');
    expect(e2?.scope).toBe('workspace');
  });

  it('group 同名覆盖 workspace（group > workspace）', () => {
    // group 与 workspace 同名 → group 胜出
    writeSkillMd(join(workspaceSkillRoot(workspace), 'shared'), 'shared', 'workspace 版');
    writeSkillMd(join(groupDir, '.rocky', 'skills', 'shared'), 'shared', 'group 版');
    const cat = SkillResolver.resolve(dataDir, workspace, store, undefined, groupDir);
    const e = cat.entries.find((x) => x.name === 'shared');
    expect(e?.scope).toBe('group');
    expect(e?.description).toBe('group 版');
  });

  it('groupDir omit → 与既有三层行为等价（向后兼容 playground/subagent）', () => {
    // 只 group 目录有 skill，但 omit groupDir → catalog 不含 group-only skill
    writeSkillMd(join(groupDir, '.rocky', 'skills', 'only-group'), 'only-group', 'x');
    writeSkillMd(join(appSkillRoot(dataDir), 'app-only'), 'app-only', 'app 版');
    const cat = SkillResolver.resolve(dataDir, workspace, store);
    const names = cat.entries.map((e) => e.name);
    expect(names).toContain('app-only');
    expect(names).not.toContain('only-group');
  });

  it('resolveAll 透传 groupDir（同 resolve）', () => {
    // disabled 的 group skill 也在 resolveAll 全量中
    writeSkillMd(join(groupDir, '.rocky', 'skills', 'sq-disabled'), 'sq-disabled', 'x');
    store.setEnabled('sq-disabled', false);
    const cat = SkillResolver.resolveAll(dataDir, undefined, store, undefined, groupDir);
    const e = cat.entries.find((x) => x.name === 'sq-disabled');
    expect(e).toBeTruthy();
    expect(e!.scope).toBe('group');
    expect(e!.enabled).toBe(false); // enabled 反映实际状态，不 filter
  });

  it('lookup：group → workspace → app → builtin 逐层 fallback', () => {
    // 仅 group 有 → 命中 group
    writeSkillMd(join(groupDir, '.rocky', 'skills', 'look'), 'look', 'group 版');
    const c1 = SkillResolver.lookup(dataDir, undefined, 'look', undefined, groupDir);
    expect(c1?.scope).toBe('group');
    expect(c1?.body).toContain('# look');
    expect(c1?.skillDir).toBe(join(groupDir, '.rocky', 'skills', 'look'));
  });

  it('lookup：workspace 补同名 → group 仍胜出（group 最高优先级）', () => {
    writeSkillMd(join(groupDir, '.rocky', 'skills', 'look'), 'look', 'group 版');
    writeSkillMd(join(workspaceSkillRoot(workspace), 'look'), 'look', 'ws 版');
    const c = SkillResolver.lookup(dataDir, workspace, 'look', undefined, groupDir);
    expect(c?.scope).toBe('group');
  });

  it('lookup：groupDir omit → 原三层 fallback 顺序不变', () => {
    // omit groupDir，走原 workspace → app → builtin 顺序
    writeSkillMd(join(appSkillRoot(dataDir), 'look'), 'look', 'app 版');
    writeSkillMd(join(workspaceSkillRoot(workspace), 'look'), 'look', 'ws 版');
    const c = SkillResolver.lookup(dataDir, workspace, 'look');
    expect(c?.scope).toBe('workspace');
  });

  it('group skill dir 不存在（groupDir 传入但 `.rocky/skills/` 目录未建）→ 无 fail，group entries 为空', () => {
    // groupDir 是 tmp 空目录，未建 .rocky/skills/ 子目录（首次 group 无 skill 场景）
    // 应静默返 empty（不抛 ENOENT），与 workspace 层 workspaceDir 存在但 .rocky/skills/ 不存在语义对齐
    writeSkillMd(join(appSkillRoot(dataDir), 'app-only'), 'app-only', 'x');
    const cat = SkillResolver.resolve(dataDir, undefined, store, undefined, groupDir);
    expect(cat.entries.map((e) => e.name)).toEqual(['app-only']);
  });

  it('4 层完整并存（各层各出一 skill，无同名）→ 4 entries + scope 各归各', () => {
    writeSkillMd(join(builtinDir, 'b1'), 'b1', 'builtin');
    writeSkillMd(join(appSkillRoot(dataDir), 'a1'), 'a1', 'app');
    writeSkillMd(join(workspaceSkillRoot(workspace), 'w1'), 'w1', 'workspace');
    writeSkillMd(join(groupDir, '.rocky', 'skills', 's1'), 's1', 'squad');
    const cat = SkillResolver.resolve(dataDir, workspace, store, builtinDir, groupDir);
    const byName = new Map(cat.entries.map((e) => [e.name, e]));
    expect(byName.get('b1')?.scope).toBe('builtin');
    expect(byName.get('a1')?.scope).toBe('app');
    expect(byName.get('w1')?.scope).toBe('workspace');
    expect(byName.get('s1')?.scope).toBe('group');
    expect(cat.entries).toHaveLength(4);
  });
});
