# ET case: 预览区显隐联动（收起 → chat/工作区扩展 → 展开 → 压缩让位）

> case_id: file_preview_ec10
> 来源: PRD §6 EC-10（UC-8 覆盖）+ test-plan §4 EC-10
> 前置: v0.0.320 三栏动态布局已编码完成（Task 2 D1/D2/D3），dev 环境已启动

## 前置条件
- dev app 已启动，进入有 workspace 的 chat 页（playground 或 studio 单聊，三栏布局）
- 预览区已展开（有 tab 或空态占位均可）

## 操作目标

1. 确认三栏初始布局：chat（左）| 预览区（中）| 工作区（右），预览区展开
2. 记录初始宽度：chat 宽 / 预览区宽 / 工作区宽（可从 DOM 测量或 snapshot 参考）
3. **收起预览区**：点预览区 header 的显示/隐藏控制（chevron）→ 断言：
   - 预览区收起/隐藏（展开态 → 36px 窄栏 rail 或完全隐藏）
   - **chat + 工作区自动扩展回收**（两侧宽度增大，回收预览区让出的空间）
4. **再点展开控制**（rail 上 chevron）→ 断言：
   - 预览区恢复展开（回到 36px rail → 全宽）
   - **chat + 工作区自动压缩让位**（回到接近初始宽度）
5. 断言显隐联动：两侧宽度随预览区显隐自动调整（非固定 flex 死区）
6. 截图留证：三栏展开态 + 收起后（rail + 两侧扩展）+ 再展开（两侧压缩让位）

## 判定
- pass: 预览区收起 → chat/工作区扩展回收；展开 → 压缩让位，显隐联动正常
- small: 联动正常但宽度过渡有视觉小瑕疵（无跳动/无死区）
- blocking: 收起后 chat/工作区不扩展 / 展开后不压缩 / 收起控制缺失 / 展开控制缺失

## 备注
- 三栏动态布局（PRD §2.1 D1）：预览区 toggle 出现/消失，两侧宽度随显隐联动调整
- 收起态 = 36px rail（与 ws-rail 同款 chevron 展开按钮，D3）
- 宽度 + 收起态 localStorage per session 持久化（`pv-width-<sid>` + `pv-collapsed-<sid>`）
- 预览区无 tab 时空态占位「打开文件以预览」（栏不消失，布局稳定，PRD §2.1）
