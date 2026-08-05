/**
 * vitest 全量 UT 配置（仓库根，跨所有 workspace）
 * 参考: specs/tech/app/package/[P0]tool_chain.md §3.1/§4.1
 *
 * - include 覆盖所有 workspace 下的 *.test.ts / *.test.tsx
 * - exclude 显式排除 node_modules / refs/ / dist / release
 * - environmentMatchGlobs 让 web 的 DOM 测试自动用 jsdom，server/protocols 保持 node
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['app/**/*.test.ts', 'app/**/*.test.tsx'],
    // 排除 node_modules：bun workspaces 把 @app/* 用 symlink 装到各 workspace 的
    // node_modules 下，vitest 默认会跟随 symlink 把同一份 test 扫两遍。显式列出避免重复。
    exclude: [
      'node_modules/**',
      'app/**/node_modules/**',
      'refs/**',
      '**/dist/**',
      'release/**',
      '**/soft_deleted/**',
    ],
    environment: 'node',
    globals: true,
    environmentMatchGlobs: [
      ['app/web/**/*.test.tsx', 'jsdom'],
      ['app/web/**/*.test.ts', 'jsdom'],
    ],
    // bun:sqlite 等 bun 内置模块只存在于 bun runtime。
    // vitest 经 vite 的 loadAndTransform 解析模块时会把 bun:sqlite 当文件 URL 去磁盘找，
    // 触发 "Failed to load url bun:sqlite"。把它标记为 external，跳过 vite 的 transform，
    // 实际 import 由 bun runtime 原生提供（bun run test 全链在 bun 下执行）。
    // 参考: specs/tech/persistence/[P0]sqlite_crud_store_engine.md §2 SqliteCrudStore
    server: {
      deps: {
        external: [/^bun:/],
      },
    },
  },
});
