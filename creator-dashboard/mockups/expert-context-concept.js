const screens = new Map([
  ["home", "概览"],
  ["context", "材料库"],
  ["ideas", "Ideas · 方法论"],
  ["workbench", "工作台"],
  ["offers", "输出形态"],
  ["interactions", "互动"],
  ["business", "经营"],
  ["settings", "设置与连接"],
]);

const addDialog = document.querySelector("#addDialog");
const ideaDialog = document.querySelector("#ideaDialog");
const addForm = document.querySelector("#addForm");
const ideaForm = document.querySelector("#ideaForm");
const contributionList = document.querySelector("#contributionList");
const detailBody = document.querySelector("#detailBody");
const toast = document.querySelector("#toast");
const workstationHelp = document.querySelector("#workstationHelp");
const copyPrompt = document.querySelector("#copyPrompt");
const channelLabels = new Map([
  ["note", "随手记录"],
  ["voice", "Creator Factory 语音 Agent 采访"],
  ["upload", "照片或文件"],
  ["link", "文章链接"],
  ["workstation", "Codex / Claude Code 工作台提取"],
  ["interaction", "售前或订阅用户互动"],
  ["api", "API / MCP"],
]);

let selectedChannel = "note";
let selectedAudience = "private";
let toastTimer;
let selectedOutput = "专家自用";
const outputConfigurations = new Map([
  ["内容创作", { "clear-problem": true, "long-term": true }],
  ["专家自用", { "clear-problem": true, "long-term": true }],
  ["获客机器人", { "clear-problem": true, "long-term": false }],
  ["完整 Agent", { "clear-problem": true, "long-term": true }],
]);

function announce(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 3000);
}

