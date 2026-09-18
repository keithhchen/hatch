import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Factory UI derives every session API from the current Product', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.match(source, /\/v1\/creator\/products\/\$\{encodeURIComponent\(productId\)\}\/factory-agents/);
  assert.doesNotMatch(source, /['"`]\/v1\/creator\/factory-agents/);
  assert.doesNotMatch(source, /evaluation-targets|method:\s*['"]PUT['"].*target/);
});

test('Product cards enter the canonical Product overview', async () => {
  const source = await readFile(new URL('./CreatorPortalV2.jsx', import.meta.url), 'utf8');
  assert.match(source, /creatorProductPath\(idOf\(product, "product"\)\)/);
  assert.doesNotMatch(source, /href="\/studio\/factory"/);
});

test('Factory header uses the real Product name and removes the inspector heading', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.match(source, /productName\s*\|\|\s*t\("product"\)/);
  assert.doesNotMatch(source, /\{productId\}<\/Typography>/);
  assert.doesNotMatch(source, /<Typography variant="subtitle1" fontWeight=\{750\}>\{t\("nextSteps"\)\}<\/Typography>/);
  assert.doesNotMatch(source, /backToStage/);
  assert.doesNotMatch(source, /<Refresh/);
  assert.match(source, /entry\?\.state === "complete" \|\| entry\?\.state === "update_available"/);
});

test('Factory navigation is URL-controlled down to the Agent page', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  const portal = await readFile(new URL('./CreatorPortalV2.jsx', import.meta.url), 'utf8');
  assert.match(source, /navigate\(creatorFactoryPath\(productId, nextStage, nextAgent\)\)/);
  assert.match(source, /const stage = section \?\? null/);
  assert.match(source, /const selected = agent \?\? null/);
  assert.doesNotMatch(source, /setStage\(|setSelected\(/);
  assert.match(portal, /section=\{route\.factorySection\}/);
  assert.match(portal, /agent=\{route\.factoryAgent\}/);
});

test('Factory overview removes duplicate chrome without removing real navigation', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /<Avatar[^>]*>F<\/Avatar>/);
  assert.doesNotMatch(source, /<Chip size="small" label=\{t\("factory"\)\} variant="outlined"/);
  assert.doesNotMatch(source, /<Typography variant="overline" color="primary\.main"[^>]*>\{t\("factory"\)\}<\/Typography>/);
  assert.doesNotMatch(source, /<Typography variant="overline" color="text\.secondary"[^>]*>\{t\("factory"\)\}<\/Typography>/);
  assert.doesNotMatch(source, /bgcolor: "#fbfcfe", borderBottom: 1, borderColor: "divider"\}\}><Typography variant="subtitle2" fontWeight=\{750\}>\{t\("factory"\)\}/);
  assert.match(source, /<SimpleTreeView/);
  assert.match(source, /onClick=\{\(\) => goToFactory\(id\)\}/);
  assert.match(source, /onClick=\{\(\) => onOpenAgent\(entry\.role\)\}/);
});

test('Factory overview is the first live Product page and retires the old workflow pages', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  const portal = await readFile(new URL('./CreatorPortalV2.jsx', import.meta.url), 'utf8');
  assert.match(source, /<TreeItem itemId="overview"/);
  assert.match(source, /<Typography variant="h4"[^>]*>\{t\("productOverview"\)\}/);
  assert.match(source, /expected_updated_at: product\.updated_at/);
  assert.match(source, /<TextField label=\{t\("productName"\)\}/);
  assert.match(source, /<TextField label=\{t\("productPromise"\)\}/);
  assert.match(portal, /FactoryProductRedirect/);
  assert.doesNotMatch(portal, /CreatorProductOverview/);
});

