// Consolidated runtime: active behavior has one explicit owner; historical entrypoints are not imported.
import { handleSearchRateStorage, acquireSearchSlot, searchRateText } from './search-rate-limit.mjs';
import { legalCommand } from './legal-commands.mjs';
import { safeLogText } from './log-safe.mjs';
import { handle as baseHandle } from './worker-entry-beta.mjs';
import { GroupTelegramOutbox } from './active-household-context.mjs';
import { pilotConfig, equalSecret, withStatelessDirectReply } from './pilot-security.mjs';
import { subrequestBudgetTransport } from './subrequest-budget.mjs';
import { captureTelegramTelemetry } from './telegram-telemetry.mjs';
import { normalizeCities, normalizeJobcenterCityInput } from './runtime-cities.mjs';
import { handleNavigation, handleHousingKeyboard, jobcenterRoomRequest, normalizeKeyboardPayload, keyboardRequestContext, handleKeyboardResetStorage, handlePrivatePromptStorage, preparePrivatePromptContext, rememberPrivatePrompt, maybeHandleFastPrivateStart } from './runtime-keyboard.mjs';
import { prepareHousingState, finishHousingState, recordHousingPrompt, sanitizeTelegramPayload, handleHousingStorage, handlePrivateHousingContinuity, normalizePrivateHousingContextRequest } from './runtime-housing-state.mjs';
import { maybeHandleJobcenterPreSearch, maybeHandleJobcenterTypedRooms, maybeHandleJobcenterRadiusSearch, handleJobcenterSearchStorage, prepareJobcenterBackgroundAck, releasePreparedJobcenterBackgroundLock, cancelJobcenterBackgroundForNavigation, transportWithAbortSignal, JOBCENTER_BACKGROUND_TASK_HEADER, JOBCENTER_BACKGROUND_ACK_HEADER, JOBCENTER_BACKGROUND_PROGRESS_HEADER, JOBCENTER_BACKGROUND_LOCK_HEADER } from './runtime-jobcenter.mjs';
import { maybeHandleVerifiedJobcenterSearch, maybeHandleDistrictJobcenterSearch, maybeHandleNextHousingPage, enrichPrivateJobcenterCallbackRequest, normalizeStandaloneHouseholdRequest, radiusAnswerSearchRequest } from './runtime-housing-search.mjs';
import { housingOutputTransport } from './runtime-housing-output.mjs';
import { handleSharedHousingRequest } from './runtime-shared-housing.mjs';
import { normalizeHousingRoomRetryRequest } from './housing-room-retry.mjs';
import { handleGroupStatsRequest } from './group-stats-v1.mjs';
import { handleGroupCommands, handleCommunity, envWithReportRecipients, reportRecipients } from './runtime-community.mjs';
import { handleKduMonitorStorage, KDU_MONITOR_OBJECT, KDU_MONITOR_PATH } from './kdu-source-monitor.mjs';
import { handleRetentionSweepStorage, RETENTION_SWEEP_PATH } from './retention-sweep.mjs';
import { forgetCommand, handleForgetUserStorage } from './forget-command.mjs';
import { eventsCommand } from './events-command.mjs';
import { beratungCommand } from './beratung-command.mjs';
import { handleWeekendEventsStorage, WEEKEND_EVENTS_PATH } from './weekend-events.mjs';
import { handleOpsMetricsStorage, OPS_REPORT_PATH } from './ops-metrics.mjs';
import { maintenanceEnabled, maintenanceGate, triggerMaintenanceAnnouncement, handleMaintenanceStorage, adminPublishCommand, clearMaintenanceMarkersWhenOff } from './runtime-maintenance.mjs';
import { publishNews, handleNewsStorage, handleNewsCacheRefreshStorage, scheduledNews } from './runtime-news.mjs';
import { handleNewsPublicationCacheStorage } from './news-publication-cache.mjs';
import { handleTelegramUpdateIdempotencyStorage, withTelegramUpdateIdempotency } from './update-idempotency.mjs';
import { channelJoinGate } from './channel-membership-gate.mjs';
import { aiCommand, aiPaymentUpdate, aiPromptedScan, aiFreeTextTransport, aiCardButtonTransport, isAiBackgroundRequest } from './ai-commands.mjs';
import { housingWatchCommand, housingWatchButtonTransport, handleHousingWatchStorage, handleHousingWatchRun, scheduledHousingWatch } from './housing-watch.mjs';
import { handleAiStateStorage } from './ai-state.mjs';
import { prepareReportState, finishReportState, handleReportStorage } from './runtime-report-state.mjs';

const STATELESS_PATH='/telegram/stateless';
const BACKGROUND_JOBCENTER_SEARCH_CALLBACK=/^(?:hka:j:\d{1,2}:[^:]{1,8}:.{1,48}|jcr:(?:15|20|25):\d{1,2}:[^:]{1,8}:.{1,48}|jcd:\d{1,2}:[^:]{1,8}:.{1,48}|jcp:\d{1,2}:\d{1,2}:[^:]{1,8}:.{1,48}|jrp:\d{1,2}(?::(?:15|20|25))?)$/u;
const BACKGROUND_JOBCENTER_WATCHDOG_MS=85000;
// ctx.waitUntil() keeps a Worker alive for at most 30s after the response.
// The waitUntil path must time out and send its failure notice inside that
// window; the Durable Object alarm path keeps the longer watchdog above.
export const BACKGROUND_JOBCENTER_WAITUNTIL_WATCHDOG_MS=22000;
export const BACKGROUND_JOBCENTER_FAILURE_NOTICE_TIMEOUT_MS=6000;
export const JOBCENTER_BACKGROUND_TASK_PATH='/jobcenter-background-task';

