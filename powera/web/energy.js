/* PowerA Energy — real 7/30/90 day per-outlet meter history and coverage. */
(() => {
  'use strict';
  const $=id=>document.getElementById(id);
  const E=(tag,cls='',text)=>{const x=document.createElement(tag);if(cls)x.className=cls;
    if(text!==undefined)x.textContent=String(text);return x;};
  const fmt=(v,d=2)=>typeof v==='number'&&Number.isFinite(v)?
    v.toLocaleString('en-US',{maximumFractionDigits:d}):'—';
  const NS='http://www.w3.org/2000/svg';
  let devices=[],loading=false,homeLoading=false,homeLoadedAt=0;
  function svg(tag,attrs={}){const n=document.createElementNS(NS,tag);
    Object.entries(attrs).forEach(([k,v])=>n.setAttribute(k,String(v)));return n;}
  async function refreshHomePreview(force=false){
    const root=$('home-energy-preview');
    if(!root||homeLoading||(!force&&Date.now()-homeLoadedAt<120000))return;
    homeLoading=true;
    try{
      const query=new URLSearchParams({days:'7',timezone:'Africa/Cairo'});
      const response=await fetch('/api/energy/report?'+query.toString(),{cache:'no-store'});
      const report=await response.json();
      if(!response.ok)throw Error(report.error||'تعذر قراءة الطاقة');
      renderHomePreview(report);
      homeLoadedAt=Date.now();
    }catch(error){
      $('home-energy-chart').replaceChildren();
      $('home-energy-total').textContent='—';
      $('home-energy-cost').textContent='التكلفة التقديرية غير متاحة';
      $('home-energy-note').textContent='تعذر تحميل سجل الطاقة. يمكنك المحاولة مجددًا من زر التحديث.';
    }finally{homeLoading=false;}
  }
  function renderHomePreview(report){
    const total=report?.summary?.observedKwh;
    $('home-energy-total').textContent=fmt(total,2);
    const cost=report?.summary?.estimatedCostEgp;
    $('home-energy-cost').textContent=typeof cost==='number'&&Number.isFinite(cost)
      ?'التكلفة التقديرية '+fmt(cost,2)+' ج.م':'التكلفة التقديرية غير متاحة';
    const values=Array.isArray(report?.daily)?report.daily.slice(-7):[];
    const chart=$('home-energy-chart');
    chart.replaceChildren();
    if(!values.length||!Number.isFinite(total)||report?.summary?.samples===0){
      $('home-energy-note').textContent='لا توجد قراءات محفوظة للفترة بعد. يبدأ التسجيل من تشغيل PowerA Hub.';
      return;
    }
    const width=680,base=110,top=14,gap=width/values.length;
    const graph=svg('svg',{viewBox:'0 0 720 152',role:'img','aria-label':'استهلاك الكهرباء المرصود لكل يوم خلال آخر سبعة أيام'});
    const title=svg('title');title.textContent='قراءات الطاقة اليومية المرصودة';graph.append(title);
    [0,1,2,3].forEach(i=>graph.append(svg('line',{x1:20,x2:700,y1:top+i*31,y2:top+i*31,stroke:'currentColor','stroke-opacity':'.12'})));
    const valid=values.filter(item=>Number(item.samples)>0);
    const maximum=Math.max(.001,...valid.map(item=>Number.isFinite(item.observedKwh)?item.observedKwh:0));
    let segment='';
    values.forEach((item,index)=>{
      const value=Number.isFinite(item.observedKwh)?Math.max(0,item.observedKwh):0;
      const x=20+index*gap+gap/2;
      if(Number(item.samples)>0){
        const y=base-value/maximum*82;
        segment+=(segment?' L':'M')+x.toFixed(1)+','+y.toFixed(1);
        const point=svg('circle',{cx:x,cy:y,r:index===values.length-1?4:3,fill:'#4ce1b0'});
        const tip=svg('title');tip.textContent=item.date+' — '+fmt(value,3)+' kWh';point.append(tip);graph.append(point);
      }else if(segment){
        graph.append(svg('path',{d:segment,fill:'none',stroke:'#4ce1b0','stroke-width':3,'stroke-linecap':'round','stroke-linejoin':'round'}));
        segment='';
      }
      const date=new Date(item.date+'T12:00:00Z');
      const label=Number.isNaN(date.valueOf())?'':date.toLocaleDateString('ar-EG',{weekday:'short',timeZone:'Africa/Cairo'});
      const textNode=svg('text',{x,y:138,'text-anchor':'middle',fill:'currentColor','font-size':'12'});
      textNode.textContent=label;graph.append(textNode);
    });
    if(segment)graph.append(svg('path',{d:segment,fill:'none',stroke:'#4ce1b0','stroke-width':3,'stroke-linecap':'round','stroke-linejoin':'round'}));
    graph.append(svg('line',{x1:20,x2:700,y1:base,y2:base,stroke:'currentColor','stroke-opacity':'.25'}));
    chart.append(graph);
    const gaps=Number(report?.summary?.gaps||0);
    $('home-energy-note').textContent=gaps
      ?'قراءات متاحة فقط؛ الفترات الناقصة لا تعني صفر استهلاك.'
      :'الرسم يعرض استهلاك الأيام المقاسة فقط.';
  }
  async function load(){
    if(loading)return;
    const panel=$('energy-dashboard');
    panel.replaceChildren(E('p','empty','جاري تحميل قراءات الطاقة الحقيقية…'));
    loading=true;
    try{
      const days=Number($('energy-days').value);
      const device=$('energy-device').value;
      const zone=$('energy-timezone').value||'Africa/Cairo';
      const query=new URLSearchParams({days:String(days),timezone:zone});
      if(device!=='all')query.set('deviceId',device);
      const response=await fetch('/api/energy/report?'+query.toString(),{cache:'no-store'});
      const report=await response.json();
      if(!response.ok)throw Error(report.error||'فشل قراءة الطاقة');
      render(panel,report);
    }catch(e){
      panel.replaceChildren(E('p','empty','تعذر عرض السجل: '+e.message));
    }finally{loading=false;}
  }
  function infoMetric(key,value,description){
    const b=E('article','energy-metric');
    b.append(E('span','',key),E('strong','',value),E('small','',description));return b;
  }
  function render(panel,data){
    panel.replaceChildren();
    const s=data.summary;
    const head=E('div','energy-summary');
    head.append(
      infoMetric('الطاقة المرصودة',fmt(s.observedKwh,4)+' kWh',
        'من القراءات المتاحة فقط'),
      infoMetric('من عداد الجهاز',fmt(s.meteredKwh,4)+' kWh',
        'فرق عداد kWh التراكمي'),
      infoMetric('تقدير من الواط',fmt(s.estimatedKwh,4)+' kWh',
        'فقط عند عدم توفر العداد'),
      infoMetric('التكلفة التقريبية',fmt(s.estimatedCostEgp)+' ج.م',
        'على أساس سعر الكهرباء المحفوظ')
    );
    panel.append(head);
    const quality=E('div','energy-quality'+(s.gaps?' warning':''));
    quality.textContent=s.samples===0?
      'مافيش قياسات محفوظة للفترة دي. التسجيل بيبدأ من تشغيل الـHub ولا يرجّع تاريخ غير موجود.':
      ('● '+s.samples+' قراءة • '+s.gaps+' فترة غير مكتملة/إعادة ضبط • أكبر قدرة مسجلة: '+
      fmt(s.peakW,1)+' W. الاستهلاك المعروض مش شامل الفترات الناقصة.');
    panel.append(quality);
    const card=E('article','energy-graph-card');
    card.append(E('h3','','استهلاك الطاقة يوميًا'));
    const list=data.daily;
    const points=list.map(x=>x.observedKwh);
    const max=Math.max(.001,...points);
    const chart=svg('svg',{viewBox:'0 0 800 260',role:'img',
      'aria-label':'رسم بياني يوضح الطاقة بالكيلوواط ساعة لكل يوم خلال الفترة المحددة'});
    const chartTitle=svg('title');
    chartTitle.textContent='استهلاك الطاقة المرصود يوميًا';
    chart.append(chartTitle);
    for(let i=0;i<=4;i++){
      const y=22+i*48;
      chart.append(svg('line',{x1:24,x2:788,y1:y,y2:y,stroke:'currentColor',
        'stroke-opacity':'.12'}));
    }
    const gap=754/list.length;
    list.forEach((x,i)=>{
      const height=x.observedKwh/max*192;
      const bar=svg('rect',{x:26+i*gap+2,y:214-height,
        width:Math.max(2,gap-4),height:Math.max(0,height),
        rx:3,fill:x.estimatedKwh>0?'#88a6ff':'#56dcb7'});
      const title=svg('title');
      title.textContent=x.date+' — '+fmt(x.observedKwh,4)+' kWh';
      bar.append(title);chart.append(bar);
    });
    card.append(chart);
    card.append(E('p','quiet',
      'أخضر = فرق العداد • بنفسجي = يتضمن تقديرًا من الواط. الأيام اللي مفيهاش بيانات مش معناها صفر استهلاك.'));
    panel.append(card);
    const outletCard=E('article','energy-graph-card');
    outletCard.append(E('h3','','استهلاك كل مخرج في الفترة'));
    const entries=data.outlets;
    const top=Math.max(.001,...entries.map(x=>x.observedKwh));
    if(!entries.length)outletCard.append(E('p','quiet','مفيش قياسات مخارج كفاية.'));
    for(const item of entries){
      const device=devices.find(x=>x.id===item.deviceId);
      const outlet=device?.outlets.find(x=>x.index===item.outlet);
      const row=E('div','energy-outlet-row');
      row.append(E('span','',((device?.name)||item.deviceId)+' • '+(outlet?.name||'مخرج '+item.outlet)));
      const meter=E('div','power-bar-track'),fill=E('div','power-bar-fill');
      fill.style.width=(item.observedKwh/top*100).toFixed(2)+'%';
      meter.append(fill);row.append(meter);
      row.append(E('b','',fmt(item.observedKwh,3)+' kWh'));
      outletCard.append(row);
    }
    panel.append(outletCard);
  }
  function updateDevices(list){
    devices=list;
    const select=$('energy-device'),previous=select.value;
    select.replaceChildren();
    const all=E('option','','كل المشتركات');all.value='all';select.append(all);
    for(const device of devices){
      const item=E('option','',device.name+' ('+device.type+')');
      item.value=device.id;select.append(item);
    }
    select.value=[...select.options].some(o=>o.value===previous)?previous:'all';
  }
  $('energy-days').addEventListener('change',load);
  $('energy-device').addEventListener('change',load);
  $('energy-timezone').addEventListener('change',load);
  $('energy-refresh').addEventListener('click',load);
  window.PowerAEnergy={open(list){updateDevices(list);load();},refresh:load,refreshHomePreview};
})();
