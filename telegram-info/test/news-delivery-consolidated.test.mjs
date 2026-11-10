import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, NOW, GROUP, json } from './runtime-fixture.mjs';
import { filterNewsCardsV2, deliverSafeNewsPublicationV2 } from '../src/news-quality-v2.mjs';
import { buildWeatherBriefV2, buildMorningBriefV2 } from '../src/morning-brief-v2.mjs';
import { publishNews } from '../src/runtime-news.mjs';

const plan={createdAt:NOW,cardCount:1,rejected:0,items:[
  {key:'header',kind:'header',method:'sendMessage',payload:{text:'Ранковий огляд'}},
  {key:'card:0',kind:'card',method:'sendPhoto',payload:{photo:'https://fixture.example/news.jpg',caption:'Перевірена новина'}}
]};
const CHANNEL=-1004480749326;
const recordKey=`telegram-news-publication:v1:${CHANNEL}:daily:2026-09-15`;
// TG-RUNTIME-115: news go to the channel only, so the delivery tests publish there.
const channelFixture=()=>fixture({TELEGRAM_ALLOWED_CHAT_IDS:`${GROUP},${CHANNEL}`,TELEGRAM_NEWS_CHAT_IDS:String(CHANNEL)});

test('quality rejects undated trusted news and undated events',()=>{
  const common={image:'https://fixture.example/image.jpg',title:'Neue Regeln für ukrainische Geflüchtete',titleUk:'Нові правила для українців'};
  const news={...common,kind:'refugee',link:'https://www.ndr.de/nachrichten/schleswig-holstein/fixture.html',source:'NDR Schleswig-Holstein',publishedAt:null};
  const event={...common,kind:'event',link:'https://www.hamburg.de/kultur/veranstaltungen/fixture',source:'hamburg.de',eventMeta:{startAt:null,fallbackDate:null}};
  assert.deepEqual(filterNewsCardsV2([news,event],NOW),[]);
  assert.equal(filterNewsCardsV2([{...news,publishedAt:NOW-1000}],NOW).length,1);
});

test('missing weather readings are not converted to a zero-degree forecast',async()=>{
  const daily={temperature_2m_min:[null],temperature_2m_max:[null],weather_code:[null],precipitation_probability_max:[null],wind_gusts_10m_max:[null]};
  assert.equal(await buildWeatherBriefV2(async()=>json([{daily}])),null);
  const zero=await buildWeatherBriefV2(async()=>json([{daily:{...daily,temperature_2m_min:[0],temperature_2m_max:[0]}}]));
  assert.equal(zero.forecasts[0].tMin,0);assert.equal(zero.forecasts[0].rain,null);assert.equal(zero.forecasts[0].code,null);
  assert.equal(zero.maxRain,null);assert.equal(zero.maxGust,null);assert.equal(zero.complete,false);
  assert.doesNotMatch(zero.text,/переважно сухо/u);
  const brief=await buildMorningBriefV2({},NOW,async(url)=>String(url).includes('open-meteo')?json([{daily:{...daily,temperature_2m_min:[0],temperature_2m_max:[0]}}]):json({},503));
  assert.match(brief,/Погодні дані неповні/u);
  assert.doesNotMatch(brief,/погодного ризику не видно/u);
});


test('dedicated news target publishes to the channel only while group stays in interaction allowlist',async()=>{
  const f=await fixture({
    TELEGRAM_ALLOWED_CHAT_IDS:`${GROUP},${CHANNEL}`,
    TELEGRAM_NEWS_CHAT_IDS:String(CHANNEL)
  });try{
    const channelRecordKey=`telegram-news-publication:v1:${CHANNEL}:daily:2026-09-15`;
    await f.storage.put(channelRecordKey,{publication:plan,states:{}});
    const delivered=[];
    const transport=async(url,options={})=>{
      const method=String(url).split('/').at(-1);
      const body=JSON.parse(options.body);
      delivered.push({method,chatId:Number(body.chat_id)});
      return json({ok:true,result:{message_id:500+delivered.length}});
    };
    const result=await publishNews(f.object,{now:NOW},transport);
    assert.equal(result.failed,0);
    assert.equal(result.skipped,false);
    assert.deepEqual(delivered.map(item=>item.chatId),[CHANNEL,CHANNEL]);
    assert.equal(await f.storage.get(`telegram-daily-news:v2:${CHANNEL}`),'2026-09-15');
    assert.equal(await f.storage.get(`telegram-daily-news:v2:${GROUP}`),undefined);
  }finally{f.close();}
});

