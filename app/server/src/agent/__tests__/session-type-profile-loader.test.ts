/**
 * SessionTypeProfileLoader + SessionTypePolicy 单测（v0.0.204 T2）
 * 参考: specs/tech/agent/session/[P0]session_type_profile.md §3/§4/§6
 *
 * 覆盖：
 *   - loadAll：扫 root 下 yaml → id 索引；基座必在（default/summary/consolidate）
 *   - extends 链：逐字段深合并 / 父补全 / 链式回退
 *   - validateAll：父存在 / 环 / toolBound 幽灵名硬失败
 *   - resolveToolSet：bound ∩ instanceOverride、保注册序、剔幽灵名
 *   - toolBound 迁移等价（对照原 TOOL_POLICY 7 key 现值，固化期望表）
 *   - 手动/自动 summary 同 profile（playground-rocky:parent:summary 空 = 全继承 summary 基座）
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SessionTypeProfileLoader } from '../session-type-profile-loader';
import { SessionTypeProfileValidator } from '../session-type-profile-validator';
import { SessionTypePolicyImpl } from '../session-type-policy';
import type { Tool, ToolDefinition } from '../../tools/types';
import { SessionKind } from '@app/shared';
import { buildRealSessionTypePolicy } from '../__helpers__/session-type-policy-test-helper';

/** 临时目录构造 helper */
function tmpProfileRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stp-test-'));
}

/** 写 yaml 文件（content 直写到 root/{name}.yaml） */
function writeYaml(root: string, name: string, content: string): void {
  fs.writeFileSync(path.join(root, `${name}.yaml`), content, 'utf8');
}

/** 全套基座 + 一个 main 类型（最小可测 set） */
function seedMinimal(root: string): void {
  writeYaml(root, 'default', `
id: default
enabled: true
toolBound: [read, write]
toolDefinitionsSource: own
runShape:
  drainMode: eager
  backgroundPath: false
  maxIterDefault: 25
  touchesStateMachine: true
  persistsRun: true
  usagePartition: current
`);
  writeYaml(root, 'summary', `
id: summary
extends: default
toolBound: []
toolDefinitionsSource: host-snapshot
runShape:
  drainMode: none
  persistsRun: false
  usagePartition: summary
`);
  writeYaml(root, 'consolidate', `
id: consolidate
extends: default
toolBound: [skill_manage, memory_manage]
toolDefinitionsSource: host-snapshot
runShape:
  drainMode: none
  persistsRun: false
  usagePartition: consolidate
`);
  writeYaml(root, 'subagent', `
id: subagent
extends: default
toolBound: [read, write]
`);
  writeYaml(root, 'playground-rocky.parent.main', `
id: playground-rocky:parent:main
extends: default
`);
  writeYaml(root, 'playground-rocky.parent.summary', `
id: playground-rocky:parent:summary
extends: summary
`);
  writeYaml(root, 'playground-rocky.parent.consolidate', `
id: playground-rocky:parent:consolidate
extends: consolidate
`);
  writeYaml(root, 'playground-rocky.subagent.main', `
id: playground-rocky:subagent:main
extends: subagent
`);
  writeYaml(root, 'playground-rocky.subagent.summary', `
id: playground-rocky:subagent:summary
extends: summary
`);
  writeYaml(root, 'playground-rocky.subagent.consolidate', `
id: playground-rocky:subagent:consolidate
extends: consolidate
`);
}

const STUB_TOOLS: Tool[] = ['read', 'write', 'skill_manage', 'memory_manage', 'edit', 'bash'].map((name) => ({
  definition: { name, description: `stub-${name}`, inputSchema: { type: 'object' as const } },
  run: async () => ({ content: [], isError: false }),
}));
const STUB_DEFS: ToolDefinition[] = STUB_TOOLS.map((t) => t.definition);

// ============================================================
// 1. loadAll 基础
// ============================================================

