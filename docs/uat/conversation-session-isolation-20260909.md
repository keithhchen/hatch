# Conversation session 隔离验证（2026-09-09）

## 问题与证据边界

0.1.29 的生产记录显示，用户报告的连续交流实际落在两个 Conversation 中。未修改、合并或迁移这些用户记录。

代码调度复现发现：切换对话等待本地设置期间，旧 Conversation 可以重新连接；旧版本连接匹配只检查 Agent entitlement，不检查 Conversation，随后可能出现显示历史与提交目标不一致。这证明存在可触发的竞态，不证明用户当时一定经历了该具体调度。

## 设计边界

- Window 仅选择视图；Session 按 account、entitlement、conversation 身份独立持有连接、运行、历史、草稿及 UI state。
- 异步消息和工具回调使用所属 Session，不读取窗口当前选中的 Conversation 作为执行目标。
- Native 工具上下文按 window、conversation、run 注册；执行、审批、取消及结果读取使用不透明 context ID。
- 切换不关闭后台 Session；退出登录和关闭窗口才统一清理。
- 不增加新消息提示，不通过清空历史掩盖归属错误。

## 当前自动化证据（未发布工作树）

- `npm run test:renderer`：38 个文件、289 项通过（15:20 重跑，含 17 项 Session 回归；最终交接后仍需构建及安装包验收）。
- `cargo test --manifest-path desktop-app/src-tauri/Cargo.toml --lib --locked --offline`：macOS 上 63 项通过，包含重复／并发撤销与新旧 context 隔离。
- `npm run build:web`：通过；存在依赖 use-client 指令和 bundle 大小警告。

Renderer 隔离测试调用生产编排函数，替换网络和 native 边界，覆盖 A→B→A、后台草稿确认、异步注册、审批、取消及工具收尾。它们不是完整 React 挂载测试，也不是实际安装包 UAT。

独立审查发现的退出登录屏障、迟到认证响应、重复 native 清理问题正在收尾。Native 仅对验证了 window/run 归属的旧 context 返回 `already_revoked`；该结果不代表 OS 子进程停止已确认。

## 发布前真实验收

1. 同一 Agent 创建两个同名对话 A/B，分别发送不同的唯一标记，核对服务端持久化目标。
2. A 运行中切换 B 并发送，再返回 A；两个回复、工具和附件不得串流。
3. A 等待工具审批时切 B；审批和取消只能作用于原始 run。
4. A 向上滚动并展开工具详情，切 B 再回 A；阅读位置、展开状态、草稿保留，无强制滚底或新消息提示。
5. 加入慢网络及迟到响应，重复快速切换；旧历史不能写入新 Session。
6. 两个运行存在时退出登录，再登录；旧连接、工具上下文和草稿租约不得复活或泄漏。

上述真实安装包验收尚未完成；0.1.29 不包含本次 Session 修复。Windows 原生执行也不能由 macOS 测试代替。
