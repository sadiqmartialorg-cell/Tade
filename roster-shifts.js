export const rosterPresets={day:['08:00','18:00'],evening:['16:30','01:00'],night:['22:00','08:00']};

const families=[
  {key:'morning',preset:'day',label:'Morning'},
  {key:'afternoon',preset:'evening',label:'Afternoon'},
  {key:'night',preset:'night',label:'Night'},
];
const minute=value=>Number(value.slice(0,2))*60+Number(value.slice(3,5));

export function classifyShift(kind,startTime,endTime){
  if(kind==='off')return {key:'off',label:'Day off'};
  if(kind==='leave')return {key:'leave',label:'Leave'};
  if(kind!=='work'||!startTime||!endTime)return {key:'empty',label:'No shift'};
  const start=startTime.slice(0,5),end=endTime.slice(0,5);
  const exact=families.find(({preset})=>rosterPresets[preset][0]===start&&rosterPresets[preset][1]===end);
  if(exact)return exact;
  const first=minute(start),last=minute(end)+(end<start?1440:0);
  const boundaries=families.map(({preset})=>minute(rosterPresets[preset][0]));
  const index=(boundaries.findLastIndex(boundary=>boundary<=first)+3)%3;
  const next=(index+1)%3;
  const boundary=boundaries[next]+(boundaries[next]<=first?1440:0);
  const family=families[index];
  if(boundary-first<=90&&last-boundary>=60){
    const after=families[next];
    return {key:family.key+'-'+after.key,label:'Custom · '+family.label+' / '+after.label};
  }
  return {key:'custom-'+family.key,label:'Custom · '+family.label};
}

export function shiftLegend(){
  return '<div class="shift-legend" aria-label="Shift colors">'+families.map(({key,label})=>
    `<span class="shift-tone shift-${key}">${label}</span>`).join('')+
    '<span class="shift-tone shift-off">Day off</span><span class="shift-tone shift-morning-afternoon">Custom hours</span></div>';
}