export function shouldDelegateWholeKreisBackground(ack, env={}) {
  return ack?.district === true && !!env?.OUTBOX;
}

const SHARED_WHOLE_KREIS_OBJECT='jobcenter-district-search';

// One Durable Object per private user: an alarm runs its queue serially, so a
// shared object made every concurrent whole-Kreis search wait for the others.
export function wholeKreisDurableObjectName(update) {
  const query=update?.callback_query;
  const chatId=Number(query?.message?.chat?.id);
  const userId=Number(query?.from?.id);
  if(query?.message?.chat?.type!=='private'
      || !Number.isSafeInteger(chatId) || chatId<=0 || chatId!==userId) return SHARED_WHOLE_KREIS_OBJECT;
  return `${SHARED_WHOLE_KREIS_OBJECT}:v2:${chatId}`;
}

export async function isWholeKreisBackgroundRequest(request) {
  try {
    const update=await request.clone().json();
    const data=String(update?.callback_query?.data || '');
    return /^(?:jcd:\d{1,2}:[^:]{1,8}:.{1,48}|jcp:\d{1,2}:\d{1,2}:[^:]{1,8}:.{1,48})$/u.test(data);
  } catch {
    return false;
  }
}

export async function handleDurableJobcenterBackgroundTask(request,outbox,{ runTask=null }={}) {
  let url;
  try { url=new URL(request?.url || ''); } catch { return null; }
  if(request?.method!=='POST' || url.hostname!=='outbox.internal' || url.pathname!==JOBCENTER_BACKGROUND_TASK_PATH) return null;
  if(request.headers.get(JOBCENTER_BACKGROUND_TASK_HEADER)!=='1') {
    return new Response(JSON.stringify({ ok:false, mode:'telegram-jobcenter-search-durable-rejected' }), {
      status:400,
      headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
    });
  }
  if(!outbox?.ctx || typeof outbox.ctx.waitUntil!=='function') {
    return new Response(JSON.stringify({ ok:false, mode:'telegram-jobcenter-search-durable-unavailable' }), {
      status:503,
      headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
    });
  }

  const body=await request.arrayBuffer();
  const taskRequest=new Request(`https://worker.internal${STATELESS_PATH}`, {
    method:'POST',
    headers:new Headers(request.headers),
    body
  });
  const fallbackRequest=taskRequest.clone();
  let task;
  if(typeof runTask==='function') {
    task=Promise.resolve(runTask(taskRequest,fallbackRequest));
  } else {
    const taskController=new AbortController();
    const taskTransport=transportWithAbortSignal(fetch,taskController.signal);
    task=superviseBackgroundJobcenterTask(
      handle(taskRequest,outbox.env,Date.now(),taskTransport),
      fallbackRequest,
      outbox.env,
      { abortController:taskController }
    );
  }
  outbox.ctx.waitUntil(task);
  return new Response(JSON.stringify({ ok:true, mode:'telegram-jobcenter-search-durable-accepted' }), {
    status:200,
    headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
  });
}

export class TelegramOutbox extends GroupTelegramOutbox {
  async publishDailyNews(now=Date.now()) { return publishNews(this,{now}); }
  async fetch(request) {
    await clearMaintenanceMarkersWhenOff(this);
    const durableTask=await handleDurableJobcenterBackgroundTask(request,this);
    if(durableTask) return durableTask;
    const updateClaim=await handleTelegramUpdateIdempotencyStorage(request,this);
    if(updateClaim) return updateClaim;
    const kduMonitor=await handleKduMonitorStorage(request,this,{ config:pilotConfig(this.env), recipients:()=>reportRecipients(this.env) });
    if(kduMonitor) return kduMonitor;
    const sweep=await handleRetentionSweepStorage(request,this);
    if(sweep) return sweep;
    const forget=await handleForgetUserStorage(request,this);
    if(forget) return forget;
    const searchRate=await handleSearchRateStorage(request,this);
    if(searchRate) return searchRate;
    const ops=await handleOpsMetricsStorage(request,this,{ config:pilotConfig(this.env), recipients:()=>reportRecipients(this.env) });
    if(ops) return ops;
    const ai=await handleAiStateStorage(request,this);
    if(ai) return ai;
    const watch=await handleHousingWatchStorage(request,this) || await handleHousingWatchRun(request,this);
    if(watch) return watch;
    return await handleMaintenanceStorage(request,this) || await handleNewsStorage(request,this) || await handleWeekendEventsStorage(request,this) || await handleNewsPublicationCacheStorage(request,this) || await handleNewsCacheRefreshStorage(request,this) || await handleKeyboardResetStorage(request,this) || await handlePrivatePromptStorage(request,this) || await handleJobcenterSearchStorage(request,this) || await handleReportStorage(request,this) || await handleHousingStorage(request,this) || super.fetch(request);
  }
}

