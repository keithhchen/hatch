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

