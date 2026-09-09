# PPTX live Desktop check — 2026-09-09

## Scope

Real CI ad-hoc ARM app from run 34342146681, source `1c8e280d`; valid bundle signature and matching DMG evidence. Connected to the real cloud Runtime and existing UAT conversation `conv_19f391161d9447dda2c9486cad4f4394`. Not a mock UI or proof of newer owner/startup commits.

## Creation run

`run_0ff12d388e4b4713932b09999f4e7ca7` created `/Users/keithchen/Documents/output/presentations/hatch-uat-0131-c.pptx` through Hatch's Presentations skill and bundled python-pptx. Size 29705 bytes, SHA-256 `704c53550f2682531e5f04e73e59613723e0033abc65034972f65b0c70ec5a47`.

- Two slides, editable Chinese/English text and a native DrawingML table (`a:tbl`) with rows 项目/数量, 图片/2, 文档/3, 合计/5.
- Actual bundled `pptx_tool.py` read, validate and render operations completed (cloud events 4035–4037).
- LibreOffice/Poppler produced both page images in `/Users/keithchen/Documents/tmp/pptx-render-0131-c/`.
- Main agent inspected both images: Chinese glyphs and numbers visible, no observed clipping/overlap. Slide 2 used blue table styling despite requested white/black styling, so full requirement compliance is NOT passed.
- Hatch actually called `file_read` on both rendered slides. Completed events 4045 and 4051; canonical events 4046 and 4052 contain `["text", "image"]` tool content.
- Initial script invocations used a stale absolute path from earlier context and failed. The agent recovered using `HATCH_DOCUMENT_SKILLS_ROOT`. This is a recorded inefficiency, not a successful first-attempt path resolution claim.

## Remaining

Requested an actual edit/alternate save to v2: document count 4, total 6, white cells/black text/gray borders, preserve v1 and slide 1. Editing, upload/reload, and native opening are not yet verified. No claim of PowerPoint application compatibility testing.
# 编辑结果复核（追加）

- v2 已生成：`/Users/keithchen/Documents/output/presentations/hatch-uat-0131-c-v2.pptx`，SHA-256 `e1a4dfe88e762576970a1a2dcdebe71e87f009412b152e53e04d5b7a77a271f2`。
- v1 SHA-256 仍为 `704c53550f2682531e5f04e73e59613723e0033abc65034972f65b0c70ec5a47`，未覆盖。
- XML 原生表格数值已改为文档 4、合计 6；第二页实际 PNG 为白底黑字、灰色边框，无文字截断。
- 云端编辑 run `run_87b073de3c4342c8bb393e34d4a7e0a4` 的两个看图调用已完成（4088、4094），对应持久化工具消息 4089、4095 均含 `["text", "image"]`。不是只生成 PNG 后宣称看过。
- 代码复核发现 `pptx_tool.py read` 只读取 `shape.text`，遗漏原生 table cells；`replace` 同样仅处理顶层 text_frame。已安排修复并增加原生表格和嵌套 group 回归，不能将当前 read 输出当成完整文档内容。
- 尚不能判定编辑完整通过：生成 XML 的边框含 `a:w` 和 `a:solidFill` 属性，需核查 DrawingML schema；LibreOffice 能渲染不代表 Office 结构合法。第一页面保留、模型实际看图事件及 Office 打开仍待核实。

## 真实附件入口与副本读取

重启恢复已实测：运行结束后在同一对话输入 `HATCH-UAT-DRAFT-RESTART-0131：这是一条未发送的恢复验收草稿。`，通过原生选择器附加 v2，正常退出（pgrep 确认旧进程消失）再启动同一 CI app。先显示“正在打开你的工作区”，随后历史恢复，输入框文字和未发送 PPTX 附件同时恢复，Documents 工作区仍在。此为该安装包的正常退出/启动 UAT，不代表崩溃或新 owner 代码验收。

通过 Hatch 原生文件选择器附加 v2 并发送，UI 显示 29 KB 附件卡片及 Open/Save as 操作，草稿附件清除。实际 run `run_045b70c998af41a5bfe53053d7e6cfca` 保持在原 UAT conversation。

云端工具事件 4113、4114 成功读取 `~/Library/Application Support/dev.hatch.local/attachments/drop_211c1a58e9a44aedb9ad6b1cdfe53a28/file/hatch-uat-0131-c-v2.pptx`，并非 output 原件。脚本摘要未含表格时，Agent 自主使用随包 python-pptx 读取表格；事件 4121 返回 2 页和图片/2、文档/4、合计/6，退出码 0。此结果验证 skill + 通用执行 + 成熟库可以完成附件读取，不需要把所有文档细节实现进 harness。重启后附件恢复尚待验证。