function housingPromptForState(payload) {
  if (!payload || typeof payload.text !== 'string') return payload;
  if (/^Вкажіть місто або район у Schleswig-Holstein(?:,|\.|$)/iu.test(payload.text.trim())) {
    return { ...payload, text:'Тема: житло. Вкажіть місто або район.' };
  }
  return payload;
}

function suppressHousingForceReply(payload) {
  if (!payload || payload?.reply_markup?.force_reply !== true || typeof payload.text !== 'string') return payload;
  const text=payload.text.trim();
  const housingPrompt =
    /^Тема: житло(?:\s*[—–-]|\.|$)/iu.test(text) ||
    /^🏠\s*Дані пошуку житла збережено\./u.test(text) ||
    /^Jobcenter-погодження житла\s*[—–-]/iu.test(text) ||
    /^Перевірка оренди\s*[—–-]/iu.test(text);
  if (!housingPrompt) return payload;
  const next={...payload};
  delete next.reply_markup;
  return next;
}

function outgoingTransport(env,now,transport,keyboardContext,{ mutateHousingState=true }={}) {
  const final=async(url,options={})=>{
    if(!/^https:\/\/api\.telegram\.org\/bot[^/]+\/sendMessage$/u.test(String(url)) || typeof options.body!=='string') return transport(url,options);
    let payload;try{payload=JSON.parse(options.body);}catch{return transport(url,options);}
    payload=sanitizeTelegramPayload(payload);
    const housingDialogue=mutateHousingState
      ? await recordHousingPrompt(housingPromptForState(payload),env,now)
      : false;
    payload=normalizeKeyboardPayload(payload,{...keyboardContext,housingDialogue});
    payload=suppressHousingForceReply(payload);

    const chatId=Number(payload?.chat_id);
    const privateChat=Number.isSafeInteger(chatId) && chatId>0;
    const privatePrompt=privateChat && payload?.reply_markup?.force_reply===true && typeof payload.text==='string'
      ? payload.text
      : null;

    // Hard client boundary: private Telegram Android must never receive ForceReply
    // or an input placeholder. Legacy handlers may still describe that contract
    // internally; the prompt is virtualized into Durable Object state instead.
    if(privatePrompt) {
      delete payload.reply_markup;
      payload=normalizeKeyboardPayload(payload,{...keyboardContext,housingDialogue});
    } else if(privateChat && Array.isArray(payload?.reply_markup?.keyboard) && payload.reply_markup.input_field_placeholder!=null) {
      const {input_field_placeholder:_placeholder,...rest}=payload.reply_markup;
      payload.reply_markup=rest;
    }

    const response=await transport(url,{...options,body:JSON.stringify(payload)});
    if(mutateHousingState && privatePrompt && response?.ok) {
      await rememberPrivatePrompt(env,chatId,privatePrompt,now);
    }
    return response;
  };
  return housingOutputTransport(final);
}

export async function isTopLevelNavigationRequest(request) {
  try {
    const update = await request.clone().json();
    const callback = String(update?.callback_query?.data || '');
    if (/^nav:(?:menu|housing|jobcenter|work|courses|school|transport|documents|kindergeld|news|report)$/u.test(callback)) return true;
    const text = String(update?.message?.text || '').trim();
    return /^(?:🏠\s*Житло|🏛\s*Jobcenter|💼\s*Робота|🎓\s*Курси|👨‍👩‍👧\s*Школа\s*\/\s*Kita|🚌\s*Транспорт|📄\s*Документи|👶\s*Kindergeld|🗞\s*Новини|🐞\s*Повідомити про помилку|☰\s*Меню)$/u.test(text);
  } catch {
    return false;
  }
}

async function route(request,env,now,transport) {
  const navigation=await handleNavigation(request,env,now,transport);
  if(navigation instanceof Response) return navigation;
  request=navigation?.request||request;
  // TG-RUNTIME-079: the radius answer runs the search at once.
  request=await radiusAnswerSearchRequest(request)||request;
  const preSearch=await maybeHandleJobcenterPreSearch(request,env,transport);
  if(preSearch) return preSearch;
  const typedRooms=await maybeHandleJobcenterTypedRooms(request,env,now,transport);
  if(typedRooms) return typedRooms;
  const radius=await maybeHandleJobcenterRadiusSearch(request,env,now,transport);
  if(radius) return radius;
  const keyboard=await handleHousingKeyboard(request,env,now,transport);
  if(keyboard instanceof Response) return keyboard;
  request=keyboard?.request||request;

  const normalized=await normalizePrivateHousingContextRequest(request,env,transport);
  if(normalized.response) return normalized.response;
  request=normalized.request;
  const continuity=await handlePrivateHousingContinuity(request,env,transport);
  if(continuity) return continuity;
  const stats=await handleGroupStatsRequest(request,env,transport);
  if(stats) return stats;
  const shared=await handleSharedHousingRequest(request,env,now,transport);
  if(shared instanceof Response) return shared;
  request=shared?.request||request;
  request=await normalizeHousingRoomRetryRequest(request);
  const group=await handleGroupCommands(request,env,now,transport);
  if(group instanceof Response) return group;
  request=group?.request||request;
  const reportState=await prepareReportState(request,env,now,transport);
  request=reportState.request;
  env=await envWithReportRecipients(request,env,transport);
  const community=await handleCommunity(request,env,now,transport);
  if(community instanceof Response) {
    await finishReportState(reportState.clearAfter,community,env);
    return community;
  }
  request=community?.request||request;
  request=await normalizeJobcenterCityInput(request,transport);
  const nextHousingPage=await maybeHandleNextHousingPage(request,env,transport);
  if(nextHousingPage) return nextHousingPage;
  const districtSearch=await maybeHandleDistrictJobcenterSearch(request,env,transport);
  if(districtSearch) return districtSearch;
  const direct=await maybeHandleVerifiedJobcenterSearch(request,env,now,transport);
  if(direct) return direct;
  request=await normalizeStandaloneHouseholdRequest(await enrichPrivateJobcenterCallbackRequest(request,env,transport));
  // The consolidated v21 stateless ingress is already authenticated above.
  // Legacy base handlers reply directly only with the explicit marker; the
  // real delivery configuration is passed through unchanged.
  const fallbackEnv = env.TELEGRAM_DELIVERY_ENABLED === 'true'
    ? withStatelessDirectReply(env)
    : env;
  return baseHandle(request,fallbackEnv,now,transport);
}