test('Upload sources is a peer Factory page with real file upload and no duplicate stage card', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.match(source, /FACTORY_SECTION_PAGES/);
  assert.match(source, /selected === "uploads"/);
  assert.match(source, /function SourceUploadWorkspace/);
  assert.match(source, /input\/manual\//);
  assert.match(source, /<input ref=\{importPicker\} hidden type="file"(?:[^>]*)multiple/);
  assert.match(source, /function StageOverview\(\{ stage, agents, sessions, agentName, onOpenAgent, locale, t \}\)/);
});

test('Deep Research starts from Creator identity and public evidence, not manual upload', async () => {
  const i18n = await readFile(new URL('./factoryAgentsI18n.js', import.meta.url), 'utf8');
  const prompt = await readFile(new URL('../../runtime-server/prompts/factory-agents/research/SYSTEM.md', import.meta.url), 'utf8');
  assert.match(i18n, /research: '告诉 Agent 你是谁、做什么，以及它可以在哪里找到你的公开资料/);
  assert.match(i18n, /sourcesStage: '认识 Creator'/);
  assert.match(prompt, /不是一个等待用户整理资料的资料摄入 Agent/);
  assert.match(prompt, /主动使用 web_search、web_scrape 和 youtube_transcript/);
  assert.match(prompt, /不要一开始就要求用户上传文件/);
});

test('Voice Interview is a whole-person interview rather than a single-judgment prompt', async () => {
  const i18n = await readFile(new URL('./factoryAgentsI18n.js', import.meta.url), 'utf8');
  const prompt = await readFile(new URL('../../runtime-server/prompts/factory-agents/voice/SYSTEM.md', import.meta.url), 'utf8');
  assert.match(i18n, /voice: '从你的经历、影响、价值取舍、审美和矛盾讲起/);
  assert.doesNotMatch(i18n, /voice: '说说你最近做过的一次判断，以及为什么这样决定/);
  assert.match(prompt, /1\. Intellectual Genealogy/);
  assert.match(prompt, /9\. Tensions & Contradictions/);
  assert.match(prompt, /specific cases.*not abstractions/);
});

test('Agent Builder owns the judgment design and receives review-oriented user input', async () => {
  const i18n = await readFile(new URL('./factoryAgentsI18n.js', import.meta.url), 'utf8');
  const prompt = await readFile(new URL('../../runtime-server/prompts/factory-agents/generation/SYSTEM.md', import.meta.url), 'utf8');
  assert.match(i18n, /generation: '查看 Agent 构建的结果，或指出需要调整的地方/);
  assert.doesNotMatch(i18n, /generation: '说明这个 Agent 应该如何判断和行动/);
  assert.match(prompt, /先理解产品要完成的工作，再编写判断、行动、条件、例外与完成标准/);
});

test('Case Builder creates the client case and receives realism feedback', async () => {
  const i18n = await readFile(new URL('./factoryAgentsI18n.js', import.meta.url), 'utf8');
  const prompt = await readFile(new URL('../../runtime-server/prompts/factory-agents/case-generation/SYSTEM.md', import.meta.url), 'utf8');
  assert.match(i18n, /'case-generation': '查看 Agent 构建的客户案例，或指出哪里不符合真实情况/);
  assert.doesNotMatch(i18n, /'case-generation': '描述一个真实客户会遇到的情境/);
  assert.match(prompt, /每次准备一个完整客户案例/);
  assert.match(prompt, /构造有生活质感、内在一致的情境/);
});

test('Factory connection errors use a floating toast and plain-language copy', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  const i18n = await readFile(new URL('./factoryAgentsI18n.js', import.meta.url), 'utf8');
  assert.match(source, /<Snackbar open=\{Boolean\(error\)\}/);
  assert.match(source, /anchorOrigin=\{\{ vertical: "bottom", horizontal: "right" \}\}/);
  assert.doesNotMatch(source, /function ErrorNotice\(\{ error \}\) \{ return error \? <Alert/);
  assert.match(i18n, /workspaceConnectionLost: '连接暂时中断，正在恢复。'/);
  assert.doesNotMatch(i18n, /与工作区服务的连接中断/);
});

test('Factory JSX keeps visible copy in i18n and reads Agent identity from database definitions', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /[\u3400-\u9fff]/);
  assert.match(source, /localizeAgentText\(entry\.name, locale\)/);
  assert.match(source, /localizeAgentText\(entry\.hint, locale\)/);
  assert.match(source, /sort\(\(a, b\) => a\.order - b\.order\)/);
  assert.doesNotMatch(source, /const ROLES|researchDescription|caseDescription/);
});

test('Factory uses live dependency state at each interaction boundary', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.match(source, /changedDependencies\(entry, agents\)/);
  assert.match(source, /const composerDisabled = locked \|\| busy \|\| Boolean\(pendingAskUser\) \|\| !config\?\.services\.model/);
  assert.match(source, /<ChatComposer disabled=\{composerDisabled\}/);
  assert.match(source, /const targetStage = factorySectionForAgent\(role\)/);
  assert.doesNotMatch(source, /availability\?\.updatedDependencies/);
  assert.doesNotMatch(source, /comments\/export|annotateLines|line-selection|lineSelection/);
});

test('Factory composer exposes send, stop, and disabled states without a focus ring', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.match(source, /<IconButton type="submit" aria-label=\{t\("send"\)\} disabled=\{sendDisabled\}[^>]*>\s*<Send/);
  assert.match(source, /const sendDisabled = composerDisabled \|\| !\(draft \|\| ""\)\.trim\(\)/);
  assert.match(source, /running \? <IconButton type="button" aria-label=\{t\("stop"\)\}/);
  assert.match(source, /disabled=\{busy\} size="small"/);
  assert.match(source, /const composerSx = .*"&:focus-within": \{ borderColor: "var\(--hatch-ui-border-soft\)", boxShadow: "none" \}/);
  assert.match(source, /<ChatComposerTextArea[^>]*disabled=\{running\}/);
});

test('Factory askuser options are content-only single-line choices with free input', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.match(source, /function askUserOption\(option, index\).*content/);
  assert.match(source, /label=\{option\.content\}/);
  assert.match(source, /<TextField disabled=\{!pending \|\| submitting\}/);
  assert.doesNotMatch(source, /option\.(label|description)/);
});

test('Every chat offers a start button that fills the Composer without sending', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  const i18n = await readFile(new URL('./factoryAgentsI18n.js', import.meta.url), 'utf8');
  assert.match(source, /<StartAgentButton role=\{session\.role\}/);
  assert.match(source, /function StartAgentButton/);
  assert.match(source, /setDraft\(current => current\.trim\(\) \? current : message\)/);
  assert.match(source, /requestAnimationFrame\(\(\) => composer\.current\?\.focus\(\)\)/);
  assert.match(i18n, /startAgentMessage: role =>/);
});

test('Factory chat keeps scrolling inside the workbench pane', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  const portal = await readFile(new URL('./CreatorPortalV2.jsx', import.meta.url), 'utf8');
  const portalStyles = await readFile(new URL('./creatorPortalV2.css', import.meta.url), 'utf8');
  const factoryStyles = await readFile(new URL('./factoryAgents.css', import.meta.url), 'utf8');
  assert.match(portal, /cpv2-main\$\{route\.kind === "factory-agents"/);
  assert.match(source, /className="factory-chat-scroll"/);
  assert.match(source, /overscrollBehavior: "contain"/);
  assert.match(`${portalStyles}\n${factoryStyles}`, /\.cpv2-main--workbench\s*\{[^}]*overflow:\s*hidden/);
  assert.match(factoryStyles, /\.factory-chat-scroll\s*\{[^}]*overscroll-behavior:\s*contain/);
  assert.doesNotMatch(factoryStyles, /\.factory-app\s*\{[^}]*overflow:\s*auto/);
});

test('Factory voice controls and Composer share the Hatch chat surface', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  const styles = await readFile(new URL('./factoryAgents.css', import.meta.url), 'utf8');
  assert.match(source, /className="factory-voice-controls"/);
  assert.match(styles, /\.factory-voice-controls,[\s\S]*\.factory-chat-composer\s*\{[^}]*var\(--hatch-ui-surface-window/s);
});

test('Factory workbench uses stable shell panes instead of card-driven page chrome', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  const portalStyles = await readFile(new URL('./creatorPortalV2.css', import.meta.url), 'utf8');
  const factoryStyles = await readFile(new URL('./factoryAgents.css', import.meta.url), 'utf8');
  assert.match(source, /className="factory-stage-rail"/);
  assert.match(source, /className="factory-workspace"/);
  assert.match(source, /className="factory-pane-header"/);
  assert.match(`${portalStyles}\n${factoryStyles}`, /grid-template-columns:\s*256px minmax\(0, 1fr\)/);
  assert.match(factoryStyles, /\.factory-chat-scroll\s*\{[^}]*background:/);
  assert.match(factoryStyles, /\.factory-inspector-scroll\s*\{[^}]*background:/);
  assert.match(factoryStyles, /\.factory-app \.MuiAccordion-root\s*\{/);
});

test('Factory chat uses right-aligned user bubbles without speaker labels', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  const styles = await readFile(new URL('./factoryAgents.css', import.meta.url), 'utf8');
  assert.match(source, /factory-message-bubble/);
  assert.match(source, /justifyContent: user \? "flex-end" : "flex-start"/);
  assert.doesNotMatch(source, /t\(message\.role === "user" \? "you" : "agent"\)/);
  assert.match(styles, /\.factory-message-bubble\s*\{/);
  assert.match(styles, /background:\s*var\(--hatch-ui-primary/);
  assert.match(styles, /max-width:\s*min\(82%, 640px\)/);
});

test('Factory uses the MUI X Chat Composer for the real session message endpoint', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(typeof packageJson.dependencies['@mui/x-chat'], 'string');
  assert.match(source, /from "@mui\/x-chat"/);
  assert.match(source, /from "@mui\/x-chat\/headless"/);
  assert.match(source, /<ChatProvider adapter=\{composerAdapter\}/);
  assert.match(source, /await api\(endpoint\(root, id, "message"\)/);
  assert.match(source, /features=\{\{ attachments: false \}\}/);
  assert.doesNotMatch(source, /<TextField fullWidth multiline minRows=\{2\}/);
});

test('Factory todo panel exposes every todo in an independently scrollable region', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.match(source, /className="factory-todo-list" sx=\{\{ maxHeight: 220, overflowY: "auto"/);
  assert.match(source, /todos\.map\(\(todo, index\)/);
  assert.doesNotMatch(source, /todos\.slice\(0, 5\)/);
});

test('Factory chat header removes terminal status and message-count chrome', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /<StatusChip/);
  assert.doesNotMatch(source, /session\.messages\?\.length \|\| 0\} \{t\("chat"\)\}/);
});

test('Factory composer does not render a redundant message label', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /<Typography variant="caption" color="text\.secondary">\{t\("messageLabel"\)\}<\/Typography>/);
});

