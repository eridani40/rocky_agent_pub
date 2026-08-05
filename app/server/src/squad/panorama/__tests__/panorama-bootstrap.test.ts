/**
 * panorama bootstrap wiring UT — 目录骨架 + 工具注册 + tool-policy 绑定（Task#4 集成层）.
 * 参考: change_plan.md 模块 7/10 + panorama_tools.md §0
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ensureSquadDirSkeleton } from '../../../stores/squad-store';
import { PanoramaEntityStore } from '../store/panorama_store';
import { PANORAMA_TOOL_DEFINITION } from '../tool/panorama-tool';
// v0.0.204 T2-B2：TOOL_POLICY 已删（迁 profile yaml toolBound）—— bound 断言改读 profile loader
import { SessionTypeProfileLoader } from '../../../agent/session-type-profile-loader';

const profileRoot = path.resolve(__dirname, '../../../../../plugins/session-types');
function boundOf(id: string): readonly string[] {
  const loader = new SessionTypeProfileLoader(profileRoot);
  loader.loadAll();
  return loader.profile(id).toolBound;
}

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pano-boot-')); });
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('panorama bootstrap — 目录骨架', () => {
  it('ensureSquadDirSkeleton 建 panorama 子目录 + events.jsonl', () => {
    ensureSquadDirSkeleton(tmpDir, 'sq1');
    const pano = path.join(tmpDir, 'squads', 'sq1', 'panorama');
    expect(fs.existsSync(path.join(pano, 'entities'))).toBe(true);
    expect(fs.existsSync(path.join(pano, '.archive'))).toBe(true);
    expect(fs.existsSync(path.join(pano, 'events.jsonl'))).toBe(true);
  });

  it('骨架后 store 端到端读写', () => {
    ensureSquadDirSkeleton(tmpDir, 'sq1');
    const s = new PanoramaEntityStore({ root: tmpDir, squadId: 'sq1' });
    s.writeBoard({ version: { id: 'v1', name: 'V', board_name: 'B' }, entities: {}, views: [] } as never);
    const got = s.readBoard();
    expect(got).not.toBeNull();
    s.createInstance('x', '1', { a: 1 });
    expect(s.getInstance('x', '1')).toMatchObject({ a: 1 });
  });
});

describe('panorama 工具注册 + profile toolBound 绑定（v0.0.204 T2-B2：TOOL_POLICY 已删，迁 profile yaml）', () => {
  it('tool definition name = panorama', () => {
    expect(PANORAMA_TOOL_DEFINITION.name).toBe('panorama');
  });

  it('studio-leader:parent:main profile toolBound 含 panorama', () => {
    expect(boundOf('studio-leader:parent:main')).toContain('panorama');
  });

  it('studio-mate:parent:main profile toolBound 含 panorama', () => {
    expect(boundOf('studio-mate:parent:main')).toContain('panorama');
  });

  it('playground-rocky / studio-squad / subagent profile toolBound 不含 panorama', () => {
    expect(boundOf('playground-rocky:parent:main')).not.toContain('panorama');
    expect(boundOf('studio-squad:parent:main')).not.toContain('panorama');
    expect(boundOf('playground-rocky:subagent:main')).not.toContain('panorama');
  });
});
