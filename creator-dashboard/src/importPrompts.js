/** The prompt an expert pastes into another AI to export what it has learned about their judgment. One per Studio locale. */
const en = `I want to export everything you have learned about how I think, judge, decide, and produce work in my area of expertise — the kind of work I most often do with you.

Review all memories, past conversations, tasks, revisions, feedback, choices between alternatives, and examples you have access to from my interactions with you.

I am NOT looking for generic preferences such as "I like concise answers." I want you to reconstruct my underlying taste, professional judgment, decision rules, heuristics, and quality standards.

Extract every distinct thing you have learned about me in the following areas. These categories are not exhaustive — if you have learned something relevant that does not fit them, include it as well:

* My overall philosophy of what makes work in my field good
* What I consider good, bad, interesting, boring, natural, forced, sophisticated, or clichéd work
* My aesthetic and professional taste
* My quality bar: when a draft, answer, or piece of work is good enough
* How I choose between two or more possible options
* How I judge details: individual words, numbers, steps, components, or decisions
* The language, tone, and style I use and expect
* What makes work feel genuine, alive, personal, or convincing to me
* What makes work feel generic, formulaic, over-polished, or AI-generated to me
* How I calibrate to the audience, client, or person I am working for
* How I diagnose a problem and find what really matters
* How I distinguish a genuine insight from a cliché or a forced conclusion
* How I structure work: openings, sequence, frameworks, outlines, endings
* How I decide what to keep, cut, expand, compress, or move
* How I revise: when I polish, rewrite, restructure, simplify, or leave something imperfect
* What I deliberately preserve even when it could technically be "better"
* Imperfections or exceptions I think make work better or more believable
* My recurring moves and techniques
* My recurring reasons for rejecting something
* Patterns, phrases, approaches, or devices I repeatedly dislike
* Patterns, phrases, approaches, or devices I repeatedly approve of
* Trade-offs I repeatedly make (for example originality vs. clarity, elegance vs. authenticity, speed vs. quality)
* How I adapt my approach for different people, cases, or situations
* How my approach changes depending on how much the other person contributes
* My bottom lines: what I will not do, recommend, or let through
* How I use AI in my work: which tasks I delegate, how I prompt, how I choose among options, and when I reject technically strong AI output because it does not feel right
* Differences in my standards across different kinds of work, if you have evidence of them
* Specific examples that strongly reveal my taste or judgment
* Counterexamples that reveal what I dislike
* Stable patterns you can infer from repeated choices, even if I never stated the rule
* Exceptions where I broke one of my usual rules, and what appears to have caused them
* Any other tacit knowledge, instinct, taste, rule, or decision pattern you have learned from me

Be extremely granular. "I prefer natural work" is not enough. Explain what "natural" appears to mean to me, based on my actual behavior and feedback.

Whenever possible, preserve my original wording verbatim, especially judgments such as "I like this because…", "This sounds too…", "This doesn't feel like…", "Give me something more…", "This is better.", "This sounds AI." or similar.

Clearly distinguish inferred patterns from things I explicitly said. Do not present an inference as a direct statement from me.

Do not invent preferences merely because they are common best practices in my field. Only include something if it is supported by my memories, previous conversations, edits, selections, rejections, or repeated behavior.

Do not collapse several observations into a vague summary. Preserve distinctions and edge cases. If two preferences appear to conflict, include both and explain the contexts in which each appeared.

For each entry, use this format:

[date, conversation, or source if available] - [category] - [EXPLICIT / INFERRED] - observation

When useful, append:
Evidence: my original wording, or a concise description of the edit or choice
Context: what I was working on at the time
Rule: the more general principle this example appears to reveal

Output everything inside ONE code block so I can copy it elsewhere.

Do not give me advice. Do not improve or reinterpret my philosophy. Do not tell me what good work in my field "should" be. Your task is to export what you have learned about MY judgment.

Do not omit an item because it seems minor, overly specific, contradictory, or hard to generalize. Those small decisions are especially valuable.

At the end of the code block, add:
COMPLETE: YES
if this is the complete set of relevant information you can currently access.

If there is relevant information you cannot access or retrieve, write:
COMPLETE: NO
and explain exactly what category of information remains inaccessible.`;

