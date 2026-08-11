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
| Dev/debug/ad-hoc session 不触发 Keychain 解锁 | PASS（本机） | 最新重建 ad-hoc `.app` 冷启动（10:10 macOS UAT）进入普通 Sign in；Computer Use AX tree/截图均无 Login Keychain prompt；Rust 认证测试 | 正式 Developer ID 包的重启读取需签名环境 |
| 正式 macOS secure session identity gate | PARTIAL | production flag `cargo check`；Team ID、bundle ID、Developer ID requirement 检查；`desktop-release.yml` 现在要求 source SHA、Developer ID/notarization、不可变 DMG manifest/hash 和受保护 target UAT 后才可 publish | 真实 Developer ID + notarization + clean-account restart UAT 与 required-reviewer 记录 |
| Windows persistent session | EXTERNAL / BLOCKED BY THREAT MODEL | Win32 Generic Credential Manager 与 PasswordVault 路径均 fail-closed；同用户 full-trust 进程可读 PasswordVault 的官方限制已记录 | 另立 device-bound session backend、Windows 签名/UAT 与 same-user 负测；不能用 MSIX/AppContainer PasswordVault 直接解锁 |
| Workspace / approval authority 在 Rust | PASS（本机） | grant-bound picker/drop、canonical containment、pending approval state；Approval 同时保留 transcript inline card 与 composer 上方 persistent action；Rust 46 tests | Windows runner 的编译和真实 junction/ACL UAT |
| Regular / compact / minimal layout tier | PARTIAL | container-query/style contract 和 tier controller tests；旧截图只作历史视觉参考 | 真实产品窗口的 macOS/Windows resize、全屏与多显示器 UAT |
| Inspector 先折叠，Sidebar 不堆到主内容上方 | PARTIAL | tier controller tests 与 shell CSS contract | 真实产品窗口的 macOS/Windows DPI/resize 真机循环 |
| Pane divider pointer/keyboard/double-click | PASS（本机） | renderer tests、ARIA splitter implementation | VoiceOver/Narrator 朗读与真实系统输入 |
| Toolbar / composer overflow 与 Native `…` 菜单 | PARTIAL | semantic registry、`show_native_command_menu`、renderer/Rust tests；compact composer contract 明确让 Workspace 与 Permission 常驻，只将 attachment 放入 overflow | 真实产品的 native popup、focus return、macOS/Windows menu metrics 与高 DPI 定位 |
| Table/code/diff/log 局部 overflow | PARTIAL | wrapper CSS、renderer tests/build；旧 zoom 截图仅作历史视觉参考 | 真实产品的 macOS/Windows 80%/150%/200%、高 DPI 与超宽内容视觉回归 |
| 每窗口 Conversation、Workspace、Agent binding、draft、zoom、scroll、cursor 独立保存 | PARTIAL | native settings schema、account-scoped window context、profile field patch（避免整份 JSON last-writer-wins）、secondary window route 的 non-secret entitlement/creator/agent binding 精确匹配与旧 manifest context fallback、renderer/native tests；`clear_auth_token` 只广播不含 secret 的 remote-session-cleared event，其他窗口回到 Sign in；Rust 三窗口关闭中间窗口回归测试 | 真实账户下三个并行 cloud Conversation 窗口的 bounds、draft、Workspace、zoom、scroll、crash/reload 与 hydration 全量 UAT |
| Conversation Library、server-issued IDs 与 per-window Agent binding | PARTIAL / PRODUCTION BLOCKED | Runtime REST/WS tests（含同一 Account 的 Agent A 三会话与 Agent B 两会话层级/跨 Agent 拒绝）、renderer client tests；不再以 timestamp 作为新 ID；跨 Agent restore 只接受 server-issued ID；真实 production UAT 登录后加载出 Maya/Seth 两个 Agent 并可切换 | 2026-08-11 对两个真实 binding 请求 production `GET /v1/conversations` 均返回 HTTP 404 `Route not found`；须部署含 P2 API 的 Runtime 后完成真实 Conversation/Send/Enter/context-menu/多窗口 E2E |
| Durable Run、幂等 message、observer recovery | PASS（本机） | Runtime 226 tests；断连/启动标为 `interrupted`，不重放 tool | 桌面应用 crash/reload 的真实 attach/replay UAT |
| Native application/context menu 与 focused-window routing | PARTIAL | semantic registry、context/window lifecycle tests、Tauri `devtools:false`；renderer 使用 native context bridge 而非 HTML 假菜单 | 真实登录产品中的 macOS/Windows secondary-click、focused multi-window routing 与 popup UAT |
| Conversation rename 与文件拖拽上下文 | PASS（本机代码 + tests） | Rename 使用侧栏 inline editor（Enter/Escape），不再调用 `window.prompt`；native drop 只传 window-scoped opaque handle，Rust 在 drop gesture 做 immutable bounded UTF-8 projection；wire protocol 0.7 传结构化 attachments，Runtime 做 hash/size/idempotency 校验；Renderer 24 files / 119 tests、snapshot journal reconciliation tests、Rust drop-context tests | macOS/Windows Finder/Explorer 真实拖放、IME 与大型/二进制文件人工验收 |
| Finder/Explorer Reveal 与 window attention | PASS（代码 + macOS bridge） | grant-bound reveal、attention command；artifact opener 复用同一 Rust containment gate | Windows Explorer 和 Dock/taskbar 真机行为 |
| Settings/About auxiliary windows | PASS（macOS UAT） | 独立 native auxiliary windows 与 accessibility tree；最新 ad-hoc 冷启动实际打开 `Hatch Settings` 窗口并检查其 AX tree | Windows owner/focus/close parity |
| Quick Look / Windows Open | PARTIAL | `artifact.quickLook` semantic command、native artifact popup、Rust grant-bound `open_workspace_artifact`；macOS `QLPreviewPanel` 与 Windows `ShellExecuteW(open)` 实现/测试 | 真实登录 + 有效 grant 的 macOS/Windows Finder/Explorer UAT；旧 fixture capture 不作产品证据 |
| Desktop-native visual review | PARTIAL | Native traffic lights/title chrome、离散 tier、overlay pane 与局部 overflow 的实现/自动测试；旧 captures 仅作历史视觉参考 | 真实产品构建的 macOS/Windows caption/menu、DPI/Snap、VoiceOver/Narrator 与 Finder/Explorer UAT |
| VoiceOver / Narrator、IME、drag/drop、fullscreen、Snap、DPI | EXTERNAL | ARIA/focus contract、CI Windows job、macOS manual tree evidence | 真实目标平台人工验收 |
| macOS / Windows 自动 UAT 候选包与证据记录 | PARTIAL（CI 配置） | PR、`master` 与手动 CI 都构建 ad-hoc macOS `.app`→DMG / unsigned Windows NSIS，并上传 package SHA-256、source SHA、runner 与 `HATCH_PERSISTENT_SESSION=0` 的 JSON evidence；另有受保护 self-hosted target-UAT skeleton 复核同一 source/hash 后采集安装、冷启动、截图与日志；详见 [automated CI UAT](automated-ci-uat.md) | 下载后的同一不可变包仍须在真实目标设备安装、启动和完成人工 P4；CI 不能代替 VoiceOver/Narrator、IME、Explorer/Finder、Snap/DPI 或签名发布验收 |
| Signed/notarized release package identity 与 publication gate | PARTIAL（受保护 workflow contract） | `record-desktop-release-artifact.mjs` 在 notarization/staple 后记录 source SHA、workflow run ID、tag、DMG bytes/SHA-256、signed/persistent-session contract 及 signing identity/Team ID/bundle ID；target job 用 default-branch verifier 复核同一 artifact、run identity 与 codesign provenance；publish job 在 post-UAT `desktop-release-publish` approval 后才允许 attach；详见 [release UAT contract](release-uat-contract.md) | GitHub Developer ID/notary secrets、`desktop-release-uat` runner approval、`desktop-release-publish` evidence reviewer、真实 interactive macOS runner、clean-account Keychain restart 与完整视觉/Workspace smoke 尚未在本机证明 |
| Web build、Tauri app build、DMG、Rust、Runtime、LocalRunner | PASS（本机；Windows 仅有记录过的 cross-check） | Renderer 119、Rust 46+1 ignored、Runtime 226、LocalRunner 43；`build:web`、真实产品入口的 `build:app`、`build` strict ad-hoc DMG 校验；Windows cross-check 曾在带 LLVM-RC/clang 的 toolchain 中通过 | 当前 macOS host 缺 `x86_64-w64-mingw32-windres`，无法重跑该 cross-check；CI runner 与发布签名链路、Windows installer、真实 Explorer/IME/DPI/Snap/Narrator UAT 仍未证明 |

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
`Hatch_0.1.0_aarch64.dmg`（`sha256:05c52e6123f68b9e9e561ac2fb012088fb71ed2960cd21d129fac6a66c71439f`，15,261,360 bytes）。它们不是可发布的 notarized artifact。正式发布必须在 CI 注入真实 Developer ID/Team ID，并完成签名、notarization、安装后重启和无 prompt 验收。

本机先用默认 Homebrew `cargo` 尝试 `x86_64-pc-windows-gnu`，因 host/toolchain
混用而在 `core/std` 处得到 `E0463`；随后显式指定 rustup 的 `RUSTC/RUSTDOC`，并
用 Homebrew `llvm-rc` + `clang --target=x86_64-pc-windows-gnu` 为 resource
preprocess，`cargo check --locked --target x86_64-pc-windows-gnu --lib` 已通过。
这只是 Rust library cross-check，不是 Windows app/installer build；本机仍没有
Windows SDK、真实 Explorer/IME/DPI/Snap/Narrator 环境，因此必须由 Windows
CI/真机重新编译和验收。
