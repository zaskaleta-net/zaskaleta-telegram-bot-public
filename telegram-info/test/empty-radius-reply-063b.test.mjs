import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/runtime.mjs';
import { fixture, NOW } from './runtime-fixture.mjs';

// Issue #63 B (phone smoke 17.10.2026): an empty 15 km radius reply carried two
// «🔎 Автопошук житла під Jobcenter» headers and two "nothing found" statements
// (the local summary and the public-source fallback appended after it).

async function radiusReply(sourceResponse) {
  const f = await fixture();
  try {
    const transport = async (url, options) => String(url).startsWith('https://api.telegram.org/')
      ? f.transport(url, options)
      : sourceResponse();
    await handle(f.request('', { callback:'jcr:15:4:3-4:Trittau' }), f.env, NOW, transport);
    const texts = f.calls.filter(call => call.method === 'sendMessage').map(call => String(call.body.text || ''));
    return texts.find(text => /Автопошук житла під Jobcenter/u.test(text)) || '';
  } finally { f.close(); }
}

const count = (text, pattern) => (text.match(pattern) || []).length;

test('#63B an empty radius reply has one header and one terminal statement (sources answered, nothing fits)', async () => {
  const reply = await radiusReply(() => new Response('<html><body>Keine Ergebnisse</body></html>', { headers:{ 'content-type':'text/html; charset=utf-8' } }));
  assert.ok(reply, 'the terminal reply is sent');
  assert.equal(count(reply, /Автопошук житла під Jobcenter/gu), 1, reply);
  assert.equal(count(reply, /Радіус пошуку/gu), 1, reply);
  assert.doesNotMatch(reply, /нових оголошень не знайдено/u, reply);
  assert.match(reply, /Параметри: Trittau, 3-4 кімнати, до 943,80 €\./u, reply);
});

test('#63B an empty radius reply with unreachable sources states the failure once', async () => {
  const reply = await radiusReply(() => new Response('unavailable', { status:503 }));
  assert.ok(reply, 'the terminal reply is sent');
  assert.equal(count(reply, /Автопошук житла під Jobcenter/gu), 1, reply);
  assert.equal(count(reply, /Не вдалося отримати оголошення/gu), 1, reply);
});
