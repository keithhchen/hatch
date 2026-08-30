# Hatch：在 Agent Corpus 基础上增加 Creator Private Model 能力

## 1. 当前产品架构

Hatch 当前交付的 Agent 由以下部分组成：

| Layer | 作用 |
|---|---|
| System Prompt / Instructions | 全局行为、优先级、边界、长期生效规则 |
| Skills | 可复用的方法、流程与局部能力 |
| External Tools | 搜索、文件、API、MCP 等执行能力 |
| Knowledge | 专家材料、案例和长尾知识 |

Runtime 在每个任务中加载对应 Agent Corpus，并负责模型调用、工具执行、上下文、对话状态和交付。

Creator Factory 当前负责把专家材料和 Creator judgment 编译为 Agent Corpus。当前实现明确属于 **prompt-and-corpus compilation**，不包含 fine-tuning 或模型权重更新。

Factory 已包含：

- Evidence extraction
- Creator questions / reference answers
- Candidate Corpus compilation
- Development evaluation
- Regression evaluation
- Sealed held-out evaluation
- Correction / revision
- Immutable release



---

## 2. 新增能力：Fine-Tuning Layer

未来 Hatch 在现有 context / harness engineering 基础上增加：

**Creator-specific Fine-Tuning**

整体结构变为：

```text
Context / Harness Engineering

System Prompt
Skills
Tools
Knowledge
Runtime
Eval
Release

        +

Model Adaptation

Creator-specific LoRA
or
Creator-specific merged model
```

Fine-tuning 不替代 System、Skills、Tools 或 Knowledge。

它增加的是一个新的模型参数层。

---

## 3. 什么进入 Context，什么进入 Weights

不同类型的信息适合不同承载方式。

| 信息类型 | 主要承载位置 |
|---|---|
| 最新知识、事实、案例 | Knowledge / RAG |
| 明确方法和工作流程 | Skills |
| 产品边界、全局要求 | System Prompt |
| 外部执行能力 | Tools / Runtime |
| 稳定的行为模式 | Fine-tuning |
| 稳定的 judgment / taste | Fine-tuning |
| 稳定的 tool-use policy | Fine-tuning / trajectory training |

因此 Fine-tuning 的主要目标不是把 Creator 的全部知识塞入模型，而是参数化已经重复观察到的：

- judgment
- behavior
- preference / taste
- decision boundary
- tool policy
- agent policy

探索方案中对应三类主要训练数据：

| 数据 | 学习目标 | 典型训练方式 |
|---|---|---|
| Behavior / Output | 应该怎么回答 | SFT |
| Judgment / Preference | 什么答案更好 | DPO |
| Agent Trajectory | 应该怎么行动 | Trajectory SFT / RL |



---

## 4. 数据来源

训练数据主要来自 Creator 对真实消费者任务的校准。

基本数据链路：

```text
Consumer Task
↓
Creator Agent 执行
↓
Creator review / correction / comparison
↓
Structured expert signal
↓
Dataset
↓
Fine-tuning
↓
Candidate model
↓
Blind evaluation
```

Hatch 当前 Factory 已经存在部分必要数据结构：

```text
Question
Creator Reference
Candidate Output
Eval Verdict
Correction
Regression Case
Held-out Case
```



未来可以进一步增加：

- post-edit
- chosen / rejected pair
- rejection reason
- counterfactual
- decision flip
- trajectory
- real task outcome

高价值数据单位因此可以从简单的：

```text
Question → Answer
```

扩展为：

```text
Case
+ Expert Answer
+ Alternative
+ Preference
+ Why
+ Counterfactual
+ Decision Flip
+ Edge Case
```



消费者数据进入训练体系需要单独的授权与用途约束。当前 V1 默认不允许 Buyer 私有数据自动进入 Creator learning dataset。

---

## 5. Creator 体验

Fine-tuning 不要求 Creator 在创建 Agent 时准备训练数据。

产品路径可以是：

```text
创建 Agent
↓
System + Skills + Tools + Knowledge 上线
↓
真实消费者开始使用
↓
Creator 持续校准
↓
积累足够高质量数据
↓
Hatch 判断 training readiness
↓
训练 Creator-specific model
↓
与现有 Agent baseline 做 blind evaluation
↓
达到要求后部署
```

