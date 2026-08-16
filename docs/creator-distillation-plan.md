# Creator Distillation Implementation Plan

> 这是一份设计阶段冻结的 implementation contract：先定义产品表面、authority、状态转换和恢复语义，再实现后端、Review API 与 @hatch/ui 页面。它不是静态 demo，也不把 fixture 或假状态当作产品行为。

## Goal

把创作者的一套方法转成一个可验证、可发布的 Agent Product。复杂的 LLM graph、prompt、provider 和 worker checkpoint 留在后台；Creator 只在三个真正需要判断的时刻介入：

```text
教它（reference） → 审它（review） → 纠正它（correction）
```

本版本不做 Creator presentation / voice 配置，不做 Brief / Complete 服务项目，不做独立 Judge 训练、SFT、RFT 或权重更新。

`:codex-annotation{index="1"}`

## Implementation contract

```text
Task
 ├─ Source Library artifacts
 ├─ Immutable Snapshots
 ├─ Runs / Revisions
 │   ├─ Working cases
 │   ├─ Known cases
 │   ├─ Blind cases
 │   ├─ Candidate / Eval artifacts
 │   └─ Review / Correction artifacts
 ├─ Append-only event graph
 └─ Derived quality gates / UI projection
```

```text
Postgres    = Task、Run、Revision、Case、Event、Gate、Release 的状态真相
Object Store = 原始文件、projection、LLM 输出、Eval、Correction、Corpus 的 immutable 内容真相
Worker state = 可恢复 checkpoint，不是业务 authority
UI          = derived projection，不直接写业务状态
```

## 产品表面

把复杂的 LLM graph 藏在后台，Creator 只看到四个页面：

```text
Source Library
      ↓
Factory / Working
      ↓
Review
      ↓
Release
```

Creator 只感知“材料 → 教方法 → 审结果 → 发布”，不需要监控后台节点、prompt 或模型调用。

Evidence 与 Corpus Compile 的职责刻意分开：Evidence 只回答“材料里有什么、哪些观察有来源、哪里存在冲突或缺口”，产出可追溯的事实与例子；Compile 才回答“哪些已确认的行为要被编码进 Agent”，把 Evidence、Creator reference、correction 和 Corpus `n-1` 合成为分层 runtime assets。LLM 可以提出抽取或编译草稿，但 host 负责 provenance、preservation、schema、digest 和 sealed boundary；因此它不是一个无法审计的“一次生成 Corpus”黑盒。

Evidence 还可以提出“源头的源头”假设：例如材料中的原则可能来自某位导师、某本书或某种方法传统。此类内容必须标成 `Inferred / provenance hypothesis`，记录支持线索、置信度、替代解释和待确认问题；下一环节把它变成 `provenance_confirmation` question。Creator 的 reference answer 才能把假设提升为可用标准，否定或修正则只留下溯源记录，不进入 Corpus。

### LLM system-instruction contract

每个 LLM 节点的 system instruction 都包含四层，而不是一句泛化的“请分析”：

1. **Role and authority**：它负责什么、不负责什么，以及 Creator answer、canonical example、source、model inference 的优先级；
2. **Reasoning protocol**：要求显式产出可审计的中间结构（Evidence 的 Observation → Interpretation → Hypothesis，Question 的 information gain，Compile 的 requirement → asset matrix，Eval 的 behavior gap），不要求或保存私有 chain-of-thought；
3. **Quality bar**：高信息密度、完整语境、保留例外与冲突、面向可交付结果，而不是流畅的通用答案；
4. **Submission and boundary**：严格的 host tool/schema、immutable artifact、sealed held-out、不能把 Factory/eval 原料复制进 runtime Corpus。

LLM 可以提出内容和判断建议，但不能拥有状态、digest、工具配置、sealed 数据或最终发布 authority；这些由 host 的 event graph、quality gates 和 Creator command 决定。

### Creator-facing node projection

每个后台节点只向 Creator 暴露可行动的结果，不暴露 LLM graph、prompt、provider 或 worker checkpoint：

