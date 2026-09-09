# 旧 Office 格式工具链集成验证

日期：2026-09-09。环境：本机 macOS，仓库随包 Python／LibreOffice。

`runtime-server/tests/legacy_office_integration.py` 实测通过，耗时 112.105 秒。

| 输入旧格式 | 实际 skill 输出 | 校验 |
| --- | --- | --- |
| DOC | DOCX | 正文标记保留 |
| RTF | DOCX | 正文标记保留 |
| XLS | XLSX | 文本单元格和数值 42 保留 |
| PPT | PPTX | 幻灯片标题保留 |

测试先用真实文档库创建测试文档，再用随包 LibreOffice 生成旧格式，最后调用生产 `documents/scripts/office_convert.py`。同时校验现代源文件和旧格式输入的 SHA-256 不变。临时文件仅在测试目录内生成，测试结束清理。

这是工具链集成证据，不是真实 Desktop／LocalRunner／Kimi 端到端验收，不证明 Windows 行为，也不证明任意第三方旧文件的排版兼容性。视觉检查及复杂旧格式样本仍需要单独验收。

运行需使用 runtime manifest 指定的 Python，并设置 `HATCH_RUNTIME_ROOT` 和对应 `PYTHONPATH`；没有随包 runtime 时测试明确跳过。
