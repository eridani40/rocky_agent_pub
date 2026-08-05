/**
 * ScopeConfigLoader 单测（白盒）—— 读 app/plugins/scopes/*.yaml → ScopeConfig[]
 * 参考: states/v0.0.179.plugin_config/verify/test-plan.md §UT（Loader 部分）
 *
 * v0.0.179 模型简化（impl 列表模型，废 selected/enabled/exclusivePicks）：
 *   - YAML 不再有 selected / enabled 字段（loader 不读、不 throw、不 warn）
 *   - 三层 → 扁平 ScopeConfig 转换：
 *     * point 存在=激活
 *     * impls[] 字符串=active+order；{implId,configValues}=active+order+config
 *     * 数组序即 order（1-based）
 *   - 所有列出 impl 一律视作 active（membership 模型，无 enabled:false 分支）
 *
 * 覆盖：
 *   - 真实 scopes 目录加载 → default 配置正确
 *   - default.yaml 全 17 EP 激活（v0.0.206 含 channel；含 context_clean_view_reducer + see_image_provider）+ 固化 order + threshold configValues.compactRatio=0.6
 *   - 文件缺失 → throw（design §2.3 硬失败）
 *   - schema 错（scopeId 缺 / groups 非数组 / impls[].implId 缺 等）→ throw
 *   - selected / enabled 字段不读不报错（用户裁决：旧字段是垃圾）
 *
 * v0.0.204 收尾：forked.yaml 已删（拆为 summary + consolidate 基座），forked 相关用例随之删除。
 * summary/consolidate 配置覆盖见 scope-extends-chain.test.ts。
 *
 * 文件系统隔离：tmpdir + mkdtempSync + afterEach rm（MANDATORY 文件系统隔离）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { ScopeConfigLoader } from '../scope-config-loader';

let tmpRoot: string;
let loader: ScopeConfigLoader;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-config-loader-'));
  loader = new ScopeConfigLoader(tmpRoot);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 写一个 scope yaml 到 tmpRoot */
function writeScope(fileName: string, content: string): void {
  fs.writeFileSync(path.join(tmpRoot, fileName), content);
}

describe('ScopeConfigLoader.loadAll — 真实 scopes 目录加载（app/plugins/scopes/）', () => {
  it('读取真实 default.yaml，scopeId/name/activatedPoints 正确', () => {
    const realScopes = path.join(__dirname, '../../../../plugins/scopes');
    const real = new ScopeConfigLoader(realScopes);
    const configs = real.loadAll();
    const byId = new Map(configs.map((c) => [c.scopeId, c]));
    expect(byId.has('default')).toBe(true);

    const d = byId.get('default')!;
    expect(d.name).toBe('Default');
    // default 全 17 EP 激活（v0.0.206：channel EP 进 default.yaml；point 节点存在 = 激活）
    expect(d.activatedPoints).toHaveLength(17);
    expect(d.activatedPoints).toContain('channel');
    expect(d.activatedPoints).toContain('llm_provider');
    expect(d.activatedPoints).toContain('web_search_provider');
    expect(d.activatedPoints).toContain('session_store');
    expect(d.activatedPoints).toContain('see_image_provider');
    expect(d.activatedPoints).toContain('skill_market_provider');
    expect(d.activatedPoints).toContain('context_clean_view_reducer');
    // v0.0.179：default exclusive EP 在 impls 中恰好 1 active（不再有 exclusivePicks 字段）
    expect(d.impls['threshold_should_compact']).toBeDefined();
    expect(d.impls['reject_should_compact']).toBeUndefined(); // 不列 = inactive
    expect(d.impls['summary_do_compact']).toBeDefined();
    expect(d.impls['noop_do_compact']).toBeUndefined();
    expect(d.impls['persistent_session_store']).toBeDefined();
    expect(d.impls['in_memory_session_store']).toBeUndefined();
  });

  it('default.yaml 固化 ordered EP order（assemble_reducer 只 base_builder=1；clean_view_reducer 8 项 dedup=1..role=8）', () => {
    const realScopes = path.join(__dirname, '../../../../plugins/scopes');
    const d = new ScopeConfigLoader(realScopes).loadAll().find((c) => c.scopeId === 'default')!;
    // context_assemble_reducer 只剩 base_builder（清理 reducer 迁 clean_view EP）
    expect(d.impls['base_builder']?.order).toBe(1);
    // v0.0.207 头插 dedup_tool_result（必须排在 orphan_tool_call 之前）
    expect(d.impls['dedup_tool_result']?.order).toBe(1);
    expect(d.impls['snip_handler']?.order).toBe(2);
    expect(d.impls['orphan_tool_call']?.order).toBe(3);
    // v0.0.256 第 4 位插 bubble_text_before_tool_call（orphan 配对过滤后处理 block 级乱序）
    expect(d.impls['bubble_text_before_tool_call']?.order).toBe(4);
    expect(d.impls['think_remove']?.order).toBe(5);
    expect(d.impls['fill_empty_text']?.order).toBe(6);
    expect(d.impls['empty_message']?.order).toBe(7);
    expect(d.impls['role_merge']?.order).toBe(8);
    // system_prompt_reducer 链
    expect(d.impls['tier_sort']?.order).toBe(1);
    expect(d.impls['dedup']?.order).toBe(2);
    expect(d.impls['budget_truncate']?.order).toBe(3);
  });

  it('default.yaml threshold 带 configValues.compactRatio=0.6（bug-A JOIN default）', () => {
    const realScopes = path.join(__dirname, '../../../../plugins/scopes');
    const d = new ScopeConfigLoader(realScopes).loadAll().find((c) => c.scopeId === 'default')!;
    expect(d.impls['threshold_should_compact']?.configValues).toEqual({ compactRatio: 0.6 });
    expect(d.impls['threshold_should_compact']?.order).toBe(1);
  });

  it('default.yaml context_ingest_handler 含 search_indexing（order 5，紧随 store_sink）', () => {
    const realScopes = path.join(__dirname, '../../../../plugins/scopes');
    const d = new ScopeConfigLoader(realScopes).loadAll().find((c) => c.scopeId === 'default')!;
    // search_indexing 是 search.sqlite 唯一 ingest 写入路径，必须在 default 激活
    expect(d.impls['query_truncate']?.order).toBe(1);
    expect(d.impls['tool_result_truncate']?.order).toBe(2);
    expect(d.impls['system_reminder_injector']?.order).toBe(3);
    expect(d.impls['store_sink']?.order).toBe(4);
    expect(d.impls['search_indexing']?.order).toBe(5);
  });
});

