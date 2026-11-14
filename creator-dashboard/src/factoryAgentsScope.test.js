import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Factory UI derives every session API from the current Product', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.match(source, /\/v1\/creator\/products\/\$\{encodeURIComponent\(productId\)\}\/factory-agents/);
  assert.doesNotMatch(source, /['"`]\/v1\/creator\/factory-agents/);
  assert.doesNotMatch(source, /evaluation-targets|method:\s*['"]PUT['"].*target/);
});

test('Agent rows enter the canonical Agent workspace', async () => {
  const source = await readFile(new URL('./CreatorPortalV2.jsx', import.meta.url), 'utf8');
  assert.match(source, /creatorProductPath\(productId\)/);
  assert.doesNotMatch(source, /href="\/studio\/factory"/);
});

test('Agent workspace header uses the real Product name and the inspector keeps no heading', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  const workspace = await readFile(new URL('./studioAgentWorkspace.jsx', import.meta.url), 'utf8');
  assert.match(workspace, /<h1>\{product \? productName\(product, t\) : "…"\}<\/h1>/);
  assert.match(workspace, /useRemote\(request, productPath\)/);
  assert.doesNotMatch(source, /\{productId\}<\/Typography>/);
  assert.doesNotMatch(source, /<Typography variant="subtitle1" fontWeight=\{750\}>\{t\("nextSteps"\)\}<\/Typography>/);
  assert.doesNotMatch(source, /backToStage/);
  assert.doesNotMatch(source, /<Refresh/);
  assert.match(source, /entry\?\.state === "complete" \|\| entry\?\.state === "update_available"/);
});

test('Published Products expose their canonical public link in the Agent header and Agent rows', async () => {
  const kit = await readFile(new URL('./studioShellKit.jsx', import.meta.url), 'utf8');
  const workspace = await readFile(new URL('./studioAgentWorkspace.jsx', import.meta.url), 'utf8');
  const portal = await readFile(new URL('./CreatorPortalV2.jsx', import.meta.url), 'utf8');
  const path = await readFile(new URL('./studioPath.js', import.meta.url), 'utf8');
  assert.match(path, /product\?\.status === "published" \|\| product\?\.status === "live"/);
  assert.match(kit, /`\/products\/\$\{idOf\(product, "product"\)\}`/);
  assert.match(workspace, /const href = live \? safePublicUrl\(publicPathOf\(product\)\) : null;/);
  assert.match(workspace, /onSelect: \(\) => open\(href\)/);
  assert.match(portal, /published \? `\/products\/\$\{encodeURIComponent\(idOf\(product, "product"\)\)\}` : ""/);
  assert.match(portal, /window\.open\(publicHref, "_blank", "noopener,noreferrer"\)/);
});

test('Factory navigation is URL-controlled down to the Agent page', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  const portal = await readFile(new URL('./CreatorPortalV2.jsx', import.meta.url), 'utf8');
  assert.match(source, /navigate\(creatorFactoryPath\(productId, nextStage, nextAgent\)\)/);
  assert.match(source, /const stage = section \?\? null/);
  assert.match(source, /const selected = agent \?\? \(stage \? FIRST_PAGE\[stage\] : null\)/);
  assert.doesNotMatch(source, /setStage\(|setSelected\(/);
  assert.match(portal, /section=\{route\.factorySection\}/);
  assert.match(portal, /agent=\{route\.factoryAgent\}/);
});

test('Factory overview is a guided path, not an admin tree', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /<SimpleTreeView|<TreeItem/);
  assert.match(source, /studioPathStates\(agents, product, manualFiles\)/);
  assert.match(source, /function FactoryStepper/);
  assert.match(source, /onClick=\{\(\) => onStep\(step\)\}/);
  assert.match(source, /onClick=\{\(\) => goToStep\(next\.step\)\}/);
  assert.match(source, /onClick=\{\(\) => onOpenAgent\(entry\.role\)\}/);
  assert.match(source, /step\.id === "ship" \? navigate\(creatorProductPath\(productId, "publish"\)\)/);
});

