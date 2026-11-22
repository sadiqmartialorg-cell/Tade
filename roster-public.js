const rosterEndpoint='https://edlpujkyxjcubvjdcmle.supabase.co/functions/v1/worklog-operations';
const $=id=>document.getElementById(id);
const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const addDays=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const formatDay=value=>new Date(value+'T00:00:00Z').toLocaleDateString('en-IN',{day:'numeric',month:'short',timeZone:'UTC'});
const clock=new Intl.DateTimeFormat('en-IN',{hour:'numeric',minute:'2-digit',timeZone:'Asia/Kolkata'});
const timestamp=new Intl.DateTimeFormat('en-IN',{day:'numeric',month:'short',hour:'numeric',minute:'2-digit',timeZone:'Asia/Kolkata'});
const dateIST=value=>new Date(Date.parse(value)+19800000).toISOString().slice(0,10);
let data=null,selectedWeek=null,showLive=false,request=0,serverOffset=0;
let team=new URLSearchParams(location.search).get('team')||'';

function range(shift){
  const overnight=dateIST(shift.endsAt)>shift.date;
  return `<span class="shift ${overnight?'overnight':''}">${esc(clock.format(Date.parse(shift.startsAt)))}–${esc(clock.format(Date.parse(shift.endsAt)))}${overnight?' <small>+1 day</small>':''}</span>`;
}
function renderWeekly(shifts){
  const days=Array.from({length:7},(_,index)=>addDays(data.week,index));
  const byTeam=new Map();
  for(const shift of shifts){
    if(shift.date<data.week)continue;
    if(!byTeam.has(shift.team))byTeam.set(shift.team,new Map());
    const members=byTeam.get(shift.team);
    if(!members.has(shift.name))members.set(shift.name,new Map());
    const dates=members.get(shift.name);
    dates.set(shift.date,[...(dates.get(shift.date)||[]),shift]);
  }
  if(!byTeam.size)return '<p class="empty">No published working shifts for this team and week.</p>';
  const headings=days.map(day=>`<th scope="col">${esc(new Date(day+'T00:00:00Z').toLocaleDateString('en-IN',{weekday:'short',timeZone:'UTC'}))}<small>${esc(formatDay(day))}</small></th>`).join('');
  return `<table><thead><tr><th scope="col">Team member</th>${headings}</tr></thead>${[...byTeam].sort(([a],[b])=>a.localeCompare(b))
    .map(([name,members])=>`<tbody><tr class="team"><th scope="rowgroup" colspan="8">${esc(name)} team</th></tr>
      ${[...members].sort(([a],[b])=>a.localeCompare(b)).map(([person,dates])=>`<tr><th scope="row">${esc(person)}</th>
        ${days.map(day=>`<td>${(dates.get(day)||[]).map(range).join(' ')||'—'}</td>`).join('')}</tr>`).join('')}</tbody>`).join('')}</table>`;
}
function renderLive(shifts){
  const now=Date.now()+serverOffset;
  const active=shifts.filter(shift=>Date.parse(shift.startsAt)<=now&&now<Date.parse(shift.endsAt))
    .sort((a,b)=>a.team.localeCompare(b.team)||a.name.localeCompare(b.name));
  return active.length?`<ul class="live-list">${active.map(shift=>`<li><span><strong>${esc(shift.name)}</strong><small>${esc(shift.team)} team · Ends ${esc(timestamp.format(Date.parse(shift.endsAt)))} IST</small></span>${range(shift)}</li>`).join('')}</ul>`
    :'<p class="empty">No one is scheduled on shift in this selection right now.</p>';
}
function render(){
  if(!data)return;
  $('viewTitle').textContent=showLive?'On shift now':'Weekly roster';
  $('weeklyView').setAttribute('aria-pressed',String(!showLive));
  $('liveView').setAttribute('aria-pressed',String(showLive));
  $('weekControls').hidden=showLive;
  $('previousWeek').disabled=data.week<=addDays(data.currentWeek,-28);
  $('nextWeek').disabled=data.week>=addDays(data.currentWeek,56);
  const weekEnd=addDays(data.week,6);
  const label=showLive?timestamp.format(Date.now()+serverOffset):`${formatDay(data.week)} – ${formatDay(weekEnd)} ${weekEnd.slice(0,4)}`;
  $('rosterStamp').textContent=`${label} IST${data.updatedAt?' · Published '+timestamp.format(Date.parse(data.updatedAt))+' IST':''}`;
  const shifts=data.shifts.filter(shift=>!team||shift.team===team);
  $('publicRosterGrid').innerHTML=showLive?renderLive(shifts):renderWeekly(shifts);
}
async function loadRoster(){
  const ticket=++request,url=new URL(rosterEndpoint);
  url.searchParams.set('view','public_roster');
  if(selectedWeek&&!showLive)url.searchParams.set('week',selectedWeek);
  try{
    const response=await fetch(url,{cache:'no-store'});
    if(!response.ok)throw Error('Unable to load the published roster.');
    const loaded=await response.json();
    if(ticket!==request)return;
    data=loaded;serverOffset=Date.parse(loaded.now)-Date.now();
    const teams=[...new Set([...(loaded.teams||[]),...loaded.shifts.map(shift=>shift.team)])].sort();
    $('teamFilter').innerHTML='<option value="">All teams</option>'+teams.map(value=>`<option value="${esc(value)}">${esc(value)}</option>`).join('');
    if(team&&!teams.includes(team))team='';
    $('teamFilter').value=team;
    $('rosterProblem').hidden=true;render();
  }catch(error){if(ticket===request){$('rosterProblem').textContent=error.message;$('rosterProblem').hidden=false;if(!data)$('rosterStamp').textContent='Published shifts · IST'}}
}
$('teamFilter').onchange=()=>{team=$('teamFilter').value;const url=new URL(location.href);if(team)url.searchParams.set('team',team);else url.searchParams.delete('team');history.replaceState(null,'',url);render()};
$('weeklyView').onclick=()=>{if(showLive){showLive=false;loadRoster()}};
$('liveView').onclick=()=>{if(!showLive){showLive=true;loadRoster()}};
$('thisWeek').onclick=()=>{selectedWeek=null;loadRoster()};
$('previousWeek').onclick=()=>{if(data){selectedWeek=addDays(data.week,-7);loadRoster()}};
$('nextWeek').onclick=()=>{if(data){selectedWeek=addDays(data.week,7);loadRoster()}};
document.addEventListener('visibilitychange',()=>{if(!document.hidden)loadRoster()});
setInterval(()=>{if(!document.hidden&&showLive)render()},15000);
setInterval(()=>{if(!document.hidden)loadRoster()},60000);
loadRoster();
