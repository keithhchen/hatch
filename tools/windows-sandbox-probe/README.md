# Windows AppContainer / LPAC compatibility probe（独立实验工具）

不进入 Hatch 产品、安装、发布或 renderer 测试路径。不是 Windows sandbox 实现，也不是产品 UAT。默认 LPAC；普通 AppContainer 必须单独显式选择，任何失败都不会回退到 host 或更宽权限。

## Windows 构建与执行

要求 Windows 10/11 x64、现有 Rust stable MSVC 工具链及 C++ Build Tools / Windows SDK、NTFS 临时目录、足够容纳**整份随包 runtime 副本**的磁盘空间。使用普通用户；不要以管理员身份掩盖兼容性问题。工具不安装 SDK、service、软件或任何系统策略。

在仓库根目录 PowerShell 执行：

```powershell
cargo build --locked --release --manifest-path tools/windows-sandbox-probe/Cargo.toml --target x86_64-pc-windows-msvc
cargo test --locked --manifest-path tools/windows-sandbox-probe/Cargo.toml --target x86_64-pc-windows-msvc
$probe = '.\tools\windows-sandbox-probe\target\x86_64-pc-windows-msvc\release\hatch-windows-sandbox-probe.exe'
# 改成已有真实 Windows 随包 runtime：包含 manifest.json、node、python、packages、native LO。
# 不接受 macOS runtime；不使用系统 Python/Node/LibreOffice 补位。
$runtime = 'C:\test-inputs\hatch-windows-runtime'
& $probe --opt-in --runtime-root $runtime --mode lpac --timeout-seconds 180 > lpac-report.json
$lpacExit = $LASTEXITCODE
& $probe --opt-in --runtime-root $runtime --mode appcontainer --timeout-seconds 180 > appcontainer-report.json
$appcontainerExit = $LASTEXITCODE
Write-Host "LPAC=$lpacExit AppContainer=$appcontainerExit"
```

不要自动忽略退出码。CI 应上传两个 JSON 和 stderr，并显式判断 `$lpacExit` / `$appcontainerExit`。两个模式是两个独立实验；AppContainer 成功不抵消 LPAC 失败。当前未添加或修改任何 CI/release workflow；后续 Windows CI/无影负责真实执行。

退出码：`0` 所有必需断言和清理通过；`1` 失败或无法判定；`2` 缺少 opt-in、参数错误、非 Windows。`--help` 不执行探针。`cargo test` 仅单元测试，不创建 sandbox profile、不改 ACL、不运行 runtime。

## 范围与可审计副作用

- `tempfile` 新建带空格/中文的随机临时根目录。原始 runtime 只读复制，不修改用户 workspace ACL、原 runtime ACL、正式 App 或凭据。
- 显式 ACL 写入函数只接受该新建根目录及其后代，拒绝 reparse point/junction 和越界路径。仅对副本设置 package SID 权限：runtime/scripts/attachments 读执行，workspace/scratch 读写执行，临时根仅 traverse，合成 secret 的 ungranted 目录不授权。RW 不授予 WRITE_DAC/WRITE_OWNER。
- 创建唯一临时 AppContainer profile（Windows 自身会管理该 profile 的目录/注册信息），结束调用 DeleteAppContainerProfile。工具不直接修改这些系统管理目录的 ACL，不更改宿主账户、权限策略或服务。
- 每个进程使用显式 SECURITY_CAPABILITIES，无额外 capability；LPAC 使用 ALL_APPLICATION_PACKAGES opt-out。挂起创建，先绑定 kill-on-close Job，再核验 AppContainer/LPAC token 与 package SID，最后恢复执行。绑定或核验失败直接终止，不启动 host 替代进程。
- 仅传递 stdin/stdout/stderr 三个显式文件句柄；这是有意的 I/O 授权，不表示目录访问授权。环境从白名单重建，不继承 host token、用户 PATH 或其他凭据环境变量。子进程使用 scratch profile/temp；不降低 PowerShell execution policy，若策略拒绝则报告失败。
- 每次启动超时受限；进程结束/超时均终止 Job 中剩余子进程。读取输出最多每流 64 KiB（固定探针不是任意命令服务；日志文件本身没有磁盘配额）。正常结束删除 profile 和整个临时目录，清理失败使总体失败，JSON 保留待清理路径/profile 名。强杀工具/断电可能残留；人工只处理报告中精确的 `Hatch.Probe.*` profile 和本次随机目录，不递归清理用户 TEMP 根。

## 真实断言和局限

PowerShell（OS 原生 WindowsPowerShell）、manifest 指定的 bundled Node/Python 分别运行固定脚本，验证 workspace 实际读写、附件/runtime 读取、只读目录写拒绝、ungranted 合成文件读写必须返回权限拒绝（不存在不算）。host 二次核验 marker 和 canary。没有读取真实宿主凭据。

