import test from 'node:test';
import assert from 'node:assert/strict';
import { answerQuestion, scanLetter, writeLandlordLetter, SYSTEM_INSTRUCTION } from '../src/ai-assistant.mjs';

// TG-RUNTIME-054: the bot has no budget. Shorter answers stretch the free
// daily Workers AI quota; only the explanation of a letter keeps more room.

function recordingAi() {
  const calls = [];
  return { calls, async run(model, input) { calls.push(input); return { response:'Відповідь.' }; } };
}

test('#054 a question and a landlord letter are capped at 500 output tokens, a letter scan at 900', async () => {
  const AI = recordingAi();
  const env = { AI };
  assert.equal((await answerQuestion(env, 'Що таке Kaltmiete?')).status, 'ok');
  assert.equal((await writeLandlordLetter(env, '🏠 Wohnung\n💶 650 €\n📍 Trittau')).status, 'ok');
  assert.equal((await scanLetter(env, { text:'Sehr geehrte Damen und Herren, bitte reichen Sie Unterlagen ein.' })).status, 'ok');
  assert.deepEqual(AI.calls.map(call => call.max_tokens), [500, 500, 900]);
});

test('#054 the external fallback gets the same cap', async () => {
  const bodies = [];
  const env = { AI:{ async run() { throw new Error('down'); } }, AI_EXTERNAL_ENABLED:'true', GROQ_API_KEY:'g' };
  const transport = async (url, options) => { bodies.push(JSON.parse(options.body)); return new Response(JSON.stringify({ choices:[{ message:{ content:'Відповідь.' } }] }), { status:200 }); };
  assert.equal((await answerQuestion(env, 'Що таке Kaltmiete?', transport)).status, 'ok');
  assert.equal(bodies[0].max_tokens, 500);
});

test('#054 the instruction asks for short answers', () => {
  assert.match(SYSTEM_INSTRUCTION, /до 1000 символів/u);
  assert.doesNotMatch(SYSTEM_INSTRUCTION, /1500 символів/u);
});
