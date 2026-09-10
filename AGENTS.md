# 项目环境与调试授权

- 用户要求测试插件在不同文献网址上的表现；发现代码问题时可以修复、构建并重载验证。
- Obsidian 实际库目录为 `D:\Work\Zhefeng_Lou`（通过 Obsidian CLI 确认），允许读取该库。
- 允许将插件构建文件部署到 `D:\Work\Zhefeng_Lou\.obsidian\plugins\obsidian-ai-rss-reader`。覆盖前备份已有构建文件，保留用户设置。
- 允许读写 `D:\Work\Zhefeng_Lou\AI RSS Reader`，测试时避免覆盖已有笔记。
- 用户明确允许将现有 Obsidian 浏览器 Cookie 用于不同文献的下载测试，包括配置的 SUTD 机构代理。仅向对应站点发送适用 Cookie，不打印或保存 Cookie、登录票据或其他凭据。
- 用户明确需要更新代码功能后需要修改README.md 对应部分，以及功能对应的tests。
- Obsidian CLI 命令为 `obsidian`，目标库名称为 `Zhefeng_Lou`；应用必须已启动。
- 当前 Obsidian 进程与默认沙箱权限级别不同。在沙箱内运行可能误报 `The CLI is unable to find Obsidian`；应使用沙箱外执行（`require_escalated`），可申请复用前缀规则 `["obsidian"]`。用户已明确允许 Obsidian CLI 相关命令跳出沙箱。