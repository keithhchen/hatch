# 0.1.31 真实消息与图片验收

## 产物和范围

使用 `desktop-app/src-tauri/target/release/bundle/macos/Hatch.app` 的本地真实 ad-hoc 构建，产品代码 `f65564d9e94032962eae876fc618abf2ef09a801`；通过真实登录、entitlement、新建 Task、Runtime、Kimi 和 native bridge。不是 fixture，也不是 tag 发布产物。

通过 GUI 新建两个验收 Task，Brief 分别包含 `HATCH-UAT-0131-A-20260909` 和 `HATCH-UAT-0131-B-20260909`，未向既有业务会话发送测试消息。两个任务仍使用产品默认同名标题，未修改旧记录。

## 已通过的观察

- A 运行时可打开 B 的新建表单。B 运行时切回 A，看到 A 自己的唯一标记。
- A 普通消息请求 `HATCH-CHAT-A-0131`，回复正确；B 不显示 A 的这条消息。
- 在 B 通过系统文件选择器附加用户提供的真实截图 `/var/folders/k0/hbmw41gn5plckh87xp1kb53m0000gn/T/TemporaryItems/NSIRD_screencaptureui_GHfPyf/截屏2026-09-09 12.41.50.png`。该文件位于所选 Documents workspace 外，75,367 字节。
- 提示不包含截图答案，只要求转写标题和按钮。Kimi 正确回答“你的任务很安全。”和“关闭任务”。
- B 图片运行时切 A，A 没有 B 的图片或运行状态；再回 B 可看到图片结果。
- 退出并重新打开 app，B 的图片、正文和模型回答仍存在。已通过实际 screenshot 视觉检查图片像素显示，不只是 AX 文件名。
- 本地 state 只读核对 B ID：`conv_7aef5b62c6754332a9c43b35e6fad664`。生产 Postgres 对应 canonical conversation 后缀一致。图片消息 run 为 `run_49fef94b659d4bab9bbfbab8d580d2af`。

## 主动看图尚未通过及根因

重启后要求 Agent 用图片工具重新读取附件，它却调用 shell_exec，先 ls、再 PIL.Image.open，再尝试 pytesseract/tesseract/Vision。生产事件证实 ls 和 PIL 成功访问 Hatch 附件副本，尺寸 986×196、RGBA；OCR 依赖不存在。

这只证明本地副本可读、随包 Python 可运行，不证明主动多模态工具成功。该 run：`run_57f04a7d71184448a2271f07f1b7a751`。

源码根因：`tools.ts` 向模型描述 file_read 为只读 UTF-8；pinned Agent 系统提示也错误地说工具仅能访问 workspace。已修正为实际支持的文本/图片读取及授权附件目录，保留 PDF/Office 走 Skill 的职责。没有增加 OCR 包或新工具。TypeScript 编译与 7 项工具/图片历史相关测试通过。

## 剩余验收

上述云端工具契约修复需要部署，随后再次验证 Agent 自主选择 file_read，以及实际图像工具结果进入 Kimi。不能拿上传图片成功代替此项。Office/PDF 完整链路、并发取消、完整历史一致性审计、Windows 实机和发布验收仍未完成。