describe('SessionTypeProfileLoader.loadAll', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProfileRoot();
    seedMinimal(root);
  });

  it('扫 root 下 yaml → id 索引（10 文件 = 10 id）', () => {
    const loader = new SessionTypeProfileLoader(root);
    const raws = loader.loadAll();
    expect(raws.length).toBe(10);
    expect(loader.has('default')).toBe(true);
    expect(loader.has('summary')).toBe(true);
    expect(loader.has('consolidate')).toBe(true);
    expect(loader.has('subagent')).toBe(true);
    expect(loader.has('playground-rocky:parent:main')).toBe(true);
    expect(loader.has('playground-rocky:subagent:main')).toBe(true);
  });

  it('基座缺失 → loadAll 抛错', () => {
    fs.unlinkSync(path.join(root, 'summary.yaml'));
    const loader = new SessionTypeProfileLoader(root);
    expect(() => loader.loadAll()).toThrow(/基座 profile "summary" 缺失/);
  });

  it('subagent 基座缺失 → loadAll 抛错（四基座之一）', () => {
    fs.unlinkSync(path.join(root, 'subagent.yaml'));
    const loader = new SessionTypeProfileLoader(root);
    expect(() => loader.loadAll()).toThrow(/基座 profile "subagent" 缺失/);
  });

  it('root 不存在 → loadAll 抛错', () => {
    const loader = new SessionTypeProfileLoader('/nonexistent/path/xyz');
    expect(() => loader.loadAll()).toThrow(/根目录不存在或不可读/);
  });
});

// ============================================================
// 2. extends 链：逐字段深合并 + 链式回退
// ============================================================

describe('SessionTypeProfileLoader extends 链合并', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProfileRoot();
    seedMinimal(root);
  });

  it('playground-rocky:parent:main extends default：toolBound 继承父值（[read,write]）', () => {
    const loader = new SessionTypeProfileLoader(root);
    loader.loadAll();
    const p = loader.profile('playground-rocky:parent:main');
    expect(p.toolBound).toEqual(['read', 'write']);
    expect(p.runShape.drainMode).toBe('eager');
    expect(p.runShape.maxIterDefault).toBe(25);
    expect(p.runShape.usagePartition).toBe('current');
  });

  it('summary 继承 default 但覆盖 drainMode/persistsRun/usagePartition/toolBound', () => {
    const loader = new SessionTypeProfileLoader(root);
    loader.loadAll();
    const p = loader.profile('summary');
    expect(p.runShape.drainMode).toBe('none');
    expect(p.runShape.persistsRun).toBe(false);
    expect(p.runShape.usagePartition).toBe('summary');
    expect(p.toolBound).toEqual([]);
    // 未覆盖字段继续继承
    expect(p.runShape.maxIterDefault).toBe(25);
    expect(p.runShape.backgroundPath).toBe(false);
  });

  it('consolidate 继承 default + 自带 toolBound=[skill_manage,memory_manage]', () => {
    const loader = new SessionTypeProfileLoader(root);
    loader.loadAll();
    const p = loader.profile('consolidate');
    expect(p.toolBound).toEqual(['skill_manage', 'memory_manage']);
    expect(p.runShape.usagePartition).toBe('consolidate');
  });

  it('缓存命中：二次 profile(id) 返同实例', () => {
    const loader = new SessionTypeProfileLoader(root);
    loader.loadAll();
    const p1 = loader.profile('playground-rocky:parent:main');
    const p2 = loader.profile('playground-rocky:parent:main');
    expect(p1).toBe(p2);
  });
});

// ============================================================
// 3. validateAll：父存在 / 环 / toolBound 幽灵名
// ============================================================

