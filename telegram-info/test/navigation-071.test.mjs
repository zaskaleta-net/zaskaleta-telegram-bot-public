import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/runtime.mjs';
import { replyFor } from '../src/worker.mjs';
import { fixture, NOW } from './runtime-fixture.mjs';

// TG-RUNTIME-071 (full analysis 23.10.2026, M3/M4/M5): /watch, /scanner and
// /premium ended without a way back; /help listed the closed /premium but not
// /menu, /news or /report; "до 3 запити" is wrong after "до".

const STAGING = { TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1', TELEGRAM_DELIVERY_ENABLED:'true', TELEGRAM_MAINTENANCE_MODE:'false', AI_ASSISTANT_ENABLED:'true', HOUSING_WATCH_ENABLED:'true', AI_PREMIUM_ENABLED:'false', AI_EXTERNAL_ENABLED:'true' };
const OFF = { TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1', TELEGRAM_DELIVERY_ENABLED:'true', TELEGRAM_MAINTENANCE_MODE:'false' };

async function say(env, text) {
  const f = await fixture(env);
  try {
    await handle(f.request(text, { user:555555 }), f.env, NOW, f.transport);
    return f.calls.filter(call => call.method === 'sendMessage' && call.body?.text).at(-1)?.body;
  } finally { f.close(); }
}

const hasMenu = body => (body?.reply_markup?.inline_keyboard || []).flat().some(button => button.callback_data === 'nav:menu');

test('#071 /watch, /scanner and /premium have the menu button, on and off', async () => {
  for (const [env, label] of [[STAGING, 'on'], [OFF, 'off']]) {
    for (const command of ['/watch', '/scanner', '/premium']) {
      const body = await say(env, command);
      assert.ok(body?.text, `${command} ${label}: a reply`);
      assert.ok(hasMenu(body), `${command} ${label}: menu button in ${JSON.stringify(body.reply_markup || null)}`);
    }
  }
});

test('#071 /help lists /menu, /news and /report, not the closed /premium', () => {
  const help = replyFor({ text:'/help' });
  for (const command of ['/menu', '/news', '/report', '/watch', '/forget']) assert.match(help, new RegExp(`^${command} — `, 'mu'), command);
  assert.doesNotMatch(help, /^\/premium/mu);
});

test('#071 "до N запитів" after "до"', async () => {
  const body = await say(STAGING, '/premium');
  assert.doesNotMatch(body.text, /до \d+ запити/u);
  assert.match(body.text, /до \d+ запит(?:у|ів) до ШІ на день/u);
});

test('#071 the Premium invoice also says "до N запитів"', async () => {
  const f = await fixture({ ...STAGING, AI_PREMIUM_ENABLED:'true', AI_PREMIUM_DAILY_LIMIT:'21' });
  try {
    await handle(f.request('/premium', { user:555555 }), f.env, NOW, f.transport);
    const invoice = f.calls.find(call => call.method === 'sendInvoice');
    assert.ok(invoice, "an invoice with Premium on");
    assert.match(invoice.body.description, /^До 21 запиту до ШІ/u);
  } finally { f.close(); }
});
