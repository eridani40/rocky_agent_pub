/**
 * SkillInstaller - multipart 上传解压/复制 → staging → 落盘核心（v0.0.21；v0.0.166 抽出 source-无关核心）
 * 参考: specs/tech/agent/skills/[P0]skill_architecture.md §5
 *       specs/tech/agent/skills/[P1]skill_market.md §7
 *       specs/api/overall/06-skill.md §2
 *
 * 本文件 = multipart 上传适配层：把 FormData 解析成文件 → staging（zip/folder/单 md）→
 * 汇入 installer-core.ts 的 source-无关落盘核心 `finalizeStagedSkill`。
 * 市场下载路径（provider.fetchSkillFiles → stageAndInstallFiles）见 installer-core.ts，
 * **不经过本文件**、**不用 adm-zip**（adm-zip 仅 multipart 上传保留）。
 *
 * multipart 协议（orchestrator 决策1）：
 *   - field files（1 或多个 part）；每个 part 的 filename = 相对 skill 根的路径
 *     （webkitRelativePath 约定，如 my-skill/SKILL.md）。
 *   - 兼容旧约定：part filename 仅基名时，读表单字段 relativePath 或
 *     relativePath_<basename> 取相对路径（tests/api/skill 下的 run.sh 用此约定）。
 *   - 单 part 为 .zip/.skill -> adm-zip 解压；单 part 为 .md -> 直接放置；多 part（folder）
 *     -> 按 filename/relativePath 重建目录。
 */
import AdmZip from 'adm-zip';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  InstallError,
  assertWithinTmp,
  finalizeStagedSkill,
  isDirectory,
} from './installer-core';
import type { InstallParams, InstallResult } from './installer-core';

// source-无关落盘核心（含 multipart 与市场下载共用的类型/错误/工具）从 installer-core 重导出，
// 保持既有 import 路径（handlers/skill.ts 等仍从 '../skills/installer' 取），并对外统一入口。
export {
  InstallError,
  scopeRoot,
  finalizeStagedSkill,
  stageAndInstallFiles,
  MAX_SKILL_BYTES,
  assertWithinTmp,
  locateSkillRoot,
  dirSize,
  isDirectory,
} from './installer-core';
export type {
  InstallResult,
  InstallParams,
  SkillGovernanceOverride,
  StagedSkill,
} from './installer-core';

/**
 * 安装 skill：从 multipart form fields 提取文件 → 解压/复制 staging → 复用落盘核心 finalizeStagedSkill。
 *
 * @param form 已 parse 的 FormData（caller 用 await req.formData()）
 * @param dataDir app 数据根
 * @param params scope + workspaceDir
 * @returns InstallResult（entry.scope/name/description/skillDir 已填，enabled=true）
 * @throws InstallError 校验/冲突/workspace 不存在/超限
 */
export async function installSkill(
  form: FormData,
  dataDir: string,
  params: InstallParams,
): Promise<InstallResult> {
  // workspace 校验（api §10）
  if (params.scope === 'workspace') {
    if (!params.workspaceDir || !isDirectory(params.workspaceDir)) {
      throw new InstallError('workspace not found', 'workspace_not_found');
    }
  }

  // 收集所有 files part（字段名 files 或 file，多值）
  const parts = await collectFileParts(form);
  if (parts.length === 0) {
    throw new InstallError('missing file(s) in multipart form', 'bad_request');
  }

  // tmp 目录（落盘前 staging）
  const tmpRoot = mkdtempSync(join(tmpdir(), 'rocky-skill-install-'));
  try {
    await stageParts(parts, tmpRoot);
    // 汇入 source-无关落盘核心（multipart 不传 governance → 保留源 frontmatter，行为不变）
    return finalizeStagedSkill(tmpRoot, dataDir, params);
  } finally {
    // 清理 tmp（无论成功失败）
    try {
      rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** 收集 FormData 中所有文件 part（字段名 files 或 file，兼容单复数） */
interface FilePart {
  /** 原始 filename */
  filename: string;
  /** 文件内容 */
  bytes: Uint8Array;
  /** 相对路径（filename 含 / 时优先；否则查 relativePath 表单字段） */
  relativePath: string;
}

async function collectFileParts(form: FormData): Promise<FilePart[]> {
  const out: FilePart[] = [];
  // FormData.getAll 支持同字段多值（folder 多文件场景）
  for (const fieldName of ['files', 'file']) {
    const values = form.getAll(fieldName);
    for (const v of values) {
      // FormDataEntryValue = File | string；只取 File/Blob（string 字段跳过）
      if (typeof v === 'string') continue;
      if (typeof (v as { arrayBuffer?: unknown }).arrayBuffer !== 'function') continue;
      const fileLike = v as File;
      const filename = fileLike.name || 'unknown';
      const buf = new Uint8Array(await (v as Blob).arrayBuffer());
      const rel = resolveRelativePath(form, filename);
      out.push({ filename, bytes: buf, relativePath: rel });
    }
  }
  return out;
}

/** 解析 part 的相对路径：filename 含 / 用之；否则查 relativePath / relativePath_<basename> 表单字段 */
function resolveRelativePath(form: FormData, filename: string): string {
  if (filename.includes('/') || filename.includes('\\')) return filename.replace(/\\/g, '/');
  const direct = form.get('relativePath');
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const keyed = form.get(`relativePath_${filename}`);
  if (typeof keyed === 'string' && keyed.length > 0) return keyed;
  return filename;
}

/** 把所有 part 写入 tmpRoot（按 relativePath 重建目录 / zip 解压） */
async function stageParts(parts: FilePart[], tmpRoot: string): Promise<void> {
  // 单 part .zip/.skill → 解压到 tmpRoot（adm-zip 0.5.17 extractAllTo 自带 zip-slip 防护）
  if (parts.length === 1 && /\.(zip|skill)$/i.test(parts[0]!.filename)) {
    let zip: AdmZip;
    try {
      zip = new AdmZip(Buffer.from(parts[0]!.bytes));
    } catch {
      throw new InstallError('invalid zip archive', 'bad_request');
    }
    try {
      zip.extractAllTo(tmpRoot, true);
    } catch {
      throw new InstallError('failed to extract zip', 'bad_request');
    }
    return;
  }
  // 单 part .md → 直接放 tmpRoot/SKILL.md（若 filename 非 SKILL.md，按 filename）
  if (parts.length === 1 && /\.md$/i.test(parts[0]!.filename)) {
    const rel = parts[0]!.relativePath || 'SKILL.md';
    assertWithinTmp(tmpRoot, rel);
    const target = join(tmpRoot, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, parts[0]!.bytes);
    return;
  }
  // 多 part（folder）→ 按 relativePath 重建
  for (const p of parts) {
    const rel = p.relativePath || p.filename;
    assertWithinTmp(tmpRoot, rel);
    const target = join(tmpRoot, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, p.bytes);
  }
}
