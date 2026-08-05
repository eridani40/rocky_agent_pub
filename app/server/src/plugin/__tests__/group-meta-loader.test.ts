/**
 * GroupMetaLoader 单测（白盒）—— 读 app/plugins/groups.json → GroupMetaFile
 * 参考: specs/tech/plugin_system/[P1]groups_meta_decl.md §3.1（加载链路）
 *       specs/tech/version_logs/v0.0.71/change_plan.md 模块 1
 *
 * 覆盖（test-plan.md §UT groups_meta）：
 *   - 真实 app/plugins/groups.json 加载 → 9 group + 15 EP 各出现一次（D5/D6，v0.0.141 加 vision）
 *   - happy path：合法 group 字段透传
 *   - 文件不存在 → throw（D6 硬失败）
 *   - 形状校验：groups 缺 / 项缺 id|label|description|extPoints / extPoints 项空字符串 → throw
 *
 * 文件系统隔离：tmpdir + mkdtempSync + afterEach rm（MANDATORY 文件系统隔离）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { GroupMetaLoader, validateGroupMetaShape } from '../group-meta-loader';

let tmpRoot: string;
let filePath: string;
let loader: GroupMetaLoader;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'group-meta-loader-'));
  filePath = path.join(tmpRoot, 'groups.json');
  loader = new GroupMetaLoader(filePath);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 写 groups.json */
function writeGroups(obj: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(obj));
}

/** 合法 group factory */
function validGroup(id = 'g1', extPoints = ['p1']): unknown {
  return {
    id,
    label: `__MSG_group.${id}.label__`,
    description: `__MSG_group.${id}.description__`,
    extPoints,
  };
}

describe('GroupMetaLoader.load — 真实 app/plugins/groups.json（D5 10 group + 17 EP，含 context_clean_view_reducer）', () => {
  it('加载真实 groups.json，10 group + 17 EP 各出现一次（D5/D6 不变量）', () => {
    const realPath = path.join(__dirname, '../../../../plugins/groups.json');
    const file = new GroupMetaLoader(realPath).load();
    expect(file.groups).toHaveLength(10);
    const allPoints = file.groups.flatMap((g) => g.extPoints);
    expect(allPoints).toHaveLength(17);
    // 17 EP 各出现一次（D6 唯一性）
    const seen = new Set<string>();
    for (const p of allPoints) {
      expect(seen.has(p)).toBe(false);
      seen.add(p);
    }
    // D5 10 group id 严格匹配（声明序 = UI 显示序，[P1]groups_meta_decl.md §5.3）
    expect(file.groups.map((g) => g.id)).toEqual([
      'context-ingest',
      'context-assemble',
      'context-compact',
      'context-engine',
      'system-prompt',
      'provider',
      'channel',
      'web',
      'vision',
      'skill-market',
    ]);
  });

  it('真实 groups.json 中 label/description 都是 i18n 占位符（__MSG_group.<snake_id>.*__）', () => {
    const realPath = path.join(__dirname, '../../../../plugins/groups.json');
    const file = new GroupMetaLoader(realPath).load();
    for (const g of file.groups) {
      const snake = g.id.replace(/-/g, '_');
      expect(g.label).toBe(`__MSG_group.${snake}.label__`);
      expect(g.description).toBe(`__MSG_group.${snake}.description__`);
    }
  });

  it('真实 groups.json 中 16 EP 归属按 D5（context-ingest 2 / assemble 3 / compact 3 / engine 1 / system-prompt 2 / provider 2 / channel 1 / web 1 / vision 1）', () => {
    const realPath = path.join(__dirname, '../../../../plugins/groups.json');
    const file = new GroupMetaLoader(realPath).load();
    const byId = new Map(file.groups.map((g) => [g.id, g.extPoints]));
    expect(byId.get('context-ingest')).toEqual(['context_ingest_handler', 'system_reminder']);
    expect(byId.get('context-assemble')).toEqual(['context_assemble_mapper', 'context_assemble_reducer', 'context_clean_view_reducer']);
    expect(byId.get('context-compact')).toEqual([
      'context_should_compact',
      'context_do_compact',
      'context_post_compact',
    ]);
    expect(byId.get('context-engine')).toEqual(['session_store']);
    expect(byId.get('system-prompt')).toEqual(['system_prompt_mapper', 'system_prompt_reducer']);
    expect(byId.get('provider')).toEqual(['llm_provider', 'llm_protocol']);
    expect(byId.get('channel')).toEqual(['channel']);
    expect(byId.get('web')).toEqual(['web_search_provider']);
    expect(byId.get('vision')).toEqual(['see_image_provider']);
  });
});