因此 Creator 可以先使用现有 Agent Corpus 能力，再随着真实使用逐步获得模型微调能力。

Fine-tuning 是后续能力，不是 Agent 创建的前置条件。

---

## 6. Private Model Asset

训练结果可以是：

### Creator-specific LoRA Adapter

```text
Shared Base Model
+
Creator A LoRA
Creator B LoRA
Creator C LoRA
```

或者：

### Creator-specific Merged Model

```text
Base Model
+
Creator Adapter
↓
Merged Creator Model
```

LoRA 与具体 base checkpoint 绑定，但 adapter 可以独立保存、版本化和导出。

Creator 可以拥有并导出自己的 adapter / model weights。

Hatch 不主张对 Creator 数据和模型资产拥有 ownership。

---

## 7. 对 Creator 的资产价值

当前 Creator AI 资产主要包括：

- source materials
- prompts
- skills
- knowledge base
- workflows
- product configuration

加入 fine-tuning 后，可以新增：

- proprietary training dataset
- Creator-specific LoRA
- Creator-specific merged model
- model evaluation history
- model versions

其中模型权重是一种更 tangible 的技术资产：

- 可以形成独立文件；
- 可以版本化；
- 可以部署；
- 可以导出；
- 可以与 base model 组合；
- 可以在 held-out evaluation 中被独立测试。

同时，别人即使获得相同课程材料、Prompt 或 Skills，也不会自动获得 Creator 在真实任务校准过程中形成的 adapter weights。

---

## 8. 对 Hatch 的资产价值

Hatch 不以拥有 Creator 数据作为主要 moat。

Hatch 长期积累的是：

### Expert Data Production Infrastructure

即：

```text
真实任务
→ Agent execution
→ Creator calibration
→ Structured training data
→ Dataset versioning
→ Training
→ Eval
→ Regression
→ Deployment
```

Fine-tuning 本身正在快速商品化。

使用 Qwen、LoRA / QLoRA、TRL、Unsloth 等工具进行训练的工程门槛和 GPU 成本已经明显下降。对于数百条数据的实验，真正主要的成本通常不是 GPU，而是：

- expert time
- data construction
- preference annotation
- counterfactual construction
- edge cases
- blind evaluation



因此 Hatch 的核心技术资产不是训练算法本身，而是：

> **把真实专家工作持续转化为高质量、可训练、可评估数据的系统能力。**

---

## 9. 为什么比单纯 Prompt / Corpus 更难复制

Prompt、Skill 和 Knowledge 都属于显式软件资产。

它们可以被：

- 阅读；
- 导出；
- 重写；
- 重新组合；
- 在另一套 Agent framework 中实现。

Creator-specific model weights 来自另一类生产过程：

```text
真实 distribution
+
Agent mistakes
+
Creator calibration
+
Preference
+
Counterfactual
+
Repeated evaluation
```

竞争者即使能够复制 Agent 软件结构，也不能直接复制已经发生的专家校准历史和由其训练产生的参数。

因此新增 Fine-Tuning 后，Hatch 可以同时产生两类资产：

| 类型 | 形式 |
|---|---|
| Explicit Agent Assets | System / Skills / Knowledge / Tools |
| Parameterized Model Assets | LoRA / Model Weights |

两者共同建立在同一套 Hatch Factory、Runtime、Eval 和 Release infrastructure 上。

---

## 10. Fine-Tuning 的采用标准

Fine-tuning 不默认优于 Context Engineering。

每次训练都应该与现有方案比较：

```text
Base Model
Best System Prompt
Few-shot
Agent Corpus
Fine-tuned Model
```

并使用真正 held-out cases 评估。



只有当 Fine-Tuning 在以下至少一个维度产生实际增益时才部署：

- expert-aligned quality
- consistency
- decision-boundary accuracy
- tool-use behavior
- generalization
- deployment characteristics

这意味着 Hatch 增加的是一项新的 **model adaptation capability**，而不是用 Fine-Tuning 取代现有 Context / Harness Engineering。

