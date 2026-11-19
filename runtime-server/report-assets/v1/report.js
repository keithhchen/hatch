/* Hatch audit report script, v1. Reads <script type="application/json" id="report-data"> and draws the data parts:
   loading overlay, score ring, level scale, 10x10 dots, radar and bars, D9 meter, paid services, appendix, footer.
   Frozen like report.css. window.reportFinish() jumps to the final state (screenshots, PDF). */
(() => {
  const NAMES = ["D1 首屏 3 秒", "D2 技术与性能", "D3 信息架构", "D4 内容与英文", "D5 信任与证明", "D6 转化路径", "D7 SEO 与 AI 搜索", "D8 设计与品牌", "D9 可持续与社会影响"];
  const MAX = [15, 8, 14, 12, 14, 14, 8, 5, 10];
  const LEVELS = [[0, 39, "名片型"], [40, 59, "目录型"], [60, 74, "可用型"], [75, 89, "获客型"], [90, 100, "增长引擎"]];
  const FLOW = ["3 秒内离开", "找不到信息", "想联系没联系", "发出询盘"];
  const SIX = ["独立页面", "年度数据", "第三方认证", "人权与供应链", "产品环境价值", "社会影响"];
  const SERVICES = [
    ["¥99", "听 3 个真实潜在客户怎么说", "AI 访谈 3 位目标市场的真实采购，看他们第一眼怎么看这个官网、哪里犹豫、会不会发询盘；5 个工作日内交付访谈 summary。"],
    ["¥99", "拿到细化的改进建议和参考样例", "每个问题怎么改、改成什么样，附同行做得好的页面作参考；3 个工作日。"],
    ["¥399", "全球行业数据、趋势和玩家报告", "品类的全球规模与趋势、主要玩家，以及他们怎么做官网和获客；3 个工作日。"]];
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const NS = "http://www.w3.org/2000/svg";

  let D;
  try { D = JSON.parse($("#report-data").textContent); } catch (e) {
    document.body.prepend(Object.assign(document.createElement("p"), { className: "report-error", textContent: "报告数据格式错误：" + e.message }));
    return;
  }
  const html = (el, s) => { el.innerHTML = s; return el; };

  // 1 hero: ring, level, scale
  const level = LEVELS.find(l => D.score >= l[0] && D.score <= l[1])[2];
  const hero = $(".hero");
  hero.prepend(html(Object.assign(document.createElement("div"), { className: "ring" }),
    `<svg viewBox="0 0 280 280"><defs><linearGradient id="ringGrad"><stop stop-color="#469A21"/><stop offset="1" stop-color="#0D7FBB"/></linearGradient></defs><circle class="bg" cx="140" cy="140" r="118"/><circle class="val" cx="140" cy="140" r="118"/></svg><div class="mid"><strong></strong><span>${level}</span></div>`));
  const ring = $(".ring");
  ring.style.setProperty("--p", D.score / 100);
  ring.style.setProperty("--s", Math.round(D.score));
  hero.append(html(Object.assign(document.createElement("div"), { className: "scale" }),
    LEVELS.map(l => `<div${l[2] === level ? ' class="on"' : ""}>${l[0]}–${l[1]}<br>${l[2]}</div>`).join("")));

  // 2 journey: the model writes four <p> reasons, in order
  const journey = $("#journey .journey");
  const why = [...journey.querySelectorAll("p")].map(p => p.innerHTML);
  const dots = D.dots.map((n, j) => Array.from({ length: n }, () => "abcd"[j]));
  journey.innerHTML = `<div class="dots" role="img" aria-label="100个买家流失点阵">${dots.flat().map((c, i) => `<i class="dot ${c}" style="--i:${i}"></i>`).join("")}</div>`
    + `<div class="jstats">${D.dots.map((n, j) => `<div class="jstat"><strong${j === 3 ? ' class="g"' : ""}>${n}</strong><p><b><i class="sw ${"abcd"[j]}"></i>${FLOW[j]}</b>${why[j] ?? ""}</p></div>`).join("")}</div>`;

  // 6 nine dimensions
  const R = 145, cx = 220, cy = 215, pt = (i, f) => { const a = -Math.PI / 2 + i * 2 * Math.PI / 9; return [cx + Math.cos(a) * R * f, cy + Math.sin(a) * R * f].map(v => v.toFixed(1)).join(","); };
  const ring9 = f => D.dims.map((_, i) => pt(i, f)).join(" ");
  const radar = `<svg class="radar" viewBox="0 0 460 440" role="img" aria-label="九维雷达图"><defs><linearGradient id="radarGrad" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#469A21" stop-opacity=".55"/><stop offset="1" stop-color="#0D7FBB" stop-opacity=".4"/></linearGradient></defs>`
    + [.25, .5, .75, 1].map(f => `<polygon class="ax${f === .75 ? " t75" : ""}" points="${ring9(f)}"/>`).join("")
    + D.dims.map((_, i) => `<line class="ax" x1="${cx}" y1="${cy}" x2="${pt(i, 1).replace(",", '" y2="')}"/><text x="${pt(i, 1.19).replace(",", '" y="')}" dy="4">D${i + 1}</text>`).join("")
    + `<polygon class="rv" points="${D.dims.map((v, i) => pt(i, v / MAX[i])).join(" ")}"/><text class="note" x="220" y="425">虚线为获客型 75% 水平</text></svg>`;
  const bars = `<div class="bars">${D.dims.map((v, i) => `<div><div class="bar-head"><span>${NAMES[i]}</span><b>${v} / ${MAX[i]}</b></div><div class="bar-track"><div class="bar-fill${v / MAX[i] >= .55 ? " hi" : ""}" style="--w:${(v / MAX[i] * 100).toFixed(1)}%"></div></div></div>`).join("")}</div>`;
  const scores = html(Object.assign(document.createElement("div"), { className: "scores" }), radar + bars);
  const dim = $("#dimensions");
  dim.append(scores, html(Object.assign(document.createElement("p"), { className: "total" }),
    `九维合计 <b>${D.total.sum}</b> 　−　雷区扣分 <b>${D.total.deduct}</b> 　＝　总分 <b>${D.score}</b>`));

  // 7 sustainability: the model writes .sus > .sus-copy
  $("#sustain .sus").prepend(html(document.createElement("div"),
    `<div class="sus-score">${D.dims[8]}<small> / 10</small></div><div class="six">${D.six.map(v => `<i style="--v:${v}"></i>`).join("")}</div><div class="six-labels">${SIX.map((s, i) => `<span>${s} ${D.six[i]}/2</span>`).join("")}</div>`));

  // 8 paid services: fixed content
  $("#services").append(html(Object.assign(document.createElement("div"), { className: "cards" }),
    SERVICES.map(s => `<div class="card"><div class="price">${s[0]}</div><h3>${s[1]}</h3><p>${s[2]}</p></div>`).join("")),
    Object.assign(document.createElement("p"), { className: "contact", textContent: "联系你的 MSC咨询 顾问即可开通" }));

  // 9 appendix: items are [dimension, label, score, evidence, confidence]
  const groups = NAMES.map((_, i) => D.items.filter(x => x[0] === "D" + (i + 1)));
  $("#appendix").append(...groups.map((g, i) => html(document.createElement("details"),
    `<summary>${NAMES[i]} · ${g.reduce((a, x) => a + x[2], 0)}/${g.length * 2}</summary>${g.map((x, k) => `<div class="check"><b>${x[2]}/2</b><div><strong>${k + 1}. ${esc(x[1])}</strong><span>${esc(x[3])} <small>（${esc(x[4])}）</small></span></div></div>`).join("")}`)));

  // 10 footer: fixed content
  html($("footer"), "<span>MSC咨询 · 外贸官网获客诊断</span><small>流失人数与询盘数为模型估算</small>");

  // scroll reveal: CSS draws dots, radar and bars once their section is .visible
  const sections = [...document.querySelectorAll("main>section:not(.hero)")];
  sections.forEach(s => s.classList.add("reveal"));
  const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add("visible"); io.unobserve(e.target); } }), { threshold: .08 });
  sections.forEach(s => io.observe(s));

  // loading overlay
  const loader = html(Object.assign(document.createElement("div"), { className: "loader" }),
    `<div class="loadbox"><div class="spinner"></div><div class="loadtitle">精准分析中…</div><div class="sources"><div>${D.sources.map(s => `<p>${esc(s)}</p>`).join("")}</div></div><div class="track"><div class="progress"></div></div><div class="percent">0%</div></div>`);
  document.body.prepend(loader);
  const lines = [...loader.querySelectorAll("p")], list = loader.querySelector(".sources div"), bar = loader.querySelector(".progress"), pct = loader.querySelector(".percent");
  const duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 500 : 6500, t0 = performance.now();
  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    loader.classList.add("done");
    setTimeout(() => loader.remove(), 700);
    document.body.classList.add("ready");
  }
  function tick(t) {
    if (finished) return;
    const p = Math.min(1, (t - t0) / duration), k = Math.min(lines.length - 1, Math.floor(p * lines.length));
    bar.style.width = p * 100 + "%";
    pct.textContent = Math.round(p * 100) + "%";
    list.style.setProperty("--k", k);
    lines.forEach((l, i) => l.classList.toggle("on", i === k));
    p < 1 ? requestAnimationFrame(tick) : finish();
  }
  requestAnimationFrame(tick);

  // final state for screenshots and PDF: no overlay, everything revealed, appendix open
  window.reportFinish = () => {
    finish();
    loader.remove();
    sections.forEach(s => s.classList.add("visible"));
    document.querySelectorAll("#appendix details").forEach(d => { d.open = true; });
  };
  addEventListener("beforeprint", window.reportFinish);
})();
