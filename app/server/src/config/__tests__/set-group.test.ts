/**
 * [v0.0.5] setGroup 单测 — 整组原子提交语义
 * 参考: specs/tech/version_logs/v0.0.5/change_log.md §修订3
 *       specs/api/overall/02-llm-chat.md §4.1/§4.2 v1.2
 *       states/v0.0.5/task.json T1
 *
 * 覆盖：
 *   - setGroup 原子落盘该 group 全部 key（upsert：新增 + 覆盖并存）
 *   - 仅该 group shard record 读/写（其他 group record 完全不读不写）
 *   - 其他 group 已有值不受 setGroup 影响
 *   - 空 items → no-op
 *   - AppConfigService 同构（同 group 多 key 一次性写）
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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'config-setgroup-'));
  app = new AppConfigService({ root: tmpRoot });
  dev = new AppConfigService({ root: tmpRoot });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('AppConfigService.setGroup 整组原子提交', () => {
  it('一次性写该 group 全部 key（新增语义）', () => {
    app.setGroup('appearance', [
      { key: 'theme', data: 'dark' },
      { key: 'density', data: 'compact' },
    ]);
    expect(app.get('appearance', 'theme')).toBe('dark');
    expect(app.get('appearance', 'density')).toBe('compact');
  });

  it('key 已存在则覆盖（upsert 语义：set 后 setGroup 覆盖）', () => {
    app.set('appearance', 'theme', 'light');
    app.setGroup('appearance', [{ key: 'theme', data: 'dark' }]);
    expect(app.get('appearance', 'theme')).toBe('dark');
  });

  it('单条 setGroup 也工作（1 item）', () => {
    app.setGroup('appearance', [{ key: 'theme', data: 'dark' }]);
    expect(app.get('appearance', 'theme')).toBe('dark');
  });

  it('listGroup 反映 setGroup 写入的全部 key', () => {
    app.setGroup('appearance', [
      { key: 'theme', data: 'dark' },
      { key: 'density', data: 'compact' },
    ]);
    const items = app.listGroup('appearance');
    expect(items.length).toBe(2);
    const theme = items.find((i) => i.key === 'theme');
    expect(theme?.data).toBe('dark');
    const density = items.find((i) => i.key === 'density');
    expect(density?.data).toBe('compact');
  });

  it('嵌套 json data 正确写入（如对象）', () => {
    const palette = { primary: '#fff', modes: { dark: {}, light: {} } };
    app.setGroup('appearance', [{ key: 'palette', data: palette }]);
    expect(app.get('appearance', 'palette')).toEqual(palette);
  });
});

describe('setGroup 仅该 group shard 读/写（其他 group 不受影响）', () => {
  it('setGroup 写 appearance 不影响 providers group 已有值', () => {
    app.set('providers', 'inst-1', { label: 'p1', models: [] });
    app.setGroup('appearance', [{ key: 'theme', data: 'dark' }]);
    // providers group 未被触碰
    expect(app.get('providers', 'inst-1')).toEqual({
      label: 'p1',
      models: [],
    });
    // appearance group 写入正确
    expect(app.get('appearance', 'theme')).toBe('dark');
  });

  it('setGroup 写 appearance group 不影响 locale group 已有值', () => {
    app.set('locale', 'language', 'zh-CN');
    app.setGroup('appearance', [
      { key: 'theme', data: 'dark' },
      { key: 'density', data: 'compact' },
    ]);
    expect(app.get('locale', 'language')).toBe('zh-CN');
    expect(app.get('appearance', 'theme')).toBe('dark');
    expect(app.get('appearance', 'density')).toBe('compact');
  });

  it('setGroup 只写该 group：不同 group 落不同 shard 目录', () => {
    app.set('locale', 'language', 'zh-CN');
    app.setGroup('appearance', [
      { key: 'theme', data: 'dark' },
      { key: 'density', data: 'compact' },
    ]);
    const dirs = collectRecordDirs(tmpRoot);
    // app_config appearance shard + app_config locale shard = 2 个目录
    expect(dirs.size).toBe(2);
    const dirNames = [...dirs.keys()];
    expect(dirNames.some((d) => d.includes('appearance'))).toBe(true);
    expect(dirNames.some((d) => d.includes('locale'))).toBe(true);
    // appearance shard 含 2 个文件（theme + density），locale shard 含 1 个
    for (const [dirName, files] of dirs) {
      if (dirName.includes('appearance')) {
        expect(files.length).toBe(2);
      } else {
        expect(files.length).toBe(1);
      }
    }
  });
});

describe('setGroup 空 items 边界', () => {
  it('items 空数组 → no-op（不抛错，不写任何 record）', () => {
    app.setGroup('appearance', []);
    expect(app.get('appearance', 'theme')).toBeUndefined();
    // 磁盘上 app_config 没有 record（没有 appearance shard 目录）
    const dirs = collectRecordDirs(tmpRoot);
    expect(dirs.size).toBe(0);
  });

  it('items 空 → 已存在的 group 不受影响', () => {
    app.set('appearance', 'theme', 'dark');
    app.setGroup('appearance', []);
    expect(app.get('appearance', 'theme')).toBe('dark');
  });
});

describe('AppConfigService.setGroup 同构（与 AppConfigService 一致）', () => {
  it('一次性写 llm_request 多 key', () => {
    dev.setGroup('llm_request', [
      { key: 'stall_timeout_s', data: 45 },
      { key: 'max_retry_times', data: 3 },
    ]);
    expect(dev.get('llm_request', 'stall_timeout_s')).toBe(45);
    expect(dev.get('llm_request', 'max_retry_times')).toBe(3);
  });

  it('setGroup 写 llm_request 不影响 agent group', () => {
    dev.set('agent', 'maxIterations', 25);
    dev.setGroup('llm_request', [
      { key: 'stall_timeout_s', data: 45 },
      { key: 'max_retry_times', data: 3 },
    ]);
    expect(dev.get('agent', 'maxIterations')).toBe(25);
    expect(dev.get('llm_request', 'stall_timeout_s')).toBe(45);
    expect(dev.get('llm_request', 'max_retry_times')).toBe(3);
  });

  it('单 key set 后整组 setGroup 覆盖该 key（upsert）', () => {
    dev.set('llm_request', 'stall_timeout_s', 30);
    dev.setGroup('llm_request', [
      { key: 'stall_timeout_s', data: 45 },
      { key: 'max_retry_times', data: 3 },
    ]);
    expect(dev.get('llm_request', 'stall_timeout_s')).toBe(45);
    expect(dev.get('llm_request', 'max_retry_times')).toBe(3);
    // listGroup 应只有 2 条
    expect(dev.listGroup('llm_request').length).toBe(2);
  });

  it('空 items no-op', () => {
    dev.setGroup('llm_request', []);
    expect(dev.get('llm_request', 'stall_timeout_s')).toBeUndefined();
  });
});

describe('setGroup 跨域隔离（app vs dev）', () => {
  it('app.setGroup 写 appearance 不影响 dev.llm_request', () => {
    dev.setGroup('llm_request', [{ key: 'stall_timeout_s', data: 45 }]);
    app.setGroup('appearance', [{ key: 'theme', data: 'dark' }]);
    expect(dev.get('llm_request', 'stall_timeout_s')).toBe(45);
    expect(app.get('appearance', 'theme')).toBe('dark');
  });
});

/**
 * 递归收集 tmpRoot 下所有 .json 记录文件所在目录（用于断言分片结构）。
 * 实现同 config-service.test.ts 的辅助函数（复制以避免跨文件耦合）。
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