---

## 11. 一句话架构定义

**Current**

```text
Creator Agent
=
System Prompt
+ Skills
+ Tools
+ Knowledge
+ Hatch Runtime / Eval / Release
```

**With Fine-Tuning**

```text
Creator Agent
=
Existing Context / Harness Engineering
+
Optional Creator-specific Model Adaptation
```

核心变化只有一个：

> **在已经存在的 Agent Corpus 和 Harness 基础上，增加把部分专家 judgment、behavior 和 agent policy 参数化进模型权重的能力。**

---

# 7. New Asset Class for Creators

在现有 Agent Corpus 基础上增加 Fine-Tuning 后，Creator 会新增一类独立的技术资产：**Creator-specific model assets**。

当前 Creator 在 Hatch 中主要拥有的是显式资产：

| Asset | 形式 |
|---|---|
| Source Materials | 课程、文章、案例、方法材料 |
| System Instructions | 全局行为与边界 |
| Skills | 可复用的方法和流程 |
| Knowledge | 专业知识、案例与长尾材料 |
| Product Configuration | Tools、Runtime、产品配置 |

Fine-Tuning 增加：

| New Asset | 形式 |
|---|---|
| Training Dataset | Creator 对真实消费者任务进行校准后形成的数据集 |
| LoRA Adapter | 基于特定 Base Model 的 Creator-specific 参数增量 |
| Merged Model | Base Model 与 Creator Adapter 合并后的独立模型 |
| Model Versions | 不同训练数据、Base Model 和训练方法产生的模型版本 |
| Evaluation Record | 每个模型版本在 Blind / Regression Eval 上的表现记录 |

LoRA 本身可以独立保存、版本化、部署和导出，并与对应的 Base Model 组合使用。

因此，Creator 的 AI 资产从单纯的：

```text
Content
+ Prompt
+ Skills
+ Knowledge
```

扩展为：

```text
Content
+ Agent Corpus
+ Training Dataset
+ Private Model Weights
```

这里的 Model Asset 不替代 Agent Corpus。

System、Skills、Knowledge 和 Tools 仍然承担动态知识、明确规则、运行时能力和可编辑配置；Fine-Tuning 只是进一步把其中适合参数化的 judgment、behavior 和 tool policy 写入模型参数。

### 7.1 更 Tangible 的技术资产

与 Prompt 或软件配置相比，Creator-specific model asset 具备几个明确的技术属性：

- 有独立的模型或 adapter 文件；
- 有明确的 Base Model dependency；
- 可以通过 digest / version 标识；
- 可以独立部署；
- 可以导出到其他兼容 inference infrastructure；
- 可以和其他模型版本进行定量 Eval；
- 可以持续通过新数据产生新版本。

因此它不仅是 Hatch 平台内部的一组配置，而是一项可以被 Creator 实际持有和迁移的技术/IP 资产。

这里不主张其具有特定的会计或财务资产属性；所指的是其作为**可保存、可版本化、可部署、可迁移的软件与模型资产**的性质。

### 7.2 更高的复制成本

System Prompt、Skills 和 Knowledge 都是显式资产。

获得相同内容后，另一方理论上可以重新实现相似的 Context / Harness Engineering。

Creator-specific model 的产生则依赖于另一组历史数据：

```text
真实消费者任务
+
Agent Output
+
Creator Calibration
+
Corrections / Preferences
+
Decision Boundaries
+
Training
+
Evaluation
```

因此，即使第三方获得相同课程、Prompt 或 Knowledge，也不会自动获得由历史消费者任务和 Creator calibration 产生的训练数据，更不会自动获得最终 adapter weights。

其复制成本不主要来自模型文件本身不可读取，而来自：

> **需要重新生产形成这些模型参数所依赖的专家校准历史。**

高价值的数据单位也不局限于 Question → Answer，而可以包括 Expert Answer、Rejected Alternative、Reason、Counterfactual、Decision Flip 和 Edge Case。

### 7.3 Creator Ownership

Hatch 不取得 Creator Data 的 ownership。

Creator-specific training data、LoRA adapter 和最终模型可以按照产品和合同约定归 Creator 所有，并允许 Creator 导出其 adapter / model asset。

