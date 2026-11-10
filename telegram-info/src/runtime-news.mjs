import { pilotConfig, readBoundedJSON } from './pilot-security.mjs';
import { berlinNewsDateKey, shouldPublishDailyNews } from './pilot-community.mjs';
import { buildSafeNewsPublicationV2, deliverSafeNewsPublicationV2 } from './news-quality-v2.mjs';
import { INTERNAL_PUBLISH_PATH, normalizeManualPublishRequest, manualPublishMarkerKey } from './admin-publish-v1.mjs';
import { subrequestBudgetTransport } from './subrequest-budget.mjs';
import { storeCachedPublication, newsPublicationNeedsRefresh } from './news-publication-cache.mjs';
import { withTranslationMemo } from './news-translation-memo.mjs';
import { sendOpsAlert, addOpsCount, opsDayKey } from './ops-metrics.mjs';
import { reportRecipients } from './runtime-community.mjs';
import { isNewsChannel } from './channel-membership-gate.mjs';

const DAILY_PREFIX='telegram-daily-news:v2:';
const PUBLICATION_PREFIX='telegram-news-publication:v1:';
// Workers Free allows 50 external subrequests per invocation, cron included.
// Each group may need up to 7 Telegram sends (header, brief, five cards); the
// feed/page fetches get what is left, so delivery is never starved.
const SUBREQUEST_LIMIT=50;
const SUBREQUEST_MARGIN=1;
const MAX_SENDS_PER_GROUP=7;
const MIN_NEWS_SOURCE_BUDGET=12;
const MAX_NEWS_SOURCE_BUDGET=36;
const DAILY_RECORD_RE=/:daily:(\d{4}-\d{2}-\d{2})$/u;
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});

export function parseNewsChatIds(value) {
  const raw=String(value||'').trim();
  if(!raw) return [];
  const parts=raw.split(',').map(item=>item.trim());
  if(!parts.length||parts.length>32||parts.some(item=>!/^-[1-9][0-9]*$/u.test(item))) return null;
  const ids=parts.map(Number);
  if(ids.some(id=>!Number.isSafeInteger(id)||id>=0)) return null;
  return [...new Set(ids)];
}

export function newsTargets(env,config) {
  const requested=parseNewsChatIds(env?.TELEGRAM_NEWS_CHAT_IDS);
  if(!config||requested===null||!requested.length) return [];
  const allowed=new Set(Array.isArray(config.chatIds)?config.chatIds:[]);
  if(requested.some(id=>!allowed.has(id))) return [];
  // TG-RUNTIME-115: news go to the channel only (fail-closed): any other
  // chat, the discussion group included, is dropped even when an old
  // TELEGRAM_NEWS_CHAT_IDS still lists it (Controller review, P1).
  return requested.filter(isNewsChannel);
}

export function newsSourceSubrequestBudget(env, groupCount) {
  const raw=String(env?.TELEGRAM_NEWS_SUBREQUEST_BUDGET||'').trim();
  if(/^[0-9]{1,3}$/u.test(raw) && Number(raw)>0) return Number(raw);
  const left=SUBREQUEST_LIMIT-SUBREQUEST_MARGIN-MAX_SENDS_PER_GROUP*Math.max(1,groupCount);
  return Math.min(MAX_NEWS_SOURCE_BUDGET,Math.max(MIN_NEWS_SOURCE_BUDGET,left));
}

// Past-day daily records can never be delivered again; drop them.
async function purgePastDailyRecords(storage, date) {
  if(typeof storage?.list!=='function') return;
  try {
    const records=await storage.list({prefix:PUBLICATION_PREFIX});
    for(const key of records.keys()) {
      const day=DAILY_RECORD_RE.exec(key)?.[1];
      if(day && day<date) await storage.delete(key);
    }
  } catch {}
}