describe('ScopeConfigLoader.loadAll — 文件缺失 / 空目录', () => {
  it('root 不存在 → throw（design §2.3 硬失败）', () => {
    const bad = new ScopeConfigLoader(path.join(tmpRoot, 'no-such-dir'));
    expect(() => bad.loadAll()).toThrow(/scopes 根目录不存在/);
  });

  it('root 是空目录 → 返回 []（合法：无 scope 声明）', () => {
    expect(loader.loadAll()).toEqual([]);
  });

  it('跳过非 .yaml 文件（README.md / *.json / _.txt 等）', () => {
    fs.writeFileSync(path.join(tmpRoot, 'README.md'), '# not a scope');
    fs.writeFileSync(path.join(tmpRoot, 'legacy.json'), '{}');
    fs.writeFileSync(path.join(tmpRoot, '_.txt'), 'ignore');
    expect(loader.loadAll()).toEqual([]);
  });
});

describe('ScopeConfigLoader.loadAll — schema 错 → throw（带文件名 + 字段名）', () => {
  it('YAML 解析失败 → throw 含文件名', () => {
    fs.writeFileSync(path.join(tmpRoot, 'broken.yaml'), 'groups: [unclosed');
    expect(() => loader.loadAll()).toThrow(/broken.yaml YAML 解析失败/);
  });

  it('顶层非对象 → throw', () => {
    writeScope('arr.yaml', '- not\n- an\n- object');
    expect(() => loader.loadAll()).toThrow(/顶层必须是对象/);
  });

  it('scopeId 缺失 → throw', () => {
    writeScope('noscope.yaml', 'name: x\ngroups: []');
    expect(() => loader.loadAll()).toThrow(/scopeId 缺失/);
  });

  it('name 缺失 → throw（消息含 scopeId）', () => {
    writeScope('noname.yaml', 'scopeId: s1\ngroups: []');
    expect(() => loader.loadAll()).toThrow(/name 缺失.*scope=s1/);
  });

  it('groups 非数组 → throw', () => {
    writeScope('badgroups.yaml', 'scopeId: s1\nname: s1\ngroups: nope');
    expect(() => loader.loadAll()).toThrow(/groups 必须是数组/);
  });

  it('point.pointId 缺失 → throw', () => {
    writeScope('badpoint.yaml', 'scopeId: s1\nname: s1\ngroups:\n  - id: g1\n    points:\n      - impls: []');
    expect(() => loader.loadAll()).toThrow(/pointId 缺失/);
  });

  it('impls 项非字符串/对象 → throw', () => {
    writeScope('badimpl.yaml', 'scopeId: s1\nname: s1\ngroups:\n  - id: g1\n    points:\n      - pointId: p1\n        impls:\n          - 123');
    expect(() => loader.loadAll()).toThrow(/必须是字符串或对象/);
  });

  it('对象形态缺 implId → throw', () => {
    writeScope('noimplid.yaml', 'scopeId: s1\nname: s1\ngroups:\n  - id: g1\n    points:\n      - pointId: p1\n        impls:\n          - configValues: {}');
    expect(() => loader.loadAll()).toThrow(/implId 缺失/);
  });

  it('impls[].configValues 非对象 → throw', () => {
    writeScope('badcv.yaml', 'scopeId: s1\nname: s1\ngroups:\n  - id: g1\n    points:\n      - pointId: p1\n        impls:\n          - implId: i1\n            configValues: "nope"');
    expect(() => loader.loadAll()).toThrow(/impls\["i1"\]\.configValues 必须对象/);
  });
});

