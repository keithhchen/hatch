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
  assert.match(source, /disabled=\{locked\}/);
  assert.match(source, /body: \{ locale \}/);
  assert.match(source, /const targetStage = factorySectionForAgent\(role\)/);
  assert.doesNotMatch(source, /updatedDependencies \|\| entry\.dependencies/);
});
