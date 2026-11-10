import test from 'node:test';
import assert from 'node:assert/strict';
import { replyFor } from '../src/worker.mjs';
import { normalizeStatewideHousingConversationRequest } from '../src/housing-conversation-statewide-v2.mjs';
import { housingActiveTransport, statewideHousingCopy } from '../src/housing-active-v21.mjs';
import { collapsiblePrivateKeyboardTransport } from '../src/worker-entry-pilot-v21.mjs';

const HOUSING_PROMPT = 'Тема: житло. Вкажіть місто або район.';
const TELEGRAM_URL = 'https://api.telegram.org/bottest/sendMessage';

function requestFor(text, previous = HOUSING_PROMPT) {
  return new Request('https://worker.example/telegram/stateless', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      update_id:1,
      message:{
        message_id:2,
        chat:{ id:321, type:'private' },
        from:{ id:321, is_bot:false },
        text,
        reply_to_message:{
          message_id:1,
          chat:{ id:321, type:'private' },
          from:{ id:999, is_bot:true, username:'ZaskaletaInfoBot' },
          text:previous
        }
      }
    })
  });
}

async function normalizedCoreReply(text, previous = HOUSING_PROMPT) {
  const request = await normalizeStatewideHousingConversationRequest(requestFor(text, previous));
  const payload = await request.json();
  return replyFor({
    text:payload.message.text,
    replyToText:payload.message.reply_to_message?.text || ''
  });
}

test('screenshot flow: Любек дві жінки -> rooms keeps two-person household', async () => {
  const first = await normalizedCoreReply('Любек дві жінки');
  assert.match(first, /^Тема: житло — Lübeck\./u);
  assert.match(first, /^Осіб: 2$/mu);
  assert.match(first, /кількість кімнат/u);
  assert.doesNotMatch(first, /Любек дві жінки|Вкажіть кількість осіб/u);

  const second = replyFor({ text:'3', replyToText:first });
  assert.match(second, /^Житло — Lübeck, 3 кімнати\./u);
  assert.match(second, /^Осіб: 2$/mu);
  assert.doesNotMatch(second, /Вкажіть місто|Вкажіть кількість осіб/u);
});

test('screenshot flow: Ренсберг для сім\'ї 3 resolves and continues instead of generic fallback', async () => {
  const first = await normalizedCoreReply("Ренсберг для сім'ї 3");
  assert.match(first, /^Тема: житло — Rendsburg\./u);
  assert.match(first, /^Осіб: 3$/mu);
  assert.match(first, /кількість кімнат/u);
  assert.doesNotMatch(first, /Не вдалося однозначно|Вкажіть місто або район/u);

  const second = replyFor({ text:'3', replyToText:first });
  assert.match(second, /^Житло — Rendsburg, 3 кімнати\./u);
  assert.match(second, /^Осіб: 3$/mu);
});

test('housing normalization preserves explicit Jobcenter condition', async () => {
  const first = await normalizedCoreReply("Ренсберг для сім'ї 3 під Jobcenter");
  assert.match(first, /^Тема: житло — Rendsburg\./u);
  assert.match(first, /^Осіб: 3$/mu);
  assert.match(first, /Jobcenter Kreis Rendsburg-Eckernförde/u);
  assert.doesNotMatch(first, /Тема: Jobcenter\./u);
});

test('Schleswig-Holstein housing copy no longer recommends Hamburg as the default example', () => {
  assert.equal(
    statewideHousingCopy('Вкажіть місто або район, наприклад: Hamburg або Trittau.'),
    'Вкажіть місто або район у Schleswig-Holstein, наприклад: Lübeck, Kiel або Trittau.'
  );
  assert.equal(
    statewideHousingCopy('3 кімнати розпізнано. Додайте місто, бюджет і тип оренди одним повідомленням, наприклад: Hamburg, 3 кімнати, 950 € Warmmiete.'),
    '3 кімнати розпізнано. Додайте місто, бюджет і тип оренди одним повідомленням, наприклад: Lübeck, 3 кімнати, 950 € Warmmiete.'
  );
});

test('active transport composition keeps specialized keyboards user-collapsible and reopenable', async () => {
  let captured = null;
  const base = async (_url, options = {}) => {
    captured = JSON.parse(options.body);
    return new Response(JSON.stringify({ ok:true }), { status:200, headers:{ 'content-type':'application/json' } });
  };
  const active = collapsiblePrivateKeyboardTransport(housingActiveTransport(base));

  await active(TELEGRAM_URL, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      chat_id:321,
      text:'🏠 Дані пошуку житла збережено. Вкажіть кількість людей.',
      reply_markup:{
        keyboard:[[{ text:'1' }, { text:'2' }, { text:'3' }], [{ text:'☰ Меню' }]],
        resize_keyboard:true,
        one_time_keyboard:true,
        is_persistent:true
      }
    })
  });

  assert.ok(captured);
  assert.equal(captured.reply_markup.resize_keyboard, true);
  assert.equal(captured.reply_markup.one_time_keyboard, false);
  assert.equal(captured.reply_markup.is_persistent, false);
});

test('outgoing housing prompt and placeholder use Schleswig-Holstein examples', async () => {
  let captured = null;
  const transport = housingActiveTransport(async (_url, options = {}) => {
    captured = JSON.parse(options.body);
    return new Response(JSON.stringify({ ok:true }), { status:200, headers:{ 'content-type':'application/json' } });
  });

  await transport(TELEGRAM_URL, {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({
      chat_id:321,
      text:'Вкажіть місто або район, наприклад: Hamburg або Trittau.',
      reply_markup:{ force_reply:true, input_field_placeholder:'Напр.: Hamburg' }
    })
  });

  assert.match(captured.text, /Schleswig-Holstein/u);
  assert.match(captured.text, /Lübeck, Kiel або Trittau/u);
  assert.doesNotMatch(captured.text, /Hamburg/u);
  assert.equal(captured.reply_markup.input_field_placeholder, 'Напр.: Lübeck');
});
