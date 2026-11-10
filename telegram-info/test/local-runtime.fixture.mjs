// Test-only entrypoint. Never deploy this file or expose these routes publicly.
import production, { TelegramOutbox as BaseOutbox, createOutboxRuntime } from '../src/worker.mjs';

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

export class TelegramOutbox extends BaseOutbox {
  constructor(ctx, env) {
    super(ctx, env);
    this.mockCalls = 0;
    // Replace the transport before any alarm can run. This fixture never makes an external request.
    this.runtime = createOutboxRuntime(ctx, env, this.outbox, async (url, options) => {
      if (!url.startsWith('https://api.telegram.org/bot') || !url.endsWith('/sendMessage')) throw Error('Unexpected transport');
      this.mockCalls++;
      const body = JSON.parse(options.body);
      if (env.TEST_TRANSPORT_MODE === 'timeout') throw Error('Synthetic timeout');
      if (env.TEST_TRANSPORT_MODE === 'rate_limited') return json({ ok: false, error_code: 429, parameters: { retry_after: 2 } }, 429);
      return json({ ok: true, result: { message_id: 1000 + this.mockCalls, chat: { id: body.chat_id } } });
    });
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.hostname !== 'test.internal') return super.fetch(request);
    const p = await request.json();
    try {
      if (p.op === 'drain') { await this.runtime.drain(); return json({ ok: true, calls: this.mockCalls }); }
      if (p.op === 'state') return json({ row: this.outbox.get(p.id), calls: this.mockCalls, alarm: await this.ctx.storage.getAlarm() });
      if (p.op === 'claim') return json({ claim: this.outbox.claim(Date.now()) });
      if (p.op === 'erase') return json({ erased: this.outbox.eraseChat(p.chatId) });
      if (p.op === 'purge') { this.outbox.purge(p.now); return json({ ok: true }); }
      if (p.op === 'count') return json({ count: this.outbox.one('SELECT COUNT(*) AS n FROM telegram_outbox').n });
      return json({ error: 'unknown' }, 400);
    } catch (error) { return json({ error: error.message }, 500); }
  }
}

export default production;