async function publishGroup(outbox, config, chatId, key, legacyKey, now, daily, transport, buildPublication) {
  const storage=outbox.householdContextStorage;
  const previous=await storage.get(legacyKey);
  if (daily ? previous===berlinNewsDateKey(now) : previous?.state==='sent') return {sent:0,alreadySent:1,complete:true};
  // Old manual attempts in flight are ambiguous after a restart. Do not resend.
  if (!daily && previous?.state==='sending') return {sent:0,alreadySent:0,complete:false,uncertain:1};
  const recordKey=`${PUBLICATION_PREFIX}${chatId}:${key}`;
  let record=await storage.get(recordKey);
  if(!record) {
    record={publication:await buildPublication(),states:{}};
    await storage.put(recordKey,record);
  }
  const result=await deliverSafeNewsPublicationV2(config,chatId,record.publication,transport,{
    states:record.states,
    checkpoint:async states=>{record.states=states;await storage.put(recordKey,record);}
  });
  if(result.complete) {
    await storage.put(legacyKey,daily?berlinNewsDateKey(now):{state:'sent',sentAt:now,sent:record.publication.items.length});
    await storage.delete(recordKey);
  }
  return result;
}

export async function publishNews(outbox, {now, publication=null}, transport=fetch) {
  const daily=!publication;
  if(daily && (outbox.env?.TELEGRAM_DAILY_NEWS_ENABLED==='false' || !shouldPublishDailyNews(now))) return {sent:0,skipped:true};
  const config=pilotConfig(outbox.env);
  const groups=newsTargets(outbox.env,config);
  if(!config || !groups.length) return {sent:0,skipped:true};
  const date=berlinNewsDateKey(now);
  const key=daily?`daily:${date}`:`manual:${publication.idempotencyKey}`;
  outbox.newsInFlight ||= new Map();
  await purgePastDailyRecords(outbox.householdContextStorage,date);
  // One bounded transport and one publication per run, shared by all groups.
  const runTransport=subrequestBudgetTransport(transport,outbox.env,{budget:newsSourceSubrequestBudget(outbox.env,groups.length)});
  let shared=null;
  // The built digest also serves "/news" requests for the next 45 minutes.
  const buildPublication=()=>(shared ||= withTranslationMemo(outbox.householdContextStorage,outbox.env,env=>buildSafeNewsPublicationV2(env,now,runTransport))
    .then(async publication=>{await storeCachedPublication(outbox.householdContextStorage,publication);return publication;})
    .catch(error=>{shared=null;throw error;}));
  let sent=0,alreadySent=0,failed=0,inFlight=0,uncertain=0,limited=false;
  for(const chatId of groups) {
    const lock=`${chatId}:${key}`;
    if(outbox.newsInFlight.has(lock)){inFlight+=1;continue;}
    // The invocation's subrequests are used up; the next cron resumes.
    if(limited){failed+=1;continue;}
    const legacyKey=daily?`${DAILY_PREFIX}${chatId}`:manualPublishMarkerKey(chatId,publication.idempotencyKey);
    // Set the lock synchronously, before storage/source/network awaits.
    outbox.newsInFlight.set(lock,true);
    try {
      const result=await publishGroup(outbox,config,chatId,key,legacyKey,now,daily,runTransport,buildPublication);
      sent+=result.sent||0;alreadySent+=result.alreadySent||0;uncertain+=result.uncertain||0;
      if(result.subrequestLimit) limited=true;
      if(!result.complete) failed+=1;
    } catch { failed+=1; }
    finally {outbox.newsInFlight.delete(lock);}
  }
  // A failed run is retried at the next cron, and one retry usually heals it.
  // A digest stopped by the subrequest limit is expected to resume; a second
  // failed run of the day is told to the admins at once (once a day).
  if(daily && failed>0 && !limited) {
    const storage=outbox.householdContextStorage;
    await addOpsCount(storage,now,'news:failed').catch(()=>{});
    const runs=Number((await storage.get(opsDayKey(now)).catch(()=>null))?.counts?.['news:failed'])||0;
    if(runs>=2) await sendOpsAlert(storage,now,{id:'news',text:`⚠️ Ранковий огляд не вдалося надіслати вже ${runs} рази сьогодні (останній раз: ${failed} з ${groups.length} чатів). Бот і далі пробує за розкладом.`},{config,recipients:()=>reportRecipients(outbox.env),transport}).catch(()=>{});
  }
  return {sent,alreadySent,failed,inFlight,uncertain,skipped:false,date};
}

