/**
 * team-sync-import-service 单测（v0.0.319 团队同步导入）
 * 参考: specs/prd/v0.0.319-team-sync.md §2.4/§5（导入建队机制 + 边界）
 *       specs/tech/version_logs/v0.0.319/change_plan.md D2
 *
 * 覆盖（test-plan §2 UT 组 2）：
 *   - validateZipEntries：拒绝 `..` / 绝对路径 / Windows 盘符 entry（path traversal 防护）
 *   - parseManifestFromDir：缺失 / JSON 损坏 / 缺必填字段；一层子目录兜底定位
 *   - ImportKeyStore：set/take 语义 + take 后删除 + 5min TTL 自动清理
 *   - importSquadFromTempDir：建队 + best-effort hire + 配置文件复制（复用 copyTemplateFiles）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import AdmZip from 'adm-zip';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  ImportKeyStore, InvalidZipError,
  importSquadFromTempDir, parseManifestFromDir, unpackToTemp, validateZipEntries,
} from '../team-sync-import-service';
import type { ManifestSchema } from '../squad-template-service';
import { SquadStore, MemberStore, squadRootDir } from '../../stores/squad-store';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';

/** 构造合法 manifest */
function makeManifest(): ManifestSchema {
  return {
    slug: 'original-slug', name: '原团队', description: 'desc',
    leaderName: 'Darvin', leaderIntro: 'leader', builtin: false,
    members: [
      { name: 'coder', intro: '代码开发者', skillConfig: { mode: 'inherit', overrides: {} } },
      { name: 'prd', intro: '产品经理', skillConfig: { mode: 'inherit', overrides: {} } },
    ],
  };
}

/**
 * 手工构造最小合法 zip（stored method），entryName 保留原始字节（不经过 adm-zip addFile 归一化）。
 * 用于构造恶意 path traversal entry（adm-zip addFile 会清洗 ../，必须绕过）。
 */
function makeRawZipWithEntry(entryName: string): Buffer {
  const nameBuf = Buffer.from(entryName, 'utf8');
  const data = Buffer.from('x');
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(0, 6); lfh.writeUInt16LE(0, 8); // flags + method=stored
  lfh.writeUInt16LE(0, 10); lfh.writeUInt16LE(0, 12);
  lfh.writeUInt32LE(0, 14); // crc（0 容错，adm-zip 读取不校验）
  lfh.writeUInt32LE(data.length, 18); lfh.writeUInt32LE(data.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26); lfh.writeUInt16LE(0, 28);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0, 10); cd.writeUInt16LE(0, 12); cd.writeUInt32LE(0, 14);
  cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
  cd.writeUInt16LE(nameBuf.length, 28);
  cd.writeUInt32LE(0, 42);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(30 + nameBuf.length + data.length, 16);
  return Buffer.concat([lfh, nameBuf, data, cd, nameBuf, eocd]);
}

/** 构造 zip buffer（manifest 放根目录或 {name}/ 子目录） */
function makeZipBuffer(opts: { subDir?: boolean; manifest?: unknown; extra?: Record<string, string> }): Buffer {
  const zip = new AdmZip();
  const prefix = opts.subDir ? 'my-squad/' : '';
  const manifest = opts.manifest === undefined ? makeManifest() : opts.manifest;
  zip.addFile(`${prefix}manifest.json`, Buffer.from(JSON.stringify(manifest)));
  zip.addFile(`${prefix}AGENTS.md`, Buffer.from('# 团队规则'));
  zip.addFile(`${prefix}.rocky/agents/coder.md`, Buffer.from('# coder 定义'));
  zip.addFile(`${prefix}.rocky/agents/prd.md`, Buffer.from('# prd 定义'));
  zip.addFile(`${prefix}.rocky/agents/leader.md`, Buffer.from('# leader 定义'));
  zip.addFile(`${prefix}.rocky/skills/s1/SKILL.md`, Buffer.from('# skill'));
  for (const [name, content] of Object.entries(opts.extra ?? {})) {
    zip.addFile(name, Buffer.from(content));
  }
  return zip.toBuffer();
}