describe('SessionTypeProfileValidator', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProfileRoot();
    seedMinimal(root);
  });

  it('合法配置：基座 + main + summary + consolidate 全部通过', () => {
    const loader = new SessionTypeProfileLoader(root);
    loader.loadAll();
    const v = new SessionTypeProfileValidator({
      loader,
      registered: { names: new Set(['read', 'write', 'skill_manage', 'memory_manage']) },
    });
    expect(() => v.validateAll()).not.toThrow();
  });

  it('toolBound 含未注册工具 → 硬失败', () => {
    writeYaml(root, 'playground-rocky.parent.main', `
id: playground-rocky:parent:main
extends: default
toolBound: [read, ghost_tool]
`);
    const loader = new SessionTypeProfileLoader(root);
    loader.loadAll();
    const v = new SessionTypeProfileValidator({
      loader,
      registered: { names: new Set(['read', 'write', 'skill_manage', 'memory_manage']) },
    });
    expect(() => v.validateAll()).toThrow(/toolBound 含未注册工具 "ghost_tool"/);
  });

  it('extends 未知父 → 硬失败', () => {
    writeYaml(root, 'playground-rocky.parent.main', `
id: playground-rocky:parent:main
extends: nonexistent
`);
    const loader = new SessionTypeProfileLoader(root);
    loader.loadAll();
    const v = new SessionTypeProfileValidator({
      loader,
      registered: { names: new Set(['read', 'write', 'skill_manage', 'memory_manage']) },
    });
    expect(() => v.validateAll()).toThrow(/extends 未知父 "nonexistent"/);
  });

  it('extends 成环 → 硬失败', () => {
    writeYaml(root, 'A', `id: A\nextends: B\n`);
    writeYaml(root, 'B', `id: B\nextends: A\n`);
    const loader = new SessionTypeProfileLoader(root);
    loader.loadAll();
    const v = new SessionTypeProfileValidator({
      loader,
      // 注册全部 base toolBound 名（避免 toolBound 校验先于环检测 throw，干扰断言）
      registered: { names: new Set(['read', 'write', 'skill_manage', 'memory_manage']) },
    });
    expect(() => v.validateAll()).toThrow(/extends 链成环/);
  });

  it('矩阵完整性：main 缺 summary → 硬失败', () => {
    // 删 subagent.summary → subagent.main 触发矩阵校验失败
    fs.unlinkSync(path.join(root, 'playground-rocky.subagent.summary.yaml'));
    const loader = new SessionTypeProfileLoader(root);
    loader.loadAll();
    const v = new SessionTypeProfileValidator({
      loader,
      registered: { names: new Set(['read', 'write', 'skill_manage', 'memory_manage']) },
    });
    expect(() => v.validateAll()).toThrow(/缺对应 summary profile "playground-rocky:subagent:summary"/);
  });

  it('矩阵完整性：main 缺 consolidate → 硬失败', () => {
    // 删 subagent.consolidate → subagent.main 触发矩阵校验失败
    fs.unlinkSync(path.join(root, 'playground-rocky.subagent.consolidate.yaml'));
    const loader = new SessionTypeProfileLoader(root);
    loader.loadAll();
    const v = new SessionTypeProfileValidator({
      loader,
      registered: { names: new Set(['read', 'write', 'skill_manage', 'memory_manage']) },
    });
    expect(() => v.validateAll()).toThrow(/缺对应 consolidate profile "playground-rocky:subagent:consolidate"/);
  });

  it('矩阵完整性：disabled main 缺 summary/consolidate → 跳过（不硬失败）', () => {
    // 新增一个 disabled main 类型，缺 summary/consolidate，不应触发校验失败
    writeYaml(root, 'studio-squad.parent.main', `
id: studio-squad:parent:main
extends: default
enabled: false
`);
    const loader = new SessionTypeProfileLoader(root);
    loader.loadAll();
    const v = new SessionTypeProfileValidator({
      loader,
      registered: { names: new Set(['read', 'write', 'skill_manage', 'memory_manage']) },
    });
    expect(() => v.validateAll()).not.toThrow();
  });

  it('矩阵完整性：基座（default/summary/consolidate，无冒号）不触发 main 矩阵校验', () => {
    // 基座 id 无 `:main` 后缀，mainPrefixOf 返 null，不进入矩阵校验
    const loader = new SessionTypeProfileLoader(root);
    loader.loadAll();
    const v = new SessionTypeProfileValidator({
      loader,
      registered: { names: new Set(['read', 'write', 'skill_manage', 'memory_manage']) },
    });
    expect(() => v.validateAll()).not.toThrow();
  });

  it('禁跨 biz extends：studio-mate extends playground-rocky → 硬失败', () => {
    writeYaml(root, 'studio-mate.subagent.main', `
id: studio-mate:subagent:main
extends: playground-rocky:subagent:main
`);
    // 矩阵闭合所需的 summary/consolidate（不影响本断言，只为隔离跨 biz 错误）
    writeYaml(root, 'studio-mate.subagent.summary', `
id: studio-mate:subagent:summary
extends: summary
`);
    writeYaml(root, 'studio-mate.subagent.consolidate', `
id: studio-mate:subagent:consolidate
extends: consolidate
`);
    const loader = new SessionTypeProfileLoader(root);
    loader.loadAll();
    const v = new SessionTypeProfileValidator({
      loader,
      registered: { names: new Set(['read', 'write', 'skill_manage', 'memory_manage']) },
    });
    expect(() => v.validateAll()).toThrow(/禁跨 biz extends.*"studio-mate:subagent:main".*"playground-rocky:subagent:main"/);
  });

  it('extends 系统基座放行：studio-leader extends subagent（基座可跨 biz 被继承）', () => {
    writeYaml(root, 'studio-leader.subagent.main', `
id: studio-leader:subagent:main
extends: subagent
`);
    writeYaml(root, 'studio-leader.subagent.summary', `
id: studio-leader:subagent:summary
extends: summary
`);
    writeYaml(root, 'studio-leader.subagent.consolidate', `
id: studio-leader:subagent:consolidate
extends: consolidate
`);
    const loader = new SessionTypeProfileLoader(root);
    loader.loadAll();
    const v = new SessionTypeProfileValidator({
      loader,
      registered: { names: new Set(['read', 'write', 'skill_manage', 'memory_manage']) },
    });
    expect(() => v.validateAll()).not.toThrow();
  });

  it('subagent 基座继承等价：playground-rocky:subagent:main extends subagent → toolBound 取基座值', () => {
    const loader = new SessionTypeProfileLoader(root);
    loader.loadAll();
    const resolved = loader.profile('playground-rocky:subagent:main');
    expect(resolved.toolBound).toEqual(['read', 'write']); // 来自 fixture subagent 基座
    expect(resolved.extends).toBe('subagent');
  });
});

