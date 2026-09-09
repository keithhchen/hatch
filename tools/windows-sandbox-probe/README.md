# Windows restricted identity probe（独立 opt-in 实验）

不进入 Hatch 产品、Mac release 或安装路径，不是产品 UAT。本工作树以专用低权限账户 + restricted token 替换 AppContainer/LPAC 启动模型；旧兼容性证据留在 Git 历史及 evidence*/，不提供旧模式或 host fallback。

## 已读上游与复用边界

固定上游 OpenAI Codex SHA `20f109eadb9b45360e6ca4f1dee2e82c83a48f7a`：
https://github.com/openai/codex/tree/20f109eadb9b45360e6ca4f1dee2e82c83a48f7a/codex-rs/windows-sandbox-rs

已读 token.rs、identity.rs、env.rs、process.rs、desktop.rs，以及 LICENSE/NOTICE。
Apache-2.0 原文保存在 LICENSE-CODEX；相关 attribution 和本地修改说明在 NOTICE / restricted.rs。
没有搬入 Codex workspace 或建立第二个产品 runner。

**WRITE_RESTRICTED 不限制读取。** Codex elevated 路径依靠专用账户与读 ACL；
unelevated 当前用户派生 token 不能满足宿主凭据/internal DB 读隔离。
本实验拒绝宿主同 SID、管理员组成员身份（含 deny-only membership），无专用身份即失败。
读隔离依赖测试账户实际 ACL，不能把 CreateRestrictedToken 或 Job Object 当作完整权限证明。

## 单一执行入口

固定脚本 -> windows.rs::launch -> CreateProcessAsUserW（挂起）
-> AssignProcessToJobObject -> 核对实际 child TokenUser / restricted capability
-> ResumeThread -> 有界等待 -> TerminateJobObject -> QueryInformationJobObject 确认 ActiveProcesses=0。

- 只继承 stdin/stdout/stderr 三个显式句柄；无通用命令服务。
- 白名单完整重建环境，不继承宿主 PATH、账户密码、云凭据或 NODE_OPTIONS。
- 独立 desktop 的 ACL 只属于新创建对象，不改 Winsta0/Default 或系统 ACL。
- runtime 仅复制；grant 的目标限定随机新建 temp 根及后代，并拒绝已存在 reparse point。
- runtime/scripts/attachments 给测试账户读执行；workspace/scratch 给测试身份/能力 SID 读写。
- 程序不创建/删除账户，不调用 LoadUserProfile，不创建 AppContainer profile。
- 正常结束关闭 desktop、token、Job、文件句柄并删除本次 temp；失败明确记录。
- temp 路径检查不是 race-proof handle-based 防线；只运行固定脚本/可信随包 runtime。
- 文件日志无磁盘配额；runner 必须设置全局 timeout，且是无真实凭据的数据隔离实验环境。

## Windows 运行（需要预置测试身份）

```powershell
cargo test --locked --manifest-path tools/windows-sandbox-probe/Cargo.toml
cargo build --locked --release --manifest-path tools/windows-sandbox-probe/Cargo.toml
# HATCH_PROBE_PASSWORD 由隔离测试协调器提供，不写 argv/日志/仓库。
.\tools\windows-sandbox-probe\target\release\hatch-windows-sandbox-probe.exe --opt-in --runtime-root C:\test-inputs\runtime --identity-user HatchProbe_test --timeout-seconds 180
```

身份必须是本地非管理员 HatchProbe_* 账户，且不同于宿主。
LogonUserW / CreateProcessAsUserW / private desktop 不可用时直接失败；
不为跑通而修改机器特权、扩大用户 ACL、改系统策略或回退其他启动方式。

隔离分支 workflow 只在 GitHub-hosted Windows runner 执行 scripts/run-ci.ps1：
显式创建随机测试账户，在 finally 按该新账户精确 SID 清理其进程/profile/账户；
不改真实用户目录 ACL，不使用生产 secrets，checkout 不保留凭据。
账户清理失败使 CI 失败。runner 强杀时 finally 不保证执行，只能依靠一次性 VM 销毁，
禁止把该脚本用于 self-hosted 或工作站。

## 验证与仍未完成的条件

- Node / PowerShell / Python 验证环境凭据 key 不存在，workspace 可读写，附件/runtime 只读。
- synthetic secret.txt 与 internal.db 必须真实权限拒绝，Python 后代重复验证同样边界。
- 保留真实 bundled openpyxl / LibreOffice 转换、缓存重算及负向输出测试。
- 不读取任何真实宿主凭据或 internal DB。
- 通过全部合成检查仍不证明 Windows 产品隔离完成：
  任意凭据位置/宽 ACL 文件、registry/COM/IPC、网络策略、宿主进程内存、
  reparse/hardlink 竞态、专用账户安装卸载及崩溃恢复均需独立验收。
- 现有 local-runner 产品入口未修改；未来只在其 Windows platform::execute 接入经验证的 launcher，
  不增加第二套 runner/authority，未验证时 fail-closed。

本轮只做已有缓存的增量 cross-target check、轻量 unit/static 检查；不构建 Desktop/runtime。
**本次源码尚未 push，因此没有此版真实 Windows CI 执行证据。**
远端手动 workflow 只 checkout ref，不接收本地 patch。不得拿旧 SHA 的 dispatch 结果冒充本次验证。