describe('validateZipEntries', () => {
  it('合法 zip（相对路径）→ 不 throw', () => {
    const zip = new AdmZip(makeZipBuffer({}));
    expect(() => validateZipEntries(zip)).not.toThrow();
  });

  it('含 `..` entry → throw InvalidZipError（path traversal）', () => {
    // adm-zip addFile 会归一化 ../，恶意 entry 必须手工构造原始 zip 字节
    const zip = new AdmZip(makeRawZipWithEntry('../../etc/passwd'));
    expect(() => validateZipEntries(zip)).toThrow(InvalidZipError);
    expect(() => validateZipEntries(zip)).toThrow(/path traversal/);
  });

  it('含绝对路径 entry → throw', () => {
    const zip = new AdmZip(makeRawZipWithEntry('/abs/path.txt'));
    expect(() => validateZipEntries(zip)).toThrow(InvalidZipError);
  });

  it('含 Windows 盘符 entry → throw', () => {
    const zip = new AdmZip(makeRawZipWithEntry('C:/win.txt'));
    expect(() => validateZipEntries(zip)).toThrow(InvalidZipError);
  });
});

describe('parseManifestFromDir', () => {
  let tmpDir: string;
  beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-sync-parse-')); });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  it('根目录 manifest → 正常解析', () => {
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(makeManifest()));
    const { manifest, srcDir } = parseManifestFromDir(tmpDir);
    expect(manifest.leaderName).toBe('Darvin');
    expect(srcDir).toBe(tmpDir);
  });

  it('一层子目录 manifest（导出 zip 的 {squadName}/ 结构）→ 兜底定位', () => {
    const sub = path.join(tmpDir, 'my-squad');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'manifest.json'), JSON.stringify(makeManifest()));
    const { manifest, srcDir } = parseManifestFromDir(tmpDir);
    expect(manifest.name).toBe('原团队');
    expect(srcDir).toBe(sub);
  });

  it('缺 manifest.json → throw「缺少 manifest.json」', () => {
    expect(() => parseManifestFromDir(tmpDir)).toThrow(/缺少 manifest\.json/);
  });

  it('manifest JSON 损坏 → throw「无法解析」', () => {
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), '{not-json');
    expect(() => parseManifestFromDir(tmpDir)).toThrow(/无法解析/);
  });

  it('manifest 缺必填字段（members）→ throw「缺少 members」', () => {
    const bad = makeManifest() as unknown as Record<string, unknown>;
    delete bad.members;
    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify(bad));
    expect(() => parseManifestFromDir(tmpDir)).toThrow(/manifest 缺少 members/);
  });
});

