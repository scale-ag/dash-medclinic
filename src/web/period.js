import { h, clear } from './dom.js';
import { PRESETS, addDays, formatDateBR, isIsoDate, startOfMonth, endOfMonth } from './shared/dates.js';

const label = id => PRESETS.find(p => p.id === id)?.label || 'Personalizado';
const monthName = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function calendar({ title, month, navigate, select, since, until, today, start }) {
  const first = startOfMonth(month);
  const prev = startOfMonth(addDays(first, -1));
  const next = addDays(endOfMonth(first), 1);
  const grid = h('div', { class: 'calendar-grid' });
  for (const day of ['D','S','T','Q','Q','S','S']) grid.append(h('span', { class: 'weekday', 'aria-hidden': 'true' }, day));
  const offset = new Date(first+'T12:00:00Z').getUTCDay();
  for (let i=0; i<offset; i++) grid.append(h('span'));
  for (let date=first; date<=endOfMonth(first); date=addDays(date,1)) {
    const selected = date === since || date === until;
    grid.append(h('button', {
      type:'button', class: selected ? 'chosen' : date > since && date < until ? 'in-range' : '',
      'aria-label':title+' '+formatDateBR(date), 'aria-pressed':String(selected), disabled: date > today || date < start,
      onClick:()=>select(date)
    }, Number(date.slice(-2))));
  }
  return h('section', {class:'calendar'}, h('strong',null,title),
    h('div',{class:'month-nav'},
      h('button',{type:'button','aria-label':'Mês anterior · '+title,disabled: first <= startOfMonth(start),onClick:()=>navigate(prev)},'‹'),
      h('span',null,monthName.format(new Date(first+'T12:00:00Z'))),
      h('button',{type:'button','aria-label':'Próximo mês · '+title,disabled: next > today,onClick:()=>navigate(next)},'›')),
    grid);
}

export function periodPicker({ preset, range, today, start, apply }) {
  start = isIsoDate(start) ? start : today;
  const trigger = h('button',{type:'button',class:'btn period-trigger','aria-haspopup':'dialog','aria-expanded':'false'},
    '▦  '+formatDateBR(range.since)+' – '+formatDateBR(range.until)+' · '+label(preset)+' ▾');
  const panel = h('div',{class:'period-panel',role:'dialog','aria-label':'Selecionar período',popover:'auto'});
  const section = h('div',{class:'period'},trigger,panel);
  let from, to, leftMonth, rightMonth;
  const redraw = () => {
    clear(panel);
    const shortcutIds = ['today','yesterday','rolling_3','rolling_7','rolling_14','rolling_30','this_month','previous_month','all','last_7_complete','month_to_yesterday'];
    const shortcuts = h('div',{class:'period-shortcuts'},shortcutIds.map(id=>h('button',{
      type:'button',class:id===preset?'current':'',onClick:()=>{panel.hidePopover();apply(id,'','');}
    },id==='previous_month'?'Mês passado':label(id))));
    const choose = (side,date) => {
      if(side==='from'){from=date;leftMonth=date;if(to<from){to=from;rightMonth=to;}}
      else {to=date;rightMonth=date;if(from>to){from=to;leftMonth=from;}}
      redraw();
    };
    const side = (key,title) => h('div', {class:'calendar-side'},
      calendar({title,month:key==='from'?leftMonth:rightMonth,since:from,until:to,today,start,
        navigate:m=>{if(key==='from')leftMonth=m;else rightMonth=m;redraw();},
        select:date=>choose(key,date)}),
      h('input',{type:'date','aria-label':title,min:start,max:today,value:key==='from'?from:to,
        onChange:e=>{const v=e.target.value;if(isIsoDate(v)&&v>=start&&v<=today)choose(key,v);}}));
    panel.append(shortcuts,h('div',{class:'calendar-body'},
      h('div',{class:'calendars'},side('from','Data de início'),side('to','Data de término')),
      h('div',{class:'period-actions'},h('button',{type:'button',class:'btn',onClick:()=>{panel.hidePopover();trigger.focus();}},'Cancelar'),
        h('button',{type:'button',class:'btn primary',onClick:()=>{panel.hidePopover();apply('custom',from,to);}},'Aplicar'))));
  };
  trigger.onclick = () => {
    if(panel.matches(':popover-open')){panel.hidePopover();return;}
    from = range.since < start ? start : range.since;
    to = range.until < start ? start : range.until;
    leftMonth=from;rightMonth=to;redraw();
    panel.showPopover();
    const rect=trigger.getBoundingClientRect();
    const panelRect=panel.getBoundingClientRect();
    panel.style.left=Math.max(8,Math.min(rect.left,document.documentElement.clientWidth-panelRect.width-8))+'px';
    panel.style.top=Math.max(8,Math.min(rect.bottom+6,window.innerHeight-panelRect.height-8))+'px';
    panel.querySelector('.current,button').focus({preventScroll:true});
  };
  panel.addEventListener('toggle',e=>trigger.setAttribute('aria-expanded',String(e.newState==='open')));
  return section;
}
