# Desktop UI Construction v1 验收矩阵

日期：2026-08-11  
分支：`codex/desktop-ui-construction`  
结论：P0–P3 的实现基础已落地；P4 仍需要 Windows 真机、签名发布包和完整桌面回归环境。

状态定义：

- **PASS（本机）**：当前 worktree 有自动化测试或 macOS UAT 证据。
- **PARTIAL**：实现已存在，但仍缺少某个目标环境或真实生命周期证据。
- **EXTERNAL**：需要 Windows、VoiceOver/Narrator、签名身份、IME/DPI 或多显示器环境。
- **DEFERRED**：明确留在后续平台集成，不得在产品 UI 中显示为已工作的占位动作。

| 契约 | 状态 | 当前证据 | 尚未证明的部分 |
| --- | --- | --- | --- |
| Dev/debug/ad-hoc session 不触发 Keychain 解锁 | PASS（本机） | ad-hoc `.app` 启动进入普通 Sign in；无 Login Keychain prompt；Rust 认证测试 | 正式 Developer ID 包的重启读取需签名环境 |
| 正式 macOS secure session identity gate | PARTIAL | production flag `cargo check`；Team ID、bundle ID、Developer ID requirement 检查；release workflow | 真实 Developer ID + notarization + clean-account restart UAT |
| Windows persistent session | EXTERNAL / BLOCKED BY THREAT MODEL | Win32 Generic Credential Manager 与 PasswordVault 路径均 fail-closed；同用户 full-trust 进程可读 PasswordVault 的官方限制已记录 | 另立 device-bound session backend、Windows 签名/UAT 与 same-user 负测；不能用 MSIX/AppContainer PasswordVault 直接解锁 |
| Workspace / approval authority 在 Rust | PASS（本机） | grant-bound picker/drop、canonical containment、pending approval state；Approval 同时保留 transcript inline card 与 composer 上方 persistent action；Rust 44 tests | Windows runner 的编译和真实 junction/ACL UAT |
| Regular / compact / minimal layout tier | PASS（macOS UAT） | `regular-1180x780`、`compact-860x600`、`minimal-640x600`；preview accessibility tree | 多显示器和 Windows 尺寸行为 |
| Inspector 先折叠，Sidebar 不堆到主内容上方 | PASS（macOS UAT） | compact/minimal captures；tier controller tests | Windows DPI/resize 真机循环 |
| Pane divider pointer/keyboard/double-click | PASS（本机） | renderer tests、ARIA splitter implementation | VoiceOver/Narrator 朗读与真实系统输入 |
| Toolbar / composer overflow 与 Native `…` 菜单 | PASS（本机 + macOS UAT） | semantic registry、`show_native_command_menu`、View menu UAT；fresh preview 已验证 `Hide Sidebar` → pane state → 下一次菜单 `Show Sidebar` 的完整闭环 | Windows menu metrics 与高 DPI popup 定位 |
| Table/code/diff/log 局部 overflow | PASS（macOS UAT + 本机） | wrapper CSS、renderer tests/build；`zoom-80-1180x780.jpeg`、`zoom-150-1180x780.jpeg`、`zoom-200-table-overflow-1180x780.jpeg`；200% 截图显示 table 自己横向滚动且 composer 固定 | Windows 80%/150%/200% 与高 DPI 视觉回归 |
| 每窗口 Conversation、Workspace、draft、zoom、scroll、cursor 独立保存 | PARTIAL | native settings schema、account-scoped window context、profile field patch（避免整份 JSON last-writer-wins）、renderer/native tests；macOS uniquely named preview UAT 实际创建主窗口 + 两个不同 `conv_preview_*` conversation windows；`conversation-windows.json` 原子 manifest 在 Cmd-Q 后保留，下一次启动恢复 conversation window，关闭前窗后其余窗口仍存活并从 manifest 移除；Rust 三窗口关闭中间窗口回归测试 | crash/reload 时 renderer 与云端 hydration 的真实账户 E2E；三个并行窗口的真实 bounds/scroll/draft 全量验收 |
| Conversation Library 与 server-issued IDs | PASS（本机） | Runtime REST/WS tests（含同一 Account 的 Agent A 三会话与 Agent B 两会话层级/跨 Agent 拒绝）、renderer client tests；不再以 timestamp 作为新 ID | 端到端真实账户与真实桌面窗口的 A/B agent 五会话验收 |
| Durable Run、幂等 message、observer recovery | PASS（本机） | Runtime 226 tests；断连/启动标为 `interrupted`，不重放 tool | 桌面应用 crash/reload 的真实 attach/replay UAT |
| Native application/context menu 与 focused-window routing | PASS（macOS UAT） | View menu、context registry、window lifecycle tests；重打包 preview 的 conversation-row secondary click AX tree 为 Rename/Open/Archive，且不含 `WKMenuItemIdentifierInspectElement`；Tauri `devtools:false`；preview 的 New window 使用真实 Tauri dynamic window command | Windows native popup 和多窗口焦点 UAT |
| Conversation rename 与文件拖拽上下文 | PASS（本机代码 + tests） | Rename 使用侧栏 inline editor（Enter/Escape），不再调用 `window.prompt`；native drop 只传 window-scoped opaque handle，Rust 在 drop gesture 做 immutable bounded UTF-8 projection；wire protocol 0.7 传结构化 attachments，Runtime 做 hash/size/idempotency 校验；Renderer 21 files / 92 tests、Rust drop-context tests | macOS/Windows Finder/Explorer 真实拖放、IME 与大型/二进制文件人工验收 |
| Finder/Explorer Reveal 与 window attention | PASS（代码 + macOS bridge） | grant-bound reveal、attention command；artifact opener 复用同一 Rust containment gate | Windows Explorer 和 Dock/taskbar 真机行为 |
| Settings/About auxiliary windows | PASS（macOS UAT） | 独立 native auxiliary windows 与 accessibility tree | Windows owner/focus/close parity |
| Quick Look / Windows Open | PARTIAL | `artifact.quickLook` semantic command、native artifact popup、Rust grant-bound `open_workspace_artifact`；macOS UAT AX tree 显示 `Quick Look`，Windows 使用 `ShellExecuteW(open)` | macOS valid-grant Quick Look 实际打开、Windows 编译/Explorer/UAT、Linux `xdg-open` fallback |
| Desktop-native visual review | PASS（macOS preview） | Native traffic lights/title chrome、离散 regular/compact/minimal 状态、overlay pane、native overflow/context menu、局部 table/code scroll；详见 [visual review](README.md#desktop-native-visual-review) | Windows caption/menu metrics、DPI/Snap、VoiceOver/Narrator 与真实 Finder/Explorer UAT |
| VoiceOver / Narrator、IME、drag/drop、fullscreen、Snap、DPI | EXTERNAL | ARIA/focus contract、CI Windows job、macOS manual tree evidence | 真实目标平台人工验收 |
| Web build、Tauri app build、DMG、Rust、Runtime、LocalRunner | PASS（本机） | Renderer 92、Rust 44+1 ignored、Runtime 226、LocalRunner 43；`build:web`、`build:app`、`build` 的 strict ad-hoc DMG 校验 | CI runner 与发布签名链路 |

## 运行证据

在独立 runtime 数据目录下执行：

```text
desktop-app: npm run test:renderer
desktop-app: npm run build:web
desktop-app/src-tauri: cargo fmt -- --check && cargo test --locked --lib
runtime-server: HATCH_RUNTIME_DATA_DIR=$(mktemp -d) npm test
local-runner: cargo test
desktop-app: npm run build:app
desktop-app: npm run build  # strict ad-hoc DMG UAT
```

`npm run build:app` 与 `npm run build` 产物是 ad-hoc/UAT `.app`/DMG，当前验证的 DMG 为
`Hatch_0.1.0_aarch64.dmg`（`sha256:e9253e220afa8a8955d0d9cf0c9242ea7f22a6cca5dd5500142fdd5c96937a05`，15,243,065 bytes）。它们不是可发布的 notarized artifact。正式发布必须在 CI 注入真实 Developer ID/Team ID，并完成签名、notarization、安装后重启和无 prompt 验收。

本机另外尝试了 `x86_64-pc-windows-gnu` 交叉 `cargo check`，并生成并提交了
Windows Tauri capability schema；检查在 Tauri 的 `tauri-winres` 阶段因本机没有
`x86_64-w64-mingw32-windres` 停止，因此没有把它计为 Windows 编译或 UAT 通过。