export const STALE_CALLBACK_NOTICE='Ця кнопка застаріла. Відкрийте ☰ Меню.';

async function privateCallbackQuery(request) {
  try {
    const query=(await request.clone().json())?.callback_query;
    const chatId=Number(query?.message?.chat?.id);
    const userId=Number(query?.from?.id);
    if(typeof query?.id!=='string' || !query.id || query?.message?.chat?.type!=='private'
        || !Number.isSafeInteger(chatId) || chatId<=0 || chatId!==userId || query?.from?.is_bot===true) return null;
    return query;
  } catch {
    return null;
  }
}

// Every private callback_query must end the client's loading spinner exactly
// once. Handlers answer through the transport; this tracks those answers so the
// last-resort answer below never duplicates one.
function callbackTrackingTransport(transport,tracker) {
  return async(url,options={})=>{
    const method=/^https:\/\/api\.telegram\.org\/bot[^/]+\/([A-Za-z]+)$/u.exec(String(url))?.[1];
    const response=await transport(url,options);
    if(method==='answerCallbackQuery') tracker.answered=true;
    else if(method==='sendMessage' || method==='sendPhoto' || method==='sendMediaGroup' || method==='editMessageText') tracker.replied=true;
    return response;
  };
}

export async function handle(request,env={},now=Date.now(),transport=fetch) {
  // Every listing card in a private chat gets the AI letter button (ai-commands.mjs).
  transport=aiCardButtonTransport(transport,env);
  // A radius search's controls get the "🔔 Стежити" button (housing-watch.mjs).
  transport=housingWatchButtonTransport(transport,env);
  const url=new URL(request.url);
  const config=pilotConfig(env);
  const query=url.pathname===STATELESS_PATH && request.method==='POST' && env.TELEGRAM_INGRESS_ENABLED==='true' && config
      && equalSecret(request.headers.get('x-telegram-bot-api-secret-token'),config.secret)
      && request.headers.get(JOBCENTER_BACKGROUND_ACK_HEADER)!=='1'
    ? await privateCallbackQuery(request)
    : null;
  if(!query) return handleUpdate(request,env,now,transport);
  // TG-RUNTIME-077: rooms under a Jobcenter prompt continue as hka:j.
  request=await jobcenterRoomRequest(request) || request;
  const tracker={answered:false,replied:false};
  const response=await handleUpdate(request,env,now,callbackTrackingTransport(transport,tracker));
  if(!tracker.answered && !(response?.status>=500)) {
    // Unknown/stale buttons (and gates such as maintenance) otherwise leave
    // the Telegram spinner running. Explain only when nothing else was sent.
    try {
      await transport(`https://api.telegram.org/bot${config.token}/answerCallbackQuery`,{
        method:'POST',
        headers:{ 'content-type':'application/json' },
        body:JSON.stringify(tracker.replied
          ? { callback_query_id:query.id }
          : { callback_query_id:query.id, text:STALE_CALLBACK_NOTICE })
      });
    } catch {}
  }
  return response;
}

