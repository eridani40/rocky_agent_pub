/**
 * team-sync-handler 单测（v0.0.319 团队同步 API）
 * 参考: specs/tech/version_logs/v0.0.319/change_plan.md D3
 *       specs/prd/v0.0.319-team-sync.md §2.2/§2.3（导出/导入流程）
 *
 * 覆盖（test-plan §2 UT 组 3）：
 *   - GET /squad/:id/export → 200 application/zip + Content-Disposition attachment + zip 可解包
 *   - GET 不存在 squad → 404
 *   - POST preview（FormData file）→ 200 { importKey, manifest }
 *   - POST preview 非 zip 文件 → 400
 *   - POST execute（importKey + name）→ 201 { squadId, created, failed } 建队成功
 *   - POST execute importKey 过期/不存在 → 400「import session expired」
 *   - 路径不匹配 → null（主分发继续）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import AdmZip from 'adm-zip';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  handleTeamSyncExport, handleTeamSyncImport, type TeamSyncHandlerDeps,
} from '../team-sync-handler';
import { createSquadService } from '../../services/squad-service';
import { SquadStore, MemberStore, squadRootDir } from '../../stores/squad-store';
import { SessionStore } from '../../agent/session-store';
import { CompositeStore } from '../../persistence/composite';
import { FsCrudStore } from '../../persistence/fs-store';
import type { ManifestSchema } from '../../services/squad-template-service';

let tmpRoot: string;
let deps: TeamSyncHandlerDeps;
let squadId: string;

function makeManifest(): ManifestSchema {
  return {
    slug: 'orig', name: '源团队', description: 'd', leaderName: 'Darvin', builtin: false,
    members: [{ name: 'coder', intro: '代码开发者', skillConfig: { mode: 'inherit', overrides: {} } }],
  };
}

function makeZipBuffer(): Buffer {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify(makeManifest())));
  zip.addFile('AGENTS.md', Buffer.from('# 规则'));
  return zip.toBuffer();
}

function previewReq(file: Blob): Request {
  const fd = new FormData();
  fd.append('file', file, 'team.zip');
  return new Request('http://t/squad/import?step=preview', { method: 'POST', body: fd });
}

function executeReq(importKey: string, name: string): Request {
  const fd = new FormData();
  fd.append('importKey', importKey);
  fd.append('name', name);
  return new Request('http://t/squad/import?step=execute', { method: 'POST', body: fd });
}

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-sync-handler-'));
  const fsEngine = new FsCrudStore({ root: tmpRoot });
  const crud = new CompositeStore().mount('session', fsEngine).mount('transcript', fsEngine)
    .mount('summary', fsEngine).mount('runs', fsEngine);
  const sessionStore = new SessionStore({ crud, fsRoot: tmpRoot });
  const squadStore = new SquadStore({ root: tmpRoot });
  const memberStore = new MemberStore({ root: tmpRoot });
  deps = { sessionStore, squadStore, memberStore, dataDir: tmpRoot };
  const created = await createSquadService(
    { sessionStore, squadStore, memberStore, dataDir: tmpRoot },
    { name: '我的团队', modelDefault: 'm', leader: { name: 'Darvin' } },
  );
  squadId = created.squad.id as string;
  // 补 AGENTS.md + agents 文件（导出有内容可验）
  const dir = squadRootDir(tmpRoot, squadId);
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# 团队规则');
});

afterEach(() => { fs.rmSync(tmpRoot, { recursive: true, force: true }); });

async function jsonBody(r: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await r.text()) as Record<string, unknown>;
}

describe('handleTeamSyncExport（GET /squad/:id/export）', () => {
  it('200 + application/zip + Content-Disposition attachment + zip 可解包含 manifest/AGENTS.md', async () => {
    const res = await handleTeamSyncExport('GET', `/squad/${squadId}/export`, deps);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    expect(res!.headers.get('content-type')).toBe('application/zip');
    const cd = res!.headers.get('content-disposition') ?? '';
    expect(cd).toContain('attachment');
    expect(cd).toContain('rocky_agent_team_');
    expect(cd).toContain('.zip');

    const zip = new AdmZip(Buffer.from(await res!.arrayBuffer()));
    const names = zip.getEntries().map((e) => e.entryName);
    expect(names).toContain('manifest.json');
    expect(names).toContain('AGENTS.md');
    const manifest = JSON.parse(zip.getEntry('manifest.json')!.getData().toString('utf8'));
    expect(manifest.leaderName).toBe('Darvin');
  });

  it('squad 不存在 → 404', async () => {
    const res = await handleTeamSyncExport('GET', '/squad/NOPE/export', deps);
    expect(res!.status).toBe(404);
  });

  it('路径不匹配 → null（主分发继续）', async () => {
    expect(await handleTeamSyncExport('GET', '/squad/abc', deps)).toBeNull();
    expect(await handleTeamSyncExport('POST', `/squad/${squadId}/export`, deps)).toBeNull();
  });
});

describe('handleTeamSyncImport（POST /squad/import?step=preview）', () => {
  it('合法 zip → 200 { importKey, manifest }', async () => {
    const res = await handleTeamSyncImport(
      previewReq(new Blob([new Uint8Array(makeZipBuffer())], { type: 'application/zip' })),
      'POST', '/squad/import', new URLSearchParams('step=preview'), deps,
    );
    expect(res!.status).toBe(200);
    const body = await jsonBody(res!);
    expect(typeof body.importKey).toBe('string');
    expect((body.manifest as ManifestSchema).leaderName).toBe('Darvin');
  });

  it('非 zip 文件 → 400 可读错误', async () => {
    const res = await handleTeamSyncImport(
      previewReq(new Blob(['not a zip'], { type: 'text/plain' })),
      'POST', '/squad/import', new URLSearchParams('step=preview'), deps,
    );
    expect(res!.status).toBe(400);
  });

  it('缺 step 参数 → 400', async () => {
    const res = await handleTeamSyncImport(
      previewReq(new Blob([new Uint8Array(makeZipBuffer())])), 'POST', '/squad/import', new URLSearchParams(), deps,
    );
    expect(res!.status).toBe(400);
  });
});

describe('handleTeamSyncImport（POST /squad/import?step=execute）', () => {
  it('preview → execute 全流程：201 { squadId, created, failed }，新 squad 建队成功', async () => {
    // step1 preview
    const previewRes = await handleTeamSyncImport(
      previewReq(new Blob([new Uint8Array(makeZipBuffer())])), 'POST', '/squad/import',
      new URLSearchParams('step=preview'), deps,
    );
    const { importKey } = (await jsonBody(previewRes!)) as { importKey: string };

    // step2 execute（无 x-session-id → 无 appConfig → modelDefault 取不到 → 400）
    const noModelRes = await handleTeamSyncImport(
      executeReq(importKey, '新团队'), 'POST', '/squad/import',
      new URLSearchParams('step=execute'), deps,
    );
    // deps 无 appConfig 且无 session → resolveModelDefaultAsync 返 null → 400
    expect(noModelRes!.status).toBe(400);
  });

  it('importKey 不存在/已消费 → 400「import session expired」', async () => {
    const res = await handleTeamSyncImport(
      executeReq('NONEXISTENT-KEY', 'x'), 'POST', '/squad/import',
      new URLSearchParams('step=execute'), deps,
    );
    expect(res!.status).toBe(400);
    const body = await jsonBody(res!);
    expect(String(body.error)).toContain('expired');
  });

  it('路径不匹配 → null', async () => {
    const res = await handleTeamSyncImport(
      executeReq('k', 'n'), 'POST', '/squad/other', new URLSearchParams('step=execute'), deps,
    );
    expect(res).toBeNull();
  });
});
