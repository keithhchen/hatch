import test from 'node:test';
import assert from 'node:assert/strict';
import { createFactoryAgentTranslator, FACTORY_AGENT_I18N_KEYS, FACTORY_AGENT_I18N_KEYS_BY_LOCALE } from './factoryAgentsI18n.js';

test('Factory has complete English, Chinese, and Japanese copy', () => {
  for (const locale of ['en', 'zh', 'ja']) {
    assert.deepEqual([...FACTORY_AGENT_I18N_KEYS_BY_LOCALE[locale]].sort(), [...FACTORY_AGENT_I18N_KEYS].sort(), `${locale} defines every Factory key without fallback`);
    const t = createFactoryAgentTranslator(locale);
    for (const key of FACTORY_AGENT_I18N_KEYS) {
      const value = t(key, 2);
      assert.notEqual(value, key, `${locale}.${key}`);
      assert.equal(typeof value, 'string', `${locale}.${key}`);
      assert.ok(value.length > 0, `${locale}.${key}`);
    }
  }
});

test('Factory overview and Studio labels use the intended product language', () => {
  assert.equal(createFactoryAgentTranslator('en')('overview'), 'Overview');
  assert.equal(createFactoryAgentTranslator('zh')('overview'), '概览');
  assert.equal(createFactoryAgentTranslator('ja')('overview'), '概要');
});