Python 使用 bundled openpyxl 创建 xlsx，再在同一 sandbox/Job 中调用 manifest 指定的 bundled `soffice.com`，断言 `A3 = A2+8`、重算缓存 `50`、公式保留、源文件 SHA-256 不变。随后 host 仅把刚生成的合法输入复制到**本次临时** ungranted 目录，执行 LO 未授权输入与只读输出负向转换。明确 access-denied 诊断且无输出才算通过；只有泛化转换错误则标 `inconclusive`，总体非零。LO 子进程沿用 Python token/Job；报告的 pre-resume token 证据针对直接启动的 PowerShell/Node/Python，不冒称独立核验了每个 LO 后代 token。

JSON 记录 runtime manifest 和执行文件 SHA-256、命令参数、token 证据、退出码、超时、脚本检查、截断日志、host 检查、清理结果。任何包无法加载、LPAC 不支持、ACL 无法设置或转换失败都保留真实错误。

这些是**合成临时目录兼容性/边界探针**，不证明任意用户目录/凭据、网络、注册表、COM、重解析点竞态或跨会话隔离已全面安全。普通 AppContainer 仍有 ALL APPLICATION PACKAGES 的系统授权；LPAC 也有 OS 固有访问范围。没有为“跑通”添加宽 capability。未来产品接入仍需独立 threat model、Windows 真机证据及 native enforcement 审查。

## 当前 Mac 可执行的开发检查

已有 rustup Windows GNU std 时（不安装大环境）：

```sh
RUSTC=/Users/keithchen/.rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc \
 /Users/keithchen/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo check \
 --locked --offline --manifest-path tools/windows-sandbox-probe/Cargo.toml \
 --target x86_64-pc-windows-gnu --all-targets
cargo test --locked --offline --manifest-path tools/windows-sandbox-probe/Cargo.toml
```

交叉 `check` 只证明 Windows cfg/API 类型检查，不产出已链接 Windows EXE，不执行 Windows 测试。没有 Windows linker/SDK 时不宣称 Windows build 或运行通过。Mac 的 opt-in 执行必须明确 unsupported/exit 2，不能制造成功证据。

本次本地实测：上述 Windows GNU `check --all-targets` exit 0；Mac `cargo test` 2 passed；Node `--check`、Python `ast.parse` 通过；未 opt-in 和非 Windows opt-in 均 exit 2。使用同一 RUSTC/cargo 将 `check --all-targets` 换成 `build` 实测 exit 101，缺少 `x86_64-w64-mingw32-dlltool`。未安装工具链补件。两个 Windows-only 路径守卫单元测试只完成交叉类型检查，PowerShell 语法/实际运行、Windows EXE 链接、AppContainer/LPAC token/ACL 与四类程序的真实执行均尚未验收。

## Windows CI 实测更新（2026-09-09）

- Run `34330729284`（`846d5537`）与 `34331451942`（`ffb595b8`）已在 Windows 上完成原生编译、链接、单元测试和真实 bundled runtime 准备；两次兼容性实验均失败。
- 第二次诊断明确失败在 `GetTokenInformation(class=46)`，即 `TokenIsLessPrivilegedAppContainer` 查询，错误为 Win32 87。PowerShell、Node、Python 在 resume 前就被阻止，不能据此判断这些工具或 LibreOffice 不兼容。
- 两种模式的临时目录及 AppContainer profile 均已清理。CI 宿主为 elevated，不能作为普通用户 Desktop UAT。
- `beacd9a7` 改用 [Chromium CheckLpacToken](https://github.com/chromium/chromium/blob/main/sandbox/win/src/app_container_test.cc) 的有效权限验证思路：在合成安全描述符上执行 `AccessCheck`，同时验证 AppContainer 身份和 profile SID。验证失败仍禁止 resume，无未隔离执行 fallback。
- Run `34331827963` 的新实现已通过 Windows 原生构建和实际 token 验证：LPAC access mask 为 2，普通 AppContainer 为 3，profile SID 匹配。总体兼容性实验仍失败。
- LPAC：PowerShell 无法读取系统 PowerShell 注册表项；Node 在 WSAStartup 返回 10107；Python 进程以 `0xc0000022` 退出，尚未运行检查脚本。不能通过放开整个宿主权限绕过。
- 普通 AppContainer：Python 成功读写 workspace，读取附件/runtime，并拒绝附件/runtime 写入及 ungranted 文件读写；LibreOffice 实际转换 60 秒超时。PowerShell 报 workspace 路径访问拒绝；Node 在加载主脚本时 `lstat C:\\` 返回 EPERM。只读输出不存在不等于 LO 权限拒绝已经验证。
- 这些结果把后续调查定位到进程启动、路径解析及系统依赖访问，不是文档 skill 缺失。合成边界局部通过不证明 Windows 产品隔离完成。上述改动只属于独立实验，不包含在 Desktop `v0.1.30` 中。
