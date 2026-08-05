/**
 * buildFileTree —— skill 预览文件树构建（v0.0.21）
 * 参考: specs/tech/agent/skills/[P0]skill_architecture.md §13
 *       specs/api/overall/06-skill.md §6
 *
 * 输出 SkillFileNode[]，path 相对 skillDir（不含 skill 名前缀，防泄漏绝对路径）。
 * 跳过隐藏目录（如 .git）+ 二进制识别留 file 端点处理。
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { SkillFileNode } from './types';

/** 跳过这些目录名（不进树） */
const SKIP_DIRS = new Set(['.git', 'node_modules']);

/**
 * 递归构建 skill 目录文件树。
 * @param skillDir skill 绝对路径根
 * @returns SkillFileNode[]（path 相对 skillDir）；目录不存在返空数组
 */
export function buildFileTree(skillDir: string): SkillFileNode[] {
  return walk(skillDir, skillDir);
}

function walk(dir: string, root: string): SkillFileNode[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: SkillFileNode[] = [];
  for (const name of names) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    const rel = relative(root, abs);
    if (st.isDirectory()) {
      out.push({ name, path: rel, type: 'dir' });
      // 递归子目录（深拷贝进同层数组，前端按 path 前缀重建树）
      for (const child of walk(abs, root)) out.push(child);
    } else if (st.isFile()) {
      out.push({ name, path: rel, type: 'file', size: st.size });
    }
  }
  return out;
}
