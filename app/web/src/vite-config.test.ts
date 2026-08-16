/**
 * vite.config.ts 回归测试 —— dev server proxy 路径覆盖防漏配
 * 参考: app/web/vite.config.ts
 *
 * 背景：v0.0.21 `/skill` 漏配 proxy 致 dev/test 全 404（vite.config 注释 BUG-001）；
 *   v0.0.33.1 `/squad` 同模式漏配 → Studio sidebar 空 + new-squad wizard 404（BUG-001/002）。
 *   dev server 漏配 proxy 时，浏览器 fetch 相对路径被 vite 自身 short-circuit 返 404，
 *   请求**根本不到后端**（verifier 抓包甚至看不到出站），全链路静默失败。
 *   本 UT 把 proxy 路径断言固化为回归门，新增端点必须补 proxy + 补断言。
 *
 * 实现：直接读 vite.config.ts 源文件 + 正则匹配 proxy 配置项。
 *   避开 dynamic import（受 rootDir 限制 + bundler resolution 禁 .ts 后缀）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** vite.config.ts 源码（src 外，用绝对路径读：app/web/src → app/web） */
const VITE_CONFIG_PATH = resolve(__dirname, '..', 'vite.config.ts');
const VITE_CONFIG_SRC = readFileSync(VITE_CONFIG_PATH, 'utf-8');

/** 提取 proxy 配置块中所有顶层路径键（形如 `'/foo': {` 或 `'/foo':{`） */
function extractProxyPaths(src: string): string[] {
  // proxy: { ... } 块内，匹配单引号字符串键 + 冒号 + 空白 + {
  const blockMatch = src.match(/proxy:\s*\{([\s\S]*?)\n\s{4}\}/);
  if (!blockMatch || !blockMatch[1]) return [];
  const body = blockMatch[1];
  const paths: string[] = [];
  // 每行 `      '/xxx': {` 或 `      '/xxx': {`（缩进 6 空格 + 引号 + 路径 + 引号 + 冒号 + 可选空格 + {）
  const lineRe = /^\s+'([^']+)':\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = lineRe.exec(body)) !== null) {
    paths.push(m[1]!);
  }
  return paths;
}

describe('vite.config.ts proxy 路径覆盖（BUG-001/002 回归保护）', () => {
  it('proxy 配置块存在', () => {
    expect(VITE_CONFIG_SRC).toMatch(/proxy:\s*\{/);
  });

  // 各端点组回归断言：新增端点必须补 proxy + 补这里一行
  const REQUIRED_PROXIES = [
    '/counter', // v0.0.1 demo
    '/health', // 健康检查
    '/session', // v0.0.8 session CRUD + messages + 派生端点
    '/sse', // v0.0.3 chat SSE
    '/config', // v0.0.5 app/dev config
    '/provider', // v0.0.7 provider/model CRUD
    '/skill', // v0.0.21 skill 管理（曾漏配，vite.config 注释 BUG-001）
    '/squad', // v0.0.33.1 squad CRUD + member（曾漏配 BUG-001/002）
    '/mention', // v0.0.45 mention/search（曾漏配 BUG-001）
    '/memory', // v0.0.77 memory CRUD（曾漏配 BUG）
    '/consolidation', // v0.0.205 consolidation CRUD（曾漏配 BUG-001）
    '/academy', // v0.0.210 academy CRUD（曾漏配，ET blocking 根因）
    '/model-routing', // v0.0.347 模型路由 status/CRUD（v0.0.347 BUG-001，ET-3 实证红绿灯不渲染）
    '/skills', // v0.0.166 skill 市场（复数，/skill 前缀覆盖不到，v0.0.347 全量排查补配）
    '/bootstrap', // v0.0.150 bootstrap/status 启动迁移提示（v0.0.347 全量排查补配）
  ] as const;

  it.each(REQUIRED_PROXIES)('proxy 含 %s（前缀匹配，覆盖该路径整棵子树）', (prefix) => {
    const paths = extractProxyPaths(VITE_CONFIG_SRC);
    expect(paths).toContain(prefix);
  });
});
