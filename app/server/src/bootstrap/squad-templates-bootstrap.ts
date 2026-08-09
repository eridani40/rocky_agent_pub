/**
 * squad-templates-bootstrap — builtin 模板同步（bootstrap 期执行）
 * 参考: specs/tech/squad/[P1]squad_templates.md §③ Builtin 机制
 *
 * 职责：扫描 builtinsDir 下 squad-templates 各子目录的 manifest.json，
 * 将 builtin:true 的模板整体复制到 {dataDir}/squad-templates/{slug}/（覆盖同名）。
 * 用户自定义模板（builtin:false）不碰。
 * 错误不阻断 bootstrap（console.warn）。
 *
 * asar 兼容性（关键）：packaged 模式下源文件在 app.asar 虚拟文件系统内。
 * Electron patch 了 readFileSync/readdirSync/existsSync 能读 asar 内文件，
 * 但 cpSync({ recursive: true }) 不能从 asar 递归复制到真实文件系统（静默失败）。
 * 故用手动递归：readdirSync 逐层遍历 + readFileSync → writeFileSync 逐文件复制。
 */
import * as path from 'node:path';
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, statSync } from 'node:fs';

/** 手动递归复制目录（asar 兼容：逐文件 read → write，不依赖 cpSync） */
function copyDirRecursive(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const srcPath = path.join(src, name);
    const destPath = path.join(dest, name);
    // statSync 在 asar 内可用（Electron patch），isDirectory() 对 asar 内条目返回正确值
    if (statSync(srcPath).isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      writeFileSync(destPath, readFileSync(srcPath));
    }
  }
}

/**
 * 同步 builtin squad 模板到用户目录。
 *
 * @param builtinsDir  builtin plugin 根目录（app/plugins/dist/builtins）
 * @param dataDir      用户数据根目录（~/.rocky_agent_prod）
 */
export function syncBuiltinSquadTemplates(builtinsDir: string, dataDir: string): void {
  const srcDir = path.join(builtinsDir, 'squad-templates');
  if (!existsSync(srcDir)) return;

  const destRoot = path.join(dataDir, 'squad-templates');
  mkdirSync(destRoot, { recursive: true });

  // 注意：不用 readdirSync({ withFileTypes: true }) + isDirectory()——asar 虚拟文件系统下
  // dirent.isDirectory() 不可靠（返回 false），会导致 packaged 模式下模板被跳过。
  // 改用普通 readdirSync + existsSync(manifest.json) 判断有效模板目录。
  for (const name of readdirSync(srcDir)) {
    const slug = name;
    const manifestPath = path.join(srcDir, slug, 'manifest.json');
    if (!existsSync(manifestPath)) continue;

    try {
      const raw = readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(raw);
      // 只覆盖 builtin:true 模板；用户自定义模板不碰
      if (!manifest.builtin) continue;

      const destDir = path.join(destRoot, slug);
      // 手动递归复制（asar 兼容：cpSync 不能从 asar 递归复制到真实 fs）
      copyDirRecursive(path.join(srcDir, slug), destDir);
    } catch (e) {
      console.warn(`[squad-templates-bootstrap] sync template "${slug}" failed:`, e);
    }
  }
}
