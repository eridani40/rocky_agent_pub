/**
 * copyPersonalAgentsMd 单测（白盒，[v0.0.250] derive 派生自成员补齐个人 AGENTS.md 复制）
 * 参考: specs/tech/squad/[P1]data_model.md §5 step7.5（derive 复制父个人 AGENTS.md → 子名下）
 *
 * 覆盖：
 *   - 父存在 → 复制成功（验目标文件内容=源；目标路径含子 name-memberId）
 *   - 父不存在（existsSync false）→ no-op（目标不建）
 *   - 复制失败（mock throw）→ no-op 不 throw（MUST NOT 触发 hire 事务回滚）
 *
 * 单文件 ≤300 行。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { copyPersonalAgentsMd } from '../member-academy-bridge';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'copy-agents-md-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

/** 成员个人 AGENTS.md 路径（{name}-{memberId}.md 字面拼，与 prompt-handler / academy bridge 同款） */
function agentsMdPath(root: string, name: string, id: string): string {
  return path.join(root, '.rocky', 'agents', `${name}-${id}.md`);
}

describe('copyPersonalAgentsMd [v0.0.250]', () => {
  it('父存在 → 复制成功：目标文件内容=源；路径含子 name-memberId', async () => {
    const parentName = 'alice';
    const parentMemberId = 'P-001';
    const childName = 'bob';
    const childMemberId = 'C-002';
    // 父个人 AGENTS.md 预置
    const agentsDir = path.join(tmpRoot, '.rocky', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    const src = agentsMdPath(tmpRoot, parentName, parentMemberId);
    const content = '# alice 个人差异\n只属于 alice 的身份段。';
    fs.writeFileSync(src, content, 'utf8');

    await copyPersonalAgentsMd({
      squadRoot: tmpRoot,
      parentName, parentMemberId,
      childName, childMemberId,
    });

    const dst = agentsMdPath(tmpRoot, childName, childMemberId);
    expect(fs.existsSync(dst)).toBe(true);
    // 内容与源一致（非空、等价）
    expect(fs.readFileSync(dst, 'utf8')).toBe(content);
    // 源文件仍在（复制非移动）
    expect(fs.existsSync(src)).toBe(true);
  });

  it('父不存在（无个人 AGENTS.md）→ no-op：不建目标、不抛错', async () => {
    // 不预置任何父文件
    await copyPersonalAgentsMd({
      squadRoot: tmpRoot,
      parentName: 'ghost', parentMemberId: 'G-999',
      childName: 'child', childMemberId: 'C-001',
    });
    // 目标不存在
    expect(fs.existsSync(agentsMdPath(tmpRoot, 'child', 'C-001'))).toBe(false);
    // .rocky/agents 目录也不应被建（existsSync=false 早返，未触 mkdir）
    expect(fs.existsSync(path.join(tmpRoot, '.rocky', 'agents'))).toBe(false);
  });

  it('复制失败 → no-op 不 throw（MUST NOT 触发 hire 事务回滚）', async () => {
    const parentName = 'alice';
    const parentMemberId = 'P-001';
    // 源路径建为「目录」（existsSync=true 进 copyFile 分支；copyFile 源是目录 → EISDIR 抛错）
    const agentsDir = path.join(tmpRoot, '.rocky', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(agentsMdPath(tmpRoot, parentName, parentMemberId), { recursive: true });

    // 不抛（外层 catch 内置空 no-op）
    await expect(copyPersonalAgentsMd({
      squadRoot: tmpRoot,
      parentName, parentMemberId,
      childName: 'bob', childMemberId: 'C-002',
    })).resolves.toBeUndefined();
    // 目标未生成（copyFile 失败被吞）
    expect(fs.existsSync(agentsMdPath(tmpRoot, 'bob', 'C-002'))).toBe(false);
  });
});
