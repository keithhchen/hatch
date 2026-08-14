# Hatch development rules

## Real product paths only

- 不得用 fixture、mock、static preview、demo state 或硬编码数据替代产品实现，并将其呈现为真实功能、产品构建或 UAT 结果。
- UI 开发和验收必须走真实产品入口与真实集成链路：authentication、entitlement、Agent、Conversation、Runtime、native bridge 和持久化。缺少真实依赖或账号时，应明确标记为未验收；不得用假数据制造“已完成”的证据。
- Fixture 只允许存在于自动化测试、Storybook/component playground 或明确标注的开发工具中。它不得通过产品入口的环境变量或隐藏分支进入可交付 app，也不得被用于证明端到端产品行为。
- Preview、test harness 和实验性 app 必须使用独立名称、bundle identifier、输出目录和可见标识；绝不能覆盖或复用正式 `Hatch.app`、正式 bundle identifier、正式数据目录或正式凭据。
- 不得为了截图或通过验收而实现无事件处理、无后端连接或无状态联动的假控件。按钮、菜单、键盘操作、Agent/Conversation 层级和窗口行为必须连接真实 command/state；否则应保持未实现并明确说明。
- 验收记录必须区分 unit/component test、fixture visual check、真实集成测试和真实 OS UAT。只有真实产品构建上的实际行为可以作为产品 UAT 证据。
- 发现当前运行的是 preview/fixture/test bundle 时，应立即停止验收，关闭该进程，重新构建并启动真实产品；不得继续在错误产物上修补视觉或宣称功能结果。
- 禁止静默 fallback 到 mock、fixture、local fake ID 或伪造成功状态。真实服务不可用时，产品应显示真实的 unavailable/error 状态，开发记录应如实报告 blocker。

## Desktop release completion

- `master` push、Hatch CI 通过和 application CD 成功都不等于 Desktop 已发布。只有版本源一致、完整 CI 通过、annotated SemVer tag 已推送、GitHub Release 已发布且标为 Latest、macOS DMG 与 Windows EXE 均存在并可下载时，才能说“有新的 Desktop release”。
- Desktop tag 必须与 `package.json`、`package-lock.json`、`Cargo.toml`、`Cargo.lock`、`tauri.conf.json`、About UI 和 Runtime `client_version` 完全一致。不得移动或复用已推送的 tag；失败后需要不同源码时必须升下一个版本。
- Release artifact 必须用随包 evidence 核验 source SHA、filename、bytes 与 SHA-256。只允许发布与 tag commit 完全一致的产物；不得用另一次 run 或本地产物补位。
- GitHub Actions 中没有 checkout 的 job 不得依赖 git 自动推断 repository；所有 `gh release`/`gh api` 写操作必须显式提供 `--repo` 或 `GH_REPO`。发布后必须反查 Release assets 与 `/releases/latest`。
- ad-hoc macOS、unsigned Windows、fixture 或 automated UAT package 必须明确标为对应层级；没有签名、notarization 和真实目标设备 UAT 时，不得描述为 signed production distribution。

## Product cutovers

- FAST FORWARD, KEEP AHEAD：一旦产品原则或 identity/source-of-truth 设计明确替换旧模型，代码、数据、路由、测试和文档都直接切到新模型。不得为了保留错误抽象而维持双写、fallback、隐藏兼容路由或第二份 authority；只有不可重写的历史事实允许在明确的 read-time migration boundary 被读取。