function showScreen(name) {
  if (!screens.has(name)) return;
  document.querySelectorAll(".screen").forEach((screen) => {
    screen.classList.toggle("is-active", screen.id === `screen-${name}`);
  });
  document.querySelectorAll("[data-screen]").forEach((button) => {
    if (button.dataset.screen === name) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.querySelector("#breadcrumb").textContent = `专家空间 / ${screens.get(name)}`;
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function selectChannel(channel) {
  selectedChannel = channelLabels.has(channel) ? channel : "note";
  document.querySelectorAll("[data-channel-choice]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.channelChoice === selectedChannel));
  });
  const isWorkstation = selectedChannel === "workstation";
  workstationHelp.hidden = !isWorkstation;
  copyPrompt.hidden = !isWorkstation;
  document.querySelector("#entryBody").placeholder = isWorkstation
    ? "粘贴 Codex、Claude Code 等工作台生成的内容。"
    : "写下一段想法，或说明这份材料是什么。";
  document.querySelector("#entryTitle").placeholder = selectedChannel === "workstation"
    ? "例如：关于团队决策的工作记录"
    : "例如：我对带团队的一点观察";
}

function openAddDialog(channel = "note", { title = "", body = "" } = {}) {
  addForm.reset();
  document.querySelector("#entryTitle").value = title;
  document.querySelector("#entryBody").value = body;
  selectChannel(channel);
  addDialog.showModal();
  if (!title) document.querySelector("#entryTitle").focus();
}

function audienceLabel(kind) {
  return ({ private: "仅自己", subscriber: "订阅者", public: "公开", review: "待整理" })[kind] ?? "仅自己";
}

function createContribution({ title, body, channel, audience = "private" }) {
  const row = document.createElement("article");
  row.className = "contribution-row";
  row.dataset.kind = audience;
  row.dataset.id = `new-${Date.now()}`;
  row.setAttribute("aria-selected", "false");
  row.tabIndex = 0;

  const icon = document.createElement("span");
  icon.className = "source-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = ({ voice: "♫", upload: "▧", link: "↗", workstation: "⌘", interaction: "◌", api: "⌁" })[channel] ?? "✎";

  const copy = document.createElement("span");
  copy.className = "item-copy";
  const strong = document.createElement("strong");
  strong.textContent = title;
  const small = document.createElement("small");
  small.textContent = `${channelLabels.get(channel)} · 等待整理`;
  copy.append(strong, small);

  const meta = document.createElement("span");
  meta.className = "item-meta";
  const audienceNode = document.createElement("span");
  audienceNode.className = `audience ${audience === "private" ? "private" : ""}`;
  const mark = document.createElement("i");
  mark.className = "audience-mark";
  const label = document.createElement("span");
  label.textContent = audienceLabel(audience);
  audienceNode.append(mark, label);
  const date = document.createElement("span");
  date.className = "date-label";
  date.textContent = "刚刚";
  meta.append(audienceNode, date);
  row.append(icon, copy, meta);
  row.dataset.body = body;
  contributionList.prepend(row);
  row.click();
  return row;
}

function updateDetail(row) {
  document.querySelectorAll(".contribution-row").forEach((item) => item.setAttribute("aria-selected", String(item === row)));
  const title = row.querySelector(".item-copy strong").textContent;
  const source = row.querySelector(".item-copy small").textContent;
  const excerpt = row.dataset.body || "这份材料可以关联到一个或多个 Ideas，作为方法依据或案例。";
  detailBody.querySelector(".detail-source strong").textContent = title;
  detailBody.querySelector(".detail-source small").textContent = source;
  detailBody.querySelector(".detail-excerpt").textContent = excerpt;
  selectedAudience = ["private", "subscriber", "public"].includes(row.dataset.kind) ? row.dataset.kind : "private";
  document.querySelectorAll("[data-audience]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.audience === selectedAudience));
  });
  document.querySelector("#detailStatus").textContent = `当前范围：${audienceLabel(selectedAudience)}`;
}

function addIdeaCard(title, description) {
  const card = document.createElement("article");
  card.className = "feature-card idea-card";
  const header = document.createElement("div");
  header.style.cssText = "display:flex;justify-content:space-between;gap:8px";
  const icon = document.createElement("span");
  icon.className = "source-icon";
  icon.textContent = "✧";
  const badge = document.createElement("span");
  badge.className = "concept-tag";
  badge.textContent = "个人使用";
  header.append(icon, badge);
  const heading = document.createElement("h2");
  heading.textContent = title;
  const copy = document.createElement("p");
  copy.textContent = description || "尚未添加说明。你可以关联支撑材料，运行 Idea 查看结果。";
  const tags = document.createElement("div");
  tags.className = "filter-row";
  tags.style.padding = "0 0 13px";
  const materialTag = document.createElement("span");
  materialTag.className = "tag";
  materialTag.textContent = "0 份支撑材料";
  tags.append(materialTag);
  const button = document.createElement("button");
  button.className = "primary-button";
  button.dataset.action = "run-idea";
  button.dataset.ideaName = title;
  button.textContent = "运行并查看结果";
  card.append(header, heading, copy, tags, button);
  document.querySelector("#screen-ideas .cards-grid").prepend(card);
}

function selectOutput(name, button) {
  selectedOutput = name;
  document.querySelector("#selectedOutputName").textContent = name;
  document.querySelectorAll("[data-output]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
  const settings = outputConfigurations.get(name) ?? { "clear-problem": false, "long-term": false };
  document.querySelectorAll("[data-output-idea]").forEach((input) => {
    input.checked = settings[input.dataset.outputIdea] ?? false;
  });
}

document.addEventListener("click", (event) => {
  const screenButton = event.target.closest("[data-screen], [data-screen-link]");
  if (screenButton) {
    showScreen(screenButton.dataset.screen ?? screenButton.dataset.screenLink);
    return;
  }

  const filter = event.target.closest("[data-filter]");
  if (filter) {
    document.querySelectorAll("[data-filter]").forEach((button) => button.setAttribute("aria-pressed", String(button === filter)));
    document.querySelectorAll(".contribution-row").forEach((row) => {
      row.hidden = filter.dataset.filter !== "all" && row.dataset.kind !== filter.dataset.filter;
    });
    return;
  }

  const row = event.target.closest(".contribution-row");
  if (row) {
    updateDetail(row);
    return;
  }

  const audience = event.target.closest("[data-audience]");
  if (audience) {
    selectedAudience = audience.dataset.audience;
    document.querySelectorAll("[data-audience]").forEach((button) => button.setAttribute("aria-pressed", String(button === audience)));
    document.querySelector("#detailStatus").textContent = `待保存：${audienceLabel(selectedAudience)}`;
    return;
  }

  const channelButton = event.target.closest("[data-channel-choice]");
  if (channelButton) {
    selectChannel(channelButton.dataset.channelChoice);
    return;
  }

  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) return;

  const { action } = actionButton.dataset;
  if (action === "add" || action === "add-channel") openAddDialog(actionButton.dataset.channel ?? "note");
  if (action === "capture") announce("将从 Creator Factory 打开现有的语音 Agent 采访入口；采访对象是专家本人。");
  if (action === "workstation") openAddDialog("workstation");
  if (action === "close-dialog") addDialog.close();
  if (action === "close-idea-dialog") ideaDialog.close();
  if (action === "show-toast") announce(actionButton.dataset.message);
  if (action === "all-context") announce("当前展示最近材料；完整材料库属于概念稿界面范围。");
  if (action === "start-writing") announce("写作工作区会选择 Idea 与材料，再展示可继续编辑的草稿。");
  if (action === "start-cowork") announce("协作工作区会保留你与 Agent 各自完成的内容。");
  if (action === "idea-materials") announce(`${actionButton.dataset.ideaName} 的支撑材料列表已在概念稿中选中。`);
  if (action === "run-idea") {
    showScreen("workbench");
    document.querySelector("#ideaRunResult").hidden = false;
    document.querySelector("#ideaRunResult .concept-tag").textContent = actionButton.dataset.ideaName;
    document.querySelector("#ideaRunResult .detail-excerpt").textContent = `示例结果：使用「${actionButton.dataset.ideaName}」处理当前问题后，先明确目标、限制与可验证的下一步。`;
    announce(`已展示「${actionButton.dataset.ideaName}」的示例运行结果。`);
  }
  if (action === "new-idea") {
    ideaForm.reset();
    ideaDialog.showModal();
    document.querySelector("#ideaTitle").focus();
  }
  if (action === "promote") openAddDialog("interaction", { title: actionButton.dataset.question, body: "来自售前或订阅互动的问题。请补充你的观点，再决定是否关联到某个 Idea。" });
  if (action === "offer-settings") showScreen("offers");
  if (action === "select-output") {
    selectOutput(actionButton.dataset.output, actionButton);
    announce(`正在配置「${actionButton.dataset.output}」可使用的 Ideas。`);
  }
  if (action === "screen-link") showScreen(actionButton.dataset.target);
});

document.querySelector("#saveAudience").addEventListener("click", () => {
  const selectedRow = document.querySelector('.contribution-row[aria-selected="true"]');
  if (selectedRow) {
    selectedRow.dataset.kind = selectedAudience;
    const audienceText = selectedRow.querySelector(".audience");
    audienceText.className = `audience ${selectedAudience === "private" ? "private" : ""}`;
    audienceText.querySelector("span").textContent = audienceLabel(selectedAudience);
  }
  document.querySelector("#detailStatus").textContent = `当前范围：${audienceLabel(selectedAudience)}`;
  announce("示例材料范围已在当前页面更新。");
});

document.querySelector("#helpButton").addEventListener("click", () => announce("这是独立概念稿，页面中的数据和操作只存在于当前浏览器页面。"));
document.querySelector("#moreDetail").addEventListener("click", () => announce("材料的编辑、归档与删除菜单属于概念稿中的后续界面。"));

document.querySelectorAll("[data-idea-offer]").forEach((input) => {
  input.addEventListener("change", () => announce(`${input.getAttribute("aria-label")}：${input.checked ? "已包含" : "已移出"}（仅当前页面示例状态）`));
});

document.querySelectorAll("[data-output-idea]").forEach((input) => {
  input.addEventListener("change", () => {
    const settings = outputConfigurations.get(selectedOutput);
    settings[input.dataset.outputIdea] = input.checked;
    announce(`「${selectedOutput}」${input.checked ? "已包含" : "已移出"}此 Idea（当前页面示例状态）。`);
  });
});

copyPrompt.addEventListener("click", async () => {
  const prompt = "请从这段工作记录中提取值得长期保留的经验、判断依据或方法。保留必要上下文，区分事实与推测；不要包含密钥、客户隐私或无关内容。请给出简洁标题、原始片段和来源说明。";
  await navigator.clipboard.writeText(prompt);
  announce("提示词已复制。粘贴到 Codex、Claude Code 等工作台，完成后把结果复制回材料框。");
});

addForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const title = document.querySelector("#entryTitle").value.trim();
  const body = document.querySelector("#entryBody").value.trim();
  if (!title) return;
  const item = createContribution({ title, body, channel: selectedChannel });
  addDialog.close();
  showScreen("context");
  document.querySelectorAll("[data-filter]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.filter === "all")));
  document.querySelectorAll(".contribution-row").forEach((row) => { row.hidden = false; });
  updateDetail(item);
  announce("示例材料已加入当前页面，可稍后关联到一个 Idea。");
});

ideaForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const title = document.querySelector("#ideaTitle").value.trim();
  const description = document.querySelector("#ideaDescription").value.trim();
  if (!title) return;
  addIdeaCard(title, description);
  ideaDialog.close();
  showScreen("ideas");
  announce(`示例 Idea「${title}」已添加。`);
});
