# app-shell

> 层级: framework
> 文件: app/web/src/components/framework/app-shell/app-shell.tsx

## 职责
app 根布局：左 nav-rail（~56px 窄图标栏，功能导航）+ 右 main（按 `currentView` 路由到对应 page）。
边界：app-shell 只做「壳 + 路由分发」，不持有任何业务状态——`currentView` 从 zustand view-store 读，页面内容由各 page 自管。

## Props
- currentView: ViewId;          // 'chat' | 'settings-app' | 'settings-plugin' ...
- setView: (v: ViewId) => void; // 切换主区 view

## 状态 / 交互
- `currentView` 决定 main 渲染哪个 page（switch 路由）

## 复用关系
- 组合：`nav-rail`（左栏导航）+ 各 `page-*`（按 currentView 路由）+ `migration-error-modal`
- 被谁用：app 根（顶层渲染入口）
