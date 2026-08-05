/**
 * ScopeActivationStore 单测（v0.0.26 task 1）—— 激活记录 get/has/listByScope/set/delete/deleteAllByScope
 * 参考: specs/tech/config/[P0]ext_impl_scope.md §3（ScopeActivationSchema + D1 独立 entity）
 *       specs/tech/config/[P0]ext_impl_scope.md §3.2（D6 default 不写 activation）
 *
 * 覆盖：
 *   - get/has（缺返 undefined/false）
 *   - set 幂等（已存在返 activated:false 不重复写）
 *   - delete 幂等（不存在返 deleted:false）
 *   - listByScope（返激活 pointId 列表）
 *   - deleteAllByScope（删整 shard 目录）
 *   - 多 scope 隔离（不同 scope 同 pointId 不串）
 *   - 落盘路径（ext_impl_scope_activation/{scopeId}/）
 *
 * D6（default 不写 activation）：本 store 不强制拒绝 default 的 set（语义门在 service 层），
 * 但本测验证 store 层保持纯存储语义（不双重校验）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { ScopeActivationStore } from '../scope-activation-store';

let tmpRoot: string;
let store: ScopeActivationStore;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-act-'));
  store = new ScopeActivationStore({ root: tmpRoot });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('ScopeActivationStore get/has（缺返 undefined/false）', () => {
  it('未写入 → get 返 undefined', () => {
    expect(store.get('custom', 'llm_provider')).toBeUndefined();
  });

  it('未写入 → has 返 false', () => {
    expect(store.has('custom', 'llm_provider')).toBe(false);
  });
});

describe('ScopeActivationStore set 幂等（spec §3.2）', () => {
  it('set 新激活返 activated:true + get 命中 activatedAt', () => {
    const r = store.set('custom', 'llm_provider', '2026-06-27T10:00:00.000Z');
    expect(r.activated).toBe(true);
    expect(store.get('custom', 'llm_provider')).toBe('2026-06-27T10:00:00.000Z');
    expect(store.has('custom', 'llm_provider')).toBe(true);
  });

  it('set 已存在返 activated:false 不重复写（幂等）', () => {
    store.set('custom', 'llm_provider', '2026-06-27T10:00:00.000Z');
    const r2 = store.set('custom', 'llm_provider', '2026-06-27T11:00:00.000Z');
    expect(r2.activated).toBe(false);
    // activatedAt 不被覆盖（幂等：保留首次）
    expect(store.get('custom', 'llm_provider')).toBe('2026-06-27T10:00:00.000Z');
  });

  it('set activatedAt 缺省用当前时间（ISO8601）', () => {
    store.set('custom', 'llm_provider');
    const at = store.get('custom', 'llm_provider');
    expect(at).toBeDefined();
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe('ScopeActivationStore delete 幂等', () => {
  it('delete 已存在返 deleted:true', () => {
    store.set('custom', 'llm_provider');
    const r = store.delete('custom', 'llm_provider');
    expect(r.deleted).toBe(true);
    expect(store.has('custom', 'llm_provider')).toBe(false);
  });

  it('delete 不存在返 deleted:false（幂等）', () => {
    const r = store.delete('custom', 'llm_provider');
    expect(r.deleted).toBe(false);
  });
});

describe('ScopeActivationStore listByScope', () => {
  it('返该 scope 激活的 pointId 列表', () => {
    store.set('custom', 'llm_provider');
    store.set('custom', 'llm_protocol');
    store.set('custom', 'context_provider');
    expect(store.listByScope('custom').sort()).toEqual([
      'context_provider',
      'llm_protocol',
      'llm_provider',
    ]);
  });

  it('空 scope 返空数组', () => {
    expect(store.listByScope('empty')).toEqual([]);
  });
});

describe('ScopeActivationStore 多 scope 隔离（按 scopeId 分片）', () => {
  it('不同 scope 同 pointId 不串', () => {
    store.set('custom', 'llm_provider', '2026-06-27T10:00:00.000Z');
    store.set('release', 'llm_provider', '2026-06-27T11:00:00.000Z');
    expect(store.get('custom', 'llm_provider')).toBe('2026-06-27T10:00:00.000Z');
    expect(store.get('release', 'llm_provider')).toBe('2026-06-27T11:00:00.000Z');
    // 各 scope 独立 list
    expect(store.listByScope('custom')).toEqual(['llm_provider']);
    expect(store.listByScope('release')).toEqual(['llm_provider']);
  });

  it('删某 scope 的某 pointId 不影响其他 scope', () => {
    store.set('custom', 'llm_provider');
    store.set('release', 'llm_provider');
    store.delete('custom', 'llm_provider');
    expect(store.has('custom', 'llm_provider')).toBe(false);
    expect(store.has('release', 'llm_provider')).toBe(true);
  });
});

describe('ScopeActivationStore deleteAllByScope（删整 shard，供 cascade）', () => {
  it('删某 scope 全部 activation', () => {
    store.set('custom', 'llm_provider');
    store.set('custom', 'llm_protocol');
    store.set('release', 'llm_provider'); // 其他 scope 不受影响

    store.deleteAllByScope('custom');

    expect(store.listByScope('custom')).toEqual([]);
    // release 保留
    expect(store.listByScope('release')).toEqual(['llm_provider']);
  });

  it('shard 目录被物理删除（落盘清空）', () => {
    store.set('custom', 'llm_provider');
    const shardDir = path.join(tmpRoot, 'ext_impl_scope_activation', 'custom');
    expect(fs.existsSync(shardDir)).toBe(true);
    store.deleteAllByScope('custom');
    expect(fs.existsSync(shardDir)).toBe(false);
  });

  it('空 scope deleteAllByScope 幂等（目录不存在不抛错）', () => {
    expect(() => store.deleteAllByScope('nope')).not.toThrow();
  });
});

describe('ScopeActivationStore 落盘路径（spec §3.2：按 scopeId 分片）', () => {
  /** 递归收集 dir 下所有 .json 文件名（persistence engine 追加 entity 子目录） */
  function collectJsonFileNames(dir: string): string[] {
    const out: string[] = [];
    function walk(d: string): void {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory()) walk(path.join(d, e.name));
        else if (e.name.endsWith('.json')) out.push(e.name);
      }
    }
    walk(dir);
    return out;
  }

  it('落盘 ext_impl_scope_activation/{scopeId}/（按 scopeId 分片）', () => {
    store.set('custom', 'llm_provider');
    const shardDir = path.join(tmpRoot, 'ext_impl_scope_activation', 'custom');
    expect(fs.existsSync(shardDir)).toBe(true);
    // shard 目录下有 json 文件（persistence engine 追加 entity 子目录）
    const files = collectJsonFileNames(shardDir);
    expect(files.length).toBe(1);
    // 文件名是 ULID（26 字符）
    expect(files[0]?.replace('.json', '').length).toBe(26);
  });
});