test('Factory tool call summaries omit the redundant successful-return label', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /t\("toolReturned"\)/);
  assert.match(source, /status \? ` · \$\{status\}` : ""/);
});

test('Factory renders grouped tool calls as ToolGroup instead of treating them as messages', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
    assert.match(source, /item\.type === "toolGroup" \? <ToolGroup key=\{item\.key\} items=\{item\.items\}/);
    assert.match(source, /item\.type === "tool" \? <ToolMessage/);
    assert.match(source, /function Message\(\{ message, files, onOpenFile, speaking, t \}\) \{ if \(!message\) return null;/);
  });

test('Factory consumes the shared Hatch UI theme instead of an indigo local theme', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  const styles = await readFile(new URL('./factoryAgents.css', import.meta.url), 'utf8');
  const muiTheme = await readFile(new URL('../../packages/ui/src/muiTheme.js', import.meta.url), 'utf8');
  assert.match(source, /hatchMuiThemeOptions/);
  assert.doesNotMatch(source, /#4f46e5|#f7f8fa|#17202f|#657083/);
  assert.doesNotMatch(styles, /#4f46e5|#273142|#17202f|#657083|#eef0f4|#f0f2f6/);
  assert.match(muiTheme, /var\(--hatch-ui-primary\)/);
  assert.match(muiTheme, /var\(--hatch-ui-accent\)/);
  assert.match(muiTheme, /var\(--hatch-radius-control\)/);
});

test('Factory file previews use a real modal while preserving live file actions', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /minHeight: 140, display: "grid"/);
  assert.doesNotMatch(source, /t\("chooseFile"\)/);
  assert.match(source, /const selectedFile = file \? session\.files\.find\(record => record\.path === file\) : null/);
  assert.match(source, /selectedFile && <FileViewer/);
  assert.match(source, /onClose=\{\(\) => setFile\(null\)\}/);
  assert.doesNotMatch(source, /file \? <FileViewer/);
  assert.match(source, /function FileViewer\(\{[^}]*onClose/);
  assert.match(source, /return <Dialog open onClose=\{onClose\}/);
  assert.match(source, /<DialogContent/);
  assert.match(source, /<DialogActions>/);
  assert.doesNotMatch(source, /<Tabs value=\{mode\}/);
  assert.doesNotMatch(source, /label=\{t\("read"\)\}/);
  assert.doesNotMatch(source, /writeRevision/);
  assert.match(source, /<TextField multiline minRows=\{16\} fullWidth/);
  assert.match(source, /onClick=\{\(\) => onAddToChat\(record\.path\)\}/);
  assert.match(source, /method: "POST", body: \{ path: target, base64: btoa\(binary\) \}/);
  assert.match(source, /discardEdits/);
  assert.match(source, /download/);
});

