/**
 * 生成 `app/server/app-version.json` —— 读根 package.json 的 version，写入静态文件。
 * 参考: specs/tech/version_logs/v0.0.150/change_plan.md §D（版本号生成链路）
 *
 * 调用时机：
 *   - `scripts/build-dmg.sh` 在 @app/server build 后、electron-builder 前调一次
 *   - `scripts/run-dev.sh` 在 server 启动前调一次
 *   - dev/packaged 同源（同一脚本生成同一文件）
 *
 * 写入位置 = `app/server/app-version.json`（src/dist 平级）：
 *   - 运行时（app/server/src/migration/app-version.ts）用 `__dirname/../../app-version.json` 读
 *   - dev `src/migration/` + packaged `dist/migration/` 都解析到 `app/server/app-version.json`
 *   - electron-builder.yml `files` 显式列出，packaged 进 asar
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const ROOT = path.resolve(__dirname, '..');
const PKG_JSON_PATH = path.join(ROOT, 'package.json');
const OUTPUT_PATH = path.join(ROOT, 'app/server/app-version.json');

interface PackageJson {
  version?: string;
}
interface AppVersionFile {
  version: string;
  generatedAt: string;
}

/**
 * 读根 package.json 的 version 字段。
 * @throws 缺失/空/等于 '0.0.0'（占位值）时抛错——无版本号 build 无意义
 */
function readRootVersion(): string {
  const raw = fs.readFileSync(PKG_JSON_PATH, 'utf-8');
  const pkg = JSON.parse(raw) as PackageJson;
  const v = pkg.version;
  if (!v || typeof v !== 'string') {
    throw new Error(`gen-version: 根 package.json 缺失 version 字段或类型错误`);
  }
  if (v.trim() === '' || v === '0.0.0') {
    throw new Error(`gen-version: version="${v}" 非法（空或占位 0.0.0）`);
  }
  return v;
}

/**
 * 写 app-version.json（覆盖写即可——本文件是 build 期生成物，不入 git）。
 */
function writeAppVersionFile(version: string): void {
  const payload: AppVersionFile = {
    version,
    generatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
}

function main(): void {
  const version = readRootVersion();
  writeAppVersionFile(version);
  console.log(`[gen-version] 已生成 ${path.relative(ROOT, OUTPUT_PATH)} (version=${version})`);
}

try {
  main();
} catch (err) {
  console.error(`[gen-version] ERROR: ${(err as Error).message}`);
  process.exit(1);
}
