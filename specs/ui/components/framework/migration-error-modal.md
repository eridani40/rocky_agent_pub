# migration-error-modal

> 层级: framework
> 文件: app/web/src/components/framework/app-shell/migration-error-modal.tsx

## 职责
启动期迁移错误提示 modal：bootstrap 期 MigrationManager 跑 handler 抛错（含 lock 冲突）时，
则渲染本 modal 聚合提示用户「N 个迁移失败，详情见日志」。
边界：只做**展示 + 确认/打开日志**，不做迁移重试、不做错误诊断。受控 modal——show 状态由
caller（AppShell）管。

## Props
- errors: Array<{ id: string; message: string; stack?: string }>
- onConfirm: () => void
- onOpenLogDir: () => void

## 状态 / 交互
- 多错聚合一条：「N 个迁移失败，详情见日志」+ 可展开列表（默认折叠，点「查看详情」展开 id+message 列表）
- 主按钮「确定」(onConfirm) + 次按钮「打开日志目录」(onOpenLogDir)
  - **当前实现状态（follow-up）**：`app-shell.tsx` 的 onOpenLogDir 暂为 noop——`shell:openPath` IPC 已就绪（package_structure §4.4），但 renderer 拿不到 DATA_DIR/logs 绝对路径（packaged 下由 runtime-config 注入主进程 env，不暴露给 renderer）；待后续加 logsDir 解析通道（main 侧解析 DATA_DIR/logs）补全。
- 走 createPortal（`<Portal>` 包到 overlay-root）——避 pointer-events 祖先链坑（modal 在 none 链里不可交互）
- 固定遮罩 + 居中 card；点遮罩不关闭（强制用户点「确定」确认）

## 复用关系
- 组合：`Portal`（lib/portal.tsx，createPortal wrapper）
- 被谁用：`app-shell`（启动 useEffect 拉取 errors 后条件渲染）
