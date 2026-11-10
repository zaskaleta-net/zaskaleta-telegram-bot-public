import { DatabaseSync } from 'node:sqlite';
import { TelegramOutbox, handle } from '../src/runtime.mjs';

export const NOW=Date.UTC(2026,8,15,8,0,0);
export const USER=777777777;
export const GROUP=-1001234567890;
export const SECRET='B'.repeat(40);
export const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

export async function fixture(overrides={}) {
  const db=new DatabaseSync(':memory:');
  const data=new Map(), calls=[], sourceCalls=[], internal=[];
  let alarm=null, sequence=100, object;
  const storage={
    async get(key){return structuredClone(data.get(key));},
    async put(key,value){data.set(key,structuredClone(value));},
    async delete(key){return data.delete(key);},
    async list({prefix='',limit=Infinity}={}){return new Map([...data].filter(([key])=>key.startsWith(prefix)).slice(0,limit).map(([key,value])=>[key,structuredClone(value)]));},
    async getAlarm(){return alarm;},async setAlarm(value){alarm=value;},
    sql:{exec(sql,...params){
      if(/^CREATE/i.test(sql.trim())){db.exec(sql);return {toArray:()=>[]};}
      const stmt=db.prepare(sql);
      if(/^(SELECT|WITH|PRAGMA)/i.test(sql.trim()))return {toArray:()=>stmt.all(...params)};
      stmt.run(...params);return {toArray:()=>[]};
    }},
    transactionSync(fn){db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(error){db.exec('ROLLBACK');throw error;}}
  };
  const env={
    TELEGRAM_RELEASE_APPROVED:'pilot-v1',TELEGRAM_PILOT_MODE:'allowlist',TELEGRAM_ALLOWED_CHAT_IDS:`${GROUP},${USER}`,TELEGRAM_NEWS_CHAT_IDS:String(GROUP),TELEGRAM_ADMIN_USER_IDS:String(USER),
    TELEGRAM_BOT_TOKEN:`123456789:${'A'.repeat(35)}`,TELEGRAM_WEBHOOK_SECRET:SECRET,
    TELEGRAM_INGRESS_ENABLED:'true',TELEGRAM_DELIVERY_ENABLED:'false',TELEGRAM_MAINTENANCE_MODE:'true',TELEGRAM_DAILY_NEWS_ENABLED:'true',
    OUTBOX:{idFromName(){return 'fixture';},get(){return {async fetch(url,options){internal.push(new URL(url).pathname);return object.fetch(new Request(url,options));}};}},
    ...overrides
  };
  const pending=[];
  const ctx={storage,blockConcurrencyWhile(fn){const promise=fn();pending.push(promise);return promise;}};
  object=new TelegramOutbox(ctx,env);await Promise.all(pending);
  const transport=async(url,options={})=>{
    const target=String(url);
    if(!target.startsWith('https://api.telegram.org/')){sourceCalls.push(target);return new Response('fixture unavailable',{status:503});}
    const method=target.split('/').at(-1);
    const body=typeof options.body==='string'?JSON.parse(options.body):Object.fromEntries(options.body||[]);
    calls.push({method,body});
    if(method==='getChatAdministrators')return json({ok:true,result:[{status:'creator',user:{id:USER,is_bot:false}}]});
    if(method==='getChatMember')return json({ok:true,result:{status:body.user_id===USER?'member':'left'}});
    if(['sendMessage','sendPhoto','sendDocument'].includes(method))return json({ok:true,result:{...body,message_id:++sequence,chat:{id:Number(body.chat_id),type:Number(body.chat_id)>0?'private':'supergroup'},from:{id:999999999,is_bot:true,username:'ZaskaletaInfoBot'}}});
    return json({ok:true,result:true});
  };
  const request=(text,{user=USER,chat=user,type='private',previous=null,callback=null,secret=SECRET,id=++sequence}={})=>{
    const message={message_id:id,date:NOW/1000,chat:{id:chat,type},from:{id:user,is_bot:false},text};
    if(previous)message.reply_to_message=previous;
    const update=callback?{update_id:id,callback_query:{id:`query-${id}`,from:message.from,data:callback,message:{...message,text:previous?.text||''}}}:{update_id:id,message};
    return new Request('https://fixture.example/telegram/stateless',{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':secret},body:JSON.stringify(update)});
  };
  const send=async(text,options={})=>{
    const before=calls.length;
    const response=await handle(request(text,options),env,NOW,transport);
    const messages=calls.slice(before).filter(call=>call.method==='sendMessage').map(call=>({...call.body,message_id:++sequence,chat:{id:Number(call.body.chat_id),type:Number(call.body.chat_id)>0?'private':'supergroup'},from:{id:999999999,is_bot:true,username:'ZaskaletaInfoBot'}}));
    return {response,body:await response.json(),messages,last:messages.at(-1)};
  };
  return {env,storage,data,object,calls,sourceCalls,internal,transport,request,send,close:()=>db.close()};
}
