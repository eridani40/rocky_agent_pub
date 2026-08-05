/**
 * web 渲染层入口。参考 specs/tech/app/frontend/[P0]tech_stack.md §4.2。
 *
 * 首屏 React 渲染前先 await initI18nFromConfig()——据持久化 locale.language 同步
 * i18next.use(lng) + documentElement.lang，避免刷新回退 / 首屏闪烁。React tree 用
 * <I18nextProvider> 包根，保证 useTranslation 消费同一 instance。
 * light-only（无 data-theme 切换），不初始化 theme。
 */
import { createRoot } from 'react-dom/client';
import { I18nextProvider } from 'react-i18next';
// 字体两族内置（design_system.md §2.2）：@fontsource 本地打包，零远程字体依赖。
// family 名与 Google Fonts 一致（'Inter' / 'JetBrains Mono'），
// tokens.css 的 font-family 栈无需改动；字重覆盖与原 Google Fonts link 对等。
import '@fontsource/inter/300.css';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import './styles/tokens.css';
import './styles/scrollbar.css'; // 全局细滚动条工具类 .scrollbar-thin（替换系统粗滚动条）
import { App } from './App';
import { initI18nFromConfig } from './lib/locale-init';
import { i18n } from './i18n';
// 渲染进程长任务监控（dev 默认开 / VITE_LONGTASK_MONITOR 显式覆盖；失败静默）
import { startLongTaskMonitor } from './lib/longtask-monitor';

async function main() {
  // 首屏渲染前启动长任务监控：越早装上 observer，越能抓到启动期卡顿；失败静默不阻断渲染
  startLongTaskMonitor();
  // 首屏 React 渲染前先据持久化 locale 初始化 i18next，避免语言回退 / 闪烁
  await initI18nFromConfig();
  const rootEl = document.getElementById('root');
  if (rootEl) {
    createRoot(rootEl).render(
      <I18nextProvider i18n={i18n}>
        <App />
      </I18nextProvider>,
    );
  }
}

void main();