| Node | Creator sees | Sealed / internal |
|---|---|---|
| Source Intake | 文件、格式、Markdown projection、Snapshot 状态 | parser 与模型细节 |
| Evidence | 材料理解状态、缺失信息摘要、带出处链的 provenance hypotheses | 抽取 prompt 与中间链 |
| Question Generation | 行为题，以及明确标记为 `provenance confirmation` 的源头推断确认题 | 生成过程 |
| Creator Reference | 自己填写的标准答案；对 hypothesis 可确认、修正、否定或补充来源 | — |
| Corpus Compile | Building candidate、真实错误；Candidate Review 中可读完整 runtime Corpus（System、Skills、References、Knowledge） | LLM 草稿与资产图 |
| Candidate Runtime | Candidate 版本与是否生成；完整 Corpus 的 immutable digest 与逐资产内容 | worker checkpoint |
| Eval | Known 通过/失败数量、诊断、低置信度提示 | Judge prompt；Blind 内容 |
| Creator Review | reference、candidate output、Eval verdict/diagnosis、Accept / Correct / Reject / Eval dispute | 原始文件与 sealed case |
| Correction | correction、why、新 revision 提示 | 覆盖旧版本 |
| Held-out | 仅通过/失败数量与确认提示 | 题目、答案、Candidate output |
| Release | Promise、Examples、Boundaries、quality gates、Release command | 内部实现细节 |

Review 页面中的 **Full Corpus** 是 Candidate 的只读 projection，不是重新生成的预览：每个资产直接从已验证的 immutable artifact 读取，并显示 layer、canonical path、sha256 与全文。Synthetic QA / held-out 属于 sealed quality gates，不是 Agent runtime Corpus；页面只显示它们保持封闭的说明，不泄露题目、答案、输出或 sealed artifact 内容。

## 1. Source Library

一个 Task 对应一个独立的上传与文件储存区域：

- 可以多次上传本地文件；
- PDF、DOCX、XLSX、CSV、TXT、HTML、JSON 等非图片格式先转成 Markdown；
- 图片保留原生格式，由模型原生读取；
- Start Run 时自动锁定 immutable Snapshot；
- 原件、Markdown projection 和每个 Snapshot 永久保留；
- 上传区是独立页面，不与 Factory 表单混在一起。

界面草图：

```text
[Task name]                         [Working]

What you are making
[Task promise................................]

[ Upload local files ]  多次上传
PDF · DOCX · XLSX · CSV · Images

Sources
✓ method.pdf       Markdown projection
✓ example.png      Native image
✓ notes.docx       Markdown projection

[ Start distillation ]
```

## 2. Factory / Working

后台流程：

```text
Evidence → Question generation → Creator reference answers → Corpus → Candidate
```

Creator 只看到当前运行状态、需要回答的问题、是否需要修正，以及 Candidate 是否 ready。

内部维护三类数据：

```text
Working set
= 当前用于迭代的 development cases

Known set
= 已确认、已修正并通过的 regression cases

Blind set
= sealed held-out cases，用于检验泛化
```

界面草图：

```text
Interview Answer Rewriter

Working
Evidence extracted → Questions ready

Your reference answers
────────────────────────
Q1  客户已经试过三个方案，你先判断什么？
    [填写你真正会给出的答案................]

Q2  什么情况下应该拒绝回答？
    [....................................]

[ Submit answers ]
```

运行中只显示简单状态：

```text
Preparing → Asking for your method → Building candidate
→ Testing known cases → Testing blind cases
```

不显示节点图、prompt 或模型调用细节。

## 3. Review

Review 只审 Candidate 的行为，不审原始文件或 prompt。

对于 Working / Known case，展示：

```text
Question
+ Creator reference
+ Candidate output
+ Eval verdict
+ Eval diagnosis
```

Creator 有三个动作：

- **Accept**：保留为通过 case；
- **Correct**：填写正确行为，生成 correction artifact；
- **Reject question**：题目或标准本身无效。

反馈路由：

```text
Correct
→ 新 revision
→ Corpus n-1 + correction + Known set
→ 重新评估

Reject question
→ 替换 question
→ 不修改 Corpus

Eval judge 错
→ 标记 judge dispute
→ 校准 Eval，不直接修改 Agent
```

Held-out 只显示通过/失败数量，不显示题目、答案或 Candidate 输出。

Held-out 失败后的闭环：

```text
Creator 确认
→ 修正
→ 修正后的 case 通过
→ 加入 Known set
→ 生成新的 Blind case
```

Review 页面顶部：

```text
Candidate v3

Known cases       8 / 8 passed
Blind cases       3 / 3 passed
Needs your review 1
```

默认只展开失败、低置信度和 critical cases。每个 case：

```text
Q1 · Known case · Eval: FAIL

Question
客户已经试过三个方案都失败了，你先判断什么？

Your reference
先判断目标定义是否错误。

Candidate output
直接推荐第四个方案。

Eval diagnosis
跳过了 Creator 要求的首要诊断。

[ Accept ] [ Correct this answer ] [ Reject this question ]
```

点击 `Correct this answer` 才展开：

```text
What should the Agent have done?
[先判断目标定义是否错误................]

Why?
[说明这是可复用的判断原则................]

[ Submit correction ]
```

Blind case 只显示：