const zh = `我想导出你从我们的互动中学到的一切：我在自己的专业领域里如何思考、判断、做决定、产出作品——也就是我最常和你一起做的那类工作。

请回顾你能访问到的所有记忆、过往对话、任务、修改、反馈、我在多个选项之间的取舍，以及相关例子。

我要的不是“我喜欢简洁的回答”这类泛泛的偏好。我要你还原我底层的品味、专业判断、决策规则、经验法则和质量标准。

请把你学到的、关于我的每一条具体认识都提取出来，涵盖以下方面。这些类别并不完整——如果你学到的相关内容不属于其中任何一类，也请一并写出：

* 我认为在我的领域里，什么样的作品是好的——我的整体理念
* 我眼中好的、差的、有意思的、无聊的、自然的、刻意的、高级的、俗套的作品分别是什么样
* 我的审美和专业品味
* 我的质量标准：一份草稿、一个答案或一件作品什么时候算“够好了”
* 我如何在两个或多个选项之间做选择
* 我如何判断细节：单个的词、数字、步骤、组成部分或决定
* 我使用并期待的语言、语气和风格
* 什么让我觉得一件作品真实、有生命力、有个人色彩、有说服力
* 什么让我觉得一件作品空泛、套路化、过度打磨，或者像 AI 写的
* 我如何根据受众、客户或服务对象调整做法
* 我如何诊断问题、找到真正重要的东西
* 我如何区分真正的洞见和陈词滥调或硬凑的结论
* 我如何组织一件作品：开头、顺序、框架、提纲、结尾
* 我如何决定保留、删掉、展开、压缩或挪动什么
* 我如何修改：什么时候打磨、重写、调整结构、简化，什么时候故意不改完美
* 即使技术上可以“更好”，我也会刻意保留的东西
* 我认为能让作品更好、更可信的不完美或例外
* 我反复使用的手法和技巧
* 我反复用来否决某样东西的理由
* 我一再不喜欢的模式、说法、做法或手法
* 我一再认可的模式、说法、做法或手法
* 我反复做出的取舍（比如原创与清晰、优雅与真实、速度与质量）
* 我如何针对不同的人、案例或情境调整做法
* 对方投入多少，会如何改变我的做法
* 我的底线：我不会做、不会推荐、不会放行的东西
* 我如何在工作中使用 AI：把哪些任务交给 AI、怎么写提示词、怎么在多个选项中挑选，以及什么时候我会因为“感觉不对”而否决技术上很强的 AI 产出
* 如果有证据，我对不同类型工作的标准有什么差别
* 最能体现我品味或判断的具体例子
* 能体现我不喜欢什么的反例
* 即使我从未明说，你也能从我反复的选择中推断出的稳定规律
* 我打破自己惯常规则的例外，以及似乎是什么导致了这些例外
* 你从我这里学到的任何其他隐性知识、直觉、品味、规则或决策模式

请极度细致。“我喜欢自然的作品”是不够的。请根据我实际的行为和反馈，解释“自然”对我来说具体意味着什么。

尽可能逐字保留我的原话，尤其是这类判断：“我喜欢这个，因为……”、“这听起来太……”、“这感觉不像……”、“给我更……的”、“这个更好。”、“这听起来像 AI。”等等。

请清楚区分推断出的规律和我明确说过的话。不要把推断当成我的原话。

不要因为某样东西是我这个领域常见的最佳实践，就编造成我的偏好。只有当它有我的记忆、过往对话、修改、选择、否决或反复行为作为依据时，才写进来。

不要把几条不同的观察合并成一句笼统的总结。保留区别和边界情况。如果两条偏好看起来互相矛盾，两条都写，并说明各自出现的情境。

每一条请使用以下格式：

[日期、对话或来源（如有）] - [类别] - [EXPLICIT / INFERRED] - 观察

需要时补充：
Evidence：我的原话，或对那次修改/选择的简要描述
Context：我当时在做什么
Rule：这个例子体现出的更一般的原则

把所有内容放在同一个代码块里输出，方便我复制到别处。

不要给我建议。不要改进或重新诠释我的理念。不要告诉我这个领域的好作品“应该”是什么样。你的任务是导出你学到的、关于我自己的判断。

不要因为某一条看起来很小、太具体、自相矛盾或难以概括就省略它。这些细小的决定恰恰最有价值。

在代码块的最后加上：
COMPLETE: YES
如果这是你目前能访问到的全部相关信息。

如果还有你无法访问或取回的相关信息，请写：
COMPLETE: NO
并具体说明哪一类信息无法访问。`;

