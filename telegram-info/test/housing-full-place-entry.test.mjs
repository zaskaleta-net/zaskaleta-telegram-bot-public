import test from 'node:test';
import assert from 'node:assert/strict';
import { knownHousingLocation } from '../src/housing-language.mjs';
import { SH_UKRAINIAN_PLACE_ROWS } from '../src/schleswig-holstein-place-names.mjs';
import { fixture } from './runtime-fixture.mjs';

test('full registered place names take precedence over shorter aliases inside them', () => {
  for (const { canonical, aliases } of SH_UKRAINIAN_PLACE_ROWS) {
    for (const name of [canonical, ...aliases]) {
      for (const text of [name, `${name} житло для 3 осіб`, `Житло в ${name} для 3 осіб`]) {
        assert.equal(knownHousingLocation(text), canonical, text);
      }
    }
  }
});

test('explicit district input retains district meaning', () => {
  for (const [name, expected] of [
    ['Kreis Segeberg', 'Kreis Segeberg'], ['район Зегеберг', 'Kreis Segeberg'],
    ['Kreis Schleswig-Flensburg', 'Kreis Schleswig-Flensburg'],
    ['районі Шлезвіг-Фленсбург', 'Kreis Schleswig-Flensburg']
  ]) {
    assert.equal(knownHousingLocation(`${name} житло для 3 осіб`), expected);
    assert.equal(knownHousingLocation(`Житло в ${name} для 3 осіб`), expected);
  }
});

function callback(result, prefix, city) {
  const data = result.messages.flatMap(message => message.reply_markup?.inline_keyboard?.flat() || [])
    .map(button => button.callback_data).find(value => value?.startsWith(prefix));
  assert.ok(data, `Missing ${prefix}`);
  assert.equal(decodeURIComponent(data.slice(prefix.length)), city);
  return data;
}

test('Bad Segeberg reaches Jobcenter search through the buttons actually returned by the dispatcher', async () => {
  for (const name of ['Bad Segeberg', 'Бад Зегеберг', 'Бад-Сегеберг']) {
    const f = await fixture();
    try {
      const entry = await f.send(`${name} житло для 3 осіб`);
      assert.match(entry.last.text, /Тема: житло — Bad Segeberg\./u);
      const rooms = await f.send('', { callback:callback(entry, 'hkr:3:', 'Bad Segeberg'), previous:entry.last });
      assert.match(rooms.last.text, /Осіб: 3/u);
      const guideline = await f.send('', { callback:callback(rooms, 'hka:j:3:3:', 'Bad Segeberg'), previous:rooms.last });
      const search = await f.send('', { callback:callback(guideline, 'jcr:15:3:3:', 'Bad Segeberg'), previous:guideline.last });
      assert.ok(f.sourceCalls.length, 'Search must reach its sources');
      const final = search.messages.find(message => /Не вдалося отримати оголошення/u.test(String(message.text || '')));
      assert.ok(final, 'Search must finish with an explicit source failure result');
      assert.match(final.text, /Bad Segeberg/u);
      assert.match(final.text, /Не вдалося отримати оголошення/u);
      for (const result of [entry, rooms, guideline, search]) {
        for (const message of result.messages) {
          assert.notEqual(message.reply_markup?.force_reply, true);
          assert.notEqual(message.reply_markup?.remove_keyboard, true);
          assert.equal(message.reply_markup?.keyboard, undefined);
        }
      }
      assert.equal(f.env.TELEGRAM_MAINTENANCE_MODE, 'true');
    } finally { f.close(); }
  }
});
