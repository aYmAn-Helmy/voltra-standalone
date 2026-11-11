/* PowerA v0.4: authoritative Standalone settings editor, never blind-rewrites.
 * Device schedules execute in firmware even when the Hub is offline.
 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  function node(tag, cls='', text) {
    const x = document.createElement(tag);
    if(cls)x.className=cls;
    if(text!==undefined)x.textContent=String(text);
    return x;
  }
  function btn(label, fn, css='button muted'){
    const b=node('button',css,label);b.type='button';b.onclick=fn;return b;
  }
  function field(parent,label,tag='input',opts={}){
    const wrap=node('label','device-field');
    wrap.append(node('span','',label));
    const input=node(tag);
    for(const [key,v] of Object.entries(opts)){
      if(key==='value')input.value=String(v);
      else if(key==='checked')input.checked=Boolean(v);
      else input.setAttribute(key,String(v));
    }
    wrap.append(input);parent.append(wrap);return input;
  }
  function choose(parent,label,options,selected){
    const select=field(parent,label,'select');
    options.forEach(([value,text])=>{
      const x=node('option','',text);x.value=String(value);select.append(x);
    });
    select.value=String(selected);return select;
  }
  function card(parent,title,subtitle){
    const box=node('section','device-settings-card');
    box.append(node('h3','',title),node('p','quiet',subtitle));
    parent.append(box);return box;
  }
  function dirtyWatch(input){
    input.addEventListener('input',()=>{dirty=true;});
    input.addEventListener('change',()=>{dirty=true;});
    return input;
  }
  function status(message,error=false){
    const x=$('device-settings-status');
    x.className='settings-status'+(error?' error':'');
    x.textContent=message;
  }
  async function api(path,body){
    const resp=await fetch(path,{method:body?'POST':'GET',cache:'no-store',
      ...(body?{headers:{'Content-Type':'application/json','X-PowerA-Client':'PowerA'},
        body:JSON.stringify(body)}:{})});
    const data=await resp.json();
    if(!resp.ok)throw Error(data.error||'تعذر الاتصال');
    return data;
  }
  let selected=null,model=null,dirty=false,conflicted=false,saving=false;
  async function read(quiet=false){
    if(!selected||saving)return;
    try{
      const fresh=await api('/api/device-settings?deviceId='+encodeURIComponent(selected.id));
      if(quiet&&dirty){
        if(fresh.revision!==model.revision){
          conflicted=true;status('⚠ إعدادات المشترك اتغيرت أثناء تعديلك. اضغط تحديث قبل الحفظ.',true);
        }
        return;
      }
      const changed=model&&fresh.revision!==model.revision;
      model=fresh;dirty=false;conflicted=false;render();
      status(changed?'تم تحديث الإعدادات من المشترك ✓':'متزامن مباشرة مع فيرموير Standalone ✓');
    }catch(e){status('تعذر قراءة الجهاز: '+e.message,true);}
  }
  async function save(section,changes){
    if(!model||saving)return;
    if(conflicted){status('فيه تغيير أحدث على الجهاز. حدّث الإعدادات الأول.',true);return;}
    saving=true;status('جاري الحفظ على المشترك والتحقق من النتيجة…');
    try{
      const data=await api('/api/device-settings',{
        deviceId:selected.id,revision:model.revision,section,changes
      });
      if(!data.ok||data.confirmed===false)throw Error('الحفظ غير مؤكد');
      model=data;dirty=false;conflicted=false;render();
      status('✓ تم الحفظ داخل المشترك وتأكيد النسخة الجديدة');
      document.dispatchEvent(new CustomEvent('powera:settings-saved'));
    }catch(e){status('الحفظ غير مؤكد: '+e.message+' — لا تعيد الإرسال قبل مراجعة الحالة.',true);}
    finally{saving=false;}
  }
  function names(root,c){
    const box=card(root,'الأسماء','تغيير حقيقي داخل المشترك — مش اسم محلي في التطبيق');
    const grid=node('div','settings-fields');
    const device=dirtyWatch(field(grid,'اسم المشترك','input',{value:c.device,maxlength:64}));
    const outlets=c.channels.map((v,i)=>dirtyWatch(field(grid,
      'المخرج '+(i+1),'input',{value:v,maxlength:64})));
    box.append(grid,btn('حفظ الأسماء',()=>save('names',{
      device:device.value,channels:outlets.map(x=>x.value)
    }),'button primary'));
  }
  const empty=()=>({minute:0,mode:0,day:0,channel:0,on:0});
  const week=['الإثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت','الأحد'];
  function schedules(root,scheduled){
    const box=card(root,'جداول الجهاز','حتى 8 جداول داخلية • شغالة بدون سيرفر • المنطقة الزمنية فرق ثابت عن UTC');
    const offset=dirtyWatch(field(box,'فرق التوقيت بالدقائق','input',{
      type:'number',min:-720,max:840,step:15,value:scheduled.timezone
    }));
    const rules=scheduled.rules.map(r=>({...r}));
    const list=node('div','device-rule-list');box.append(list);
    function draw(){
      list.replaceChildren();
      rules.forEach((r,i)=>{
        if(!r.mode)return;
        const row=node('div','device-rule');
        const top=node('div','device-rule-head');
        top.append(node('strong','','جدول '+(i+1)));
        const enable=dirtyWatch(field(top,'مفعّل','input',{
          type:'checkbox',checked:Boolean(r.mode&128)
        }));
        enable.onchange=()=>{r.mode=(r.mode&127)|(enable.checked?128:0);dirty=true;};
        top.append(btn('حذف',()=>{rules[i]=empty();dirty=true;draw();},'button danger'));
        row.append(top);
        const grid=node('div','schedule-grid');
        const kind=dirtyWatch(choose(grid,'التكرار',
          [[1,'يومي'],[2,'أسبوعي'],[3,'يوم في الشهر'],[4,'آخر يوم في الشهر']],r.mode&127));
        kind.onchange=()=>{
          r.mode=Number(kind.value)|(r.mode&128);
          r.day=kind.value==='2'?127:kind.value==='3'?1:0;
          dirty=true;draw();
        };
        const clock=dirtyWatch(field(grid,'الوقت','input',{type:'time',
          value:String(Math.floor(r.minute/60)).padStart(2,'0')+':'+
            String(r.minute%60).padStart(2,'0')}));
        clock.onchange=()=>{const t=clock.value.split(':').map(Number);
          r.minute=t[0]*60+t[1];dirty=true;};
        const target=dirtyWatch(choose(grid,'المخرج',
          [[0,'1'],[1,'2'],[2,'3'],[3,'4'],[4,'الكل']],r.channel));
        target.onchange=()=>{r.channel=Number(target.value);dirty=true;};
        const on=dirtyWatch(choose(grid,'الإجراء',[[1,'تشغيل'],[0,'فصل']],r.on));
        on.onchange=()=>{r.on=Number(on.value);dirty=true;};
        if((r.mode&127)===3){
          const day=dirtyWatch(field(grid,'يوم الشهر','input',{
            type:'number',min:1,max:31,value:r.day
          }));
          day.onchange=()=>{r.day=Number(day.value);dirty=true;};
        }
        row.append(grid);
        if((r.mode&127)===2){
          const days=node('div','weekday-list');
          week.forEach((text,d)=>{
            const label=node('label','',text);
            const x=node('input');x.type='checkbox';x.checked=Boolean(r.day&(1<<d));
            x.onchange=()=>{r.day=x.checked?r.day|(1<<d):r.day&~(1<<d);dirty=true;};
            label.prepend(x);days.append(label);
          });
          row.append(days);
        }
        list.append(row);
      });
      const free=rules.findIndex(x=>x.mode===0);
      if(free!==-1){
        list.append(btn('＋ إضافة جدول',()=>{
          rules[free]={minute:600,mode:129,day:0,channel:0,on:1};
          dirty=true;draw();
        }));
      }
    }
    draw();
    box.append(btn('حفظ الجداول في فيرموير المشترك',()=>save('schedules',{
      schedule:{timezone:Number(offset.value),rules}
    }),'button primary'));
  }
  function timers(root,c){
    const box=card(root,'مؤقتات المخرج','فصل تلقائي داخل الجهاز • 0 = غير مفعّل • حتى 1440 دقيقة');
    const grid=node('div','settings-fields');
    const fields=c.timer_minutes.map((m,i)=>dirtyWatch(field(grid,
      c.channels[i],'input',{type:'number',min:0,max:1440,step:1,value:m})));
    box.append(grid,btn('حفظ مؤقتات الجهاز',()=>save('timers',{
      minutes:fields.map(x=>Number(x.value))
    }),'button primary'));
    box.append(node('p','quiet','مينفعش تفعيل مؤقت وجدول داخلي على نفس المخرج.'));
  }
  function protection(root,c){
    const box=card(root,'الحماية الكهربائية','الحدود بيطبقها الفيرموير. أجهزة الحماية المعتمدة لازمة أيضًا.');
    const grid=node('div','settings-fields'), p=c.protection,items={};
    let mask=p.enabled;
    const defs=[['temperature','الحرارة °C',1,50,90],
                ['current','التيار الكلي mA',2,1000,16000],
                ['power','القدرة الكلية W',4,100,3000]];
    defs.forEach(([key,label,bit,min,max])=>{
      const area=node('div','protect-setting');
      const checked=field(area,'تفعيل '+label,'input',{
        type:'checkbox',checked:Boolean(mask&bit)});
      checked.onchange=()=>{mask=checked.checked?mask|bit:mask&~bit;dirty=true;};
      const v=dirtyWatch(field(area,label,'input',{type:'number',
        min,max,step:1,value:p[key]}));
      grid.append(area);items[key]=v;
    });
    box.append(grid,btn('حفظ حماية الجهاز',()=>save('protection',{
      settings:{enabled:mask,temperature:Number(items.temperature.value),
        current:Number(items.current.value),power:Number(items.power.value)}
    }),'button primary'));
  }
  function locks(root,c){
    const box=card(root,'قفل الأزرار الفعلية',
      'يمنع الضغط من زر المشترك فقط، ولا يعطّل التحكم من PowerA');
    const items=node('div','weekday-list'),checks=[];
    c.channels.forEach((title,i)=>{
      const x=field(items,title,'input',{type:'checkbox',
        checked:Boolean(c.button_lock&(1<<i))});
      checks.push(dirtyWatch(x));
    });
    box.append(items,btn('حفظ قفل الأزرار',()=>{
      const mask=checks.reduce((m,x,i)=>m|(x.checked?1<<i:0),0);
      save('button-lock',{mask});
    },'button primary'));
  }
  function mqtt(root,c){
    const box=card(root,'MQTT','كلمة المرور القديمة بتفضل على الجهاز ومش بترجع لـPowerA');
    const grid=node('div','settings-fields');
    const enable=dirtyWatch(field(grid,'تفعيل MQTT','input',
      {type:'checkbox',checked:c.enabled}));
    const broker=dirtyWatch(field(grid,'Broker','input',{value:c.broker}));
    const port=dirtyWatch(field(grid,'Port','input',{
      type:'number',min:1,max:65535,value:c.port}));
    const user=dirtyWatch(field(grid,'اسم المستخدم','input',{value:c.user}));
    const topic=dirtyWatch(field(grid,'Topic','input',{value:c.topic}));
    box.append(grid,btn('حفظ إعدادات MQTT غير السرّية',()=>save('mqtt',{
      enabled:enable.checked,broker:broker.value,port:Number(port.value),
      user:user.value,topic:topic.value
    }),'button primary'));
  }
  function render(){
    if(!model)return;
    const root=$('device-settings-container');
    root.replaceChildren();
    $('device-settings-title').textContent=selected.name+' • إعدادات Standalone';
    const summary=node('div','sync-state');
    summary.append(node('span','','● المصدر الأساسي: فيرموير المشترك'),
      node('span','',model.revision.slice(0,12)+'…'));
    root.append(summary);
    const c=model.configuration;
    names(root,c);schedules(root,model.schedule);timers(root,c);
    protection(root,c);locks(root,c);mqtt(root,c);
    const recovery=card(root,'استعادة الكهرباء',
      'Always ON / Always OFF / Restore Last State');
    recovery.append(node('p','quiet',
      'الأنماط دي مش متاحة كإعدادات API في نسخة الفيرموير اللي راجعناها؛ مفيش حفظ وهمي.'));
  }
  async function open(device){
    if(!device||device.type!=='standalone')throw Error('إعدادات الجهاز متاحة للـStandalone فقط');
    selected=device;model=null;dirty=false;conflicted=false;
    $('device-settings-container').replaceChildren(node('p','empty','جاري قراءة إعدادات الجهاز…'));
    $('device-settings-title').textContent='إعدادات '+device.name;
    await read();
  }
  $('device-settings-refresh').addEventListener('click',()=>{
    if(dirty&&!window.confirm('تجاهل التغييرات غير المحفوظة وقراءة نسخة الجهاز؟'))return;
    dirty=false;read();
  });
  $('device-settings-back').addEventListener('click',()=>{
    document.querySelector('.tab[data-page="devices"]').click();
  });
  setInterval(()=>{
    if(selected&&model&&!document.hidden&&!$('device-settings-page').hidden)read(true);
  },20000);
  window.PowerADeviceSettings={open};
})();
