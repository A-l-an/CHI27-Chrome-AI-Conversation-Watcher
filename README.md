# CHI27 Chrome AI Conversation Watcher

Chrome 0.2.9 源码仓库。扩展观察 ChatGPT/Claude 网页端的对话切换、回答完成、通知点击与返回行为，并向本机 ActivityWatch 写入不含正文的事件。回答开头最多 150 个字符只用于短暂系统通知，不进入 ActivityWatch 或常规导出。

验证与打包：`npm test`，随后运行 `npm run package` 和 `npm run verify:package`。打包器根据 `manifest.json`、HTML、CSS 与 `background.js` 的实际引用动态计算闭包，生成可复现的 `dist/*-unpacked-extension.zip`、SHA-256 sidecar 与构建 manifest；验证器默认在 checkout 模式重新推导精确运行时闭包，逐文件核对 ZIP 与仓库源文件的大小、SHA-256 和 bytes，并检查三件套名称、封闭 manifest、archive 路径安全、敏感文件 denylist 与本机绝对路径。`source_validation` 还要求 canonical origin、manifest commit 等于 checkout HEAD 且工作树干净。显式的 `--verification-mode artifact-only` 只证明产物内部合同，不声称 checkout 或 commit binding。本机默认产物标为 `local_validation`；GitHub Actions 注入 canonical repository、`github.sha` 和 `source_validation`，OS/architecture 取 runner 内置的 `RUNNER_OS`/`RUNNER_ARCH`，而 Vault 来源 commit/tree 只保留在独立 `provenance` 字段中。源码仓库故意不含生成的 `participant_config.json`；参与者编号只能由上层受控打包流程注入。

GitHub Actions 在 `windows-2025` 与 `macos-15` 上使用 Node 22/Python 3.12 运行相同验证并保留 14 天构建产物。CI 证明源码测试和打包闭包通过，不等于真实 Chrome、ActivityWatch、通知或参与者端到端已经通过。

仓库映射：canonical local root 为 `Documents/[02] Research Related/[00] Projects/[03] AttentionSwitching/[06] Study-Tooling/CHI27-Chrome-AI-Conversation-Watcher`；计划中的私有远程为 `https://github.com/A-l-an/CHI27-Chrome-AI-Conversation-Watcher`；默认分支 `main`；最后核对于 2026-08-05。

来源与支持测试的精确版本见 [SOURCE_PROVENANCE.json](SOURCE_PROVENANCE.json)，安全边界见 [SECURITY.md](SECURITY.md)，原目录说明保留在 [docs/UPSTREAM_README.md](docs/UPSTREAM_README.md)。本仓库未授予开源许可，详见 [LICENSE](LICENSE)。
