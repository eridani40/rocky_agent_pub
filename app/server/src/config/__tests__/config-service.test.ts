/**
 * AppConfigService 单测（白盒，真实 tmp DATA_DIR 落盘）
 * 参考: specs/tech/config/[P0]app_config.md §1/§5
 *       specs/tech/config/[P0]overview.md §5.1
 *       states/v0.0.3/verify/test-plan.md §2 P3/P5/P6（overlay 稀疏 delta）
 *
 * 历史：v0.0.89 dev_config 废弃前此文件测试 AppConfigService 与 DevConfigService 的同构 + 数据隔离；
 *       dev_config 废弃后两 service 合一，本文件聚焦 AppConfigService 单域 get/set 行为。
 *
 * 覆盖：
 *   - P3 AppConfigService get/set + 稀疏 delta（未 set 返 undefined）
 *   - update（同 group/key 再 set 覆盖）
 *   - 分片磁盘结构（同 group 同 shard、不同 group 不同 shard）
 *   - 同一 service 类多实例行为一致性
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { AppConfigService } from '../app-config-service';

let tmpRoot: string;
let app: AppConfigService;
let dev: AppConfigService;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-service-'));
  app = new AppConfigService({ root: tmpRoot });
  dev = new AppConfigService({ root: tmpRoot });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('AppConfigService 稀疏 delta（app_config.md §5）', () => {
  it('set 后 get 命中返 data（简单标量）', () => {
    app.set('appearance', 'theme', 'dark');
    expect(app.get('appearance', 'theme')).toBe('dark');
  });

  it('set 后 get 命中返 data（嵌套 json）', () => {
    const palette = { primary: '#fff', modes: { dark: {}, light: {} } };
    app.set('appearance', 'palette', palette);
    expect(app.get('appearance', 'palette')).toEqual(palette);
  });

  it('未 set 的 (group,key) get 返 undefined（视为未配置，不回退默认）', () => {
    expect(app.get('appearance', 'theme')).toBeUndefined();
    expect(app.get('providers', 'some-instance-id')).toBeUndefined();
  });

  it('同 group/key 再 set 覆盖旧值（update 语义）', () => {
    app.set('appearance', 'theme', 'dark');
    app.set('appearance', 'theme', 'light');
    expect(app.get('appearance', 'theme')).toBe('light');
  });

  it('不同 key 互不影响（同 group 多 key 共存）', () => {
    app.set('appearance', 'theme', 'dark');
    app.set('appearance', 'density', 'compact');
    expect(app.get('appearance', 'theme')).toBe('dark');
    expect(app.get('appearance', 'density')).toBe('compact');
  });
});

/**
 * 递归收集 tmpRoot 下所有 .json 记录文件的「所在目录 → 文件数」映射。
 * 用于断言分片结构（同 group 聚同目录、不同 group 不同目录），
 * 不硬编码具体路径层级（persistence 按 {dirTemplate}/{entity}/<id>.json 落盘，
 * 见 fs_crud_store_engine.md §2；config schema 的 dirTemplate 含 entity 前缀，
 * 实际落盘层级以 persistence 实现为准）。
 */
function collectRecordDirs(base: string): Map<string, string[]> {
  const dirs = new Map<string, string[]>();
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const files: string[] = [];
    for (const e of entries) {
      if (e.isDirectory()) {
        walk(path.join(dir, e.name));
      } else if (e.name.endsWith('.json')) {
        files.push(e.name);
      }
    }
    if (files.length > 0) dirs.set(path.relative(base, dir), files);
  }
  walk(base);
  return dirs;
}

describe('AppConfigService 分片磁盘结构（app_config.md §1，与 fs.sharding 一致）', () => {
  it('同 group 多 key 落同一 shard 目录（每条 KV 一文件）', () => {
    app.set('appearance', 'theme', 'dark');
    app.set('appearance', 'density', 'compact');
    const dirs = collectRecordDirs(tmpRoot);
    // 两个 appearance key 应聚在同一目录
    expect(dirs.size).toBe(1);
    const [onlyDir, onlyFiles] = [...dirs.entries()][0]!;
    expect(onlyDir).toContain('appearance');
    expect(onlyFiles.length).toBe(2);
  });

  it('不同 group 落不同 shard 目录', () => {
    app.set('appearance', 'theme', 'dark');
    app.set('locale', 'language', 'zh-CN');
    const dirs = collectRecordDirs(tmpRoot);
    expect(dirs.size).toBe(2);
    const dirNames = [...dirs.keys()];
    expect(dirNames.some((d) => d.includes('appearance'))).toBe(true);
    expect(dirNames.some((d) => d.includes('locale'))).toBe(true);
    // 每个 shard 只有 1 条记录
    for (const files of dirs.values()) expect(files.length).toBe(1);
  });
});

describe('AppConfigService 同一 service 多次实例化共享 fs 落盘（v0.0.89 dev_config 废弃后仅一域）', () => {
  // 历史：v0.0.89 前此处测「DevConfigService 与 AppConfigService 同构 + 数据隔离」；
  // dev_config 废弃后两 service 合一，该组测试改为同一 AppConfigService 类的多实例行为覆盖。
  it('get/set 签名一致：set 后 get 命中', () => {
    dev.set('llm', 'retries', 2);
    expect(dev.get('llm', 'retries')).toBe(2);
  });

  it('record 缺失返 undefined（不内置默认，默认回退留消费方 ?? CODE_DEFAULT）', () => {
    expect(dev.get('agent', 'maxIterations')).toBeUndefined();
    expect(dev.get('llm', 'timeoutMs')).toBeUndefined();
  });

  it('同 group/key 再 set 覆盖', () => {
    dev.set('llm', 'retries', 2);
    dev.set('llm', 'retries', 5);
    expect(dev.get('llm', 'retries')).toBe(5);
  });

  it('不同 group 落不同 shard 目录（与 fs.sharding 一致）', () => {
    dev.set('llm', 'retries', 2);
    dev.set('agent', 'maxIterations', 25);
    const dirs = collectRecordDirs(tmpRoot);
    expect(dirs.size).toBe(2);
    const dirNames = [...dirs.keys()];
    expect(dirNames.some((d) => d.includes('llm'))).toBe(true);
    expect(dirNames.some((d) => d.includes('agent'))).toBe(true);
  });
});

// 历史：v0.0.89 前此处有「两 service 数据隔离」测试（app 与 dev 同 group/key 不串）；
// dev_config 废弃后两 service 合一（同 root 多实例共享落盘），该测试不再适用，已删除。