async function handleUpdate(request,env,now,transport) {
  const url=new URL(request.url);
  const config=pilotConfig(env);
  const isStatelessPost=url.pathname===STATELESS_PATH && request.method==='POST';
  const suppliedSecret=request.headers.get('x-telegram-bot-api-secret-token');
  // In live-delivery mode, reject an invalid webhook secret here before falling
  // through to legacy handlers whose delivery gate would otherwise return 503.
  if(isStatelessPost && env.TELEGRAM_INGRESS_ENABLED==='true' && config && !equalSecret(suppliedSecret,config.secret)) {
    return new Response(JSON.stringify({ error:'Unauthorized' }), {
      status:401,
      headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
    });
  }
  // Gate before city resolution, state reads and any provider request.
  if(!isStatelessPost || env.TELEGRAM_INGRESS_ENABLED!=='true' || !config || !equalSecret(suppliedSecret,config.secret)) return baseHandle(request,env,now,transport);
  const payment=await aiPaymentUpdate(request,env,now,transport);
  if(payment) return payment;
  // TG-RUNTIME-066: deletion and legal information never wait for maintenance.
  const forget=await forgetCommand(request,env,now,transport);
  if(forget) return forget;
  const legal=await legalCommand(request,env,now,transport);
  if(legal) return legal;
  // TG-RUNTIME-115: group join requests are checked against the news channel
  // before maintenance, so a paused bot never loses a request update.
  const joinGate=await channelJoinGate(request,env,transport);
  if(joinGate) return joinGate;
  const maintenance=await maintenanceGate(request,env,transport);
  if(maintenance) return maintenance;
  const manual=await adminPublishCommand(request,env,now,transport);
  if(manual) return manual;
  const events=await eventsCommand(request,env,now,transport);
  if(events) return events;
  const beratung=await beratungCommand(request,env,now,transport);
  if(beratung) return beratung;
  const ai=await aiCommand(request,env,now,transport);
  if(ai) return ai;
  const watch=await housingWatchCommand(request,env,now,transport);
  if(watch) return watch;

  // A top-level navigation action is a hard session boundary. Process/translate
  // it before restoring any previous housing prompt so a timed-out background
  // search can never make "🏠 Житло" or another main section appear dead.
  if (await isTopLevelNavigationRequest(request)) {
    // New top-level navigation invalidates any previous whole-Kreis ownership.
    // A detached background result from the old flow must never mutate or
    // overwrite the new housing conversation.
    await cancelJobcenterBackgroundForNavigation(request,env,now);
    const earlyNavigation = await handleNavigation(request,env,now,transport);
    if (earlyNavigation instanceof Response) return earlyNavigation;
    request = earlyNavigation?.request || request;
  }

  const keyboardContext=await keyboardRequestContext(request);
  if(keyboardContext.fastStart===true){
    const navigation=await handleNavigation(request,env,now,transport);
    if(navigation instanceof Response)return navigation;
    request=navigation?.request||request;
    const reportState=await prepareReportState(request,env,now,transport);
    request=reportState.request;
    // /start answers here, before the general prompt context below, so it
    // clears a saved question or section follow-up itself.
    request=await preparePrivatePromptContext(request,env,now);
    // TG-RUNTIME-082: the saved housing step ends here too ("🏠 Житло",
    // /start, «Trittau» continued the old housing question).
    await prepareHousingState(request,env,now,transport,keyboardContext);
    const fastStart=await maybeHandleFastPrivateStart(request,env,transport);
    if(fastStart){
      await finishReportState(reportState.clearAfter,fastStart,env);
      return fastStart;
    }
  }
  request=await preparePrivatePromptContext(request,env,now);
  // A town typed after "🔎 Інше місто" / "🔎 Пошук за містом" now carries the
  // saved prompt as reply context.
  const promptedEvents=await eventsCommand(request,env,now,transport);
  if(promptedEvents) return promptedEvents;
  const promptedBeratung=await beratungCommand(request,env,now,transport);
  if(promptedBeratung) return promptedBeratung;
  // The text of a letter after /scanner.
  const promptedScan=await aiPromptedScan(request,env,now,transport);
  if(promptedScan) return promptedScan;
  request=await normalizeCities(request,transport);
  const backgroundJobcenterTask=request.headers.get(JOBCENTER_BACKGROUND_TASK_HEADER)==='1';
  // A question the bot cannot route gets an AI answer instead of the fallback.
  const answering=await aiFreeTextTransport(request,env,now,transport);
  const outgoing=outgoingTransport(env,now,answering,keyboardContext,{ mutateHousingState:!backgroundJobcenterTask });
  const state=await prepareHousingState(request,env,now,outgoing,keyboardContext);
  const response=await route(state.request,env,now,outgoing);
  await finishHousingState(state.clearAfter,response,env);
  return response;
}

export async function isBackgroundJobcenterSearchRequest(request,env={}) {
  let url;
  try { url=new URL(request?.url || ''); } catch { return false; }
  if(request?.method!=='POST' || url.pathname!==STATELESS_PATH || env?.TELEGRAM_INGRESS_ENABLED!=='true') return false;
  const config=pilotConfig(env);
  if(!config || !equalSecret(request.headers.get('x-telegram-bot-api-secret-token'),config.secret)) return false;
  try {
    const update=await request.clone().json();
    const data=String(update?.callback_query?.data || '');
    const chatId=Number(update?.callback_query?.message?.chat?.id);
    const userId=Number(update?.callback_query?.from?.id);
    return update?.callback_query?.message?.chat?.type==='private'
      && Number.isSafeInteger(chatId) && chatId>0 && chatId===userId
      && update?.callback_query?.from?.is_bot!==true
      && BACKGROUND_JOBCENTER_SEARCH_CALLBACK.test(data);
  } catch {
    return false;
  }
}

