import test from 'node:test';
import assert from 'node:assert/strict';
import { handle } from '../src/worker-entry-beta.mjs';

const NOW = 1700000000000;
const TOKEN = '123456789:' + 'A'.repeat(35);
const SECRET = 'B'.repeat(40);
const GROUP = -1001234567890;

function telegram(value) {
  return new Response(JSON.stringify({ ok:true, result:value }), { status:200, headers:{ 'content-type':'application/json' } });
}

function request(update) {
  return new Request('https://pilot.example/telegram/stateless', {
    method:'POST',
    headers:{ 'content-type':'application/json', 'x-telegram-bot-api-secret-token':SECRET },
    body:JSON.stringify(update)
  });
}

function groupMessage(id, userId, text) {
  return {
    update_id:id,
    message:{ message_id:id + 100, date:NOW / 1000, chat:{ id:GROUP, type:'supergroup' }, from:{ id:userId, is_bot:false }, text }
  };
}

function env(fetchInternal, admins = '777') {
  return {
    TELEGRAM_RELEASE_APPROVED:'pilot-v1', TELEGRAM_PILOT_MODE:'allowlist', TELEGRAM_ALLOWED_CHAT_IDS:String(GROUP),
    TELEGRAM_ADMIN_USER_IDS:admins, TELEGRAM_BOT_TOKEN:TOKEN, TELEGRAM_WEBHOOK_SECRET:SECRET,
    TELEGRAM_INGRESS_ENABLED:'true', TELEGRAM_DELIVERY_ENABLED:'false', TELEGRAM_GROUP_PRIVATE_ONLY:'false', KLAZ_API_KEY:'klaz_live_' + 'C'.repeat(24),
    OUTBOX:{ idFromName(name){ assert.equal(name, 'telegram-pilot-v1'); return name; }, get(){ return { fetch:fetchInternal }; } }
  };
}

test('ordinary group conversation is ignored before storage and Telegram network calls', async () => {
  let internal = 0, network = 0;
  const response = await handle(request(groupMessage(1, 777, 'Привіт усім, гарного вечора')), env(async () => { internal++; throw Error('unexpected'); }), NOW, async () => { network++; throw Error('unexpected'); });
  assert.deepEqual(await response.json(), { ok:true, ignored:true });
  assert.equal(internal, 0);
  assert.equal(network, 0);
});

test('group housing prompt is addressed to the triggering participant message', async () => {
  const operations = [];
  const e = env(async (_url, options) => {
    const body = JSON.parse(options.body); operations.push(body.op);
    assert.equal(body.message.chatId, GROUP);
    assert.equal(body.message.userId, 701);
    return new Response(JSON.stringify({ status:'ok', handled:true, reply:'Житло — Trittau. Вкажіть кількість кімнат: наприклад 3 або 3-4.' }), { status:200, headers:{'content-type':'application/json'} });
  });
  let payload;
  const update = groupMessage(2, 701, '@ZaskaletaInfoBot житло: Trittau');
  const response = await handle(request(update), e, NOW, async (url, options) => {
    assert.match(url, /sendMessage$/);
    payload = JSON.parse(options.body);
    return telegram({ message_id:500, chat:{ id:GROUP } });
  });
  assert.deepEqual(operations, ['message']);
  assert.equal(payload.chat_id, GROUP);
  assert.equal(payload.reply_parameters.message_id, 102);
  assert.equal(payload.reply_markup.force_reply, true);
  assert.doesNotMatch(JSON.stringify(payload), /klaz_live_|BBBB/);
  assert.equal((await response.json()).delivered, true);
});

test('non-admin technical commands are silent while an approved admin receives only safe status text', async () => {
  const internal = async () => new Response(JSON.stringify({ status:'ok', handled:false }), { status:200, headers:{'content-type':'application/json'} });
  let calls = 0;
  const denied = await handle(request(groupMessage(3, 701, '/status@ZaskaletaInfoBot')), env(internal), NOW, async () => { calls++; throw Error('must stay silent'); });
  assert.equal((await denied.json()).delivered, false);
  assert.equal(calls, 0);

  let adminPayload;
  const allowed = await handle(request(groupMessage(4, 777, '/status@ZaskaletaInfoBot')), env(internal), NOW, async (_url, options) => {
    adminPayload = JSON.parse(options.body);
    return telegram({ message_id:501, chat:{ id:GROUP } });
  });
  assert.match(adminPayload.text, /Beta Worker/);
  assert.doesNotMatch(adminPayload.text, /chat.?id|user.?id|API|token|queue/i);
  assert.equal((await allowed.json()).delivered, true);
});