const ja = `あなたが私とのやり取りから学んだことを、すべて書き出してほしいです。私が自分の専門分野で、どう考え、どう判断し、どう決め、どう成果物をつくるか――つまり、私があなたと一番よく一緒にしている種類の仕事についてです。

あなたがアクセスできる記憶、過去の会話、タスク、修正、フィードバック、複数の選択肢からの取捨選択、具体例をすべて見直してください。

「簡潔な回答が好き」のような一般的な好みが欲しいわけではありません。私の根底にある感覚（センス）、専門的な判断、意思決定のルール、経験則、品質基準を再構成してほしいのです。

以下の分野について、私について学んだことを一つ残らず抽出してください。これらの分類は網羅的ではありません。どれにも当てはまらない関連事項を学んでいれば、それも含めてください：

* 私の分野で何が良い仕事なのかについての、私の全体的な考え方
* 私にとって良い／悪い／面白い／退屈／自然／不自然／洗練された／ありきたりな仕事とは何か
* 私の美的感覚とプロとしてのセンス
* 私の品質基準：下書き、回答、成果物がいつ「十分に良い」と言えるか
* 二つ以上の選択肢からどう選ぶか
* 細部をどう判断するか：一つひとつの言葉、数字、手順、構成要素、決定
* 私が使い、期待する言葉づかい、トーン、スタイル
* 何があると、私は仕事を本物で、生きていて、個人的で、説得力があると感じるか
* 何があると、私は仕事を平凡、型通り、磨きすぎ、または AI が作ったように感じるか
* 相手（読み手、クライアント、支援する人）に合わせてどう調整するか
* 問題をどう見立て、本当に大事なことをどう見つけるか
* 本物の洞察と、決まり文句や無理やりの結論をどう見分けるか
* 仕事をどう組み立てるか：書き出し、順序、フレームワーク、構成案、締めくくり
* 何を残し、削り、広げ、縮め、移すかをどう決めるか
* どう直すか：いつ磨き、書き直し、構成を変え、単純化し、あえて不完全なまま残すか
* 技術的には「もっと良く」できても、あえて残すもの
* 仕事をより良く、より信じられるものにすると私が考える不完全さや例外
* 私が繰り返し使う手法やテクニック
* 何かを却下するときの、繰り返し出てくる理由
* 私が繰り返し嫌うパターン、言い回し、やり方、手法
* 私が繰り返し認めるパターン、言い回し、やり方、手法
* 私が繰り返し行うトレードオフ（例：独創性と分かりやすさ、優雅さと本物らしさ、速さと質）
* 人、ケース、状況によってやり方をどう変えるか
* 相手がどれだけ関わるかによって、私のやり方がどう変わるか
* 私の譲れない一線：私がやらないこと、勧めないこと、通さないこと
* 私が仕事で AI をどう使うか：どの作業を任せるか、どう指示を書くか、複数の案からどう選ぶか、技術的に優れた AI の出力を「しっくりこない」という理由で却下するのはどんなときか
* 根拠があれば、仕事の種類による基準の違い
* 私のセンスや判断がよく表れている具体例
* 私が何を嫌うかが分かる反例
* 私が明言したことがなくても、繰り返しの選択から推測できる安定したパターン
* 私がいつものルールを破った例外と、その原因と思われるもの
* あなたが私から学んだ、その他の暗黙知、直感、センス、ルール、判断のパターン

とことん細かく書いてください。「自然な仕事が好き」では不十分です。私の実際の行動とフィードバックに基づいて、私にとって「自然」が何を意味するのかを説明してください。

できる限り、私の言葉をそのまま残してください。特に「これが好きなのは……だから」「これは……すぎる」「これは……っぽくない」「もっと……なものを」「こっちの方がいい」「これは AI っぽい」などの判断です。

推測したパターンと、私がはっきり言ったことを明確に区別してください。推測を私の発言として書かないでください。

私の分野でよくあるベストプラクティスだという理由だけで、好みをでっち上げないでください。私の記憶、過去の会話、修正、選択、却下、繰り返しの行動に裏付けがあるものだけを含めてください。

複数の観察を一つのあいまいな要約にまとめないでください。違いや境界のケースを残してください。二つの好みが矛盾しているように見える場合は両方を書き、それぞれが現れた状況を説明してください。

各項目は次の形式で書いてください：

[日付、会話、または出典（分かれば）] - [分類] - [EXPLICIT / INFERRED] - 観察

必要に応じて追記：
Evidence：私の元の言葉、または修正・選択の簡潔な説明
Context：そのとき私が取り組んでいたこと
Rule：この例が示している、より一般的な原則

すべてを一つのコードブロックの中に出力してください。別の場所にコピーできるようにするためです。

アドバイスはしないでください。私の考え方を改善したり、解釈し直したりしないでください。私の分野の良い仕事が「どうあるべきか」も言わないでください。あなたの役割は、私自身の判断について学んだことを書き出すことです。

小さすぎる、具体的すぎる、矛盾している、一般化しにくいといった理由で項目を省かないでください。そうした小さな判断こそ特に価値があります。

コードブロックの最後に、次を追加してください：
COMPLETE: YES
（今アクセスできる関連情報がこれですべての場合）

アクセスできない、または取り出せない関連情報がある場合は：
COMPLETE: NO
と書き、どの種類の情報にアクセスできないのかを具体的に説明してください。`;

export const IMPORT_PROMPTS = { en, zh, ja };

/** The prompt for a Studio locale; any locale without its own prompt gets English. */
export const importPrompt = locale => IMPORT_PROMPTS[String(locale || "").slice(0, 2)] ?? en;