// ============================================================
// 4. resolveToolSet：三层一致 + bound ∩ instanceOverride
// ============================================================

describe('SessionTypePolicyImpl.resolveToolSet', () => {
  let root: string;
  beforeEach(() => {
    root = tmpProfileRoot();
    seedMinimal(root);
  });

  it('main-run 无 instanceOverride → tools = bound', () => {
    const loader = new SessionTypeProfileLoader(root);
    loader.loadAll();
    const policy = new SessionTypePolicyImpl({
      loader, allTools: STUB_TOOLS, allToolDefinitions: STUB_DEFS,
    });
    const kind = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent', runKind: 'main' });
    const r = policy.resolveToolSet(kind);
    expect(r.allowedTools).toEqual(['read', 'write']);
    expect(r.tools.map((t) => t.definition.name)).toEqual(['read', 'write']);
    expect(r.toolDefinitions.map((d) => d.name)).toEqual(['read', 'write']);
  });

  it('instanceOverride ∩ bound → 子集（剔 bound 外）', () => {
    const loader = new SessionTypeProfileLoader(root);
    loader.loadAll();
    const policy = new SessionTypePolicyImpl({
      loader, allTools: STUB_TOOLS, allToolDefinitions: STUB_DEFS,
    });
    const kind = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'subagent', runKind: 'main' });
    // override 含 [read, write, bash]；playground bound=[read,write] → bash 被剥离
    const r = policy.resolveToolSet(kind, { tools: ['read', 'write', 'bash'] });
    expect(r.allowedTools).toEqual(['read', 'write']);
  });

  it('保 allTools 注册序（非 override 输入序）', () => {
    const loader = new SessionTypeProfileLoader(root);
    loader.loadAll();
    const policy = new SessionTypePolicyImpl({
      loader, allTools: STUB_TOOLS, allToolDefinitions: STUB_DEFS,
    });
    const kind = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent', runKind: 'main' });
    // override 输入序 [write, read] → 输出按 registry 序 [read, write]
    const r = policy.resolveToolSet(kind, { tools: ['write', 'read'] });
    expect(r.allowedTools).toEqual(['read', 'write']);
  });

  it('summary runKind：bound=[] → 零工具', () => {
    const loader = new SessionTypeProfileLoader(root);
    loader.loadAll();
    const policy = new SessionTypePolicyImpl({
      loader, allTools: STUB_TOOLS, allToolDefinitions: STUB_DEFS,
    });
    const kind = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent', runKind: 'summary' });
    const r = policy.resolveToolSet(kind);
    expect(r.allowedTools).toEqual([]);
    expect(r.tools).toEqual([]);
  });

  it('consolidate runKind：bound=[skill_manage, memory_manage]', () => {
    const loader = new SessionTypeProfileLoader(root);
    loader.loadAll();
    const policy = new SessionTypePolicyImpl({
      loader, allTools: STUB_TOOLS, allToolDefinitions: STUB_DEFS,
    });
    const kind = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent', runKind: 'consolidate' });
    const r = policy.resolveToolSet(kind);
    expect(r.allowedTools).toEqual(['skill_manage', 'memory_manage']);
  });

  it('bound 含未注册工具（ghost）→ resolveToolSet 静默剔除（保 registry 序）', () => {
    // bound 写入 ghost 名（validator 会被绕过，但 resolveToolSet 自身防御剔除）
    writeYaml(root, 'playground-rocky.parent.main', `
id: playground-rocky:parent:main
extends: default
toolBound: [read, ghost_tool, write]
`);
    const loader = new SessionTypeProfileLoader(root);
    loader.loadAll();
    const policy = new SessionTypePolicyImpl({
      loader, allTools: STUB_TOOLS, allToolDefinitions: STUB_DEFS,
    });
    const kind = new SessionKind({ biz: 'playground', role: 'rocky', derivation: 'parent', runKind: 'main' });
    const r = policy.resolveToolSet(kind);
    expect(r.allowedTools).toEqual(['read', 'write']);
    expect(r.tools.find((t) => t.definition.name === 'ghost_tool')).toBeUndefined();
  });
});

