# Factory 规格完成审查

日期：2026-09-09。目标为 Dashboard 内的四个 Agent，不将链路跑通替代产物质量。

最新切换：Factory 已接入 Dashboard 的 `/studio/factory`；独立 Portal、节点登录与文件版本管理已移除。下表早期真实操作证据来自原实验工作台，不能当作新 Dashboard 的线上 UAT。新入口的 Dashboard 构建、Runtime 编译、113 个 Dashboard 测试及 8 个 Factory 测试通过；线上部署、旧实验数据迁入所属 Creator、新入口真实 UAT 尚未完成。

| 要求 | 当前证据 | 结论 |
| --- | --- | --- |
| 四个 single agents，共用 Kimi/pi，状态和文件隔离 | factoryAgents/runtime.ts、store.ts；四个角色真实聊天；workbench.test.ts | 已实现，真实运行与隔离测试有证据 |
| Voice 保持已有实现 | 工作范围在 factoryAgents、factory-workbench，未要求修改 Voice | 本任务未修改 |
| 自己列出并读完 inputs，手动交接 | 真实 Research→Generation、Case→Evaluator 的工具记录与 UI；COMMON 和角色 Prompt；HTTP transfer 测试 | 已验证交接与读取；后续轮次只补读新文件 |
| Markdown 主文件与真实写入 | 四角色实际 output；write 失败后明确修订，文件持久化与并发测试 | 已验证 |
| 每轮 report_progress，无影子模型 | runtime.ts；实际会话 progress；单 Pi 测试 | 已验证；100 不代表质量通过 |
| 聊天、停止、继续、恢复与错误传播 | Generation 实际停止与继续；runtime.ts；各角色真实多轮 | 已实现；不重放失败副作用 |
| 阅读、编辑草稿、文件链接与批注 | UAT 记录：Research 草稿恢复；Evaluator 真成果逐行批注、重开；相对文件链接 | 已验证主要操作；原结果不可改写，修订副本分开 |
| Research 真实搜索和原文、来源边界 | Tavily 实际来源与 RESEARCH.md，四份一手文章/访谈；web 工具明确不是视频转写 | 已验证网页链路；未宣称 YouTube 转写可用 |
| Research 深度与事实质量 | factory-output-review：短博客不足，追到长访谈和具体案例，保留边界 | 有改善证据，仍需最终质量复核 |
| Generation System/Skill 原有格式 | corpusTools 与 CorpusPublisher；线上真实加载已发布定义 | 已验证 |
| 原始 Knowledge 上传与索引 | 四份原件真实 Files API 上传，线上 published CORPUS.md；工具读取原始字节 | 已验证；评测答案未作为 Knowledge |
| 发布入口仅接受直接定义提交 | PR #126 已合并部署；缺 corpus 拒绝测试、线上成功 | 已验证 |
| Case 单一连贯客户与私有标准隔离 | 原 SaaS 案例五份文件；Case 工具无 HTool | 已实现；独立陶艺案例质量复核进行中 |
| HTool 共用 Runtime、无 LocalRunner | hatchTool.ts 调用 Desktop client；线上两轮同会话；Creator/buyer 协议测试 | 已验证；不等于 Desktop/OS UAT |
| 真实目标选择、权限、持久化 | Registry 目录、UI 选中已发布 Product、session.ready 检查、真实 results/ | 已验证 |
| Evaluator 不泄漏私有资料、准确模拟客户 | 专属材料传入工具隔离测试；真实第二轮出现客户事实范围被扩大 | 工具隔离有效；Prompt 行为缺陷已识别，修订复核中 |
| 专家意见能回到 Generation | 真成果批注→REVIEW.md→Generation 手动交接与定义修订 | 已验证，无自动流水线 |
| 厚实、专家延伸、可靠交付 | 首轮目标计算/证据缺陷；Evaluator 宽松误判；已迭代 Prompt | 未达最终验收，不能宣称整体完成 |

自动化测试替身仅证明对应协议和状态逻辑。真实服务验收详见 factory-workbench-20260909.md；内容判断详见 factory-output-review-20260909.md。当前正在执行的独立案例和定义修订不会被当作已通过证据。