// Every background search callback (start, radius, whole Kreis and paging:
// each page runs the search again) takes the user's search slot.
// Returns { limited } (a ready response) or { slot } to release later.
async function takeSearchSlot(request,env) {
  let update=null;
  try { update=await request.clone().json(); } catch { return { slot:null }; }
  const query=update?.callback_query;
  const chatId=Number(query?.message?.chat?.id);
  const userId=Number(query?.from?.id);
  const slot=await acquireSearchSlot(env,chatId,userId,Date.now());
  if(slot.allowed) return { slot };
  const config=pilotConfig(env);
  try {
    await fetch(`https://api.telegram.org/bot${config.token}/answerCallbackQuery`,{
      method:'POST', headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ callback_query_id:String(query?.id || ''), text:searchRateText(slot.reason), show_alert:true }),
      signal:AbortSignal.timeout(3000)
    });
  } catch {}
  console.info('TELEGRAM_SEARCH_RATE',JSON.stringify({ allowed:false, reason:slot.reason }));
  return { limited:new Response(JSON.stringify({ ok:true, mode:'telegram-search-rate-limited', reason:slot.reason }), {
    status:200,
    headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
  }) };
}

function backgroundAcceptedResponse() {
  return new Response(JSON.stringify({ ok:true, mode:'telegram-jobcenter-search-background-accepted' }), {
    status:200,
    headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
  });
}

export function backgroundJobcenterFailureText() {
  return [
    '⚠️ Пошук житла не завершився через технічну помилку.',
    'Бот не залишатиме цей запит без фінальної відповіді.',
    'Спробуйте пошук ще раз.'
  ].join('\n');
}