Hatch 的产品原则因此可以表述为：

> **Creator owns the intelligence; Hatch provides the infrastructure used to produce it.**

对于使用真实消费者 interaction 形成训练数据的场景，需要另外取得适当的数据授权与用途许可。当前 Hatch V1 的数据边界仍然是不自动将 Buyer private data 纳入 Creator learning dataset。

---

# 8. Hatch Value Capture

Hatch 的商业价值不依赖于拥有 Creator 数据，也不依赖于禁止 Creator 导出模型。

Hatch 提供的是一套持续生产、训练、验证和运行 Creator-specific AI assets 的基础设施。

其完整技术链路包括：

```text
Consumer Task
→ Agent Runtime
→ Creator Calibration
→ Structured Dataset
→ Dataset Versioning
→ Training
→ Evaluation
→ Model Version
→ Deployment
→ New Calibration Data
```

其中真正具有持续价值的部分，不只是 Fine-Tuning 计算本身。

当前开源生态已经使 SFT、DPO、LoRA / QLoRA 等模型训练的计算门槛和 GPU 成本显著下降。对于数百条训练数据，真正主要的成本往往来自专家时间、数据构造、Preference、Counterfactual、Edge Case 和 Blind Evaluation，而不是单次 GPU Run。

因此 Hatch 的价值主要集中在三个商业层。

## 8.1 Creator Platform

Creator 首先使用 Hatch 完成：

- Agent Corpus construction；
- System / Skills / Knowledge management；
- Runtime；
- Eval；
- Regression；
- Release；
- Version management；
- Creator calibration workflow。

这些能力在 Creator 尚未达到 Fine-Tuning readiness 时已经独立产生价值。

对应的商业模式是持续的软件与基础设施收入，例如 Creator subscription、workspace 或 product-level SaaS fee。

---

## 8.2 Model Development

当 Creator 积累足够数据以后，Hatch进一步提供模型开发能力：

- Training readiness assessment；
- Dataset construction；
- Train / Validation / Blind Test split；
- Base Model selection；
- SFT；
- DPO；
- Trajectory Training；
- Candidate evaluation；
- Prompt / Corpus / Fine-Tuned baseline comparison；
- Adapter / Model versioning；
- Export。

这里出售的不是单纯的 GPU 时间。

GPU Training 本身正在商品化；Hatch 提供的是：

> **从真实专家 calibration 到一个经过验证的 Private Model Asset 的完整生产过程。**

因此这一层可以成为更高价值的 premium model-development service / infrastructure revenue。

---

## 8.3 Managed Model Infrastructure

即使 Creator 拥有并可以导出自己的 weights，也仍然需要长期运行模型所需的基础设施，包括：

- compatible Base Model management；
- LoRA loading；
- Multi-LoRA serving；
- inference deployment；
- autoscaling；
- GPU utilization management；
- model version routing；
- observability；
- rollback；
- security；
- regression testing；
- retraining。

因此：

```text
Creator owns the model
≠
Creator must operate the model infrastructure
```

Hatch 可以允许资产 portability，同时提供默认的 managed deployment environment。

商业上可以形成持续的：

- inference revenue；
- hosting fee；
- model management fee；
- usage-based infrastructure revenue。

这使 Hatch 不需要通过数据或模型 lock-in 获得持续收入。

Creator 可以带走资产；Hatch capture value 的基础是持续提供更方便、更完整的模型生产和运行基础设施。

---

## 8.4 Hatch 的核心商业资产

因此，Hatch 自身并不需要拥有所有 Creator 的训练数据。

Hatch 长期积累的是一套 **Expert Data and Model Production Infrastructure**：

```text
Agent Creation
+
Real-world Execution
+
Expert Calibration
+
Data Construction
+
Training
+
Evaluation
+
Deployment
```

其核心能力是：

> **以较低的专家时间成本，把真实专业服务中产生的 judgment 转化为可训练数据，并进一步转化为经过验证、可部署的 Creator-specific model assets。**

Hatch 的 Value Capture 来自持续提供这套基础设施，而不是取得 Creator intelligence 的所有权。
