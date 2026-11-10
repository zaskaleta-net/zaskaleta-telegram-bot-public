import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { safeLogText } from '../src/log-safe.mjs';
import { privacyPolicyHtml } from '../src/privacy-policy.mjs';

// TG-RUNTIME-065 (owner, 19.10.2026: "Вмикай!"): Workers Logs are on and kept
// 3 days, so log lines carry no secrets and no Telegram identifiers.

test('#065 log text keeps the meaning and drops tokens, keys, query strings and IDs', () => {
  const raw = 'fetch https://api.telegram.org/bot123456789:AAEhBP0av28X9fFqZpxQwTrS3kLmN0pQrSt/sendMessage failed for chat 987654321 and -1001234567890; '
    + 'klaz_live_abcDEF123456 gsk_ABCdef1234567890 https://www.kleinanzeigen.de/s-suchanfrage.html?locationStr=Trittau&maxPrice=944 HTTP 503 after 12 km, 943.8 €';
  const safe = safeLogText(raw, 1000);
  assert.doesNotMatch(safe, /AAEhBP0av28X9fFq|abcDEF123456|ABCdef1234567890|987654321|1001234567890|locationStr|maxPrice/u);
  assert.match(safe, /<token>/u);
  assert.match(safe, /<key>/u);
  assert.match(safe, /<id>/u);
  assert.match(safe, /s-suchanfrage\.html\?<query>/u);
  assert.match(safe, /HTTP 503 after 12 km, 943\.8 €/u, 'short numbers stay');
  assert.equal(safeLogText('x'.repeat(500)).length, 240);
});

function consoleCalls(source) {
  const calls = [];
  const re = /console\.(?:log|info|warn|error|debug)\(/gu;
  let match;
  while ((match = re.exec(source))) {
    let depth = 0, end = match.index + match[0].length - 1;
    for (; end < source.length; end += 1) {
      if (source[end] === '(') depth += 1;
      else if (source[end] === ')' && --depth === 0) break;
    }
    calls.push(source.slice(match.index, end + 1));
  }
  return calls;
}

test('#065 every log call in src passes error texts through safeLogText and logs no chat or user IDs', () => {
  const dir = new URL('../src/', import.meta.url);
  const problems = [];
  let count = 0;
  for (const file of readdirSync(dir).filter(name => name.endsWith('.mjs'))) {
    for (const call of consoleCalls(readFileSync(new URL(file, dir), 'utf8'))) {
      count += 1;
      if (/\b(?:message|error)\s*:(?!\s*'[^']*'\s*[,}])/u.test(call) && !/safeLogText\(/u.test(call)) problems.push(`${file}: error text not sanitized: ${call.slice(0, 120)}`);
      if (/\b(?:chatId|userId|chat_id|user_id|receivedChatId|chatIds|text|caption|username|first_name)\s*[:,})]/u.test(call.replace(/'[^']*'/gu, "''"))) problems.push(`${file}: identifier or content in log: ${call.slice(0, 160)}`);
    }
  }
  assert.ok(count >= 40, String(count));
  assert.deepEqual(problems, []);
});

test('#065 the privacy policy names the logs, what is in them and the 3 days', () => {
  const html = privacyPolicyHtml({ name:'A B', address:'Str. 1, 00000 Musterstadt', email:'a@example.org' });
  assert.match(html, /Workers Logs\)[^<]*Telegram-ID und Chat-ID werden dort nicht eingetragen\. Cloudflare löscht diese Protokolle nach 3 Tagen\./u);
  assert.match(html, /Журнали роботи\.<\/b>[^<]*Telegram-ID та ID чату туди не записуються\. Cloudflare видаляє ці журнали через 3 дні\./u);
});

test('#065 review: IDs before a full stop or after "_" are dropped; source logs keep only allowlisted fields', async () => {
  assert.equal(safeLogText('chat 123456789. user_987654321 price 943.8 € PLZ 22946'), 'chat <id>. user_<id> price 943.8 € PLZ 22946');
  assert.equal(safeLogText('bot123456789:AAEhBP0av28X9fFqZpxQwT/getMe'), 'bot<token>/getMe');
  const { sourcesLog } = await import('../src/log-safe.mjs');
  const [entry] = sourcesLog([{ source:'Kleinanzeigen public', status:'ok', count:2, url:'https://x/?q=Trittau', pages:[{ reason:'parsed', httpStatus:200, bytesReceived:10, durationMs:5, matchedCount:2, error:'chat 123456789', url:'https://x/?q=1' }] }]);
  assert.deepEqual(entry, { source:'Kleinanzeigen public', status:'ok', count:2, pages:[{ reason:'parsed', httpStatus:200, bytes:10, durationMs:5, matched:2 }] });
});