describe('ScopeConfigLoader.loadAll — v0.0.179 旧字段 selected/enabled 不读不报错', () => {
  it('YAML 含 selected 字段 → loader 忽略（不 throw 不 warn，字段已废）', () => {
    // v0.0.179：selected 是旧字段，loader 不解析；YAML 含也不报错（已迁移干净，无残留需兜底）
    writeScope('withselected.yaml', 'scopeId: s1\nname: s1\ngroups:\n  - id: g1\n    points:\n      - pointId: p1\n        selected: whatever\n        impls:\n          - a');
    const cfg = loader.loadAll()[0]!;
    expect(cfg.activatedPoints).toEqual(['p1']);
    expect(cfg.impls['a']).toEqual({ order: 1 });
    // 无 exclusivePicks 字段（v0.0.179 已废）
    expect((cfg as unknown as { exclusivePicks?: unknown }).exclusivePicks).toBeUndefined();
  });

  it('YAML 含 impls[].enabled 字段 → loader 忽略（v0.0.179：所有列出项一律 active）', () => {
    // v0.0.179：enabled 是旧字段，loader 不解析；YAML 含也不报错
    writeScope('withenabled.yaml', 'scopeId: s1\nname: s1\ngroups:\n  - id: g1\n    points:\n      - pointId: p1\n        impls:\n          - implId: a\n            enabled: false');
    const cfg = loader.loadAll()[0]!;
    // 即使 YAML 写 enabled:false，loader 仍视作 active（v0.0.179 一律视作 active）
    expect(cfg.impls['a']).toEqual({ order: 1 });
    expect((cfg.impls['a'] as unknown as { enabled?: unknown }).enabled).toBeUndefined();
  });
});

describe('ScopeConfigLoader.loadAll — 三层 → 扁平转换语义', () => {
  it('纯字符串 impl → order=数组序（不写 enabled 字段，membership = key 存在）', () => {
    writeScope('str.yaml', 'scopeId: s1\nname: s1\ngroups:\n  - id: g1\n    points:\n      - pointId: p1\n        impls:\n          - a\n          - b\n          - c');
    const cfg = loader.loadAll()[0]!;
    expect(cfg.activatedPoints).toEqual(['p1']);
    expect(cfg.impls['a']).toEqual({ order: 1 });
    expect(cfg.impls['b']).toEqual({ order: 2 });
    expect(cfg.impls['c']).toEqual({ order: 3 });
  });

  it('对象 {implId, configValues} → order + configValues', () => {
    writeScope('obj.yaml', 'scopeId: s1\nname: s1\ngroups:\n  - id: g1\n    points:\n      - pointId: p1\n        impls:\n          - implId: a\n            configValues:\n              k: v');
    const cfg = loader.loadAll()[0]!;
    expect(cfg.impls['a']).toEqual({ order: 1, configValues: { k: 'v' } });
  });

  it('point 无 impls 字段 = 激活但无 impl（合法）', () => {
    writeScope('noimpls.yaml', 'scopeId: s1\nname: s1\ngroups:\n  - id: g1\n    points:\n      - pointId: p1');
    const cfg = loader.loadAll()[0]!;
    expect(cfg.activatedPoints).toEqual(['p1']);
    expect(cfg.impls).toEqual({});
  });

  it('point.impls: [] = 激活但 0 active impl（合法，表示该 EP 显式声明空）', () => {
    writeScope('emptyimpls.yaml', 'scopeId: s1\nname: s1\ngroups:\n  - id: g1\n    points:\n      - pointId: p1\n        impls: []');
    const cfg = loader.loadAll()[0]!;
    expect(cfg.activatedPoints).toEqual(['p1']);
    expect(cfg.impls).toEqual({});
  });
});

describe('ScopeConfigLoader.loadAll — 多 scope / 同名覆盖', () => {
  it('多文件多 scope 全部加载', () => {
    writeScope('a.yaml', 'scopeId: sa\nname: A\ngroups: []');
    writeScope('b.yaml', 'scopeId: sb\nname: B\ngroups: []');
    const ids = loader.loadAll().map((c) => c.scopeId).sort();
    expect(ids).toEqual(['sa', 'sb']);
  });

  it('两文件同 scopeId → 后者覆盖前者 + warning', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    writeScope('a.yaml', 'scopeId: dup\nname: A\ngroups: []');
    writeScope('b.yaml', 'scopeId: dup\nname: B\ngroups: []');
    const configs = loader.loadAll();
    // 两条都返回（loader 不去重），但 warning 已打；下游以最后一条为准
    expect(configs).toHaveLength(2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('scopeId "dup"'),
    );
    warnSpy.mockRestore();
  });
});
