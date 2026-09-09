# Factory Workbench 验证记录（2026-09-09）

范围：独立实验 Workbench，127.0.0.1:8790。不是 Desktop/OS UAT。

## 真实模型与服务调用

- Research：会话 b0005b2f-5be8-475c-9268-258d1af90519。实际 Kimi/pi 调用 Tavily 搜索、提取正文，保存来源与 RESEARCH.md。第一轮受限冒烟结果过浅；第二轮正常研究产生 7 份来源、NOTES.md 和更新报告。工具真实提交完成度 100。报告质量仍需专家审核，100 是任务自报完成度。
- Generation：会话 a115d13e-03a6-4503-abd1-d951c0f8672e。从真实 UI 手动接收两份原始来源，实际读取并写出 SYSTEM.md、Skill、References、TOOLS.md、KNOWLEDGE.md。首次暴露引用 kind 说明不清，模型反复猜测；已停止该轮，修正 Prompt/工具描述，继续后走到真实缺少 Registry 配置错误。没有生成虚假发布凭据。
- Case：会话 74ff2847-f46f-4eed-ba07-78d0ec7ee02b。实际 Kimi/pi 生成 CASE.md、CLIENT_STATE.md、RUBRIC.md 和两份材料；案例明确为合成。初版将某些示例方案变为强制评分条件，已调整 Prompt 并启动修订。没有调用 Hatch Tool。
- Evaluator：会话 cc952c1b-76b2-481c-89ba-53c204302957。实际 UI 创建聊天并读取 Agent 列表；正确显示未连接登录会话。尚未执行真实目标 Agent。

## UI 检查

实际页面操作过新建聊天、发送消息、角色切换、选择来源并手动推入另一个聊天。主题样式加载问题已修复。窄屏采用聊天/文件切换，消息与文件可持续更新。已去除模型品牌、Markdown 写入机制、Runtime 复用等解释性文案。

编辑草稿已按会话/路径保存，文件并发更新时保留原编辑版本并在保存时检测冲突。该新增行为编译通过，浏览器交互复核尚未完成。专家批注持久化及版本锚点目前有自动化覆盖，真实 Evaluator 成果上的完整 UI 验收尚未完成。

## 自动化证据

- TypeScript 编译、Workbench Vite 构建通过。
- Factory 5 项自动化测试通过：独立状态和文件版本、单 Pi Agent 进度、HTTP 手动交接、Corpus 上传与现有 Runtime resolver、Hatch Tool 协议。
- 既有 Registry/Corpus/Runtime resolver 27 项测试通过。
- 新增上传失败保留真实原件记录的断言通过。

Corpus 测试运行实际本地 HTTP handler、认证、存储和装配器；不调用真实 Qdrant。Hatch Tool 的 HTTP/WS 服务仅为明确测试替身，不能证明真实运行服务连通。

## 未完成的验收

- 原始 Knowledge 的真实索引（线上 Creator 登录与四份原件上传现已通过，见下）。
- Generation 发布的同一 Agent 出现在实际可运行列表，并具有真实运行权限。
- Evaluator 通过现有服务端 Runtime 核对版本、完成多轮客户对话、读取真实结果文件。
- 专家在该真实结果上批注、重开后核对版本关联。

不把缺少配置、无权限、测试替身或模型自报进度当作完整验收成功。

## 后续复核

Case 第二轮虽自报 100%，实际写工具因未传版本拒绝保存，旧 Rubric 仍存在；此前“修订完成”的模型答复不算证据。已改进 write 工具：宿主保存最近读取版本，Agent 只提交路径与正文，继续保留并发修改保护。待新版服务加载后重新执行修订。

新增在线登录入口复用 Desktop auth-session 客户端；角色检查和凭据不出现在公开状态的自动化测试通过。尚未完成真实用户登录。线上 `/health/runtime` 和 `/health/registry` 返回 200；未登录的账户与列表接口返回真实 401。

## 文件 UI 实际复核

在真实 Research 会话打开 RESEARCH.md，进入编辑、输入临时草稿、切换 NOTES.md 后再回来，编辑器恢复同一草稿。随后放弃草稿，确认磁盘报告原件未变化。

通过逐行批注 UI 选择研究范围所在行，提交关于日期与读取完整性的实际意见。服务端持久化的批注绑定 `sha256:0f3fe679a734063ac2cd1d5621bf834e43dc4e68be5699c5432a127edbd59c4e`，按该版本读取并核对，quote 与起止位置完全一致。此项证明 Research 文件的真实编辑/批注组件行为；还不能替代 Evaluator 真实成果上的端到端验收。

HTool 已修复保留配置 URL 的路径（线上为 `/v1/runtime`），协议测试检查该路径通过。新版 write 和登录入口已由运行中的 Workbench 服务加载，Case 的第三轮修订已启动。

Case 第三轮实际修订成功：RUBRIC.md 版本 e5cc2b8696041794…、CLIENT_STATE.md 版本 f2c0f937d59ee705…；已核对并行验证、粗略数字、服务形态及本地工具限制的修正落盘。


## 线上发布实测与服务端接入

