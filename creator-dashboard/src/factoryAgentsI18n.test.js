import test from 'node:test';
import assert from 'node:assert/strict';
import { createFactoryAgentTranslator, FACTORY_AGENT_I18N_KEYS } from './factoryAgentsI18n.js';

test('Factory has complete English, Chinese, and Japanese copy', () => {
  for (const locale of ['en', 'zh', 'ja']) {
    const t = createFactoryAgentTranslator(locale);
    for (const key of FACTORY_AGENT_I18N_KEYS) {
      const value = t(key, 2);
      assert.notEqual(value, key, `${locale}.${key}`);
      assert.equal(typeof value, 'string', `${locale}.${key}`);
      assert.ok(value.length > 0, `${locale}.${key}`);
    }
  }
});