export async function handleNewsStorage(request,outbox) {
  const url=new URL(request.url);
  if(request.method!=='POST' || url.hostname!=='outbox.internal' || url.pathname!==INTERNAL_PUBLISH_PATH) return null;
  const parsed=await readBoundedJSON(request.clone(),32768);
  const now=Number(parsed.error?NaN:parsed.value?.now);
  const publication=normalizeManualPublishRequest(parsed.error?null:parsed.value?.publication,now);
  if(!Number.isFinite(now)||now<0||!publication) return json({status:'bad_operation'},400);
  if(!pilotConfig(outbox.env)) return json({status:'forbidden'},403);
  const result=await publishNews(outbox,{now,publication});
  const ok=!result.skipped && result.failed===0 && result.inFlight===0;
  return json({status:ok?'ok':'unavailable',...result,idempotencyKey:publication.idempotencyKey},ok?200:503);
}

export const NEWS_CACHE_REFRESH_PATH='/news-publication-refresh';
// A digest build needs no Telegram sends; the rest of the 50 subrequests stays free.
const NEWS_CACHE_REFRESH_SUBREQUEST_BUDGET=40;

export async function refreshNewsPublicationCache(outbox,now,transport=fetch) {
  const storage=outbox?.householdContextStorage;
  if(!storage || !pilotConfig(outbox.env)) return {status:'skipped'};
  if(!(await newsPublicationNeedsRefresh(storage,now))) return {status:'fresh'};
  const runTransport=subrequestBudgetTransport(transport,outbox.env,{budget:NEWS_CACHE_REFRESH_SUBREQUEST_BUDGET});
  const publication=await withTranslationMemo(storage,outbox.env,env=>buildSafeNewsPublicationV2(env,now,runTransport));
  const stored=await storeCachedPublication(storage,publication);
  return {status:stored?'refreshed':'not_cached',cards:Number(publication?.cardCount||0)};
}

export async function handleNewsCacheRefreshStorage(request,outbox) {
  const url=new URL(request.url);
  if(request.method!=='POST' || url.hostname!=='outbox.internal' || url.pathname!==NEWS_CACHE_REFRESH_PATH) return null;
  const parsed=await readBoundedJSON(request.clone(),4096);
  const now=Number(parsed.error?NaN:parsed.value?.now);
  if(!Number.isFinite(now)||now<0) return json({status:'bad_operation'},400);
  try { return json(await refreshNewsPublicationCache(outbox,now)); }
  catch { return json({status:'unavailable'},503); }
}

export async function scheduledNews(event,env,ctx) {
  const now=Number.isFinite(event?.scheduledTime)?event.scheduledTime:Date.now();
  if(!env?.OUTBOX) return;
  const task=(async()=>{
    try {
      const id=env.OUTBOX.idFromName('telegram-pilot-v1');
      const response=await env.OUTBOX.get(id).fetch('https://outbox.internal/beta-group',{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op:'daily_news',now})
      });
      const parsed=await readBoundedJSON(response,16384);
      const value=parsed.error?{}:parsed.value;
      // Fixed aggregate fields only; do not emit raw storage responses or IDs.
      console.info('TELEGRAM_DAILY_NEWS',JSON.stringify({status:response.ok?'handled':'unavailable',sent:Number(value.sent||0),failed:Number(value.failed||0),uncertain:Number(value.uncertain||0),skipped:value.skipped===true}));
    } catch {console.info('TELEGRAM_DAILY_NEWS',JSON.stringify({status:'unavailable'}));}
    // After the daily run, which may already have stored a fresh digest.
    try {
      const response=await env.OUTBOX.get(env.OUTBOX.idFromName('telegram-pilot-v1')).fetch(`https://outbox.internal${NEWS_CACHE_REFRESH_PATH}`,{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({now})
      });
      const parsed=await readBoundedJSON(response,4096);
      const value=parsed.error?{}:parsed.value;
      console.info('TELEGRAM_NEWS_CACHE',JSON.stringify({status:String(value.status||'unavailable'),cards:Number(value.cards||0)}));
    } catch {console.info('TELEGRAM_NEWS_CACHE',JSON.stringify({status:'unavailable'}));}
  })();
  if(ctx?.waitUntil) ctx.waitUntil(task);else await task;
}