test('Publish tab edits details and brief and keeps only the unlisted toggle; the Agent publishes', async () => {
  const workspace = await readFile(new URL('./studioAgentWorkspace.jsx', import.meta.url), 'utf8');
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.match(source, /function FactoryOverview/);
  assert.match(workspace, /method: "PATCH"[^\n]*expected_updated_at: product\.updated_at/);
  assert.match(workspace, /\/brief-spec`, \{ method: "PUT"[^\n]*contract_version: "1"[^\n]*expected_updated_at: product\.updated_at/);
  assert.match(workspace, /\/storefront-preview`/);
  assert.doesNotMatch(workspace, /\/rollback`/);
  assert.match(workspace, /useRemote\(request, `\$\{base\}\/live`\)/);
  assert.doesNotMatch(workspace, /method: "POST"[^\n]*\/live`|sxPublishAction|sxBuildIncomplete|sxStatusDraft/);
  assert.match(workspace, /`\$\{base\}\/listing`, \{ method: "PUT"/);
  assert.doesNotMatch(workspace, /\/release`|candidate_id|readinessChecklist|"storefront"|"readiness"/);
  assert.doesNotMatch(source, /<TextField label=\{t\("productName"\)\}/);
});

test('Upload sources is a peer Factory page with real file upload', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.match(source, /selected === "uploads"/);
  assert.match(source, /function SourceUploadWorkspace/);
  assert.match(source, /input\/manual\//);
  assert.match(source, /<input ref=\{importPicker\} hidden type="file"(?:[^>]*)multiple/);
  assert.match(source, /onDrop=\{event => \{[^}]*uploadProjectFiles\(\[\.\.\.event\.dataTransfer\.files\]\)/);
});

test('Deep Research starts from Creator identity and public evidence, not manual upload', async () => {
  const i18n = await readFile(new URL('./factoryAgentsI18n.js', import.meta.url), 'utf8');
  const prompt = await readFile(new URL('../../runtime-server/prompts/factory-agents/research/SYSTEM.md', import.meta.url), 'utf8');
  assert.match(i18n, /research: '告诉 Agent 你是谁、做什么，以及它可以在哪里找到你的公开资料/);
  assert.match(i18n, /sourcesStage: '认识你'/);
  assert.match(i18n, /sourcesStage: 'Get to know you'/);
  assert.match(i18n, /sourcesStage: 'あなたを知る'/);
  assert.match(prompt, /不是一个等待用户整理资料的资料摄入 Agent/);
  assert.match(prompt, /主动使用 web_search 和 web_scrape/);
  assert.doesNotMatch(prompt, /youtube_transcript/);
  assert.match(prompt, /不要一开始就要求用户上传文件/);
});

test('The Interview opens with a few light questions, then writes the whole review page', async () => {
  const i18n = await readFile(new URL('./factoryAgentsI18n.js', import.meta.url), 'utf8');
  const shared = await readFile(new URL('../../runtime-server/prompts/assistant/INTERVIEW_DONE.md', import.meta.url), 'utf8');
  const prompt = await readFile(new URL('../../runtime-server/prompts/factory-agents/voice/SYSTEM.md', import.meta.url), 'utf8');
  assert.match(i18n, /voice: '说说你为什么想做这个 Agent，想让它替你做什么/);
  assert.doesNotMatch(i18n, /voice: '从你的经历、影响、价值取舍、审美和矛盾讲起/);
  assert.match(shared, /^# 访谈方法/m);
  assert.match(shared, /先宽，再一次写全/);
  assert.doesNotMatch(prompt, /Intellectual Genealogy/);
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
  assert.doesNotMatch(source + i18n, /workspaceConnectionLost/, 'a dropped stream retries silently');
  assert.doesNotMatch(i18n, /与工作区服务的连接中断/);
});

test('Factory JSX keeps visible copy in i18n and reads Agent identity from database definitions', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.match(source, /localizeAgentText\(agentEntry\(role\)\?\.name, locale\)/);
  assert.match(source, /localizeAgentText\(entry\.hint, locale\)/);
  assert.doesNotMatch(source, /const ROLES|researchDescription|caseDescription/);
});

test('Factory uses live dependency state at each interaction boundary', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.match(source, /const updatedDependencies = updatedSources\(entry\)/);
  assert.match(source, /updatedDependencies\.length > 0 && <HatchButton[^>]*onClick=\{onUseLatest\}/);
  assert.match(source, /const composerDisabled = locked \|\| !config\?\.services\.model/);
  assert.match(source, /composerDisabled=\{composerDisabled\}/);
  assert.match(source, /const targetStage = factorySectionForAgent\(role\)/);
  assert.doesNotMatch(source, /availability\?\.updatedDependencies/);
  assert.doesNotMatch(source, /comments\/export|annotateLines|line-selection|lineSelection/);
});

test('Factory chat is the shared chat: its composer, thread and steps are the Product chat components', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.match(source, /<ChatView controller=\{controller\}/);
  assert.match(source, /attachControl=\{false\}/);
  assert.match(source, /activityKinds=\{STEP_KINDS\}/);
  assert.match(source, /dictate=\{dictation\}/);
  assert.doesNotMatch(source, /@mui\/x-chat|ChatComposer|function ToolGroup|function ToolMessage|function Message\(/);
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
  assert.match(source, /t\("startAgentLabel", session\.role\)/);
  assert.match(source, /controller\.setDraft\(t\("startAgentMessage", session\.role\)\)/);
  assert.match(source, /querySelector\("textarea"\)\?\.focus\(\)/);
  assert.match(i18n, /startAgentMessage: role =>/);
  assert.match(i18n, /startAgentLabel = role => role === 'evaluator'/);
});

test('Factory start and dependency-update prompts follow the evaluator calibration flow', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  const i18n = await readFile(new URL('./factoryAgentsI18n.js', import.meta.url), 'utf8');
  assert.match(source, /t\("useLatestMessage", session\.role\)/);
  assert.match(i18n, /useLatestMessage = role => role === 'evaluator'/);
  assert.match(i18n, /挑出一到三处最影响客户结果、需要我来判断的地方问我/);
  assert.match(i18n, /把我的判断记下来就可以停了/);
  assert.doesNotMatch(i18n, /askuser|案例调用|ask me to assess them in one askuser batch/);
});

test('Factory chat keeps scrolling inside the workbench pane', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  const portal = await readFile(new URL('./CreatorPortalV2.jsx', import.meta.url), 'utf8');
  const portalStyles = await readFile(new URL('./creatorPortalV2.css', import.meta.url), 'utf8');
  const factoryStyles = await readFile(new URL('./factoryAgents.css', import.meta.url), 'utf8');
  assert.match(portal, /cpv2-main\$\{workbench \? " cpv2-main--workbench" : ""\}/);
  assert.match(portal, /const workbench = route\.kind === "agent" && route\.tab === "build"/);
  assert.match(source, /className="factory-chat web-chat web-chat--embedded"/);
  assert.match(`${portalStyles}\n${factoryStyles}`, /\.cpv2-main--workbench\s*\{[^}]*overflow:\s*hidden/);
  assert.match(factoryStyles, /\.factory-chat \.web-chat__main\s*\{[^}]*min-height:\s*0/);
  assert.doesNotMatch(factoryStyles, /\.factory-app\s*\{[^}]*overflow:\s*auto/);
});

test('Factory chat keeps its start and update buttons in the shared chat dock', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  const styles = await readFile(new URL('./factoryAgents.css', import.meta.url), 'utf8');
  assert.match(source, /dockAccessory=\{accessory\}/);
  assert.match(source, /className="factory-composer-toolbar"/);
  assert.match(styles, /\.factory-composer-toolbar\s*\{/);
});

test('Factory workbench is a two-pane chat grid inside the Studio shell', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  const portalStyles = await readFile(new URL('./creatorPortalV2.css', import.meta.url), 'utf8');
  const factoryStyles = await readFile(new URL('./factoryAgents.css', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /factory-stage-rail|react-resizable-panels/);
  assert.match(source, /className="factory-workspace"/);
  assert.match(factoryStyles, /\.factory-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) 340px/);
  assert.match(portalStyles, /\.cpv2-main--workbench\s*\{[^}]*overflow:\s*hidden/);
  assert.match(factoryStyles, /\.factory-inspector-scroll\s*\{[^}]*background:/);
  assert.match(factoryStyles, /\.factory-app \.MuiAccordion-root\s*\{/);
});

test('Factory chat has no bubbles or speaker labels of its own', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  const styles = await readFile(new URL('./factoryAgents.css', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /factory-message-bubble|t\(message\.role === "user" \? "you" : "agent"\)/);
  assert.doesNotMatch(styles, /\.factory-message-bubble|\.factory-tool/);
});

test('Factory sends through the real session message endpoint with one key per message', async () => {
  const transport = await readFile(new URL('./factorySessionTransport.js', import.meta.url), 'utf8');
  assert.match(transport, /\/message`, \{ method: "POST", headers: \{ "Idempotency-Key": clientMessageId \}/);
  assert.match(transport, /\/stop`/);
  assert.match(transport, /\/events`/);
});

test('Factory workbench does not render the todo panel or the published card', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /factory-todo-list|function Binding|agentPublished/);
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
  assert.match(source, /return <Dialog open onOpenChange=/);
  assert.match(source, /<DialogContent title=/);
  assert.match(source, /previousFile/);
  assert.match(source, /viewRendered/);
  assert.doesNotMatch(source, /@mui\/material[^;]*Dialog/);
  assert.doesNotMatch(source, /<Tabs value=\{mode\}/);
  assert.doesNotMatch(source, /label=\{t\("read"\)\}/);
  assert.doesNotMatch(source, /writeRevision/);
  assert.doesNotMatch(source, /SendIcon|onAddToChat\(record\.path\)/);
  assert.match(source, /method: "POST", body: \{ path: target, base64: textBase64\(edit\) \}/);
  assert.match(source, /discardEdits/);
  assert.match(source, /download/);
});

