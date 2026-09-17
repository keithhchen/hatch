import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Factory UI derives every session API from the current Product', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.match(source, /\/v1\/creator\/products\/\$\{encodeURIComponent\(productId\)\}\/factory-agents/);
  assert.doesNotMatch(source, /['"`]\/v1\/creator\/factory-agents/);
  assert.doesNotMatch(source, /evaluation-targets|method:\s*['"]PUT['"].*target/);
});

test('Product cards enter the canonical Product-scoped Factory', async () => {
  const source = await readFile(new URL('./CreatorPortalV2.jsx', import.meta.url), 'utf8');
  assert.match(source, /creatorFactoryPath\(idOf\(product, "product"\)\)/);
  assert.doesNotMatch(source, /href="\/studio\/factory"/);
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
  assert.match(source, /availability\?\.updatedDependencies \|\| \[\]/);
  assert.match(source, /ChatComposer disabled=\{locked \|\| busy \|\| running \|\| !config\?\.services\.model\}/);
  assert.match(source, /const targetStage = factorySectionForAgent\(role\)/);
  assert.doesNotMatch(source, /updatedDependencies \|\| entry\.dependencies/);
  assert.doesNotMatch(source, /comments\/export|annotateLines|line-selection|lineSelection/);
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

test('Factory tool call summaries omit the redundant successful-return label', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /t\("toolReturned"\)/);
  assert.match(source, /status \? ` · \$\{status\}` : ""/);
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
  assert.match(source, /<Tabs value=\{mode\}/);
  assert.match(source, /onClick=\{\(\) => onAddToChat\(record\.path\)\}/);
  assert.match(source, /method: "POST", body: \{ path: target, base64: btoa\(binary\) \}/);
  assert.match(source, /discardEdits/);
  assert.match(source, /download/);
});

test('Collect sources lists the real manual-upload files from the research session', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.match(source, /const manualFiles = researchSession\?\.files\?\.filter\(record => record\.path\.startsWith\("input\/manual\/"\)\)/);
  assert.match(source, /manualFiles\.map\(record =>/);
  assert.match(source, /onClick=\{\(\) => onOpenAgent\("research"\)\}/);
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

test('Factory hands selected output files to an available Agent in the same Product', async () => {
  const source = await readFile(new URL('./FactoryAgents.jsx', import.meta.url), 'utf8');
  assert.match(source, /candidate\.role !== session\.role && candidate\.state !== "locked"/);
  assert.match(source, /sessions\.find\(item => item\.role === candidate\.role\)\?\.status !== "running"/);
  assert.match(source, /if \(!target\) target = await api\(`\$\{root\}\/sessions`, \{ method: "POST", body: \{ role: destinationRole \} \}\)/);
  assert.match(source, /endpoint\(root, target\.id, "transfer"\)/);
  assert.match(source, /body: \{ fromSessionId: id, files: selectedOutputs\.map\(path => \(\{ path \}\)\) \}/);
  assert.match(source, /path\.startsWith\("output\/"\)/);
  assert.match(source, /\^\(input\\\/\(\?:manual\|handoff\)\)\\\//);
  assert.match(source, /method: "DELETE", body: \{ path \}/);
});
