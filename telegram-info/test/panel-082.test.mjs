import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/runtime.mjs';
import { pilotConfig, isAllowedPilotChat, isListedGroupChat } from '../src/pilot-security.mjs';
import { PANEL_TEXT } from '../src/main-panel.mjs';
import { START_TEXT } from '../src/start-text.mjs';
import { GROUP_LAUNCH_PANEL_TEXT } from '../src/group-launch-panel-v1.mjs';
import { fixture, NOW, GROUP, USER } from './runtime-fixture.mjs';

// TG-RUNTIME-082: private /panel answered "Невідома команда"; on staging
// (public mode) the group welcome and the group /panel never ran, and a
// member's /panel got no answer; "Kiel 2 кімнати до 900 € warm" was not
// understood.

const PUBLIC = { TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1', TELEGRAM_DELIVERY_ENABLED:'true', TELEGRAM_MAINTENANCE_MODE:'false' };
const MEMBER = 424242;

async function run(env, steps) {
  const f = await fixture(env);
  try {
    const out = [];
    for (const { text, chat = MEMBER, type = 'private', user = MEMBER, join = false } of steps) {
      const before = f.calls.length;
      let request = f.request(text, { user, chat, type });
      if (join) {
        const update = await request.json();
        update.message.new_chat_members = [{ id:user, is_bot:false, first_name:'Olena' }];
        delete update.message.text;
        request = new Request(request.url, { method:'POST', headers:request.headers, body:JSON.stringify(update) });
      }
      await handle(request, f.env, NOW, f.transport);
      out.push(f.calls.slice(before).filter(call => ['sendMessage', 'pinChatMessage'].includes(call.method)));
    }
    return out;
  } finally { f.close(); }
}

const lastText = calls => calls.filter(call => call.method === 'sendMessage').at(-1)?.body;

test('#082 private /panel and /menu open the short panel; the first two buttons take a whole row', async () => {
  const replies = await run(PUBLIC, [{ text:'/panel' }, { text:'/menu' }, { text:'/menu@ZaskaletaInfoBot' }, { text:'/start' }]);
  for (const calls of replies.slice(0, 3)) {
    const body = lastText(calls);
    assert.equal(body.text, PANEL_TEXT);
    const rows = body.reply_markup.inline_keyboard;
    assert.deepEqual(rows.slice(0, 2).map(row => row.length), [1, 1]);
    assert.deepEqual(rows.slice(0, 2).map(row => row[0].callback_data), ['nav:housing', 'nav:jobcenter']);
    const data = rows.flat().map(button => button.callback_data);
    for (const key of ['documents', 'kindergeld', 'work', 'courses', 'school', 'transport', 'news', 'events', 'advice', 'report']) assert.ok(data.includes(`nav:${key}`), key);
  }
  assert.equal(lastText(replies[3]).text, START_TEXT, '/start keeps the greeting');
  assert.ok(PANEL_TEXT.length < 200);
});

test('#082 public mode: a group named in TELEGRAM_ALLOWED_CHAT_IDS gets the welcome and /panel', async () => {
  const env = { ...PUBLIC, TELEGRAM_ALLOWED_CHAT_IDS:String(GROUP) };
  const [join, member, admin, chatter] = await run(env, [
    { join:true, chat:GROUP, type:'supergroup' },
    { text:'/panel', chat:GROUP, type:'supergroup' },
    { text:'/panel@ZaskaletaInfoBot', chat:GROUP, type:'supergroup', user:USER },
    { text:'Elmschorn', chat:GROUP, type:'supergroup' }
  ]);
  assert.match(lastText(join).text, /^👋 Вітаємо, Olena!/u);
  const answer = lastText(member);
  assert.match(answer.text, /особистому чаті/u);
  assert.deepEqual(answer.reply_markup.inline_keyboard, [[{ text:'🤖 Відкрити помічник', url:'https://t.me/ZaskaletaInfoBot?start=assistant' }]]);
  assert.ok(!member.some(call => call.method === 'pinChatMessage'), 'a member does not pin');
  assert.equal(lastText(admin).text, GROUP_LAUNCH_PANEL_TEXT);
  assert.ok(admin.some(call => call.method === 'pinChatMessage'));
  assert.equal(chatter.length, 0, 'ordinary group messages stay unanswered');
});

test('#082 public mode still refuses every group that is not listed', async () => {
  const [join, panel] = await run({ ...PUBLIC, TELEGRAM_ALLOWED_CHAT_IDS:'' }, [{ join:true, chat:GROUP, type:'supergroup' }, { text:'/panel', chat:GROUP, type:'supergroup', user:USER }]);
  assert.equal(join.length + panel.length, 0);
  const config = pilotConfig({ ...PUBLIC, TELEGRAM_ALLOWED_CHAT_IDS:String(GROUP), TELEGRAM_BOT_TOKEN:'123456:abcdefghijklmnopqrstuvwxyzABCDEFGHI', TELEGRAM_WEBHOOK_SECRET:'s'.repeat(32) });
  assert.equal(isAllowedPilotChat(config, GROUP), false, 'ordinary group replies stay off in public mode');
  assert.equal(isListedGroupChat(config, GROUP), true);
  assert.equal(isListedGroupChat(config, -1009999999999), false);
  assert.equal(isListedGroupChat(config, MEMBER), false, 'a private chat is no group');
});

test('#082 the panel example and "до" / "bis" before the sum are understood', async () => {
  const texts = ['Kiel 2 кімнати до 900 € warm', 'Kiel, 2 кімнати, до 900 € warm', 'Kiel 2 Zimmer bis 900 warm', 'Bad Segeberg 3 кімнати макс 1100 € kalt'];
  const replies = await run(PUBLIC, texts.map(text => ({ text })));
  assert.match(lastText(replies[0]).text, /^Параметри житла: Kiel, 2 кімнати, до 900 € Warmmiete\. Оберіть радіус/u);
  assert.match(lastText(replies[1]).text, /^Параметри житла: Kiel, 2 кімнати, до 900 € Warmmiete\./u);
  assert.match(lastText(replies[2]).text, /^Параметри житла: Kiel, 2 кімнати, до 900 € Warmmiete\./u);
  assert.match(lastText(replies[3]).text, /^Параметри житла: Bad Segeberg, 3 кімнати, до 1100 € Kaltmiete\./u);
  const [open] = await run(PUBLIC, [{ text:'Kiel 2 кімнати до 900 €' }]);
  assert.match(lastText(open).text, /^Пошук житла — Kiel, 2 кімнати, бюджет до 900 €\. Це Warmmiete чи Kaltmiete\?/u);
});

test('#082 /start, /menu and /panel end a saved housing step', async () => {
  for (const reset of ['/start', '/menu', '/panel']) {
    const replies = await run(PUBLIC, [{ text:'🏠 Житло' }, { text:reset }, { text:'Trittau' }]);
    assert.doesNotMatch(lastText(replies[2]).text, /^Тема: житло — Trittau/u, reset);
  }
});

// Review findings (#082 round 1).
test('#082 /panel ends a pending bug report like /menu', async () => {
  const replies = await run(PUBLIC, [{ text:'/report' }, { text:'/panel' }, { text:'Kiel 2 кімнати до 900 € warm' }]);
  assert.match(lastText(replies[2]).text, /^Параметри житла: Kiel, 2 кімнати/u);
  assert.ok(!replies[2].some(call => /Звіт .* прийнято/u.test(call.body?.text || '')), 'not sent as a report');
});

test('#082 with "до" / "bis" the first words must be a known town', async () => {
  const replies = await run(PUBLIC, ['Шукаю 2 кімнати до 900 warm', 'Ich suche 2 Zimmer bis 900', 'Termin 2 bis 120'].map(text => ({ text })));
  for (const calls of replies) assert.doesNotMatch(lastText(calls).text, /^(?:Параметри житла: |Пошук житла — )(?:Шукаю|Ich suche|Termin)/u);
});
