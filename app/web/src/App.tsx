/**
 * web 渲染层 App 根（v0.0.3）
 * 参考: specs/ui/overall/02-llm-chat.md §1/§2
 *
 * v0.0.3：替换 v0.0.1 counter demo 为 AppShell（2 栏布局 + currentView 路由）。
 * counter-store 保留（向后兼容，不再在 App 渲染）。
 * theme 默认由 html data-theme 属性控制（tokens.css 两套变量集，T6 接 settings 切换）。
 */
// v0.0.5：AppShell 迁入 framework/app-shell/（纯结构迁移零行为变更）
import { AppShell } from './components/framework/app-shell/app-shell';

/** App 根：渲染 AppShell（2 栏布局 + 内存路由） */
export function App() {
  return <AppShell />;
}

export default App;
