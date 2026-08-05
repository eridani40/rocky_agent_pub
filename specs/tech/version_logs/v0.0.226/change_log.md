# v0.0.226 change_log
## 变更
- render action waitUntil 'load'→'domcontentloaded'（修持续加载页 headless 超时；ixdzs8 实证 load 20s+ 超时、domcontentloaded 1.5s）
- web_fetch 加 render?:boolean 参数（强制 headless，跳过静态直起渲染；LLM 对已知 JS 页/静态内容不全时强制渲染）
## spec 同步
web_fetch_tool.md §2/§3.3/§3.4/§6.5 + browser_tool.md（概念先行编码期落）
## 验证
typecheck PASS + 64 test 全绿 + code review PASSED