通过 Workbench 的真实登录入口连接线上 Hatch Creator 账号成功。Generation 第五轮实际创建 Product `290ca90b-2d62-477e-af4c-10576de1b148`，四份完整原始资料上传成功并获得真实文档 ID。Generation 已将 KNOWLEDGE.md 更新为原件上传成功、Corpus 发布失败，完成度报 90%，没有伪造 CORPUS.md。

线上发布响应为 422：`Registry publish failed during latest_completed_corpus: No completed Corpus Node execution is available`。这证明当前线上仍走旧 Corpus Node 发布契约，需要部署已实现的直接定义提交入口后才能继续。原件已上传不代表索引或发布已完成。

Creator 评估复用现有 owned-Product Runtime 授权，不要求另购自己的 Agent。HTool 的客户账号与 Creator 账号两种传输测试均通过；Creator REST 会话授权测试通过。相关改动尚未部署线上。

Case 的五份输出（案例、私有事实、Rubric 和两份客户材料）已通过实际手动交接 API 放入 Evaluator input，尚未启动目标 Agent。下一步为上线服务端入口、重试发布、选择目标并运行完整案例。


服务端补丁已独立提交至 https://github.com/keithhchen/hatch/pull/126 。独立工作区完整 Runtime 测试：498 通过、9 跳过、0 失败；GitHub CI 仍在运行，尚未合并或部署。Workbench 已加载简化后的文件工具和详细服务错误，重新连接线上账号。Generation 正在修正将恐惧、定价和口碑方法泛化成硬规则的问题，此轮不发布。


PR #126 已于 2026-09-09 11:18 UTC 合并。PR 的 Runtime/Registry、Commerce、Dashboard 和容器构建检查通过；Desktop 原生打包仍在运行，本任务不宣称 Desktop release/UAT。master 的 Hatch Web CI（run 34344899246）正在运行，将通过现有 CD 更新服务。线上 Corpus 发布与 Evaluator 集成仍待部署后验证。


master Web CI 已通过，应用 CD run 34345170648 正在运行。Generation 第六轮已实际写入 System、Skill 与四份相关 References，对恐惧解释、定价、口碑和多受众策略补充适用条件；未重试发布。


## 真实发布、运行与专家批注

应用 CD run 34345170648 成功，线上切换、索引初始化与公共健康检查全部通过。Generation 已将当前定义与四份原件真实发布并生成 CORPUS.md。Creator 选择目录已改为使用 Registry `/v1/creator/products` 的 live release；Runtime 的 release resolver 本来不提供 catalog，不能用它的空列表推断没有权限。对应实际本地 Registry 集成测试通过。

通过真实 UI 选择“Factory 验证：受众选择顾问”并启动 Evaluator。真实 Runtime 会话 `conv_c6f6b3386afb422a93fb5ec358b8ec56` 首轮正常完成，RESULT.md 与原始运行记录已保存。首次 EVALUATION.md 虽已生成，但人工复核发现漏判了算术错误、将无依据阈值评成证据充分，并过度强调追问轮数，因此质量不通过。

已补入四份原始来源并改进 Evaluator 提示词，要求复核证据与基本计算、区分客户事实和假设、接受有依据的直接建议。第二轮继续同一客户案例，仍待完成。

在真实 RESULT.md 第 40 行通过逐行批注 UI 保存关于销量计算和市场证据的专家意见。切换 CASE.md 再打开 RESULT.md，意见仍完整显示。已导出 REVIEW.md，与首轮原始结果一同手动交给 Generation；其修订只针对可迁移的判断要求，本轮不发布，不以案例答案补丁替代方法改进。

Markdown 相对文件链接已修复；在 Evaluator CASE.md 点击“个人专业背景与现状”，真实界面打开同一工作区 input/materials/personal_background.md，未跳转错误页面。前端构建通过。

## 专家修订副本实际验收

在修订版对照 Evaluator `4c37f2dd-a658-4451-bd1b-8e64ef731f65` 打开真实 RESULT.md，点击“编写修订副本”，输入对收入核算段落的人工修订并另存为 `output/专家修订-收入核算.md`。实际 API 返回可读文件，原 RESULT.md 仍为只读原文。再从文件区重新打开副本，界面完整显示修订内容。副本明确标注只修订该段、不代表整份方案已验收；没有改写运行证据。


## Dashboard 接入（本地代码验证）

四个聊天进入现有 `/studio/factory`，共用 Creator 登录与导航。Dashboard BFF 复用 Cookie/CSRF 认证，Registry 再验证 Creator 身份后进入按 Creator 隔离的聊天与文件目录。没有单独登录、Project、版本选择或自动交接。普通文件同名覆盖；Runtime 原始成果按运行留存，批注保留原文。

验证：Dashboard 构建、Runtime TypeScript 编译通过；113 个 Dashboard 自动化测试、8 个 Factory 自动化测试通过，覆盖 Cookie/CSRF、拒绝客户账号、SSE 转发、跨 Creator 读写与交接隔离、持久化、普通文件覆盖以及现有 Corpus/HTool 调用。测试替身仅证明对应状态和协议；没有将其当作真实产品 UAT。

尚未部署本次 Dashboard/Registry 接入，未完成新入口的真实 UAT。旧本地实验文件完整保留，未自动归入其他账号；迁入登录 Creator 与线上搜索凭据配置仍需部署阶段完成。既有真实目标运行和质量评价不因 UI 接入而自动通过。