test('Collect sources lists the real manual-upload files from the research session', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.match(source, /const \[sessions, setSessions\] = useState\(\[\]\)/);
  assert.match(source, /const \[agents, setAgents\] = useState\(\[\]\)/);
  assert.match(source, /const \[manualFiles, setManualFiles\] = useState\(\[\]\)/);
  assert.match(source, /setManualFiles\(value\.manualFiles \|\| \[\]\)/);
  assert.match(source, /records\.map\(record =>/);
  assert.match(source, /onOpenAgent\("research"\)/);
  assert.match(source, /t\("manualUploads"\)/);
});

test('Factory chat keeps streamed blocks stable through terminal persistence', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.match(source, /const \[activityVisible, setActivityVisible\] = useState\(true\)/);
  assert.match(source, /if \(value\.type === "message"\) load\(true\)/);
  assert.match(source, /if \(clearStream\) \{ setStream\(""\); setActivityVisible\(false\); \}/);
  assert.match(source, /\{running && activityVisible && <Stack/);
  assert.match(source, /if \(value\.type === "delta"\) \{ setActivityVisible\(false\);/);
  assert.doesNotMatch(source, /if \(value\.type === "message" \|\| value\.type === "state"\) \{ setStream\(""\); load\(\); \}/);
});

test('Factory no longer exposes the obsolete manual output handoff controls', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /selectedOutputs|destinationRole|handoffNotice|transferOutputs|sendOutputsTo|destinationAgent|sendFiles|handoffHint|\/transfer/);
  assert.doesNotMatch(source, /selectable selectedOutputs/);
  assert.match(source, /<FileSection title=\{t\("outputs"\)\}/);
  assert.match(source, /method: "DELETE", body: \{ path \}/);
});
