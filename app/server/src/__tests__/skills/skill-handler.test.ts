/**
 * skill handler 集成单测 — install(list/patch/delete/tree/file) 经 router
 * 覆盖 multipart folder/zip/.skill/单 md + 校验 + 路径越界 + 原子冲突
 * 参考: specs/api/overall/06-skill.md §2-§7
 *       test-plan §3（UT: install handler）
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import AdmZip from 'adm-zip';
import { handleRequest } from '../../router';

function req(method: string, path: string, init: RequestInit = {}): Request {
  return new Request(`http://127.0.0.1:3700${path}`, { method, ...init });
}
async function jsonBody(r: Response): Promise<any> {
  return JSON.parse(await r.text());
}

/** 构造 multipart folder upload（多 file 带 relativePath_* 字段） */
function folderForm(files: Array<{ filename: string; rel: string; content: string }>): FormData {
  const form = new FormData();
  for (const f of files) {
    form.append('file', new File([f.content], f.filename), f.filename);
    form.append(`relativePath_${f.filename}`, f.rel);
  }
  return form;
}

/** 构造 zip upload（单 .zip file） */
function zipForm(zipBytes: Uint8Array, filename: string): FormData {
  const form = new FormData();
  // File BlobPart 需 ArrayBuffer（非 SharedArrayBuffer）；Buffer.from 包一层
  form.append('file', new File([Buffer.from(zipBytes)], filename), filename);
  return form;
}

/** 内存构造一个 zip buffer（顶层目录 = skillRootDirName） */
function makeZip(topDir: string, files: Array<{ path: string; content: string }>): Uint8Array {
  const zip = new AdmZip();
  for (const f of files) {
    zip.addFile(`${topDir}/${f.path}`, Buffer.from(f.content, 'utf8'));
  }
  return zip.toBuffer();
}