test('Collect sources lists the real manual-upload files from the research session', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.match(source, /const \[sessions, setSessions\] = useState\(\[\]\)/);
  assert.match(source, /const \[agents, setAgents\] = useState\(\[\]\)/);
  assert.match(source, /const \[manualFiles, setManualFiles\] = useState\(\[\]\)/);
  assert.match(source, /setManualFiles\(value\.manualFiles \|\| \[\]\)/);
  assert.match(source, /<FileList title=\{t\("factoryUploadedTitle"\)\}/);
  assert.match(source, /t\("factoryUploadedTitle"\)/);
});

test('Factory no longer exposes the obsolete manual output handoff controls', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /selectedOutputs|destinationRole|handoffNotice|transferOutputs|sendOutputsTo|destinationAgent|sendFiles|handoffHint|\/transfer/);
  assert.doesNotMatch(source, /selectable selectedOutputs/);
  assert.match(source, /<FileList key="output" records=\{outputFiles\} pageSize=\{FILE_PAGE_SIZE\}/);
  assert.match(source, /method: "DELETE", body: \{ path: record\.path \}/);
});

test('File pager uses localized chevron icon buttons with 44px mobile targets', async () => {
  const source = await readFile(new URL('./FileList.jsx', import.meta.url), 'utf8');
  const css = await readFile(new URL('./fileList.css', import.meta.url), 'utf8');
  assert.match(source, /<IconButton className="fl__page" label=\{t\("previousPage"\)\}[^]*?disabled=\{page <= 1\}[^]*?><ChevronLeft/);
  assert.match(source, /<IconButton className="fl__page" label=\{t\("nextPage"\)\}[^]*?disabled=\{page >= pages\}[^]*?><ChevronRight/);
  assert.match(source, /<span>\{page\}\/\{pages\}<\/span>/);
  assert.match(css, /\.fl__pager \.fl__page \{ min-width: 44px; min-height: 44px; \}/);
});