test('Jobcenter callback in a group is bound to the user who owns the housing result', async () => {
  const callback = owner => ({
    update_id:10,
    callback_query:{
      id:'cb-group', from:{ id:702, is_bot:false }, data:`jc:3506905833:u${owner}`,
      message:{ message_id:88, chat:{ id:GROUP, type:'supergroup' }, from:{ id:999, is_bot:true, username:'ZaskaletaInfoBot' }, caption:'1. Wohnung\n💶 850 € · 22946 Trittau\n🛏 3 кімн. · 📐 90 м²' }
    }
  });

  let internalCalls = 0;
  const mismatchMethods = [];
  const denied = await handle(request(callback(703)), env(async () => { internalCalls++; throw Error('must not touch state'); }), NOW, async (url) => {
    mismatchMethods.push(url.split('/').at(-1));
    return telegram(true);
  });
  assert.deepEqual(mismatchMethods, ['answerCallbackQuery']);
  assert.equal(internalCalls, 0);
  assert.equal((await denied.json()).delivered, false);

  const operations = [];
  const methods = [];
  let prompt;
  const allowed = await handle(request(callback(702)), env(async (_url, options) => {
    const body = JSON.parse(options.body); operations.push(body.op);
    if (body.op === 'flow_read') return new Response(JSON.stringify({ status:'ok', state:null }), { status:200, headers:{'content-type':'application/json'} });
    assert.equal(body.op, 'jc_start');
    assert.equal(body.message.userId, 702);
    assert.equal(body.message.chatId, GROUP);
    return new Response(JSON.stringify({ status:'ok' }), { status:200, headers:{'content-type':'application/json'} });
  }), NOW, async (url, options) => {
    const method = url.split('/').at(-1); methods.push(method);
    if (method === 'answerCallbackQuery') return telegram(true);
    prompt = JSON.parse(options.body);
    return telegram({ message_id:502, chat:{ id:GROUP } });
  });
  assert.deepEqual(operations, ['flow_read','jc_start']);
  assert.deepEqual(methods, ['answerCallbackQuery','sendMessage']);
  assert.equal(prompt.chat_id, GROUP);
  assert.equal(prompt.reply_parameters.message_id, 88);
  assert.equal(prompt.reply_markup.force_reply, true);
  assert.doesNotMatch(prompt.text, /Реєстр:/);
  assert.equal((await allowed.json()).delivered, true);
});


test('group start is a clean standalone card while followups stay attached to the participant', async () => {
  const e = env(async () => new Response(JSON.stringify({ status:'ok', handled:false, state:null }), { headers:{'content-type':'application/json'} }));
  let id = 80;
  async function exchange(text, previous) {
    const update = groupMessage(id++, 701, text);
    if (previous) update.message.reply_to_message = {
      message_id:previous.messageId, chat:update.message.chat,
      from:{ id:999, is_bot:true, username:'ZaskaletaInfoBot' }, text:previous.text
    };
    let payload;
    const messageId = id + 900;
    const response = await handle(request(update), e, NOW, async (url, options) => {
      assert.match(url, /sendMessage$/);
      payload = JSON.parse(options.body);
      return telegram({ message_id:messageId, chat:{id:GROUP} });
    });
    assert.equal((await response.json()).delivered, true);
    const entryCommand = /^\/(?:start|help|topics)(?:@ZaskaletaInfoBot)?(?:\s|$)/i.test(text);
    if (entryCommand) assert.equal(payload.reply_parameters, undefined);
    else assert.equal(payload.reply_parameters.message_id, update.message.message_id);
    assert.equal(payload.reply_markup?.force_reply, true, text);
    assert.equal(payload.reply_markup.selective, !entryCommand);
    assert.ok(payload.entities?.some(entity => entity.type === 'bold'), text);
    assert.equal(payload.parse_mode, undefined);
    return { text:payload.text, messageId };
  }
  let prompt = await exchange('/start@ZaskaletaInfoBot');
  assert.match(prompt.text, /Вітаємо/);
  prompt = await exchange('Житло', prompt);
  assert.match(prompt.text, /Вкажіть місто/);
  prompt = await exchange('Kiel', prompt);
  assert.match(prompt.text, /Kiel/);
  prompt = await exchange('3-4', prompt);
  assert.match(prompt.text, /Kiel, 3-4 кімнати/);
  prompt = await exchange('Джобцентер', prompt);
  assert.match(prompt.text, /^Jobcenter-погодження/);
  prompt = await exchange('800', prompt);
  assert.match(prompt.text, /Сума без призначення: 800/);
  prompt = await exchange('/start@ZaskaletaInfoBot', prompt);
  assert.match(prompt.text, /^Вітаємо/);
});