describe('skill handlers (经 router, multipart)', () => {
  let dataDir: string;
  let oldNodeEnv: string | undefined;
  let oldAppEnv: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rocky-skill-h-'));
    // debug endpoint + 部分 gate 需 test 环境
    oldNodeEnv = process.env.NODE_ENV;
    oldAppEnv = process.env.APP_ENV;
    process.env.NODE_ENV = 'test';
    process.env.APP_ENV = 'test';
  });
  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    process.env.NODE_ENV = oldNodeEnv;
    process.env.APP_ENV = oldAppEnv;
  });

  it('folder install → 202 + name/description 来自 frontmatter + GET 列表含', async () => {
    const form = folderForm([
      { filename: 'SKILL.md', rel: 'demo/SKILL.md', content: '---\nname: demo\ndescription: 演示\n---\n\n# demo\n' },
      { filename: 'reference.md', rel: 'demo/reference.md', content: 'ref body' },
    ]);
    const r = await handleRequest(req('POST', '/skill/install', { body: form }), dataDir);
    expect(r.status).toBe(202);
    const b = await jsonBody(r);
    expect(b.skill.name).toBe('demo');
    expect(b.skill.description).toBe('演示');
    expect(b.skill.scope).toBe('app');
    expect(b.skill.enabled).toBe(true);
    expect(b.skill.skillDir).toContain('skills/demo');

    // GET 列表
    const list = await handleRequest(req('GET', '/skill'), dataDir);
    const lb = await jsonBody(list);
    expect(lb.items.some((e: any) => e.name === 'demo')).toBe(true);
  });

  it('folder install 缺 SKILL.md → 400', async () => {
    const form = folderForm([
      { filename: 'readme.md', rel: 'noskill/readme.md', content: 'no skill md' },
    ]);
    const r = await handleRequest(req('POST', '/skill/install', { body: form }), dataDir);
    expect(r.status).toBe(400);
  });

  it('folder install frontmatter 缺 name → 400', async () => {
    const form = folderForm([
      { filename: 'SKILL.md', rel: 'x/SKILL.md', content: '---\ndescription: d\n---\nbody' },
    ]);
    const r = await handleRequest(req('POST', '/skill/install', { body: form }), dataDir);
    expect(r.status).toBe(400);
  });

  it('zip install → 解压落盘 + tree 含引用文件', async () => {
    const zip = makeZip('demo', [
      { path: 'SKILL.md', content: '---\nname: demo\ndescription: z\n---\n\n# demo' },
      { path: 'reference.md', content: 'REF_BODY_42' },
    ]);
    const form = zipForm(zip, 'demo.zip');
    const r = await handleRequest(req('POST', '/skill/install', { body: form }), dataDir);
    expect(r.status).toBe(202);

    const tree = await handleRequest(req('GET', '/skill/demo/tree'), dataDir);
    const tb = await jsonBody(tree);
    const paths = tb.tree.map((n: any) => n.path);
    expect(paths).toContain('SKILL.md');
    expect(paths).toContain('reference.md');
    // path 相对 skillDir，不含 skill 名前缀
    expect(paths.some((p: string) => p.startsWith('demo/'))).toBe(false);
  });

  it('.skill（zip 改后缀）install → 同 zip 行为', async () => {
    const zip = makeZip('demo', [
      { path: 'SKILL.md', content: '---\nname: demo\ndescription: sf\n---\nbody' },
    ]);
    const form = zipForm(zip, 'demo.skill');
    const r = await handleRequest(req('POST', '/skill/install', { body: form }), dataDir);
    expect(r.status).toBe(202);
    const b = await jsonBody(r);
    expect(b.skill.name).toBe('demo');
  });

  it('单 .md install → 直接放置', async () => {
    const form = new FormData();
    form.append('file', new File(['---\nname: lone\ndescription: single\n---\n# lone'], 'SKILL.md'), 'SKILL.md');
    const r = await handleRequest(req('POST', '/skill/install', { body: form }), dataDir);
    expect(r.status).toBe(202);
    const b = await jsonBody(r);
    expect(b.skill.name).toBe('lone');
  });

  it('原子性：同名已存在 → 409（不覆盖）', async () => {
    const form1 = folderForm([
      { filename: 'SKILL.md', rel: 'demo/SKILL.md', content: '---\nname: demo\ndescription: v1\n---\n' },
    ]);
    await handleRequest(req('POST', '/skill/install', { body: form1 }), dataDir);
    const form2 = folderForm([
      { filename: 'SKILL.md', rel: 'demo/SKILL.md', content: '---\nname: demo\ndescription: v2\n---\n' },
    ]);
    const r = await handleRequest(req('POST', '/skill/install', { body: form2 }), dataDir);
    expect(r.status).toBe(409);
    // 原内容未被破坏（v1）
    const list = await handleRequest(req('GET', '/skill'), dataDir);
    const lb = await jsonBody(list);
    expect(lb.items.find((e: any) => e.name === 'demo').description).toBe('v1');
  });

  it('PATCH toggle enabled → 持久化（重扫反映）', async () => {
    const form = folderForm([
      { filename: 'SKILL.md', rel: 'demo/SKILL.md', content: '---\nname: demo\ndescription: d\n---\n' },
    ]);
    await handleRequest(req('POST', '/skill/install', { body: form }), dataDir);

    const dis = await handleRequest(req('PATCH', '/skill/demo',
      { body: JSON.stringify({ enabled: false }), headers: { 'content-type': 'application/json' } }), dataDir);
    expect(dis.status).toBe(200);
    expect((await jsonBody(dis)).skill.enabled).toBe(false);

    const list = await handleRequest(req('GET', '/skill'), dataDir);
    const lb = await jsonBody(list);
    expect(lb.items.find((e: any) => e.name === 'demo').enabled).toBe(false);

    // 再开
    const en = await handleRequest(req('PATCH', '/skill/demo',
      { body: JSON.stringify({ enabled: true }), headers: { 'content-type': 'application/json' } }), dataDir);
    expect((await jsonBody(en)).skill.enabled).toBe(true);
  });

  it('PATCH missing skill → 404', async () => {
    const r = await handleRequest(req('PATCH', '/skill/ghost',
      { body: JSON.stringify({ enabled: true }), headers: { 'content-type': 'application/json' } }), dataDir);
    expect(r.status).toBe(404);
  });

  it('DELETE → 物理删（mv 到 soft_deleted，列表不含）', async () => {
    const form = folderForm([
      { filename: 'SKILL.md', rel: 'demo/SKILL.md', content: '---\nname: demo\ndescription: d\n---\n' },
    ]);
    await handleRequest(req('POST', '/skill/install', { body: form }), dataDir);

    const del = await handleRequest(req('DELETE', '/skill/demo'), dataDir);
    expect(del.status).toBe(200);
    expect((await jsonBody(del)).ok).toBe(true);

    // 列表不含
    const list = await handleRequest(req('GET', '/skill'), dataDir);
    const lb = await jsonBody(list);
    expect(lb.items.some((e: any) => e.name === 'demo')).toBe(false);

    // 原目录已 mv（不在 skills/ 下）
    expect(existsSync(join(dataDir, 'skills', 'demo'))).toBe(false);
    // 在 soft_deleted 下
    const trash = join(dataDir, 'soft_deleted', 'skills', 'app');
    expect(readdirSync(trash).some((n) => n.startsWith('demo-'))).toBe(true);
  });

  it('file 端点：文本原样 + 路径越界 400 + 不存在 404', async () => {
    const form = folderForm([
      { filename: 'SKILL.md', rel: 'demo/SKILL.md', content: '---\nname: demo\ndescription: d\n---\nORIG_TEXT' },
    ]);
    await handleRequest(req('POST', '/skill/install', { body: form }), dataDir);

    const ok = await handleRequest(req('GET', '/skill/demo/file?path=SKILL.md'), dataDir);
    expect(ok.status).toBe(200);
    const ob = await jsonBody(ok);
    expect(ob.content).toContain('ORIG_TEXT');
    expect(ob.binary).toBe(false);
    expect(ob.truncated).toBe(false);

    // 越界
    const evil = await handleRequest(req('GET', '/skill/demo/file?path=../etc/passwd'), dataDir);
    expect([400, 404]).toContain(evil.status);

    // 不存在
    const miss = await handleRequest(req('GET', '/skill/demo/file?path=nope.md'), dataDir);
    expect(miss.status).toBe(404);
  });

  it('file 缺 path → 400', async () => {
    const form = folderForm([
      { filename: 'SKILL.md', rel: 'demo/SKILL.md', content: '---\nname: demo\ndescription: d\n---\n' },
    ]);
    await handleRequest(req('POST', '/skill/install', { body: form }), dataDir);
    const r = await handleRequest(req('GET', '/skill/demo/file'), dataDir);
    expect(r.status).toBe(400);
  });

  // C1 回归：path traversal / zip-slip 防护（installer stageParts assertWithinTmp）
  // 攻击者构造 relativePath=../escape 或绝对路径 → 必须被拒（400），不得越界写沙箱外
  it('folder install relativePath 含 .. → 400（路径遍历防护）', async () => {
    const form = folderForm([
      { filename: 'SKILL.md', rel: '../escape/SKILL.md', content: '---\nname: demo\ndescription: d\n---\n' },
    ]);
    const r = await handleRequest(req('POST', '/skill/install', { body: form }), dataDir);
    expect(r.status).toBe(400);
    // 确认未越界写到 dataDir 之外
    expect(existsSync(join(dataDir, '..', 'escape'))).toBe(false);
  });

  it('folder install 绝对路径 relativePath → 400', async () => {
    const form = folderForm([
      { filename: 'SKILL.md', rel: '/tmp/evil/SKILL.md', content: '---\nname: demo\ndescription: d\n---\n' },
    ]);
    const r = await handleRequest(req('POST', '/skill/install', { body: form }), dataDir);
    expect(r.status).toBe(400);
  });

  it('单 .md install 含子目录（docs/guide.md）→ 202 正常', async () => {
    // 正常相对路径（嵌套子目录）不应被误拒
    const form = new FormData();
    form.append('file', new File(['---\nname: demo\ndescription: d\n---\n# demo'], 'SKILL.md'), 'SKILL.md');
    const r = await handleRequest(req('POST', '/skill/install', { body: form }), dataDir);
    expect(r.status).toBe(202);
    const b = await jsonBody(r);
    expect(b.skill.name).toBe('demo');
  });
});