```text
Blind evaluation · 3 / 3 passed
题目和答案在发布前保持封闭
```

## 4. Release

只有所有 Known cases 通过、Blind set 通过、且没有未处理 correction 时，才允许发布：

```text
Preview buyer-facing promise / examples / boundaries
→ 一个 Release command
```

Release 同时完成 Candidate approval 和 Product publish，并绑定同一个 immutable digest。

界面草图：

```text
Ready to release

[消费者看到的 Product preview]

Promise
Examples
Boundaries

Quality
✓ Known set passed
✓ Blind set passed
✓ No unresolved corrections

[ Release ]
```

`Release` 是唯一最终按钮。

导航只保留：

```text
Tasks
Source Library
Factory
Review
Versions
```

建议状态文案：

```text
Working
Waiting for your answers
Needs review
Needs correction
Ready to release
Published
```

## 数据与存储

### Postgres

保存：

```text
Task
Run / Revision
Case classification
Review decisions
Gate status
Event graph
```

### Object Store

保存 immutable artifacts：

```text
Original
Markdown projection
Snapshot
Creator reference
Candidate output
Eval report
Correction
Corpus bundle
```

每个 artifact 都带 `artifact_id + sha256`。Review 不是直接改状态，而是写 immutable review/correction artifact，再由事件图派生当前状态。

## Authority 与状态管理

### 真相来源

```text
Postgres event graph + quality gates = 状态真相
Object Store = immutable 内容真相
Factory state.json = worker checkpoint，不是业务真相
UI = derived projection，不自己保存业务状态
```

### Revision 状态

```text
created
→ running
→ waiting_for_creator
→ evaluating
→ review_required
→ needs_correction
→ ready
→ released
```

旧 Revision 永远不修改。Correction 必须创建新 Revision：

```text
Revision N
  └─ correction artifact
      └─ Revision N+1
```

### Case 状态

每个 case 有独立、append-only 的生命周期：

```text
working
→ evaluated
→ accepted
```

或者：

```text
evaluated
→ correction_required
→ corrected
→ accepted
```

题目无效则：

```text
evaluated
→ rejected_question
→ replacement question
```

Held-out 额外保持：

```text
blind + sealed
```

在晋升为 Known 之前，不能向 UI 或 Corpus compiler 泄露内容。

## Creator Review 写入规则

Creator 点击任何动作都不是直接改 `status`，而是写入：

```text
Review artifact
+ event
+ actor
+ expected revision
+ case id
+ candidate digest
+ reason / correction
```

服务器再从事件和 gates 推导：

```text
needs_review
needs_correction
ready
```

这样重复点击、刷新或并发 tab 都不会产生不同结果。

## API 约束

所有 mutation 都必须有：

```text
authenticated owner
idempotency key
expected revision/version
content digest
```

客户端不能提交：

```json
{
  "status": "ready",
  "passed": true,
  "published": true
}
```

这些只能由后台根据真实 artifact 和 gate 产生。

## UI 状态管理

- Server state：Task、Revision、Case、Gate、Release；
- Local state：当前 textarea 草稿、展开哪个 case、确认弹窗；
- Creator answer 草稿可以暂存在内存，但提交必须写服务器；
- Source、Correction、Review 都不能依赖 localStorage；
- 版本冲突时重新读取 authoritative projection，不静默覆盖。

## 真实产品要求

- 没有真实 artifact / Eval / gate，就显示 `Unavailable`，不显示假成功；
- Held-out 只返回摘要；
- Review 页面只读取 review projection，不读取本地 fixture；
- Worker 中断后从 checkpoint 继续，不能重复调用已完成的 LLM；
- Release 只绑定已经通过当前 revision 的 immutable digest。

## Implementation 范围与顺序

### 最小改动范围

1. 保留现有 Source Library、Factory、Snapshot 和 Release；
2. 把 `development / regression / held-out` 明确投影成 `Working / Known / Blind`；
3. 新增逐 case Review API 和 UI；
4. Correction 自动创建新 revision；
5. Held-out 只返回摘要；
6. 暂不做独立 Judge 训练、SFT、RFT 或权重更新。

### 实现顺序

```text
先固定数据模型和 commands
→ 再实现 server projections
→ 再实现 Review UI
→ 最后接 Release / browser UAT
```

### 核心闭环

```text
Creator 定义标准
→ Agent 生成
→ Eval 辅助判断
→ Creator adjudication
→ 修正后的行为进入 Known set
→ Blind set 检验泛化
→ Release
```

这份文件是产品与数据状态的轻量 contract。实现必须走真实 authentication、持久化、Worker、LLM 和 Release 链路；不使用 mock、fixture、静态 preview 或假成功状态证明产品行为。