test('clean start leaves a non-selective ForceReply so Privacy Mode can deliver the next free-text request', async () => {
  const internal = async () => new Response(JSON.stringify({ status:'ok', handled:false, state:null }), { headers:{'content-type':'application/json'} });
  let startPayload;
  await handle(request(groupMessage(90, 701, '/start@ZaskaletaInfoBot')), env(internal), NOW, async (_url, options) => {
    startPayload = JSON.parse(options.body);
    return telegram({ message_id:990, chat:{id:GROUP} });
  });
  assert.equal(startPayload.reply_parameters, undefined);
  assert.equal(startPayload.reply_markup.force_reply, true);
  assert.equal(startPayload.reply_markup.selective, false);

  const update = groupMessage(91, 701, "Trittau житло для сім'ї 4 людини Для Джобцентер");
  update.message.reply_to_message = { message_id:990, chat:update.message.chat, from:{ id:999, is_bot:true, username:'ZaskaletaInfoBot' }, text:startPayload.text };
  let replyPayload;
  const response = await handle(request(update), env(internal), NOW, async (_url, options) => {
    replyPayload = JSON.parse(options.body);
    return telegram({ message_id:991, chat:{id:GROUP} });
  });
  assert.equal((await response.json()).delivered, true);
  assert.match(replyPayload.text, /Trittau/u);
  assert.match(replyPayload.text, /^Осіб: 4$/mu);
  assert.doesNotMatch(replyPayload.text, /Вкажіть місто/u);
});

test('bare housing word remains ignored while start and topics invite a targeted reply', async () => {
  let calls = 0;
  const plain = await handle(request(groupMessage(95, 701, 'Житло')), env(async () => { calls++; throw Error('unexpected'); }), NOW, async () => { calls++; throw Error('unexpected'); });
  assert.equal((await plain.json()).ignored, true);
  assert.equal(calls, 0);
  const internal = async () => new Response(JSON.stringify({status:'ok', handled:false}), {headers:{'content-type':'application/json'}});
  for (const command of ['/topics@ZaskaletaInfoBot', '/help@ZaskaletaInfoBot']) {
    let payload;
    await handle(request(groupMessage(96, 701, command)), env(internal), NOW, async (_url, options) => {
      payload = JSON.parse(options.body);
      return telegram({message_id:997, chat:{id:GROUP}});
    });
    assert.equal(payload.reply_parameters, undefined, command);
    assert.equal(payload.reply_markup?.force_reply, true, command);
    assert.equal(payload.reply_markup.selective, false);
  }
});

test('group screenshot request keeps Ahrensburg and four people through formatted housing and rent replies', async () => {
  const e = env(async () => new Response(JSON.stringify({ status:'ok', handled:false, state:null }), { headers:{'content-type':'application/json'} }));
  let previous = 'Вітаємо!\nSchleswig-Holstein Помічник 🇺🇦🇩🇪', id = 120;
  for (const input of ["Житло для сім'ї 4 людини під Джобцентер в Аренсбургу", '3-4', 'Джобцентер', '900', 'Kaltmiete']) {
    const update = groupMessage(id++, 701, input);
    update.message.reply_to_message = { message_id:id + 500, chat:update.message.chat, from:{ id:999, is_bot:true, username:'ZaskaletaInfoBot' }, text:previous };
    let payload;
    const response = await handle(request(update), e, NOW, async (url, options) => {
      assert.match(url, /sendMessage$/);
      payload = JSON.parse(options.body);
      return telegram({ message_id:id + 600, chat:{id:GROUP} });
    });
    assert.equal((await response.json()).delivered, true);
    assert.equal(payload.reply_parameters.message_id, update.message.message_id);
    assert.equal(payload.reply_markup.force_reply, true);
    assert.ok(payload.entities?.some(entity => entity.type === 'bold'));
    assert.match(payload.text, /Ahrensburg/u);
    assert.match(payload.text, /^Осіб: 4$/mu);
    assert.doesNotMatch(payload.text, /Вкажіть місто|Тема: Jobcenter/u);
    previous = payload.text;
  }
  assert.match(previous, /Зібрано: Kaltmiete 900 €/u);
  assert.match(previous, /Ще потрібні: Betriebskosten, Heizkosten/u);
});