async function notifyBackgroundJobcenterFailure(request,env,transport=fetch) {
  const config=pilotConfig(env);
  if(!config) return false;
  try {
    const update=await request.clone().json();
    const query=update?.callback_query;
    const chatId=Number(query?.message?.chat?.id);
    const userId=Number(query?.from?.id);
    if(query?.message?.chat?.type!=='private'
        || !Number.isSafeInteger(chatId) || chatId<=0 || chatId!==userId
        || query?.from?.is_bot===true) return false;
    const response=await transport(`https://api.telegram.org/bot${config.token}/sendMessage`,{
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({
        chat_id:chatId,
        text:backgroundJobcenterFailureText(),
        disable_notification:true
      }),
      signal:AbortSignal.timeout(BACKGROUND_JOBCENTER_FAILURE_NOTICE_TIMEOUT_MS)
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function superviseBackgroundJobcenterTask(taskPromise, fallbackRequest, env, { transport=fetch, timeoutMs=BACKGROUND_JOBCENTER_WATCHDOG_MS, abortController=null } = {}) {
  let timer;
  try {
    const outcome = await Promise.race([
      Promise.resolve(taskPromise).then(response => ({ type:'response', response }), error => ({ type:'error', error })),
      new Promise(resolve => {
        timer = setTimeout(() => resolve({ type:'timeout' }), timeoutMs);
      })
    ]);

    if (outcome.type === 'timeout') {
      console.error('telegram_jobcenter_background_watchdog_timeout', { timeoutMs });
      try { abortController?.abort(); } catch {}
      await releasePreparedJobcenterBackgroundLock(fallbackRequest,env);
      await notifyBackgroundJobcenterFailure(fallbackRequest,env,transport);
      await captureTelegramTelemetry(env, 'telegram_search', {
        chat_type:'private', action:'search', outcome:'failed', reason:'timeout'
      }, 'v21', transport).catch(()=>({ status:'unavailable' }));
      return new Response(JSON.stringify({ ok:false, mode:'telegram-jobcenter-search-background-timeout' }), {
        status:504,
        headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
      });
    }

    if (outcome.type === 'error') {
      console.error('telegram_jobcenter_background_failed',{
        name:String(outcome.error?.name || 'Error'),
        message:safeLogText(outcome.error?.message || 'Background Jobcenter search failed')
      });
      try { abortController?.abort(); } catch {}
      await releasePreparedJobcenterBackgroundLock(fallbackRequest,env);
      await notifyBackgroundJobcenterFailure(fallbackRequest,env,transport);
      await captureTelegramTelemetry(env, 'telegram_search', {
        chat_type:'private', action:'search', outcome:'failed', reason:'error'
      }, 'v21', transport).catch(()=>({ status:'unavailable' }));
      return new Response(JSON.stringify({ ok:false, mode:'telegram-jobcenter-search-background-failed' }), {
        status:500,
        headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
      });
    }

    const response = outcome.response;
    let body = null;
    try { body = await response?.clone?.().json(); } catch {}
    if (!response?.ok || body?.delivered === false) {
      console.error('telegram_jobcenter_background_delivery_failed',{
        status:Number(response?.status || 0),
        mode:safeLogText(body?.mode || 'unknown', 120)
      });
      await releasePreparedJobcenterBackgroundLock(fallbackRequest,env);
      await notifyBackgroundJobcenterFailure(fallbackRequest,env,transport);
      await captureTelegramTelemetry(env, 'telegram_search', {
        chat_type:'private', action:'search', outcome:'failed', reason:'delivery_failed'
      }, 'v21', transport).catch(()=>({ status:'unavailable' }));
    } else {
      await captureTelegramTelemetry(env, 'telegram_search', {
        chat_type:'private', action:'search', outcome:'delivered', reason:'completed'
      }, 'v21', transport).catch(()=>({ status:'unavailable' }));
    }
    return response;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// TG-RUNTIME-058: saved housing searches can run every 15 minutes; the other
// scheduled work keeps its hourly rhythm (the full chain runs at minute 0
// and on the daily cron). The daily cron never runs the housing watch, so
// the 8:30 daily cron and the 8:30 tick never run it twice.
// TG-RUNTIME-059: every other cron runs the watch, so it also runs while
// the deployed schedule is still the hourly one.
export const HOUSING_WATCH_CRON='*/15 * * * *';
export const DAILY_CRON='30 8 * * *';
export async function scheduled(event,env,ctx) {
  const now=Number.isFinite(event?.scheduledTime)?event.scheduledTime:Date.now();
  const watchTick=event?.cron!==DAILY_CRON;
  if(watchTick) {
    // Saved housing searches: each search in its own invocation (housing-watch.mjs).
    const watch=scheduledHousingWatch(env,now).then(result=>console.info('TELEGRAM_HOUSING_WATCH',JSON.stringify({status:String(result?.status||'unknown'),groups:Number(result?.groups||0),sent:Number(result?.sent||0),failed:Number(result?.failed||0)})))
      .catch(()=>console.info('TELEGRAM_HOUSING_WATCH',JSON.stringify({status:'unavailable'})));
    if(ctx?.waitUntil)ctx.waitUntil(watch);else await watch;
    if(event?.cron && new Date(now).getUTCMinutes()!==0) return { status:'housing-watch-only' };
  }
  const announcement=triggerMaintenanceAnnouncement(env,now).catch(()=>({status:'unavailable'}));
  if(ctx?.waitUntil)ctx.waitUntil(announcement);else await announcement;
  // Own object: its own storage and subrequest budget, one run per Berlin day.
  if(env?.OUTBOX) {
    const monitor=env.OUTBOX.get(env.OUTBOX.idFromName(KDU_MONITOR_OBJECT)).fetch(`https://outbox.internal${KDU_MONITOR_PATH}`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({now})
    }).then(response=>response.json()).then(result=>console.info('TELEGRAM_KDU_MONITOR',JSON.stringify({status:String(result?.status||'unknown'),alerts:Number(result?.alerts||0),sent:Number(result?.sent||0)})))
      .catch(()=>console.info('TELEGRAM_KDU_MONITOR',JSON.stringify({status:'unavailable'})));
    if(ctx?.waitUntil)ctx.waitUntil(monitor);else await monitor;
    // Expired per-user state is deleted, not only ignored (see retention-sweep.mjs).
    const sweep=env.OUTBOX.get(env.OUTBOX.idFromName('telegram-pilot-v1')).fetch(`https://outbox.internal${RETENTION_SWEEP_PATH}`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({now})
    }).then(response=>response.json()).then(result=>console.info('TELEGRAM_RETENTION_SWEEP',JSON.stringify({status:String(result?.status||'unknown'),deleted:Number(result?.total||0)})))
      .catch(()=>console.info('TELEGRAM_RETENTION_SWEEP',JSON.stringify({status:'unavailable'})));
    if(ctx?.waitUntil)ctx.waitUntil(sweep);else await sweep;
    // Daily report to the admins after 21:00 Berlin, once (see ops-metrics.mjs).
    const report=env.OUTBOX.get(env.OUTBOX.idFromName('telegram-pilot-v1')).fetch(`https://outbox.internal${OPS_REPORT_PATH}`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({now})
    }).then(response=>response.json()).then(result=>console.info('TELEGRAM_OPS_REPORT',JSON.stringify({status:String(result?.status||'unknown'),sent:Number(result?.sent||0)})))
      .catch(()=>console.info('TELEGRAM_OPS_REPORT',JSON.stringify({status:'unavailable'})));
    if(ctx?.waitUntil)ctx.waitUntil(report);else await report;
    // Friday from 16:00 Berlin: "Куди піти на вихідних" in the news chats, once.
    const weekend=env.OUTBOX.get(env.OUTBOX.idFromName('telegram-pilot-v1')).fetch(`https://outbox.internal${WEEKEND_EVENTS_PATH}`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({now})
    }).then(response=>response.json()).then(result=>console.info('TELEGRAM_WEEKEND_EVENTS',JSON.stringify({status:String(result?.status||'unknown'),sent:Number(result?.sent||0)})))
      .catch(()=>console.info('TELEGRAM_WEEKEND_EVENTS',JSON.stringify({status:'unavailable'})));
    if(ctx?.waitUntil)ctx.waitUntil(weekend);else await weekend;
  }
  return scheduledNews(event,env,ctx);
}
export function queueAggregateRequestTelemetry(request, responsePromise, env = {}, ctx, transport = fetch) {
  if (!ctx || typeof ctx.waitUntil !== 'function') return false;
  let isTelegramIngress = false;
  try {
    const url = new URL(request?.url || '');
    isTelegramIngress = request?.method === 'POST' && url.pathname === STATELESS_PATH;
  } catch {}
  if (!isTelegramIngress) return false;

  const telemetryPromise = Promise.resolve(responsePromise).then(
    response => captureTelegramTelemetry(env, 'telegram_request', {
      chat_type:'unknown',
      action:'other',
      outcome:response?.ok === false ? 'failed' : 'handled'
    }, 'v21', transport),
    () => captureTelegramTelemetry(env, 'telegram_error', {
      chat_type:'unknown',
      action:'other',
      outcome:'failed'
    }, 'v21', transport)
  ).catch(() => ({ status:'unavailable' }));

  ctx.waitUntil(telemetryPromise);
  return true;
}
async function processWebhook(request,env,ctx) {
    if(ctx?.waitUntil && maintenanceEnabled(env)) ctx.waitUntil(triggerMaintenanceAnnouncement(env,Date.now()).catch(()=>({status:'unavailable'})));

    if(ctx?.waitUntil && await isBackgroundJobcenterSearchRequest(request,env)) {
      // TG-RUNTIME-069: one search at a time per user, at most 20 in 10 min.
      const { limited, slot }=await takeSearchSlot(request,env);
      if(limited) return limited;
      // A search that never starts gives its slot back and is not counted.
      let started=false;
      const refundSlot=()=>(started ? undefined : slot?.release(true));
      try {
        const wholeKreis=await isWholeKreisBackgroundRequest(request);
        const ack = await prepareJobcenterBackgroundAck(request,env);
        const headers = new Headers(request.headers);
        headers.set(JOBCENTER_BACKGROUND_TASK_HEADER,'1');
        if (ack?.callbackAnswered) headers.set(JOBCENTER_BACKGROUND_ACK_HEADER,'1');
        if (Number.isSafeInteger(ack?.progressMessageId) && ack.progressMessageId > 0) {
          headers.set(JOBCENTER_BACKGROUND_PROGRESS_HEADER,String(ack.progressMessageId));
        }
        if (ack?.lockAcquired === true) headers.set(JOBCENTER_BACKGROUND_LOCK_HEADER,'1');
        if (ack?.skipBackground === true) { await refundSlot(); return backgroundAcceptedResponse(); }
        const taskRequest = new Request(request.clone(), { headers });
        const fallbackRequest=taskRequest.clone();

        if (shouldDelegateWholeKreisBackground({ district:wholeKreis },env)) {
          try {
            let update=null;
            try { update=await taskRequest.clone().json(); } catch {}
            const doId=env.OUTBOX.idFromName(wholeKreisDurableObjectName(update));
            const body=await taskRequest.clone().arrayBuffer();
            const delegated=await env.OUTBOX.get(doId).fetch(`https://outbox.internal${JOBCENTER_BACKGROUND_TASK_PATH}`, {
              method:'POST',
              headers:taskRequest.headers,
              body
            });
            // The whole-Kreis run counts as a search, but the Durable Object
            // does not know the slot; its own per-user lock
            // (district_acquire) keeps one run at a time, so the slot is
            // freed right after the hand-off instead of blocking for the lease.
            if(delegated?.ok) { started=true; await slot?.release(); return backgroundAcceptedResponse(); }
            console.error('telegram_jobcenter_durable_dispatch_failed',{ status:Number(delegated?.status || 0) });
          } catch(error) {
            console.error('telegram_jobcenter_durable_dispatch_failed',{
              name:String(error?.name || 'Error'),
              message:safeLogText(error?.message || 'Durable Object dispatch failed')
            });
          }
          await refundSlot();
          await releasePreparedJobcenterBackgroundLock(fallbackRequest,env);
          await notifyBackgroundJobcenterFailure(fallbackRequest,env);
          return backgroundAcceptedResponse();
        }

        const taskController = new AbortController();
        const taskTransport = transportWithAbortSignal(subrequestBudgetTransport(fetch,env), taskController.signal);
        const task=superviseBackgroundJobcenterTask(
          handle(taskRequest,env,Date.now(),taskTransport),
          fallbackRequest,
          env,
          { abortController:taskController, timeoutMs:BACKGROUND_JOBCENTER_WAITUNTIL_WATCHDOG_MS }
        );
        started=true;
        ctx.waitUntil(Promise.resolve(task).finally(()=>slot?.release()));
        queueAggregateRequestTelemetry(fallbackRequest,task,env,ctx);
        return backgroundAcceptedResponse();
      } catch(error) {
        await refundSlot();
        throw error;
      }
    }

    if(ctx?.waitUntil && await isAiBackgroundRequest(request,env)) {
      const task=handle(request,env,Date.now(),subrequestBudgetTransport(fetch,env)).catch(error=>{
        console.error('telegram_ai_background_failed',{ name:String(error?.name || 'Error') });
        return null;
      });
      ctx.waitUntil(task);
      queueAggregateRequestTelemetry(request,task,env,ctx);
      return new Response(JSON.stringify({ ok:true, mode:'telegram-ai-background-accepted' }), {
        status:200,
        headers:{ 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store' }
      });
    }

    const response=handle(request,env,Date.now(),subrequestBudgetTransport(fetch,env));
    queueAggregateRequestTelemetry(request,response,env,ctx);
    return response;
}

export default {
  async fetch(request,env,ctx) {
    // Telegram redelivers updates after a failed or slow webhook call.
    return withTelegramUpdateIdempotency(request,env,ctx,()=>processWebhook(request,env,ctx));
  },
  scheduled
};