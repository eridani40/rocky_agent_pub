/**
 * skills/file-io 单测 —— skill 文件读写原语（越界 / binary / 截断 / 最小写权限面）
 * 参考: specs/api/overall/06-skill.md §7.2/§7.3
 *       specs/api/overall/18-academy.md §1.11（academy 版本 skill 端点共用本原语）
 *
 * 覆盖：
 *   - resolveInsideDir 三型越界（`../` 逃逸 / 绝对路径 / 同前缀兄弟目录冒充）
 *   - readSkillFile：正常文本 / 不存在 / 目录当文件 / binary / >256KB 截断
 *   - writeSkillFile：覆写成功 / 拒绝新建 / 拒绝 binary 目标 / 越界
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  MAX_FILE_CHARS,
  isBinaryBuffer,
  readSkillFile,
  resolveInsideDir,
  writeSkillFile,
} from '../file-io';

let tmpRoot: string;
let skillDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-file-io-'));
  skillDir = path.join(tmpRoot, 'demo');
  fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'ORIG_TEXT', 'utf8');
  fs.writeFileSync(path.join(skillDir, 'references', 'guide.py'), 'print(1)', 'utf8');
  // binary fixture（含 NUL 字节）
  fs.writeFileSync(path.join(skillDir, 'logo.png'), Buffer.from([0x89, 0x50, 0x00, 0x01]));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('resolveInsideDir — 越界守卫', () => {
  it('目录内相对路径 → 绝对路径', () => {
    expect(resolveInsideDir(skillDir, 'references/guide.py')).toBe(
      path.join(skillDir, 'references', 'guide.py'),
    );
  });

  it('`../` 逃逸 → null', () => {
    expect(resolveInsideDir(skillDir, '../etc/passwd')).toBeNull();
    expect(resolveInsideDir(skillDir, 'references/../../outside.md')).toBeNull();
  });

  it('绝对路径入参 → null（resolve 后落到根外）', () => {
    expect(resolveInsideDir(skillDir, '/etc/hosts')).toBeNull();
  });

  it('同前缀兄弟目录冒充 → null（demo-evil 不算 demo 内）', () => {
    const evil = path.join(tmpRoot, 'demo-evil');
    fs.mkdirSync(evil, { recursive: true });
    fs.writeFileSync(path.join(evil, 'x.md'), 'evil', 'utf8');
    expect(resolveInsideDir(skillDir, '../demo-evil/x.md')).toBeNull();
  });
});

describe('isBinaryBuffer', () => {
  it('含 NUL → true；纯文本 → false', () => {
    expect(isBinaryBuffer(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
    expect(isBinaryBuffer(Buffer.from('hello', 'utf8'))).toBe(false);
  });

  it('只看前 8000 字节（8000 之后的 NUL 不判 binary）', () => {
    const buf = Buffer.concat([Buffer.alloc(8000, 0x41), Buffer.from([0x00])]);
    expect(isBinaryBuffer(buf)).toBe(false);
  });
});

describe('readSkillFile', () => {
  it('文本文件 → 原样内容 + truncated/binary 均 false', () => {
    const r = readSkillFile(skillDir, 'SKILL.md');
    expect(r).toEqual({
      ok: true, path: 'SKILL.md', content: 'ORIG_TEXT', truncated: false, binary: false,
    });
  });

  it('越界 path → invalid_path', () => {
    expect(readSkillFile(skillDir, '../etc/passwd')).toEqual({ ok: false, error: 'invalid_path' });
  });

  it('空 path → invalid_path', () => {
    expect(readSkillFile(skillDir, '')).toEqual({ ok: false, error: 'invalid_path' });
  });

  it('文件不存在 → not_found', () => {
    expect(readSkillFile(skillDir, 'nope.md')).toEqual({ ok: false, error: 'not_found' });
  });

  it('目标是目录 → not_found（不是 invalid_path）', () => {
    expect(readSkillFile(skillDir, 'references')).toEqual({ ok: false, error: 'not_found' });
  });

  it('binary 文件 → content 空 + binary=true', () => {
    const r = readSkillFile(skillDir, 'logo.png');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.binary).toBe(true);
    expect(r.content).toBe('');
    expect(r.truncated).toBe(false);
  });

  it('>256KB 文本 → 截断到 MAX_FILE_CHARS + truncated=true', () => {
    fs.writeFileSync(path.join(skillDir, 'big.md'), 'x'.repeat(MAX_FILE_CHARS + 100), 'utf8');
    const r = readSkillFile(skillDir, 'big.md');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.truncated).toBe(true);
    expect(r.content.length).toBe(MAX_FILE_CHARS);
  });
});

describe('writeSkillFile — 最小写权限面', () => {
  it('覆写已存在文本文件 → ok + 内容落盘', () => {
    const r = writeSkillFile(skillDir, 'SKILL.md', 'NEW_TEXT');
    expect(r).toEqual({ ok: true, path: 'SKILL.md' });
    expect(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8')).toBe('NEW_TEXT');
  });

  it('拒绝新建文件 → not_found 且磁盘上不出现该文件', () => {
    const r = writeSkillFile(skillDir, 'brand-new.md', 'x');
    expect(r).toEqual({ ok: false, error: 'not_found' });
    expect(fs.existsSync(path.join(skillDir, 'brand-new.md'))).toBe(false);
  });

  it('拒绝建目录 + 新文件 → not_found 且目录未创建', () => {
    const r = writeSkillFile(skillDir, 'newdir/a.md', 'x');
    expect(r).toEqual({ ok: false, error: 'not_found' });
    expect(fs.existsSync(path.join(skillDir, 'newdir'))).toBe(false);
  });

  it('拒绝写 binary 目标 → binary_target 且原字节未变', () => {
    const before = fs.readFileSync(path.join(skillDir, 'logo.png'));
    const r = writeSkillFile(skillDir, 'logo.png', 'text');
    expect(r).toEqual({ ok: false, error: 'binary_target' });
    expect(fs.readFileSync(path.join(skillDir, 'logo.png'))).toEqual(before);
  });

  it('越界 path → invalid_path 且目标文件未被改', () => {
    const outside = path.join(tmpRoot, 'outside.md');
    fs.writeFileSync(outside, 'KEEP', 'utf8');
    const r = writeSkillFile(skillDir, '../outside.md', 'HACKED');
    expect(r).toEqual({ ok: false, error: 'invalid_path' });
    expect(fs.readFileSync(outside, 'utf8')).toBe('KEEP');
  });
});