describe('unpackToTemp', () => {
  it('解包 zip 到 os.tmpdir()/rocky-import-* 并返回路径（调用方清理）', () => {
    const tmpDir = unpackToTemp(makeZipBuffer({}));
    try {
      expect(path.basename(tmpDir)).toMatch(/^rocky-import-/);
      expect(fs.existsSync(path.join(tmpDir, 'manifest.json'))).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('恶意 zip（.. entry）→ unpack 前 validate throw', () => {
    expect(() => unpackToTemp(makeRawZipWithEntry('../evil.txt'))).toThrow(InvalidZipError);
  });
});

describe('ImportKeyStore', () => {
  it('set 返 importKey；take 取出条目并从 Map 删除（二次 take 返 undefined）', () => {
    const store = new ImportKeyStore();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-sync-key-'));
    const key = store.set({ tmpDir, manifest: makeManifest(), srcDir: tmpDir });
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(0);

    const entry = store.take(key);
    expect(entry?.tmpDir).toBe(tmpDir);
    expect(store.take(key)).toBeUndefined(); // 已消费
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('5min TTL 到期自动清理临时目录（fake timers）', () => {
    vi.useFakeTimers();
    try {
      const store = new ImportKeyStore();
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-sync-ttl-'));
      store.set({ tmpDir, manifest: makeManifest(), srcDir: tmpDir });
      expect(fs.existsSync(tmpDir)).toBe(true);
      vi.advanceTimersByTime(5 * 60 * 1000 + 1000);
      expect(fs.existsSync(tmpDir)).toBe(false); // TTL 清理生效
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('importSquadFromTempDir', () => {
  let tmpRoot: string;
  let unpackDir: string;
  let deps: {
    sessionStore: SessionStore; squadStore: SquadStore; memberStore: MemberStore; dataDir: string;
  };

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-sync-import-data-'));
    const fsEngine = new FsCrudStore({ root: tmpRoot });
    const crud = new CompositeStore().mount('session', fsEngine).mount('transcript', fsEngine)
      .mount('summary', fsEngine).mount('runs', fsEngine);
    deps = {
      sessionStore: new SessionStore({ crud, fsRoot: tmpRoot }),
      squadStore: new SquadStore({ root: tmpRoot }),
      memberStore: new MemberStore({ root: tmpRoot }),
      dataDir: tmpRoot,
    };
    // 解包一个合法 zip 到 unpackDir
    unpackDir = unpackToTemp(makeZipBuffer({}));
  });
  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(unpackDir, { recursive: true, force: true });
  });

  it('建队 + 批量 hire + 复制配置文件（AGENTS.md 覆盖 / agents 关联新 memberId / skills merge）', async () => {
    const { manifest, srcDir } = parseManifestFromDir(unpackDir);
    const result = await importSquadFromTempDir(
      unpackDir, manifest, srcDir,
      { name: '新团队', modelDefault: 'm' },
      deps,
    );
    expect(result.squadId).toBeTruthy();
    expect(result.created).toEqual(['coder', 'prd']);
    expect(result.failed).toEqual([]);

    // 新 squad 目录验证
    const newDir = squadRootDir(tmpRoot, result.squadId);
    expect(fs.readFileSync(path.join(newDir, 'AGENTS.md'), 'utf8')).toBe('# 团队规则');
    expect(fs.existsSync(path.join(newDir, '.rocky', 'skills', 's1', 'SKILL.md'))).toBe(true);
    // agents 文件已关联新 memberId（{name}-{ULID}.md）
    const agentFiles = fs.readdirSync(path.join(newDir, '.rocky', 'agents'));
    expect(agentFiles.some((f) => /^coder-[0-9A-HJKMNP-TV-Z]{26}\.md$/.test(f))).toBe(true);
    expect(agentFiles.some((f) => /^prd-[0-9A-HJKMNP-TV-Z]{26}\.md$/.test(f))).toBe(true);
    // [v0.0.321] leader.md 改名实名 {leaderName}-{leaderMemberId}.md（manifest.leaderName='Darvin'）
    const leaderMember = (await deps.memberStore.listMembers(result.squadId)).find((m) => m.name === 'Darvin');
    expect(leaderMember).toBeTruthy();
    expect(agentFiles.some((f) => f === `Darvin-${leaderMember!.id}.md`)).toBe(true);
    // 不再残留未改名的 leader.md
    expect(agentFiles.includes('leader.md')).toBe(false);

    // 成员名与 zip 内一致（PRD UC-5）
    const members = await deps.memberStore.listMembers(result.squadId);
    const names = members.map((m) => m.name as string).sort();
    expect(names).toEqual(['Darvin', 'coder', 'prd']);
  });

  it('best-effort hire：manifest 内重名 member → 第一个成功第二个记 failed，不中断', async () => {
    const dup = makeManifest();
    dup.members.push({ name: 'coder', intro: '重名', skillConfig: { mode: 'inherit', overrides: {} } });
    const zip = new AdmZip();
    zip.addFile('manifest.json', Buffer.from(JSON.stringify(dup)));
    const dupDir = unpackToTemp(zip.toBuffer());
    try {
      const { manifest, srcDir } = parseManifestFromDir(dupDir);
      const result = await importSquadFromTempDir(
        dupDir, manifest, srcDir, { name: '重名团队', modelDefault: 'm' }, deps,
      );
      expect(result.created).toEqual(['coder', 'prd']);
      expect(result.failed).toEqual(['coder']); // 第二个 coder 冲突记 failed
    } finally {
      fs.rmSync(dupDir, { recursive: true, force: true });
    }
  });
});
