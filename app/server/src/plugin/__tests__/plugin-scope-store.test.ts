/**
 * PluginScopeStore 单测（v0.0.26 task 1）—— scope CRUD + bootstrap + cascade
 * 参考: specs/tech/config/[P0]ext_impl_scope.md §2（bootstrap default）+ §3.3（cascade 三步原子）
 *       specs/tech/config/[P0]ext_impl_scope.md §6.2（scope CRUD 拒绝语义）
 *
 * 覆盖：
 *   - bootstrap ensure default（缺则创建，幂等）
 *   - list（default 首位 + createdAt 升序）
 *   - get/create/delete + 拒绝 default 创建/删除/重复 id
 *   - deleteScope cascade（mock activationStore.deleteAllByScope + policyStore.listImpls/deleteImpl）
 *   - 落盘路径（plugin_scope/{scopeId}/<id>.json）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { PluginScopeStore, DEFAULT_SCOPE_ID } from '../plugin-scope-store';
import type { ScopeCascadeDeps } from '../plugin-scope-store';

let tmpRoot: string;
let store: PluginScopeStore;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-scope-'));
  store = new PluginScopeStore({ root: tmpRoot });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('PluginScopeStore.bootstrap ensure default（spec §2）', () => {
  it('缺则创建 default scope', () => {
    expect(store.get(DEFAULT_SCOPE_ID)).toBeUndefined();
    store.bootstrap();
    const def = store.get(DEFAULT_SCOPE_ID);
    expect(def).toBeDefined();
    expect(def?.scopeId).toBe(DEFAULT_SCOPE_ID);
    expect(def?.name).toBe('Default');
    expect(def?.description).toBe('默认基线 scope');
    expect(def?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO8601 信封注入
  });

  it('已存在则幂等（不重复创建，不抛错）', () => {
    store.bootstrap();
    const c1 = store.get(DEFAULT_SCOPE_ID)?.createdAt;
    store.bootstrap(); // 二次调用
    const c2 = store.get(DEFAULT_SCOPE_ID)?.createdAt;
    expect(c2).toBe(c1); // 同一条 record，createdAt 不变
  });

  it('bootstrap 后 list 必含 default', () => {
    store.bootstrap();
    const ids = store.list().map((s) => s.scopeId);
    expect(ids).toContain(DEFAULT_SCOPE_ID);
  });
});

describe('PluginScopeStore CRUD', () => {
  beforeEach(() => store.bootstrap());

  it('create 创建非 default scope', () => {
    const s = store.create('custom', '快速对话', '快速模式');
    expect(s.scopeId).toBe('custom');
    expect(s.name).toBe('快速对话');
    expect(s.description).toBe('快速模式');
    // get 命中
    expect(store.get('custom')?.name).toBe('快速对话');
  });

  it('create description 可选（缺省空串）', () => {
    const s = store.create('release', 'Release');
    expect(s.description).toBe('');
  });

  it('create 拒绝 id=default（spec §6.2）', () => {
    expect(() => store.create(DEFAULT_SCOPE_ID, 'dup')).toThrow(/default/);
  });

  it('create 拒绝重复 id（spec §6.2 409 语义）', () => {
    store.create('custom', 'C1');
    expect(() => store.create('custom', 'C2')).toThrow(/已存在/);
  });

  it('list default 首位 + 其余按 createdAt 升序', () => {
    store.create('beta', 'B');
    store.create('alpha', 'A');
    const list = store.list();
    expect(list[0]?.scopeId).toBe(DEFAULT_SCOPE_ID);
    // alpha 后创建 createdAt > beta，故 beta < alpha（升序）
    expect(list.map((s) => s.scopeId)).toEqual([DEFAULT_SCOPE_ID, 'beta', 'alpha']);
  });

  it('get 缺失返 undefined', () => {
    expect(store.get('nope')).toBeUndefined();
  });
});

describe('PluginScopeStore.delete cascade（spec §3.3 三步原子）', () => {
  let cascade: { deleteAllActivations: ReturnType<typeof vi.fn>; listImplKeys: ReturnType<typeof vi.fn>; deleteImpl: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    store.bootstrap();
    store.create('custom', 'C');
    cascade = {
      deleteAllActivations: vi.fn(),
      listImplKeys: vi.fn().mockReturnValue(['custom::impl_a', 'custom::impl_b']),
      deleteImpl: vi.fn(),
    };
    store.setCascadeDeps(cascade as unknown as ScopeCascadeDeps);
  });

  it('delete 拒绝 default（spec §2 不可删基线）', () => {
    expect(() => store.delete(DEFAULT_SCOPE_ID)).toThrow(/不可删|default/i);
    // cascade 未调用
    expect(cascade.deleteAllActivations).not.toHaveBeenCalled();
  });

  it('delete 不存在 scope 抛错', () => {
    expect(() => store.delete('nope')).toThrow(/不存在/);
  });

  it('delete 触发 cascade 三步：scope record + activation shard + policy impl', () => {
    store.delete('custom');

    // 步骤 1：plugin_scope record 已删
    expect(store.get('custom')).toBeUndefined();

    // 步骤 2：activationStore.deleteAllByScope('custom') 调用
    expect(cascade.deleteAllActivations).toHaveBeenCalledWith('custom');

    // 步骤 3：listImplKeys('custom') + 逐条 deleteImpl
    expect(cascade.listImplKeys).toHaveBeenCalledWith('custom');
    expect(cascade.deleteImpl).toHaveBeenCalledWith('custom', 'custom::impl_a');
    expect(cascade.deleteImpl).toHaveBeenCalledWith('custom', 'custom::impl_b');
    expect(cascade.deleteImpl).toHaveBeenCalledTimes(2);
  });

  it('delete 步骤 2 失败反向清理（恢复 scope record，不调步骤 3）', () => {
    cascade.deleteAllActivations.mockImplementation(() => {
      throw new Error('activation shard 删失败');
    });
    expect(() => store.delete('custom')).toThrow(/步骤 2.*已回滚/);
    // scope record 已恢复
    expect(store.get('custom')?.scopeId).toBe('custom');
    // 步骤 3 未执行
    expect(cascade.listImplKeys).not.toHaveBeenCalled();
  });

  it('delete 步骤 3 中途失败抛错（policy 部分残留）', () => {
    cascade.deleteImpl.mockImplementationOnce(() => {
      throw new Error('删 impl_a 失败');
    });
    expect(() => store.delete('custom')).toThrow(/步骤 3.*impl_a/);
    // scope record + activation 已清（无法回滚）
    expect(store.get('custom')).toBeUndefined();
  });

  it('delete 无 cascade 依赖注入时跳过步骤 2/3（容忍 bootstrap 早期阶段）', () => {
    const freshStore = new PluginScopeStore({ root: tmpRoot });
    freshStore.bootstrap();
    freshStore.create('solo', 'S');
    // 未 setCascadeDeps
    expect(() => freshStore.delete('solo')).not.toThrow();
    expect(freshStore.get('solo')).toBeUndefined();
  });
});

describe('PluginScopeStore 落盘路径（spec §2：plugin_scope/{scopeId}/，按 scopeId 分片）', () => {
  beforeEach(() => store.bootstrap());

  /** 递归收集 dir 下所有 .json 文件相对路径（persistence engine 会追加 entity 名子目录） */
  function collectJsonFiles(dir: string): string[] {
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
        else if (e.name.endsWith('.json')) out.push(path.relative(tmpRoot, path.join(d, e.name)));
      }
    }
    walk(dir);
    return out;
  }

  it('每 scope 一个 shard 目录（plugin_scope/{scopeId}/，按 scopeId 分片隔离）', () => {
    store.create('custom', 'C');
    const shardDir = path.join(tmpRoot, 'plugin_scope', 'custom');
    expect(fs.existsSync(shardDir)).toBe(true);
    // 该 shard 目录下有 json 文件（persistence engine 追加 entity 子目录）
    const files = collectJsonFiles(shardDir);
    expect(files.length).toBe(1);
    expect(files[0]).toContain('plugin_scope');
  });

  it('不同 scope 落不同 shard 目录（分片隔离）', () => {
    store.create('custom', 'C');
    store.create('release', 'R');
    expect(fs.existsSync(path.join(tmpRoot, 'plugin_scope', 'custom'))).toBe(true);
    expect(fs.existsSync(path.join(tmpRoot, 'plugin_scope', 'release'))).toBe(true);
  });
});