// ============================================================
// 5. toolBound 迁移等价表（与原 TOOL_POLICY 7 key 对照）
// ============================================================

describe('toolBound 迁移等价（对照原 TOOL_POLICY 7 key）', () => {
  // 用项目实际 app/plugins/session-types 目录的真实 yaml 跑
  const projectRoot = path.resolve(__dirname, '../../../../plugins/session-types');

  it('项目 session-types/ 目录存在 + 全套 yaml 加载 + validate', () => {
    const loader = new SessionTypeProfileLoader(projectRoot);
    expect(() => loader.loadAll()).not.toThrow();
    // 基座在
    expect(loader.has('default')).toBe(true);
    expect(loader.has('summary')).toBe(true);
    expect(loader.has('consolidate')).toBe(true);
  });

  it('playground-rocky:parent:main toolBound = 22 工具（等价原 SHARED_PLAYGROUND_BOUND + todo v0.0.223 经 default 继承）', () => {
    const loader = new SessionTypeProfileLoader(projectRoot);
    loader.loadAll();
    const p = loader.profile('playground-rocky:parent:main');
    expect(p.toolBound.length).toBe(22);
    expect(['read', 'write', 'agent', 'cron', 'ask-question', 'memory', 'computer', 'history_search', 'history_get_context', 'see_image', 'send_message', 'todo']
      .every((n) => p.toolBound.includes(n))).toBe(true);
    expect(['team', 'goal', 'requirement', 'task'].some((n) => p.toolBound.includes(n))).toBe(false);
  });

  it('studio-squad:parent:main toolBound = [send_message, todo, skill_manage, memory_manage]（哑路由 + consolidate 交集工具 + todo v0.0.223）', () => {
    const loader = new SessionTypeProfileLoader(projectRoot);
    loader.loadAll();
    expect(loader.profile('studio-squad:parent:main').toolBound).toEqual(['send_message', 'todo', 'skill_manage', 'memory_manage']);
  });

  it('studio-leader:parent:main toolBound = 24 工具（含 team/cron/presence/panorama/todo，无 agent；v0.0.237 摘 task/goal/requirement）', () => {
    const loader = new SessionTypeProfileLoader(projectRoot);
    loader.loadAll();
    const p = loader.profile('studio-leader:parent:main');
    expect(p.toolBound.length).toBe(24);
    expect(['team', 'cron', 'ask-question', 'memory', 'presence', 'panorama', 'history_search', 'history_get_context', 'see_image', 'computer', 'todo']
      .every((n) => p.toolBound.includes(n))).toBe(true);
    expect(p.toolBound).not.toContain('agent');
    // v0.0.237 task/goal/requirement 摘除
    expect(p.toolBound).not.toContain('task');
    expect(p.toolBound).not.toContain('goal');
    expect(p.toolBound).not.toContain('requirement');
  });

  it('studio-mate:parent:main toolBound = 25 工具（含 agent + presence + panorama；v0.0.237 摘 task/goal/requirement）', () => {
    const loader = new SessionTypeProfileLoader(projectRoot);
    loader.loadAll();
    const p = loader.profile('studio-mate:parent:main');
    expect(p.toolBound.length).toBe(25);
    expect(['agent', 'presence', 'panorama'].every((n) => p.toolBound.includes(n))).toBe(true);
    expect(p.toolBound).not.toContain('task');
    expect(p.toolBound).not.toContain('goal');
    expect(p.toolBound).not.toContain('requirement');
  });

  it('subagent (playground-rocky:subagent:main) toolBound = 19 工具（含 consolidate 交集 2 工具）', () => {
    const loader = new SessionTypeProfileLoader(projectRoot);
    loader.loadAll();
    const p = loader.profile('playground-rocky:subagent:main');
    expect(p.toolBound.length).toBe(19);
    // consolidate 旁路 run 交集工具（主 run 不主动整理资产，为旁路交集非空而带）
    expect(p.toolBound).toContain('skill_manage');
    expect(p.toolBound).toContain('memory_manage');
    expect(['agent', 'team', 'goal', 'requirement', 'task'].some((n) => p.toolBound.includes(n))).toBe(false);
  });

  it('手动/自动 summary 同 profile：playground-rocky:parent:summary 空=继承 summary 基座（无区分手动/自动字段）', () => {
    const loader = new SessionTypeProfileLoader(projectRoot);
    loader.loadAll();
    const p = loader.profile('playground-rocky:parent:summary');
    expect(p.toolBound).toEqual([]);
    expect(p.runShape.usagePartition).toBe('summary');
    expect(p.runShape.drainMode).toBe('none');
    expect(p.runShape.persistsRun).toBe(false);
    // profile 禁区分手动/自动字段：无 manualOnly / autoOnly / triggerSource 等字段
    const pAsAny = p as unknown as Record<string, unknown>;
    expect(pAsAny.manualOnly).toBeUndefined();
    expect(pAsAny.autoOnly).toBeUndefined();
  });

  it('squad consolidate allowedTools 交集非空（main toolBound ∩ consolidate 基座 = [skill_manage, memory_manage]）', () => {
    const loader = new SessionTypeProfileLoader(projectRoot);
    loader.loadAll();
    // 机制：consolidate run 的 allowedTools = main snapshot.tools（∝ main toolBound）
    //   ∩ consolidate profile toolBound（基座 [skill_manage, memory_manage]）。
    // main toolBound 缺这两工具 → 交集空 → 旁路空跑（v0.0.204 review M3）。
    for (const prefix of ['studio-squad:parent']) {
      const mainBound = loader.profile(`${prefix}:main`).toolBound;
      const consolidateBound = loader.profile(`${prefix}:consolidate`).toolBound;
      const intersection = consolidateBound.filter((n) => mainBound.includes(n));
      expect(intersection).toEqual(['skill_manage', 'memory_manage']);
    }
  });

  it('subagent 基座 toolBound ∩ consolidate 基座 含 skill_manage + memory_manage（全体 subagent fork-2 不空跑）', () => {
    const loader = new SessionTypeProfileLoader(projectRoot);
    loader.loadAll();
    // 各 *.subagent.main extends subagent 基座 + scope 未覆写 post_compact（继承 default
    // memory_skill_consolidation）→ subagent 基座必须带两资产工具，否则全部 subagent 旁路空跑。
    // v0.0.238：consolidate 扩 read/write/edit/glob/grep（T1 整理者化），subagent 基座本就带这些
    // 基础工具 → 交集 ⊇ [skill_manage, memory_manage, read, write, edit, glob, grep]（不再 toEqual 精确，
    // 因 consolidate toolBound 后续可能再扩；只断言关键资产工具非空即可）。
    const subagentBound = loader.profile('subagent').toolBound;
    const consolidateBound = loader.profile('consolidate').toolBound;
    const intersection = consolidateBound.filter((n) => subagentBound.includes(n));
    expect(intersection).toContain('skill_manage');
    expect(intersection).toContain('memory_manage');
    // 两个业务 subagent profile 经 extends 继承后同样成立
    for (const id of ['playground-rocky:subagent:main', 'studio-mate:subagent:main']) {
      const bound = loader.profile(id).toolBound;
      const inter = consolidateBound.filter((n) => bound.includes(n));
      expect(inter).toContain('skill_manage');
      expect(inter).toContain('memory_manage');
    }
  });
});