describe('GroupMetaLoader.load — happy path', () => {
  it('合法多 group 加载 → 字段透传正确', () => {
    writeGroups({ groups: [validGroup('g1', ['p1', 'p2']), validGroup('g2', ['p3'])] });
    const file = loader.load();
    expect(file.groups).toHaveLength(2);
    expect(file.groups[0]!.id).toBe('g1');
    expect(file.groups[0]!.label).toBe('__MSG_group.g1.label__');
    expect(file.groups[0]!.description).toBe('__MSG_group.g1.description__');
    expect(file.groups[0]!.extPoints).toEqual(['p1', 'p2']);
    expect(file.groups[1]!.id).toBe('g2');
    expect(file.groups[1]!.extPoints).toEqual(['p3']);
  });

  it('接受 string 路径或 options.path 两种构造形式', () => {
    writeGroups({ groups: [validGroup()] });
    expect(new GroupMetaLoader({ path: filePath }).load().groups).toHaveLength(1);
    expect(new GroupMetaLoader(filePath).load().groups).toHaveLength(1);
  });
});

describe('GroupMetaLoader.load — 文件不存在 → throw（D6 硬失败）', () => {
  it('groups.json 不存在 → throw 含文件路径', () => {
    expect(() => loader.load()).toThrow(/groups\.json 不存在或不可读/);
  });
});

describe('GroupMetaLoader.load — 形状校验 fail → throw（带文件名 + 字段名）', () => {
  it('JSON 解析失败 → throw 含文件名', () => {
    fs.writeFileSync(filePath, '{ not json');
    expect(() => loader.load()).toThrow(/JSON 解析失败/);
  });

  it('顶层非对象 → throw', () => {
    writeGroups(['not', 'an', 'object']);
    expect(() => loader.load()).toThrow(/顶层必须是对象/);
  });

  it('groups 缺失 → throw', () => {
    writeGroups({ foo: 'bar' });
    expect(() => loader.load()).toThrow(/groups 必须是数组/);
  });

  it('groups 非数组 → throw', () => {
    writeGroups({ groups: 'nope' });
    expect(() => loader.load()).toThrow(/groups 必须是数组/);
  });

  it('group 项非对象 → throw', () => {
    writeGroups({ groups: ['nope'] });
    expect(() => loader.load()).toThrow(/groups\[0\] 必须是对象/);
  });

  it('group.id 缺失 → throw（消息含 index）', () => {
    writeGroups({ groups: [{ label: 'L', description: 'D', extPoints: ['p1'] }] });
    expect(() => loader.load()).toThrow(/groups\[0\]\.id 缺失/);
  });

  it('group.id 空字符串 → throw', () => {
    writeGroups({ groups: [{ id: '', label: 'L', description: 'D', extPoints: ['p1'] }] });
    expect(() => loader.load()).toThrow(/groups\[0\]\.id 缺失/);
  });

  it('group.label 缺失 → throw（消息含 group id）', () => {
    writeGroups({ groups: [{ id: 'g1', description: 'D', extPoints: ['p1'] }] });
    expect(() => loader.load()).toThrow(/groups\[0\]\.label 缺失.*group=g1/);
  });

  it('group.description 缺失 → throw（消息含 group id）', () => {
    writeGroups({ groups: [{ id: 'g1', label: 'L', extPoints: ['p1'] }] });
    expect(() => loader.load()).toThrow(/groups\[0\]\.description 缺失.*group=g1/);
  });

  it('group.extPoints 缺失 → throw（消息含 group id）', () => {
    writeGroups({ groups: [{ id: 'g1', label: 'L', description: 'D' }] });
    expect(() => loader.load()).toThrow(/groups\[0\]\.extPoints 必须是数组.*group=g1/);
  });

  it('group.extPoints 项空字符串 → throw（消息含 group id）', () => {
    writeGroups({
      groups: [{ id: 'g1', label: 'L', description: 'D', extPoints: ['p1', ''] }],
    });
    expect(() => loader.load()).toThrow(/extPoints\[\] 项必须非空字符串.*group=g1/);
  });

  it('group.extPoints 非字符串项 → throw', () => {
    writeGroups({
      groups: [{ id: 'g1', label: 'L', description: 'D', extPoints: [123] }],
    });
    expect(() => loader.load()).toThrow(/extPoints\[\] 项必须非空字符串/);
  });
});

describe('validateGroupMetaShape — 直接调用', () => {
  it('合法对象 → 返回 GroupMetaFile', () => {
    const file = validateGroupMetaShape(
      { groups: [validGroup('g1', ['p1'])] },
      'fake.json',
    );
    expect(file.groups).toHaveLength(1);
    expect(file.groups[0]!.id).toBe('g1');
  });

  it('空 groups 数组合法（数量校验归 Validator，本 loader 只校验形状）', () => {
    const file = validateGroupMetaShape({ groups: [] }, 'fake.json');
    expect(file.groups).toEqual([]);
  });
});
