/**
 * web/ Vite 配置（浏览器目标构建）
 * 参考: specs/tech/app/frontend/[P0]tech_stack.md §4.3 / specs/api/overall/01-counter.md §1.1
 *       specs/tech/app/package/[P0]packaging_toolchain.md §3.3（两段式：web build → electron-builder）
 *
 * - React + Tailwind v4 经 Vite 插件接入（不另起 PostCSS 链，tech_stack §3.5）
 * - dev server proxy：把 /counter、/health 转发到 http://127.0.0.1:${API_PORT}，
 *   web 内 fetch 相对路径即可，免 CORS（v0.0.1 不引入 IPC / Electron）
 * - API_PORT 从 process.env 读，缺省 3700（test env，见 environments.md §3.1）
 * - build.outDir 指向 app/electron/web-dist（约定路径，packaging_toolchain §3.3）：
 *   让 vite build 产物落在 electron 包内，electron-builder files 直接含 web-dist/**，
 *   无需跨越 workspace 边界（builder 默认禁 .. 路径）。
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

/** 后端 API 端口（test 3700 / dev 3710 / prod 3720） */
const API_PORT = process.env.API_PORT ?? '3700';

/** proxy 目标 */
const API_TARGET = `http://127.0.0.1:${API_PORT}`;

/** 打包产物根目录（app/electron/web-dist，packaging_toolchain §3.3 约定） */
const WEB_DIST = resolve(__dirname, '..', 'electron', 'web-dist');

/** [v0.0.68 dev 白屏 fix] @app/shared 直接 alias 到 src，绕过 dist CJS 产物
 * 的 esbuild 具名 export 分析坑（tsc re-export 编出 Object.defineProperty getter，
 * vite ESM 分析器识别不到具名 export → SyntaxError → 白屏）。
 * shared src 无外部 @app/* 运行时依赖（仅 test import vitest），alias 安全。
 * server/electron 仍吃 dist CJS（它们的 tsconfig 是 CommonJS）。
 */
const SHARED_SRC = resolve(__dirname, '..', 'shared', 'src');

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@app/shared': SHARED_SRC,
    },
  },
  // packaged 用 file:// 加载 index.html，相对路径即可；dev 走 vite server URL
  base: './',
  build: {
    outDir: WEB_DIST,
    emptyOutDir: true,
    // packaged web bundle 含 monaco/merk/tiptap 等大依赖，chunk > 500KB 默认 warn 是噪音（不阻断）
    chunkSizeWarningLimit: 2000,
  },
  server: {
    host: '127.0.0.1',
    proxy: {
      '/counter': {
        target: API_TARGET,
        changeOrigin: false,
      },
      '/health': { target: API_TARGET, changeOrigin: false },
      // v0.0.3：chat SSE / config / provider CRUD（specs/api/overall/02-llm-chat.md）
      // v0.0.8：/chat 作废，新增 /session* /session/:id/messages /sse*
      '/chat': { target: API_TARGET, changeOrigin: false },
      '/session': { target: API_TARGET, changeOrigin: false },
      '/sse': { target: API_TARGET, changeOrigin: false },
      '/config': { target: API_TARGET, changeOrigin: false },
      '/provider': { target: API_TARGET, changeOrigin: false },
      // v0.0.21：/skill 管理（install/list/toggle/delete/tree/file）—— 漏配致 dev/test 全 404（BUG-001）
      '/skill': { target: API_TARGET, changeOrigin: false },
      // v0.0.33.1：/squad CRUD + member/charter 子路径 —— 漏配致 Studio sidebar 空 + new-squad wizard 404（BUG-001/002）
      // 前缀匹配覆盖 /squad 整棵子树（/squad, /squad/:id, /squad/:id/member/*, /squad/:id/charter*）
      '/squad': { target: API_TARGET, changeOrigin: false },
      // v0.0.45：/mention/search（skill/squad @mention 候选检索）—— 漏配致 dev/E2E 环境下 fetch 拿到 index.html 而非 JSON（BUG-001）
      '/mention': { target: API_TARGET, changeOrigin: false },
      // v0.0.77：/memory/*（UI memory CRUD：GET/POST/PATCH/DELETE /memory/:scope[/:name]）—— 漏配致
      // dev 下 vite 返 index.html，req() 静默把 HTML 当 body，r.entries ?? [] → 空数组无报错，UI 永远空（BUG）
      '/memory': { target: API_TARGET, changeOrigin: false },
      // v0.0.205 BUG-001：/consolidation CRUD —— 漏配致 dev 环境"立即整理"404（POST 空响应）+ status 返 SPA
      // index.html（onInit 兜底"尚未整理过"）；同类 v0.0.21 /skill 漏配 BUG-001。生产 packaged 直连不受影响。
      '/consolidation': { target: API_TARGET, changeOrigin: false },
      // v0.0.210 ET 实证：/academy 板块 CRUD（classroom/student/version）+ training-task/dataset/grader 子路径 ——
      // 漏配致 dev/ET 环境下所有 academy API POST 被 vite 当 SPA 路由返 404，未透传后端（ET blocking 根因）。
      // 后端 academy 实现完整（curl API_PORT 直接 201）；packaged 不走 vite 不受影响。同类 v0.0.33.1 /squad 漏配先例。
      // 前缀匹配覆盖 /academy 整棵子树：/academy/classroom、/academy/classroom/:cid/student、
      // /academy/training-task/:tid、/academy/dataset、/academy/grader 等（specs/api/overall/18-academy.md）
      '/academy': { target: API_TARGET, changeOrigin: false },
    },
  },
});
