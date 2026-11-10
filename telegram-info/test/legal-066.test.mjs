import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, USER } from './runtime-fixture.mjs';
import { privacyPolicyHtml, privacyCommandText, PRIVACY_CONTROLLER } from '../src/privacy-policy.mjs';
import { impressumCommandText, handleImpressumRequest, impressumPublished, IMPRESSUM_PATH } from '../src/legal-commands.mjs';
import { forgetFailedText } from '../src/forget-command.mjs';
import { replyFor } from '../src/worker.mjs';
import { BRANDED_BOT_COMMANDS } from '../src/bot-command-sync.mjs';

// TG-RUNTIME-066 (full analysis 23.10.2026, stage 1): legal information and
// deletion work in every operating state; texts match what the bot does.

const FILLED = { name:'Anna Beispiel', address:'Musterweg 1, 00000 Musterstadt', email:'kontakt@example.org', contact:'Telefon: +49 4154 000000' };

test('#066 /forget, /privacy, /datenschutz and /impressum are answered in maintenance for a non-admin user', async () => {
  // Review finding: the fixture USER is a group creator and skips maintenance,
  // so a plain user in public mode is used, with /help as the control.
  const f = await fixture({ TELEGRAM_MAINTENANCE_MODE:'true', TELEGRAM_PILOT_MODE:'public', TELEGRAM_RELEASE_APPROVED:'public-v1' });
  const PLAIN = 555555;
  try {
    const control = await f.send('/help', { user:PLAIN });
    assert.equal(control.body.mode, 'maintenance', 'control: maintenance is really on for this user');
    for (const [command, mode] of [['/forget', 'forget-v1'], ['/privacy', 'legal-privacy'], ['/datenschutz', 'legal-datenschutz'], ['/impressum', 'legal-impressum']]) {
      const reply = await f.send(command, { user:PLAIN });
      assert.equal(reply.body.mode, mode, command);
      assert.doesNotMatch(reply.last?.text || '', /технічному обслуговуванні/u, command);
    }
  } finally { f.close(); }
});

test('#066 while unpublished: no claim that Telegram\'s policy covers the bot; honest Impressum text', () => {
  const privacy = privacyCommandText(PRIVACY_CONTROLLER);
  assert.doesNotMatch(privacy, /Privacy Policy for Bots|стандартна Privacy Policy/u);
  assert.match(privacy, /ще готуються/u);
  assert.match(privacy, /\/forget/u);
  assert.match(impressumCommandText(PRIVACY_CONTROLLER), /ще готується/u);
  assert.equal(handleImpressumRequest(new Request(`https://bot.zaskaleta.net${IMPRESSUM_PATH}`)), null, 'no page with placeholders');
});

test('#066 once the controller is filled: Impressum command and page name the provider', async () => {
  const text = impressumCommandText(FILLED);
  for (const value of Object.values(FILLED)) assert.ok(text.includes(value), value);
  const response = handleImpressumRequest(new Request(`https://bot.zaskaleta.net${IMPRESSUM_PATH}`), FILLED);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/u);
  const html = await response.text();
  assert.match(html, /<h1>Impressum<\/h1>/u);
  assert.match(html, /Anna Beispiel<br>Musterweg 1, 00000 Musterstadt/u);
  assert.match(html, /mailto:kontakt@example\.org/u);
  const evil = handleImpressumRequest(new Request(`https://bot.zaskaleta.net${IMPRESSUM_PATH}`), { ...FILLED, name:'<script>x</script>' });
  assert.doesNotMatch(await evil.text(), /<script>/u);
  assert.equal(handleImpressumRequest(new Request(`https://bot.zaskaleta.net${IMPRESSUM_PATH}`, { method:'POST' }), FILLED), null);
});

test('#066 the policy no longer says logs are off, and names the Google search buttons', () => {
  const html = privacyPolicyHtml(FILLED);
  assert.doesNotMatch(html, /Dauerhafte Server-Protokolle sind abgeschaltet|Постійні журнали сервера вимкнено/u);
  assert.match(html, /Betriebsprotokolle \(Abschnitt 2\)[^<]*nach 3 Tagen gelöscht/u);
  assert.match(html, /Google-Suche[^<]*ruft Ihr Gerät google\.com auf; Google erhält dabei die Suchbegriffe[^<]*IP-Adresse/u);
  assert.match(html, /пошук оголошень у Google[^<]*IP-адресу вашого пристрою[^<]*Бот сам нічого не передає Google/u);
});

test('#066 commands: /impressum is offered; /watch describes the 15-minute default', () => {
  const impressum = BRANDED_BOT_COMMANDS.find(item => item.command === 'impressum');
  assert.ok(impressum);
  assert.doesNotMatch(BRANDED_BOT_COMMANDS.find(item => item.command === 'watch').description, /раз на годину/u);
});

test('#066 a failed /forget names the e-mail only once it is published', () => {
  assert.equal(forgetFailedText(PRIVACY_CONTROLLER), '⚠️ Не вдалося видалити дані зараз. Спробуйте ще раз через кілька хвилин.');
  assert.match(forgetFailedText(FILLED), /напишіть на kontakt@example\.org\.$/u);
  assert.ok(USER > 0);
});

test('#066 review: the Impressum needs a second direct contact, not /report; groups get /impressum and /datenschutz', async () => {
  const { contact, ...withoutContact } = FILLED;
  assert.ok(contact);
  assert.equal(impressumPublished(withoutContact), false);
  assert.equal(handleImpressumRequest(new Request(`https://bot.zaskaleta.net${IMPRESSUM_PATH}`), withoutContact), null);
  const html = await handleImpressumRequest(new Request(`https://bot.zaskaleta.net${IMPRESSUM_PATH}`), FILLED).text();
  assert.doesNotMatch(html, /\/report/u);
  assert.match(html, /Telefon: \+49 4154 000000/u);
  assert.match(impressumCommandText(FILLED), /Telefon: \+49 4154 000000/u);
  assert.match(privacyPolicyHtml(FILLED), /<a href="\/impressum">Impressum<\/a>/u);
  assert.doesNotMatch(privacyPolicyHtml(withoutContact), /href="\/impressum"/u, 'review: no link to an unpublished Impressum');
  for (const text of ['/impressum@ZaskaletaInfoBot', '/datenschutz@ZaskaletaInfoBot']) {
    const reply = replyFor({ text, chatId:-100123, chatType:'supergroup' });
    assert.doesNotMatch(String(reply), /Невідома команда/u, text);
    assert.match(String(reply), /Impressum|Конфіденційність/u, text);
  }
});
