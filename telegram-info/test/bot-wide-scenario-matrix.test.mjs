import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, USER } from './runtime-fixture.mjs';
import { SH_JURISDICTIONS } from '../src/jobcenter-jurisdictions.mjs';
import { SH_RUNTIME_MUNICIPALITY_ROWS } from '../src/sh-municipality-jurisdiction-runtime.mjs';
import { jurisdictionForHousingLocation, filterHousingListingsToJurisdiction } from '../src/housing-jurisdiction-scope.mjs';

test('bot-wide scenario matrix keeps every Schleswig-Holstein jurisdiction fail-closed', () => {
  const covered=new Set();
  for(const jurisdiction of SH_JURISDICTIONS){
    const own=SH_RUNTIME_MUNICIPALITY_ROWS.find(row=>row.jurisdiction===jurisdiction);
    const foreign=SH_RUNTIME_MUNICIPALITY_ROWS.find(row=>row.jurisdiction!==jurisdiction);
    assert.ok(own, `missing municipality fixture for ${jurisdiction}`);
    assert.ok(foreign);
    assert.equal(jurisdictionForHousingLocation(own.canonical),jurisdiction);
    const result=filterHousingListingsToJurisdiction([
      {id:`${jurisdiction}-own`,url:`https://example.invalid/${own.ags}/own`,location:own.canonical},
      {id:`${jurisdiction}-foreign`,url:`https://example.invalid/${foreign.ags}/foreign`,location:foreign.canonical},
      {id:`${jurisdiction}-unknown`,url:'https://example.invalid/unknown',location:'Unknown place'}
    ],jurisdiction,own.canonical);
    assert.deepEqual(result.map(x=>x.id),[`${jurisdiction}-own`]);
    covered.add(jurisdiction);
  }
  assert.equal(covered.size,15);
});

test('active bot rejects foreign owner callbacks without source traffic or messages', async()=>{
  const f=await fixture();
  try{
    const result=await f.send('',{callback:`jcn:l:5:u${USER+1}`});
    assert.equal(f.sourceCalls.length,0);
    // Only the presser's own spinner is closed; nothing is sent or searched.
    assert.deepEqual(f.calls.map(call=>call.method),['answerCallbackQuery']);
    assert.ok(result.response);
  }finally{f.close();}
});

test('active bot keeps invalid webhook secret outside all application side effects', async()=>{
  const f=await fixture();
  try{
    await f.send('/start',{secret:'invalid-secret'});
    assert.equal(f.sourceCalls.length,0);
    assert.equal(f.calls.length,0);
    assert.equal(f.internal.length,0);
  }finally{f.close();}
});

test('active bot start, housing keyboard and Jobcenter handoff form one deterministic journey', async()=>{
  const f=await fixture();
  try{
    const start=await f.send('/start');
    assert.ok(start.messages.some(m=>Array.isArray(m.reply_markup?.inline_keyboard)));
    const replyKeyboards=start.messages.filter(m=>Array.isArray(m.reply_markup?.keyboard));
    assert.equal(replyKeyboards.length,1,'/start may emit exactly one non-persistent migration pulse');
    assert.equal(replyKeyboards[0].reply_markup.one_time_keyboard,true);
    assert.equal(replyKeyboards[0].reply_markup.is_persistent,false);
    assert.equal(replyKeyboards[0].reply_markup.input_field_placeholder,undefined);
    assert.notEqual(replyKeyboards[0].reply_markup.force_reply,true);
    const rooms=await f.send('',{callback:'hkr:3:Trittau'});
    assert.equal(rooms.body.mode,'housing-keyboard-people');
    const people=await f.send('',{callback:'hkp:4:3:Trittau'});
    assert.equal(people.body.mode,'housing-keyboard-action');
    const jobcenter=await f.send('',{callback:'hka:j:4:3:Trittau'});
    assert.equal(jobcenter.body.mode,'jobcenter-guideline-awaiting-search');
    assert.match(JSON.stringify(jobcenter.last?.reply_markup||{}),/jcr:15:4:3:Trittau/u);
  }finally{f.close();}
});
