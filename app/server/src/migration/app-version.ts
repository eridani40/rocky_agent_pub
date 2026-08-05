/**
 * 当前 app 版本号读取——从 `app/server/app-version.json` 静态文件读。
 * 参考: specs/tech/version_logs/v0.0.150/change_plan.md §A / §B（packaged 护栏 BUG-001/BUG-004）
 *
 * 路径解析关键：
 *   - dev 模式：__dirname = `app/server/src/migration/`，`../../app-version.json` → `app/server/app-version.json`
 *   - packaged 模式：__dirname = `app/server/dist/migration/`（asar 内），同相对路径 → `app/server/app-version.json`
 *   - 用 `__dirname` 派生绝对路径 → packaged cwd=/ 安全（不依赖 cwd，BUG-004）
 *
 * 注：change_plan 原写 `../app-version.json` 路径算错（只到 src/ 或 dist/，不到 app/server/），
 * coder 改为 `../../app-version.json`（正确两级回溯）。
 *
 * 不走 process.env / runtime-config（packaged env 干净，BUG-001）；不 import json（避 bundler copy 坑）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** app-version.json 文件形状（由 scripts/gen-version.ts 写入） */
interface AppVersionFile {
  version: string;
  generatedAt: string;
}

/** app-version.json 路径（__dirname 派生，dev/packaged 均稳：src/migration 或 dist/migration 都回溯两级到 app/server/） */
const APP_VERSION_PATH = path.resolve(__dirname, '../../app-version.json');

/**
 * 读取当前 app 版本号。
 *
 * 读 `app/server/app-version.json` → 解析 JSON → 返回 `.version` 字段。
 * 文件由 build/dev 启动前的 `bun run gen-version` 写入（scripts/gen-version.ts）。
 *
 * @returns 版本号字符串（如 '0.0.150'）
 * @throws 文件缺失或 JSON 损坏时抛错（构建链断裂的硬失败信号，不应静默回退）
 */
export function getAppVersion(): string {
  const raw = fs.readFileSync(APP_VERSION_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as AppVersionFile;
  if (!parsed.version || typeof parsed.version !== 'string') {
    throw new Error(`app-version: 文件 ${APP_VERSION_PATH} 缺失 version 字段或类型错误`);
  }
  return parsed.version;
}
