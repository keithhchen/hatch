# 外贸官网诊断报告：组件参考 v1

报告只写 HTML 结构和文字，不写 CSS、不写绘图代码。样式和脚本固定在：

- `https://gethatchapp.com/report-assets/v1/report.css`
- `https://gethatchapp.com/report-assets/v1/report.js`

版本路径只做缺陷修复（浏览器缓存 1 小时），改版或破坏性改动一律走 `v2`。Agent 的电脑和买家浏览器都用这两个地址；PDF 用 Playwright 打开本地报告 HTML 时同样加载它们。

## 文件骨架

```html
<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>公司名 外贸官网获客诊断 · MSC咨询</title>
<link rel="stylesheet" href="https://gethatchapp.com/report-assets/v1/report.css"></head><body>
<script type="application/json" id="report-data">{…数据…}</script>
<main> …下面 9 个区块，按顺序… </main>
<footer></footer>
<script src="https://gethatchapp.com/report-assets/v1/report.js"></script></body></html>
```

加载层、环形分数、等级标尺、点阵、雷达图、条形图、D9 进度格、付费卡片、附录、页脚、滚动淡入、`@media print`、减少动态效果，全部由 CSS/JS 提供。区块标题上方的 `01 · ` 编号、红线与关键原因的 `01/02/03` 序号、「看到了什么 / 买家心里想的」标签也是自动生成，**不要自己写**。没有红线时整段 `#redlines` 删掉，编号自动顺延。

## 数据 `#report-data`（JSON，必须能被 `JSON.parse`）

```json
{"score":33,"dots":[71,11,12,6],"dims":[3.8,5.3,11.7,3,7,7,2.7,1.7,0],
 "total":{"sum":42.1,"deduct":9},"six":[0,0,0,0,0,0],
 "sources":["读取首页、About、产品页与 Contact 页","测速 · Google PageSpeed 移动端"],
 "items":[["D1","卖什么与卖给谁",1,"证据一句话","实测"]]}
```

- `score` 总分整数（等级和标尺自动算）。`dots` 四个数加起来 100：3 秒内离开 / 找不到信息 / 想联系没联系 / 发出询盘。
- `dims` 九维实得分，顺序 D1–D9（满分 15/8/14/12/14/14/8/5/10 已内置）；得分率 ≥55% 自动用渐变。
- `total` 页脚算式的「九维合计」和「雷区扣分」。`six` D9 的 6 个检查项各 0/1/2。
- `sources` 加载层来源，只写本次真正用到的。
- `items` 54 项，每项 `[维度, 项名, 0-2 分, 一句证据, "实测"或"推断"]`，按维度分组自动折叠。字符串里的英文引号写成 `\"` 或用 “ ”；不要出现 `</`。

## 区块（按 9.2 顺序）

渐变色文字用 `class="g"`。每个 `section` 的 `id` 固定，`.kicker` 只写区块名。

```html
<!-- 1 首屏判决 -->
<section class="hero"><div class="verdict"><div class="kicker">公司 · 目标市场</div>
<h1>这个官网每年大约让你错过 <b class="g">95 个询盘</b></h1>
<p>两句白话 + 一句定性</p><small>流量按多少估算的一行小字</small></div></section>

<!-- 2 买家去了哪：四个 <p> 依次是四种去向的原因，数字和颜色来自 dots -->
<section id="journey"><div class="kicker">买家去了哪</div><h2>标题</h2><p class="lead">导语，含同类好官网对照数</p>
<div class="journey"><p>3 秒内离开的原因</p><p>找不到信息的原因</p><p>想联系没联系的原因</p><p>发出询盘的原因</p></div></section>

<!-- 3 红线（如有） -->
<section id="redlines"><div class="kicker">红线</div><h2>标题</h2>
<div class="redline"><div><h3>一句话标题</h3><p>证据</p></div></div></section>

<!-- 4 三个关键原因：h3 + 证据在 .see，买家的话在 .think -->
<section id="reasons"><div class="kicker">三个关键原因</div><h2>标题</h2>
<div class="reason"><div class="see"><h3>标题</h3><p>引用原文、指出页面元素</p></div><p class="think">“采购口吻的一句话”</p></div></section>

<!-- 5 次要原因 -->
<section id="minor"><div class="kicker">次要原因</div><h2>标题</h2>
<div class="minors"><div><h3>标题</h3><p>一两句话</p></div><div>…</div><div>…</div></div></section>

<!-- 6 九维得分：雷达图、条形、合计算式由 dims/total 生成 -->
<section id="dimensions"><div class="kicker">九维得分</div><h2>标题</h2><p class="lead">一句话点出做得相对好的部分</p></section>

<!-- 7 可持续：大号 D9 分数、6 格进度条在左，自动生成 -->
<section id="sustain"><div class="kicker">可持续与社会影响</div><h2>标题</h2>
<div class="sus"><div class="sus-copy"><p>官网缺什么</p><p>海外客户通常会问什么</p></div></div></section>

<!-- 8 付费延伸服务：三张固定卡片和「联系你的 MSC咨询 顾问即可开通」自动生成 -->
<section id="services"><div class="kicker">付费延伸服务</div><h2>标题</h2><p class="lead">一句话</p></section>

<!-- 9 附录：折叠列表来自 items -->
<section id="appendix"><div class="kicker">附录</div><h2>54 个检查项，每一分都有页面证据</h2><p class="lead">打分说明</p></section>
```

页脚 `<footer></footer>` 留空，文字自动生成。

## 检查与 PDF

- 结构检查要解析**渲染后的 DOM**（`page.content()`），因为点阵、雷达、服务卡片、附录和页脚由脚本生成。
- 截图和 PDF 前先调 `page.evaluate("reportFinish()")`：去掉加载层、显示所有区块和最终数值、展开附录，不必等 6.5 秒。`page.pdf` 打印时也会自动触发同样的最终态。
- 打印样式已处理：加载层隐藏、动画元素为最终值、点阵/雷达/卡片/每条原因整块不拆页、不强制分页。