test('news publishing fails closed when dedicated target is absent from the interaction allowlist',async()=>{
  const f=await fixture({TELEGRAM_NEWS_CHAT_IDS:String(CHANNEL)});try{
    let sends=0;
    const result=await publishNews(f.object,{now:NOW},async()=>{sends+=1;return json({ok:true});});
    assert.equal(result.skipped,true);
    assert.equal(result.sent,0);
    assert.equal(sends,0);
  }finally{f.close();}
});

test('partial delivery resumes only the failed card, retaining accepted header and date marker semantics',async()=>{
  const f=await channelFixture();try{
    await f.storage.put(recordKey,{publication:plan,states:{}});
    const calls=[];let fail=true;
    const transport=async(url)=>{const method=String(url).split('/').at(-1);calls.push(method);return method==='sendPhoto'&&fail?json({ok:false},503):json({ok:true,result:{message_id:123}});};
    const first=await publishNews(f.object,{now:NOW},transport);
    assert.equal(first.sent,1);assert.equal(first.failed,1);assert.equal(await f.storage.get(`telegram-daily-news:v2:${CHANNEL}`),undefined);
    fail=false;
    const second=await publishNews(f.object,{now:NOW+1000},transport);
    assert.equal(second.failed,0);assert.equal(second.sent,1);
    assert.deepEqual(calls,['sendMessage','sendPhoto','sendPhoto']);
    assert.equal(await f.storage.get(`telegram-daily-news:v2:${CHANNEL}`),'2026-09-15');
    const third=await publishNews(f.object,{now:NOW+2000},transport);assert.equal(third.alreadySent,1);assert.equal(calls.length,3);
  }finally{f.close();}
});

test('timeout and persisted in-flight send remain uncertain across restart instead of duplicate delivery',async()=>{
  const f=await channelFixture();try{
    await f.storage.put(recordKey,{publication:plan,states:{header:{state:'sent',messageId:100},'card:0':{state:'sending'}}});
    let sends=0;const transport=async()=>{sends++;return json({ok:true});};
    const result=await publishNews(f.object,{now:NOW},transport);
    assert.equal(result.failed,1);assert.equal(result.uncertain,1);assert.equal(sends,0);
    const states={};
    const direct=await deliverSafeNewsPublicationV2({token:'fixture'},GROUP,plan,async()=>{throw new Error('timeout');},{states});
    assert.equal(direct.uncertain,1);assert.equal(states.header.state,'uncertain');assert.equal(states['card:0'],undefined);
  }finally{f.close();}
});

test('concurrent scheduled attempts publish each component once',async()=>{
  const f=await channelFixture();try{
    await f.storage.put(recordKey,{publication:plan,states:{}});
    let release;const barrier=new Promise(resolve=>{release=resolve;});let sends=0;
    const transport=async()=>{sends++;await barrier;return json({ok:true,result:{message_id:100+sends}});};
    const first=publishNews(f.object,{now:NOW},transport);
    const second=await publishNews(f.object,{now:NOW},transport);assert.equal(second.inFlight,1);
    release();await first;assert.equal(sends,2);
  }finally{f.close();}
});

test('legacy sent marker prevents repost after rollout and outside morning window does not send',async()=>{
  const f=await channelFixture();try{
    await f.storage.put(`telegram-daily-news:v2:${CHANNEL}`,'2026-09-15');
    const transport=async()=>{throw new Error('network must not be called');};
    const existing=await publishNews(f.object,{now:NOW},transport);assert.equal(existing.alreadySent,1);
    const late=await publishNews(f.object,{now:Date.UTC(2026,8,15,9)},transport);assert.equal(late.skipped,true);
  }finally{f.close();}
});
