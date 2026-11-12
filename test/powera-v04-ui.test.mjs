import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from 'jsdom';

const root=new URL('../powera/web/',import.meta.url);
const html=await readFile(new URL('index.html',root),'utf8');
const settingsJs=await readFile(new URL('device-settings.js',root),'utf8');
const energyJs=await readFile(new URL('energy.js',root),'utf8');

function configuration(){
  return {
    persistent:true,device:'مكتب',channels:['كمبيوتر','إضاءة','مروحة','شاحن'],
    language:1,enabled:false,broker:'',port:1883,user:'',topic:'mttl',
    protection:{enabled:7,temperature:90,current:16000,power:3000},
    schedule_hex:'0000'+'000000000000'.repeat(8),
    button_lock:0,timer_minutes:[0,0,0,0]
  };
}
const device={id:'standalone:001122334455',type:'standalone',name:'مكتب',online:true,
  outlets:[1,2,3,4].map(index=>({index,name:'مخرج '+index}))};
const makeSettings=config=>({
  ok:true,deviceId:device.id,revision:'abcdef1234567890abcdef12',
  configuration:structuredClone(config),
  schedule:{timezone:120,rules:Array.from({length:8},()=>({
    minute:0,mode:0,day:0,channel:0,on:0
  }))},
  capabilities:{powerRecovery:false,schedules:true,timers:true,protection:true}
});
async function app(){
  const dom=new JSDOM(html,{url:'http://192.168.1.2:8098/',runScripts:'outside-only'});
  const {window}=dom;
  let conf=configuration(),settings=makeSettings(conf);
  let saveCount=0;
  const calls=[];
  window.confirm=()=>true;
  window.fetch=async (url,opts={})=>{
    const path=String(url);calls.push({path,opts});
    let result;
    if(path.startsWith('/api/device-settings?')){
      result=settings;
    }else if(path==='/api/device-settings'&&opts.method==='POST'){
      saveCount++;
      const data=JSON.parse(opts.body);
      assert.equal(data.revision,settings.revision);
      if(data.section==='names'){
        conf.device=data.changes.device;conf.channels=[...data.changes.channels];
      }
      settings=makeSettings(conf);
      settings.revision='abcdef1234567890abcdef'+String(saveCount).padStart(2,'0');
      result={...settings,confirmed:true};
    }else if(path.startsWith('/api/energy/report')){
      const url=new URL(path,'http://example.test');
      const days=Number(url.searchParams.get('days'));
      result={
        days,summary:{observedKwh:1.25,meteredKwh:1.2,estimatedKwh:.05,
          estimatedCostEgp:2.8,peakW:170,samples:200,gaps:2},
        daily:Array.from({length:days},(_,i)=>({
          date:'2026-11-'+String((i%28)+1).padStart(2,'0'),
          observedKwh:.02,meteredKwh:.02,estimatedKwh:0
        })),
        outlets:[{deviceId:device.id,outlet:1,observedKwh:1.25}],
        pricePerKwh:2.25
      };
    }else throw Error('Unexpected URL '+path);
    return {ok:true,status:200,json:async()=>result};
  };
  window.eval(settingsJs);
  window.eval(energyJs);
  const settle=async()=>{
    for(let i=0;i<8;i++)await new Promise(resolve=>setImmediate(resolve));
  };
  return {window,dom,calls,settle,get saves(){return saveCount;},
    changeDevice(update){
      settings={...settings,configuration:{...settings.configuration,...update},
        revision:'fedcba1234567890fedcba12'};
    }
  };
}

test('Standalone device editor exposes real firmware schedules, timers, protection and recovery limitation',async()=>{
  const x=await app();
  try{
    await x.window.PowerADeviceSettings.open(device);
    const doc=x.window.document;
    assert.match(doc.querySelector('#device-settings-title').textContent,/مكتب/);
    assert.ok(doc.querySelectorAll('.device-settings-card').length>=6);
    const text=doc.querySelector('#device-settings-container').textContent;
    assert.match(text,/جداول الجهاز/);
    assert.match(text,/الحماية الكهربائية/);
    assert.match(text,/مؤقتات/);
    assert.match(text,/مش متاحة/);
    assert.equal(x.saves,0,'Reading must not write to firmware');
  }finally{x.dom.window.close();}
});

test('saving four names sends one revision-guarded device write',async()=>{
  const x=await app();
  try{
    await x.window.PowerADeviceSettings.open(device);
    const input=x.window.document.querySelector('.device-settings-card .settings-fields input');
    input.value='PowerA Office';
    input.dispatchEvent(new x.window.Event('input'));
    const b=[...x.window.document.querySelectorAll('.device-settings-card button')]
      .find(el=>el.textContent==='حفظ الأسماء');
    assert.ok(b);
    b.click();
    await x.settle();
    const post=x.calls.find(c=>c.path==='/api/device-settings'&&c.opts.method==='POST');
    assert.ok(post);
    const payload=JSON.parse(post.opts.body);
    assert.equal(payload.section,'names');
    assert.equal(payload.changes.device,'PowerA Office');
    assert.equal(payload.revision,'abcdef1234567890abcdef12');
    assert.equal(x.saves,1);
    assert.match(x.window.document.querySelector('#device-settings-status').textContent,/تم الحفظ/);
  }finally{x.dom.window.close();}
});

test('90-day dashboard never hides incomplete coverage or estimated measurements',async()=>{
  const x=await app();
  try{
    x.window.document.getElementById('energy-days').value='90';
    x.window.PowerAEnergy.open([device]);
    await x.settle();
    const doc=x.window.document;
    const calls=x.calls.filter(c=>c.path.startsWith('/api/energy/report'));
    assert.equal(calls.length,1);
    assert.ok(calls[0].path.includes('days=90'));
    assert.equal(doc.querySelectorAll('.energy-metric').length,4);
    assert.match(doc.querySelector('.energy-quality').textContent,/2 فترة/);
    assert.equal(doc.querySelectorAll('.energy-graph-card').length,2);
    assert.equal(doc.querySelectorAll('.energy-graph-card svg rect').length,90);
    assert.match(doc.querySelector('#energy-dashboard').textContent,/1.25/);
  }finally{x.dom.window.close();}
});

test('settings conflict does not automatically push an outdated draft',async()=>{
  const x=await app();
  try{
    await x.window.PowerADeviceSettings.open(device);
    const input=x.window.document.querySelector('.device-settings-card .settings-fields input');
    input.value='اسم غير محفوظ';
    input.dispatchEvent(new x.window.Event('input'));
    x.changeDevice({device:'تغيير خارجي'});
    x.window.document.dispatchEvent(new x.window.Event('visibilitychange'));
    await x.settle();
    const save=[...x.window.document.querySelectorAll('.device-settings-card button')]
      .find(b=>b.textContent==='حفظ الأسماء');
    save.click();
    await x.settle();
    assert.equal(x.saves,0);
    assert.match(x.window.document.querySelector('#device-settings-status').textContent,/اتغيرت|تغيير أحدث/);
  }finally{x.dom.window.close();}
});
