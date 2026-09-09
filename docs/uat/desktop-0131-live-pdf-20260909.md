# 0.1.31 真实 PDF 创建、渲染与看图

## 产品路径

本地真实 Mac ad-hoc app 产品代码 f65564d9，云端 Runtime 已通过 application CD 34337642461 部署至 1f19556c。真实验收 Conversation 为 conv_19f391161d9447dda2c9486cad4f4394，run 为 run_44b3083c4a554bdd81ed3233b5a6802a。

用户级验收消息要求生成一页中文 PDF、使用对应 skill 和随包工具链，渲染后实际看图。不向已有业务对话写入测试消息。

## 权威证据

- 生产事件 3722：skill.activated，name 为 pdf。
- file_read 读取了 skill://pdf/scripts/create_pdf.mjs 与 skill://pdf/scripts/pdf_tool.py。
- 真实 shell 通过随包 Python/ReportLab 生成文件，通过随包 PDF 脚本和 Poppler 渲染。
- 事件 3806/3808：file_read requested/completed，读取 tmp/pdf-render-0131-c/page-1.png。
- 本地真实输出：`/Users/keithchen/Documents/output/pdf/hatch-uat-0131-c.pdf`，27,582 字节；渲染图 `/Users/keithchen/Documents/tmp/pdf-render-0131-c/page-1.png`，75,196 字节。
- 随包 pdfinfo 实测 exit 0，标题 Hatch 图片验收记录，1 页、A4、未加密、PDF 1.3。
- 主代理按 PDF skill 要求直接查看最新 PNG：标题及三行正文中文正常，未见裁剪、重叠或黑方块。

## 暴露的问题及限制

- 模型先尝试 Linux 字体路径；fc-list 报 Fontconfig 默认配置缺失并超时。之后找到 Mac 系统中文字体，最终生成与渲染成功。已另行修复运行环境，不能称字体发现全程正常。
- 模型首次用云端 `/app/runtime-server/skills/...` 路径执行本地脚本失败，随后通过 HATCH_DOCUMENT_SKILLS_ROOT 找到随包路径并成功。这是实际路径选择摩擦，不能描述为零失败。
- 模型把渲染临时文件放到 workspace 的 tmp/，而非提示要求的 output/pdf/；未覆盖原文件，但未完全遵守提示的输出目录限制。
- 本次只证明这份简单中文 PDF 的创建、渲染和图片校验；不证明复杂 PDF 编辑、Office、Windows 或完整发行验收。