test('Lübeck screenshot keeps two people and three rooms through formatted housing and rent replies', async () => {
  const e = env(async () => new Response(JSON.stringify({ status:'ok', handled:false, state:null }), { headers:{'content-type':'application/json'} }));
  let previous = 'Вітаємо!\nSchleswig-Holstein Помічник 🇺🇦🇩🇪', id = 140;
  for (const input of ["Житло для двух людей в Любику під Джобцентер", '3', 'Джобцентер', '900', 'Kaltmiete']) {
    const update = groupMessage(id++, 701, input);
    update.message.reply_to_message = { message_id:id + 500, chat:update.message.chat, from:{ id:999, is_bot:true, username:'ZaskaletaInfoBot' }, text:previous };
    let payload;
    const response = await handle(request(update), e, NOW, async (url, options) => {
      assert.match(url, /sendMessage$/);
      payload = JSON.parse(options.body);
      return telegram({ message_id:id + 600, chat:{id:GROUP} });
    });
    assert.equal((await response.json()).delivered, true);
    assert.equal(payload.reply_parameters.message_id, update.message.message_id);
    assert.equal(payload.reply_markup.force_reply, true);
    assert.ok(payload.entities?.some(entity => entity.type === 'bold'));
    assert.match(payload.text, /Lübeck/u);
    assert.match(payload.text, /^Осіб: 2$/mu);
    assert.doesNotMatch(payload.text, /Вкажіть місто|Тема: Jobcenter/u);
    previous = payload.text;
  }
  assert.match(previous, /Lübeck, 3 кімнати/u);
  assert.match(previous, /Зібрано: Kaltmiete 900 €/u);
  assert.match(previous, /Ще потрібні: Betriebskosten, Heizkosten/u);
});

test('group first reply shows Plön norms before collecting search preferences', async () => {
  const e = env(async () => new Response(JSON.stringify({ status:'ok', handled:false, state:null }), { headers:{'content-type':'application/json'} }));
  let previous = 'Вітаємо!\nSchleswig-Holstein Помічник 🇺🇦🇩🇪', id = 160;
  for (const input of ["Житло для сім'ї 3 людини в плен для Джобцентер", '3', 'Джобцентер', '900', 'Kaltmiete']) {
    const update = groupMessage(id++, 701, input);
    update.message.reply_to_message = { message_id:id + 500, chat:update.message.chat, from:{ id:999, is_bot:true, username:'ZaskaletaInfoBot' }, text:previous };
    let payload;
    const response = await handle(request(update), e, NOW, async (url, options) => {
      assert.match(url, /sendMessage$/);
      payload = JSON.parse(options.body);
      return telegram({ message_id:id + 600, chat:{id:GROUP} });
    });
    assert.equal((await response.json()).delivered, true);
    assert.equal(payload.reply_parameters.message_id, update.message.message_id);
    assert.equal(payload.reply_markup.force_reply, true);
    assert.ok(payload.entities?.some(entity => entity.type === 'bold'));
    assert.match(payload.text, /Plön/u);
    assert.match(payload.text, /^Осіб: 3$/mu);
    assert.doesNotMatch(payload.text, /Вкажіть місто|Тема: Jobcenter/u);
    if (input.startsWith('Житло')) {
      assert.match(payload.text, /Площа-орієнтир: 75 м²/u);
      assert.match(payload.text, /до 680 € на місяць/u);
      assert.match(payload.text, /2–3 — рекомендація, не норматив/u);
      assert.ok(payload.text.includes('2026-01-mog-jc-kreis-ploen.pdf'));
    }
    previous = payload.text;
  }
  assert.match(previous, /Plön, 3 кімнати/u);
  assert.match(previous, /Зібрано: Kaltmiete 900 €/u);
  assert.match(previous, /Ще потрібні: Betriebskosten, Heizkosten/u);
});