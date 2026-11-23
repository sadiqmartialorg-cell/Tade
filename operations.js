import {classifyShift,rosterPresets,shiftLegend} from './roster-shifts.js';

export function setupOperations({supabase,getUser,getModules,toast,closeUserDrawer}) {
  const $=id=>document.getElementById(id);
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const today=()=>new Date(Date.now()+330*60000).toISOString().slice(0,10);
  const addDays=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
  const monday=day=>addDays(day,-((new Date(day+'T00:00:00Z').getUTCDay()+6)%7));
  const when=iso=>iso?new Date(iso).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'—';
  const names=new Map();let basics=null,activity=null,series=null,roster=null,inbox=[],mode='mine',lastInboxCheck=0;
  let activityKind='all',activityPage=0,activityRequest=0;
  const activityPageSize=25;
  const activityFilterFields={search:'opsActivitySearch',customer:'opsCustomerFilter',assignee:'opsOwnerFilter',status:'opsStatusFilter'};
  let activityFilters={},activitySort={key:'time',direction:1};
  const allowed=key=>getModules().some(m=>m.key===key);
  async function call(action,args={}) {const {data,error}=await supabase.functions.invoke('worklog-operations',{body:{action,args}});if(error){let detail;try{detail=await error.context?.json()}catch(_){}throw Error(detail?.error||error.message)}if(data?.error)throw Error(data.error);return data}
  function activate(id) {
    closeUserDrawer();document.querySelectorAll('.view').forEach(x=>x.classList.remove('active'));$(id).classList.add('active');
    $('trackerTabs').hidden=true;$('usersTabs').hidden=true;$('dailyTabs').hidden=id!=='dailyActivity';
    for(const nav of ['trackerNav','reportingNav','usersNav','dailyNav','rosterNav'])$(nav).classList.toggle('active',nav===(id==='dailyActivity'?'dailyNav':id==='rosterView'?'rosterNav':''));
    $('inboxButton').classList.toggle('active',id==='inboxView');
    window.scrollTo(0,0);
  }
  async function ensureBasics(){if(!basics){basics=await call('bootstrap');for(const p of basics.people)names.set(p.id,p.name)}return basics}
  function select(id,rows,label='Select…'){const node=$(id),prior=node.value;node.innerHTML='<option value="">'+esc(label)+'</option>'+rows.map(r=>`<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');if(rows.some(r=>r.id===prior))node.value=prior}
  function canManage(){return basics?.canManage===true}
  async function openDaily(tab='mine'){
    if(!allowed('daily_activity'))return;mode=tab;activate('dailyActivity');
    for(const [name,id] of [['mine','dailyMineTab'],['team','dailyTeamTab'],['series','dailySeriesTab']]){$(id).classList.toggle('active',name===tab);$(id).setAttribute('aria-pressed',String(name===tab));$(id).hidden=name==='series'&&!canManage()}
    activityPage=0;$('dailyFilters').hidden=tab==='series';$('opsOwnerFilterWrap').hidden=tab!=='team';$('dailyList').hidden=tab==='series';$('dailyCarryover').hidden=tab!=='mine';$('dailyPagination').hidden=true;$('dailySummary').hidden=tab==='series';$('seriesList').hidden=tab!=='series';
    $('handoverButton').hidden=true;
    if(!$('opsDate').value)$('opsDate').value=today();
    try{await ensureBasics();$('dailySeriesTab').hidden=!canManage();select('opsCustomerFilter',basics.customers,'All customers');select('opsOwnerFilter',basics.people,'All assignees');if(tab==='series')await loadSeries();else await refreshDaily();}
    catch(e){$('dailyList').textContent=e.message;toast(e.message)}
  }
  async function refreshDaily(){
    if(!allowed('daily_activity'))return;
    const date=$('opsDate').value||today(),request=++activityRequest;
    $('activityTodayButton').hidden=date===today();
    $('dailyList').textContent='Loading activities…';$('dailyPagination').hidden=true;$('dailyCarryover').replaceChildren();$('dailySummary').replaceChildren();
    try{
      if(handoverRequest)await handoverRequest.catch(()=>{});
      const data=await call('activity_list',{date,includeEarlier:mode==='mine'});
      if(request!==activityRequest)return;
      activity=data;
      select('quickPrerequisite',(activity.prerequisites||[]).map(item=>({id:item.id,name:item.title+' · '+(names.get(item.owner_id)||'Assignee')})),'Select prerequisite');
      renderDaily();
    }catch(error){if(request===activityRequest)$('dailyList').textContent=error.message}
  }
  let handoverRequest = null;
  function loadShiftHandover(){
    if(!handoverRequest)handoverRequest=call('shift_handover').finally(()=>{handoverRequest=null});
    return handoverRequest;
  }
  function handoverHistory(history){
    if(!history?.length)return '';
    return `<details class="handover-history"><summary>Handover history · ${history.length}</summary><ol>${history.map(move=>
      `<li><strong>${esc(move.fromName)}</strong> left this check unfinished. Passed to <strong>${esc(move.toName)}</strong> on ${esc(when(move.at))} IST.</li>`).join('')}</ol></details>`;
  }
  function showShiftHandover(report){
    $('handoverActivityButton').hidden=!report.incoming.length;
    const row=item=>`<li><strong>${esc(item.title)}</strong><p>${esc(item.customer||'Customer')} · ${item.completedAt
      ?`Completed by ${esc(item.completedBy||'Team member')} at ${esc(when(item.completedAt))} IST`
      :`Original deadline ${esc(when(item.dueAt))} IST`}</p>${handoverHistory(item.history)}</li>`;
    $('shiftHandoverContent').innerHTML=report.shift?`<p class="hint">Your shift · ${esc(when(report.shift.first))}–${esc(when(report.shift.last))} IST</p>
      <section><h3>Handed to you (${report.incoming.length})</h3>${report.incoming.length?`<ul>${report.incoming.map(row).join('')}</ul>`:'<p>No unfinished checks to pick up.</p>'}</section>
      <section><h3>Completed on the previous shift (${report.completed.length})</h3>${report.completed.length?`<ul>${report.completed.map(row).join('')}</ul>`:'<p>No completed checks to report.</p>'}</section>`
      :'<p>You have no published shift in progress.</p>';
    if(!$('shiftHandoverDialog').open)$('shiftHandoverDialog').showModal();
  }
  async function openShiftHandover(){
    try{showShiftHandover(await loadShiftHandover());await refreshDaily()}
    catch(error){toast(error.message)}
  }
  function viewHandoverActivity(){
    $('shiftHandoverDialog').close();
    $('opsDate').value=today();
    setActivityKind('check');openDaily('mine');
  }
  function activityTime(item){return item.kind==='check'?item.window_start_at:item.due_at}
  function status(item){
    if(item.status==='cancelled')return 'Cancelled';
    if(item.status==='missed')return item.completed_at?'Missed · recovered':'Missed';
    if(item.completed_at||item.status==='completed')return 'Completed';
    const prerequisite=activity?.dependencies?.find(row=>row.id===item.prerequisite_id);
    if(item.prerequisite_id&&prerequisite?.status!=='completed')return 'Blocked';
    const now=Date.now();
    if(item.kind==='check'){
      if(now>=Date.parse(item.window_end_at))return 'Missed';
      if(now>Date.parse(item.window_start_at))return 'Overdue';
    }else if(now>Date.parse(item.due_at))return 'Overdue';
    return 'Open';
  }
  function activityActions(item,pending){
    const mine=[item.owner_id,item.backup_owner_id].includes(getUser()?.id);
    const mayComplete=mine&&!item.completed_at&&['open','missed'].includes(item.status)&&
      (item.kind!=='check'||Date.parse(item.window_start_at)<=Date.now());
    return `<div class="ops-table-actions">${mayComplete?`<button type="button" onclick="completeActivity('${item.id}')">${status(item)==='Missed'?'Record recovery':'Complete'}</button>`:''}
      ${item.kind!=='check'&&item.owner_id===getUser()?.id&&item.status==='open'&&!pending?`<button type="button" class="secondary" onclick="requestActivityExtension('${item.id}')">Request extension</button>`:''}
      ${pending?.approver_id===getUser()?.id?`<button type="button" onclick="decideActivityExtension('${pending.id}',true)">Approve</button><button type="button" class="secondary" onclick="decideActivityExtension('${pending.id}',false)">Decline</button>`:''}</div>`;
  }
  function setActivityKind(kind){
    activityKind=kind;
    for(const button of $('dailyFilters').querySelectorAll('[data-kind]'))button.setAttribute('aria-pressed',String(button.dataset.kind===kind));
    $('opsDateLabel').textContent=kind==='check'?'Scheduled date':kind==='one'?'Due date':'Scheduled / due date';
    filterDaily();
  }
  function activityDateChanged(){
    activityPage=0;
    refreshDaily();
  }
  function setActivityToday(){
    $('opsDate').value=today();
    activityDateChanged();
  }
  function openActivityFilters(){
    for(const [key,id] of Object.entries(activityFilterFields))$(id).value=activityFilters[key]||'';
    $('activityFilterDialog').showModal();
  }
  function applyActivityFilters(event){
    event.preventDefault();
    for(const [key,id] of Object.entries(activityFilterFields)){
      if(key!=='assignee'||mode==='team')activityFilters[key]=$(id).value.trim();
    }
    $('activityFilterDialog').close();
    filterDaily();
  }
  function clearActivityFilters(){
    activityFilters={};
    if($('activityFilterDialog').open)$('activityFilterDialog').close();
    filterDaily();
  }
  function filterActivityStatus(status){
    activityFilters.status=activityFilters.status===status?'':status;
    filterDaily();
  }
  function sortActivities(key){
    activitySort={key,direction:activitySort.key===key?-activitySort.direction:1};
    filterDaily();
  }
  function filterDaily(){activityPage=0;renderDaily()}
  function stepActivityPage(delta){activityPage+=delta;renderDaily()}
  function findActivity(id){return [...(activity?.items||[]),...(activity?.carryover||[])].find(row=>row.id===id)}
  function openActivityDetails(id){
    const item=findActivity(id);if(!item)return;
    const customer=activity.customers.find(customer=>customer.id===item.customer_id)?.name||'Customer';
    const pending=activity.extensions.find(extension=>extension.item_id===item.id);
    const assignment=item.roster_assignment;
    const historicGap=item.coverage_gap&&item.kind==='check'&&Date.parse(item.window_end_at)<=Date.now();
    $('activityDetailsTitle').textContent=item.title;
    $('activityDetailsBody').innerHTML=`<p>${esc(customer)} · ${esc(status(item))}</p>
      <p><strong>Assignee</strong> ${esc(names.get(item.owner_id)||'Unassigned')}</p>
      <p><strong>${item.kind==='check'?'Scheduled':'Due'}</strong> ${esc(quickDateTime(activityTime(item)))}</p>
      ${item.kind==='check'?`<p><strong>Completion window closes</strong> ${esc(quickDateTime(item.window_end_at))}</p>`:''}
      ${item.coverage_gap?`<p class="ops-roster-alert">${historicGap?'Recorded coverage gap at the scheduled check time. Roster projections show the current plan.':'Coverage gap. A team member with Daily Activity access must be on shift at the scheduled time.'}</p>`:''}
      ${assignment?`<p>Assigned shift ${esc(quickDateTime(assignment.startsAt))} to ${esc(quickDateTime(assignment.endsAt))}${assignment.rosterVersion!=null?' · Roster v'+esc(assignment.rosterVersion):''}</p>`:''}
      ${item.instructions?`<p class="ops-activity-instructions">${esc(item.instructions)}</p>`:''}
      ${item.steps?.length?`<ul>${item.steps.map(step=>`<li>${esc(step)}</li>`).join('')}</ul>`:''}
      ${pending?`<p>Extension requested to ${esc(quickDateTime(pending.proposed_due_at))}. ${esc(pending.reason||'')}</p>`:''}
      ${item.completed_at?`<p>Completed by ${esc(names.get(item.completed_by)||'Team member')} on ${esc(quickDateTime(item.completed_at))}.</p>`:''}
      ${item.recovery_reason?`<p>Late recovery · ${esc(item.recovery_reason)}</p>`:''}
      ${item.evidence?`<p>Evidence · ${esc(item.evidence)}</p>`:''}${handoverHistory(item.handover_history)}`;
    $('activityDetailsDialog').showModal();
  }
  function renderDaily(){
    if(!activity||mode==='series')return;
    const mine=mode==='mine',me=getUser()?.id;
    const {customer,assignee,status:filterStatus,search=''}=activityFilters;
    const customers=new Map(activity.customers.map(customer=>[customer.id,customer.name]));
    const extensions=new Map(activity.extensions.map(extension=>[extension.item_id,extension]));
    const query=search.toLowerCase();
    const baseFilter=item=>{
      if(mine&&![item.owner_id,item.backup_owner_id].includes(me)&&extensions.get(item.id)?.approver_id!==me)return false;
      if(activityKind==='check'&&item.kind!=='check'||activityKind==='one'&&item.kind==='check')return false;
      if(customer&&item.customer_id!==customer||!mine&&assignee&&item.owner_id!==assignee)return false;
      return !query||[item.title,item.kind,customers.get(item.customer_id),names.get(item.owner_id)]
        .some(value=>String(value||'').toLowerCase().includes(query));
    };
    const outstanding=item=>['Open','Overdue','Blocked'].includes(status(item));
    const matchStatus=item=>{
      if(!filterStatus)return true;
      if(filterStatus==='outstanding')return outstanding(item);
      if(filterStatus==='coverage')return item.coverage_gap===true;
      return status(item).toLowerCase().startsWith(filterStatus);
    };
    const filtered=activity.items.filter(baseFilter);
    const rows=filtered.filter(matchStatus);
    const sortValues={title:item=>item.title,customer:item=>customers.get(item.customer_id)||'',assignee:item=>names.get(item.owner_id)||'',
      time:item=>activityTime(item),status:item=>status(item)};
    const getValue=sortValues[activitySort.key];
    rows.sort((left,right)=>{
      const ordered=activitySort.key==='time'?Date.parse(activityTime(left))-Date.parse(activityTime(right)):
        String(getValue(left)||'').localeCompare(String(getValue(right)||''));
      return ordered*activitySort.direction;
    });
    const missed=filtered.filter(item=>status(item)==='Missed').length;
    const filterCount=Object.entries(activityFilters).filter(([key,value])=>value&&(!mine||key!=='assignee')).length;
    $('activityFilterButton').textContent=filterCount?`Filters · ${filterCount}`:'Filters';
    $('dailySummary').innerHTML=mine?'':`<button type="button" class="secondary" data-selected="${filterStatus==='outstanding'}" onclick="filterActivityStatus('outstanding')">${filtered.filter(outstanding).length} outstanding</button>
      <button type="button" class="secondary" data-selected="${filterStatus==='missed'}" onclick="filterActivityStatus('missed')">${missed} missed</button>${filterStatus?`<button type="button" class="ops-link-button" onclick="filterActivityStatus('')">Clear status filter</button>`:''}`;
    const carryover=(activity.carryover||[]).filter(baseFilter).filter(matchStatus);
    const handovers=[...rows,...carryover].filter(item=>item.handover_history?.length&&!item.completed_at&&item.status!=='cancelled');
    $('handoverButton').hidden=!mine||$('opsDate').value!==today()||!handovers.length;
    $('handoverButton').querySelector('button').textContent=`Shift handover · ${handovers.length} to pick up`;
    const table=(items,caption)=>renderActivityTable(items,caption,mine,customers,extensions);
    $('dailyCarryover').innerHTML=mine&&carryover.length?`<details class="ops-activity-panel ops-carryover" open><summary>Earlier work still open · ${carryover.length}</summary>${table(carryover,'Earlier work still open')}</details>`:'';
    const groups=mine?[
      ['Needs attention',rows.filter(item=>!item.completed_at&&(item.handover_history?.length||['Overdue','Missed','Blocked'].includes(status(item)))&&item.status!=='cancelled')],
      ['Upcoming this shift',rows.filter(item=>status(item)==='Open'&&!item.handover_history?.length)],
      ['Completed',rows.filter(item=>item.completed_at||status(item)==='Completed')],
    ]:[['Team activity',rows]];
    if(mine&&rows.some(item=>item.status==='cancelled'))groups.push(['Cancelled',rows.filter(item=>item.status==='cancelled')]);
    activityPage=Math.max(0,Math.min(activityPage,Math.ceil(rows.length/activityPageSize)-1));
    const start=activityPage*activityPageSize,limit=Math.min(start+activityPageSize,rows.length);
    let offset=0;
    $('dailyList').innerHTML=groups.map(([label,group])=>{
      const page=group.slice(Math.max(0,start-offset),Math.max(0,limit-offset));
      offset+=group.length;
      return `<section class="ops-activity-panel">${mine?`<header><h3>${label}</h3><span>${group.length}</span></header>`:''}
        ${page.length?table(page,label):`<p class="empty">${group.length?'No activities in this group on this page.':'No activities here.'}</p>`}</section>`;
    }).join('');
    $('dailyPagination').hidden=!rows.length;
    $('dailyPageStatus').textContent=rows.length?`Showing ${start+1}–${limit} of ${rows.length}`:'';
    $('dailyPrevious').disabled=start===0;$('dailyNext').disabled=limit>=rows.length;
  }
  function renderActivityTable(items,caption,mine,customers,extensions){
    const columns=[['title','Activity'],['customer','Customer'],['time','Scheduled / due · IST']];
    if(!mine)columns.push(['assignee','Assignee']);
    columns.push(['status','Status']);
    const headings=columns.map(([key,label])=>{
      const current=activitySort.key===key,direction=activitySort.direction===1?'ascending':'descending';
      return `<th scope="col"${current?` aria-sort="${direction}"`:''}><button type="button" onclick="sortActivities('${key}')">${label}${current?(activitySort.direction===1?' ↑':' ↓'):''}</button></th>`;
    }).join('');
    const body=items.map(item=>{
      const statusText=status(item);
      const coverage=item.coverage_gap?`<button type="button" class="ops-link-button ops-coverage-label" onclick="openActivityDetails('${item.id}')">Coverage gap</button>`:'';
      return `<tr><th scope="row"><button type="button" class="ops-link-button" onclick="openActivityDetails('${item.id}')">${esc(item.title)}</button><small>${esc(item.kind==='check'?'Recurring check':item.kind)}${item.handover_history?.length?' · Handover':''}</small></th>
        <td>${esc(customers.get(item.customer_id)||'Customer')}</td><td>${esc(when(activityTime(item)))}</td>
        ${mine?'':`<td>${esc(names.get(item.owner_id)||'Unassigned')}</td>`}
        <td><span class="ops-status ${statusText.toLowerCase().split(' ')[0]}">${esc(statusText)}</span>${coverage}</td>
        <td>${activityActions(item,extensions.get(item.id))}</td></tr>`;
    }).join('');
    return `<div class="ops-activity-scroll" role="region" aria-label="${esc(caption)}" tabindex="0"><table class="ops-activity-table${mine?' ops-my-worklist':''}"><thead><tr>${headings}<th scope="col">Actions</th></tr></thead><tbody>${body}</tbody></table></div>`;
  }
  let quickOwnerState={assignment:[],support:[],dependency:[]},quickDueRequest=0;
  const quickMode=()=>$('quickAddForm').querySelector('[name="quickMode"]:checked')?.value||'once';
  const quickOwnerIds=()=>quickOwnerState[$('quickType').value];
  function quickClock(time){return new Date('2026-01-01T'+time+':00+05:30').toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'numeric',minute:'2-digit'})}
  function quickDateTime(iso){return new Date(iso).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',hour:'numeric',minute:'2-digit'})+' IST'}
  function openQuickAdd(){
    if(!basics)return toast('Activity is still loading');
    $('quickAddForm').reset();$('quickError').textContent='';$('quickMore').open=false;
    $('quickType').value='assignment';quickOwnerState={assignment:[],support:[],dependency:basics.oneTimeOwners?.dependency?.includes(getUser().id)?[getUser().id]:[]};$('quickAssignmentChoices').replaceChildren();
    $('quickStart').value=today();$('quickEnd').value='never';$('quickDueMode').value='shift';
    $('quickRecurringOption').hidden=!canManage();
    if(mode==='series'&&canManage())$('quickRecurringOption').querySelector('input').checked=true;
    select('quickCustomer',basics.customers,'Choose customer');
    $('quickCustomer').value=mode==='team'?activityFilters.customer||'':'';
    select('quickTeam',basics.activityTeams||[],'Choose team');
    $('quickTeam').value=(basics.activityTeams||[]).find(team=>team.id===roster?.teamId)?.id||basics.activityTeams?.[0]?.id||'';
    $('quickCheckRows').replaceChildren();addQuickCheck('09:00');
    toggleQuickMode();toggleQuickType();
    if(!(basics.oneTimeOwners?.assignment||[]).length)$('quickMore').open=true;
    $('quickAddDialog').showModal();$('quickTitle').focus();
  }
  function closeQuickAdd(){$('quickAddDialog').close()}
  function toggleQuickMode(){
    const repeat=quickMode()==='repeat';
    $('quickOnceFields').hidden=repeat;$('quickRepeatFields').hidden=!repeat;
    $('quickTypeWrap').hidden=repeat;$('quickScheduleOptions').hidden=!repeat;
    $('quickPrerequisiteWrap').hidden=repeat||$('quickType').value!=='dependency';
    $('quickCustomDue').required=!repeat&&$('quickDueMode').value==='custom';
    $('quickTeam').required=repeat;
    for(const row of $('quickCheckRows').children)row.querySelector('.quick-check-time').required=repeat;
    if(repeat)updateQuickRepeatSummary();else updateQuickDue();
  }
  function toggleQuickType(){
    const kind=$('quickType').value;
    $('quickOwnerSearch').value='';
    $('quickOwnerLabel').textContent=kind==='assignment'?'Assignees · reportees':kind==='support'?'Assignee · higher tier':'Assignee · same tier';
    $('quickPrerequisiteWrap').hidden=kind!=='dependency'||quickMode()==='repeat';
    renderQuickOwners();
    updateQuickDue();
  }
  function renderQuickOwners(){
    const kind=$('quickType').value,eligible=basics?.oneTimeOwners?.[kind]||[];
    const selected=quickOwnerIds();
    const search=$('quickOwnerSearch').value.trim().toLowerCase();
    $('quickSelectedOwners').innerHTML=selected.map(id=>`<button type="button" data-owner="${esc(id)}" aria-label="Remove ${esc(names.get(id)||'assignee')}">${esc(names.get(id)||'Assignee')} ×</button>`).join('');
    const people=eligible.map(id=>basics.people.find(person=>person.id===id)).filter(person=>person&&!selected.includes(person.id)&&person.name.toLowerCase().includes(search));
    $('quickAssignmentChoices').innerHTML=people.map(person=>`<button type="button" data-owner="${esc(person.id)}">${esc(person.name)} <small>Tier ${esc(person.tier)}</small></button>`).join('')||
      (eligible.length&&search?'<span class="hint">No people match this search.</span>':'');
    $('quickOwnerHelp').textContent=eligible.length?'':kind==='assignment'?'No eligible reportees. Check the task type under More options.':'No eligible people with Daily Activity access.';
  }
  function toggleQuickOwner(id){
    const kind=$('quickType').value;
    if(!basics.oneTimeOwners?.[kind]?.includes(id))return;
    const selected=quickOwnerIds();
    if(selected.includes(id))quickOwnerState[kind]=selected.filter(person=>person!==id);
    else if(kind!=='assignment')quickOwnerState[kind]=[id];
    else if(selected.length<10)quickOwnerState[kind]=[...selected,id];
    else return toast('Choose up to 10 reportees');
    renderQuickOwners();
    $('quickOwnerSearch').focus();
    updateQuickDue();
  }
  for(const id of ['quickAssignmentChoices','quickSelectedOwners']){
    $(id).addEventListener('click',event=>{
      const button=event.target.closest('[data-owner]');
      if(button)toggleQuickOwner(button.dataset.owner);
    });
  }
  async function updateQuickDue(){
    if(quickMode()==='repeat')return;
    const choice=$('quickDueMode').value,ids=quickOwnerIds(),ticket=++quickDueRequest;
    $('quickCustomDueWrap').hidden=choice!=='custom';$('quickCustomDue').required=choice==='custom';
    if(choice==='custom'){
      const picked=$('quickCustomDue').value?new Date($('quickCustomDue').value+':00+05:30'):null;
      $('quickDueSummary').textContent=picked&&Number.isFinite(picked.getTime())?quickDateTime(picked.toISOString()):'Choose a future date and time in IST.';return;
    }
    if(choice==='tomorrow'){
      $('quickDueSummary').textContent='Due '+quickDateTime(addDays(today(),1)+'T18:00:00+05:30')+' for each assignee.';return;
    }
    if(!ids.length){$('quickDueSummary').textContent='Select an assignee to see the end of their next published shift.';return}
    $('quickDueSummary').textContent='Checking published shifts…';
    try{const rows=await call('due_preview',{kind:$('quickType').value,ownerIds:ids});if(ticket!==quickDueRequest)return;
      $('quickDueSummary').innerHTML=rows.map(row=>{const name=basics.people.find(p=>p.id===row.ownerId)?.name||'Assignee';return `<span>${esc(name)}: ${row.dueAt?esc(quickDateTime(row.dueAt)):'<strong>No upcoming published shift · pick another deadline</strong>'}</span>`}).join('');
    }catch(e){if(ticket===quickDueRequest)$('quickDueSummary').textContent=e.message}
  }
  function toggleQuickFrequency(){$('quickDaysWrap').hidden=$('quickFrequency').value!=='selected';updateQuickRepeatSummary()}
  function updateQuickRepeatSummary(){
    $('quickEndDateWrap').hidden=$('quickEnd').value!=='date';
    $('quickRepeatSummary').textContent='Starts '+($('quickStart').value===today()?'today':$('quickStart').value||'on the selected date')+' · '+($('quickEnd').value==='date'?$('quickEndDate').value?'Ends '+$('quickEndDate').value:'Choose end date':'Until ended');
  }
  function quickWindow(start,minutes){const [h,m]=start.split(':').map(Number),total=h*60+m+Number(minutes),end=String(Math.floor(total/60)%24).padStart(2,'0')+':'+String(total%60).padStart(2,'0');return {end,label:quickClock(start)+'–'+quickClock(end)+(total>=1440?' next day':'')+' IST'}}
  function refreshQuickChecks(){for(const [index,row] of [...$('quickCheckRows').children].entries()){
    row.querySelector('.quick-check-title').textContent='Check '+(index+1);
    row.querySelector('.quick-check-remove').hidden=$('quickCheckRows').children.length===1;
    const start=row.querySelector('.quick-check-time').value,minutes=Number(row.querySelector('.quick-check-duration').value);
    row.querySelector('.quick-check-window').textContent=start&&minutes>=5&&minutes<=1439?'Window · '+quickWindow(start,minutes).label:'Choose a time and a 5–1439 minute window';
  }}
  function addQuickCheck(defaultTime=''){
    if(!basics||$('quickCheckRows').children.length>=24)return;
    const row=document.createElement('div');row.className='ops-quick-check';
    row.innerHTML=`<div class="ops-check-heading"><strong class="quick-check-title"></strong><button type="button" class="secondary quick-check-remove">Remove</button></div>
      <label>Check time (IST)<input class="quick-check-time" type="time"></label><p class="quick-check-window hint"></p>
      <details><summary>Completion window and label</summary><div class="ops-quick-check-main"><label>Window · minutes<input class="quick-check-duration" type="number" min="5" max="1439" value="60"></label>
      <label>Check label · optional<input class="quick-check-label" maxlength="120" placeholder="e.g. Booking review"></label></div></details>`;
    row.querySelector('.quick-check-time').value=defaultTime;
    row.querySelector('.quick-check-remove').onclick=()=>{row.remove();refreshQuickChecks()};
    row.addEventListener('input',refreshQuickChecks);$('quickCheckRows').append(row);refreshQuickChecks();toggleQuickMode();
  }
  async function submitQuickAdd(event){
    event.preventDefault();const button=$('quickSave');button.disabled=true;$('quickError').textContent='';
    try{
      const common={customerId:$('quickCustomer').value,title:$('quickTitle').value.trim(),instructions:$('quickInstructions').value,steps:$('quickSteps').value.split('\n').map(x=>x.trim()).filter(Boolean),evidenceRequired:$('quickEvidence').checked};
      if(quickMode()==='once'){
        const ownerIds=quickOwnerIds();if(!ownerIds.length)throw Error('Choose an assignee');if(ownerIds.length>10)throw Error('Choose up to 10 reportees');
        const kind=$('quickType').value,choice=$('quickDueMode').value;
        if(kind==='dependency'&&!$('quickPrerequisite').value){$('quickMore').open=true;throw Error('Choose a prerequisite task')}
        let dueAt=null;if(choice==='custom'){const picked=new Date($('quickCustomDue').value+':00+05:30');if(!Number.isFinite(picked.getTime()))throw Error('Choose a valid deadline in IST');dueAt=picked.toISOString()}
        const created=await call('one_create',{...common,kind,ownerIds,dueMode:choice,dueAt,prerequisiteId:kind==='dependency'?$('quickPrerequisite').value:null});
        if(created.items?.length)$('opsDate').value=new Date(Date.parse(created.items[0].due_at)+330*60000).toISOString().slice(0,10);
        activityKind==='check'&&setActivityKind('one');
        activityFilters={};
        closeQuickAdd();toast(ownerIds.length>1?`${ownerIds.length} tasks added`:'Task added');
        if(mode==='mine'&&!ownerIds.includes(getUser().id))await openDaily('team');else await refreshDaily();
      }else{
        const frequency=$('quickFrequency').value,days=frequency==='weekdays'?[1,2,3,4,5]:frequency==='selected'?[...$('quickDaysWrap').querySelectorAll('input:checked')].map(x=>Number(x.value)):[];
        if(frequency==='selected'&&!days.length)throw Error('Select at least one repeat day');
        if($('quickEnd').value==='date'&&!$('quickEndDate').value){$('quickMore').open=true;throw Error('Choose an end date')}
        const checks=[...$('quickCheckRows').children].map((row,index)=>{
          const start=row.querySelector('.quick-check-time').value,minutes=Number(row.querySelector('.quick-check-duration').value||60);
          if(!start||!Number.isInteger(minutes)||minutes<5||minutes>1439)throw Error('Choose a valid time and window for each check');
          return {label:row.querySelector('.quick-check-label').value.trim()||`Check ${index+1}`,start,end:quickWindow(start,minutes).end};
        });
        if(!checks.length)throw Error('Add at least one check');
        if(new Set(checks.map(check=>check.start)).size!==checks.length)throw Error('Use a different time for each check.');
        await call('series_create',{...common,teamId:$('quickTeam').value,
          scheduleKind:frequency==='selected'?'weekdays':frequency,weekdays:days,startsOn:$('quickStart').value,
          endsOn:$('quickEnd').value==='date'?$('quickEndDate').value:null,reminderMinutes:Number($('quickReminder').value),checks});
        closeQuickAdd();toast('Recurring schedule added');await openDaily('series');
      }
    }catch(e){$('quickError').textContent=e.message}finally{button.disabled=false}
  }
  async function loadSeries(){try{series=await call('series_list');renderSeries()}catch(e){$('seriesList').textContent=e.message}}
  function renderSeries(){
    const customers=new Map(basics.customers.map(customer=>[customer.id,customer.name]));
    if(!series.series.length){$('seriesList').innerHTML='<div class="ops-activity-panel empty">No recurring schedules yet.</div>';return}
    const rows=series.series.map(schedule=>{
      const checks=series.checks.filter(check=>check.series_id===schedule.id);
      return `<tr><th scope="row">${esc(schedule.title)}<small>${esc(schedule.schedule_kind)} · ${schedule.active?'Active':'Ended'} · ${esc(schedule.starts_on)} to ${esc(schedule.ends_on||'until ended')}</small></th>
        <td>${esc(customers.get(schedule.customer_id)||'Customer')}</td>
        <td>${esc(schedule.roster_team_name?schedule.roster_team_name+' team':'Team review needed')}</td>
        <td>${checks.map(check=>`<div title="${esc(check.label)}">${esc(quickClock(check.window_start.slice(0,5)))}–${esc(quickClock(check.window_end.slice(0,5)))}</div>`).join('')}</td>
        <td><div class="ops-table-actions"><button type="button" class="secondary" onclick="previewSeries('${schedule.id}')">Preview 14 days</button>
          ${schedule.active&&!schedule.roster_team_id?`<button type="button" class="secondary" onclick="adoptSeries('${schedule.id}')">Assign to team</button>`:''}
          ${schedule.active?`<button type="button" class="secondary" onclick="endActivitySeries('${schedule.id}')">End series</button>`:''}
        </div></td></tr><tr id="seriesPreviewRow_${schedule.id}" hidden><td colspan="5" id="seriesPreview_${schedule.id}"></td></tr>`;
    }).join('');
    $('seriesList').innerHTML=`<div class="ops-activity-panel ops-activity-scroll" role="region" aria-label="Recurring schedules" tabindex="0">
      <table class="ops-activity-table"><thead><tr><th>Schedule</th><th>Customer</th><th>Team</th><th>Check times (IST)</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  async function previewSeries(seriesId){
    const node=$('seriesPreview_'+seriesId),row=$('seriesPreviewRow_'+seriesId);if(!row.hidden){row.hidden=true;return}
    row.hidden=false;node.textContent='Loading upcoming checks…';
    try{
      const rows=await call('series_preview',{seriesId});
      node.innerHTML=rows.length?rows.map(row=>`<p><strong>${esc(row.date)}</strong> · ${esc(row.title)} · ${esc(names.get(row.owner_id)||(row.coverage_gap?'Coverage gap':'Unassigned'))} · ${esc(when(row.window_start_at))}–${esc(when(row.window_end_at))} IST</p>`).join(''):'No checks in the next 14 days.';
    }catch(error){node.textContent=error.message}
  }
  function adoptSeries(seriesId){
    const options=(basics.activityTeams||[]).map(team=>`<option value="${esc(team.id)}">${esc(team.name)}</option>`).join('');
    dialog('Assign to team roster','Review the upcoming check preview after saving.',`<label for="adoptTeam">Team</label><select id="adoptTeam" required><option value="">Choose team</option>${options}</select>`,async()=>{
      await call('series_adopt',{seriesId,teamId:$('adoptTeam').value});
      toast('Schedule now follows the published roster');
    });
  }
  function dialog(title,help,fields,submit,{label='Save',refreshActivity=true}={}){
    $('opsDialogTitle').textContent=title;$('opsDialogHelp').textContent=help;$('opsDialogFields').innerHTML=fields;
    const button=$('opsDialogSubmit');
    button.textContent=label;$('opsDialogError').textContent='';
    $('opsDialogForm').onsubmit=async event=>{
      event.preventDefault();button.disabled=true;
      try{
        await submit();
        $('opsDialog').close();
        if(refreshActivity){if(mode==='series')await loadSeries();else await refreshDaily()}
      }catch(error){$('opsDialogError').textContent=error.message}
      finally{button.disabled=false}
    };
    $('opsDialog').showModal();
  }
  function completeActivity(itemId){const item=findActivity(itemId);if(!item)return;const late=item.status==='missed'||item.kind==='check'&&Date.parse(item.due_at)<=Date.now();const fields=`${(item.steps||[]).map((step,i)=>`<label class="ops-check"><input type="checkbox" data-step="${i}"> ${esc(step)}</label>`).join('')}<div class="field"><label for="opsEvidence">Evidence ${item.evidence_required?'(required)':'(optional)'}</label><textarea id="opsEvidence" ${item.evidence_required?'required':''}></textarea></div>${late?'<div class="field"><label for="opsRecovery">Late recovery reason</label><textarea id="opsRecovery" required></textarea></div>':''}`;dialog(late?'Record late recovery':'Complete activity',item.title,fields,async()=>{await call('item_complete',{itemId,completedSteps:[...$('opsDialogFields').querySelectorAll('[data-step]:checked')].map(x=>Number(x.dataset.step)),evidence:$('opsEvidence').value,recoveryReason:$('opsRecovery')?.value||''});toast('Completion recorded')})}
  function requestActivityExtension(itemId){const item=findActivity(itemId);dialog('Request extension',`Current deadline: ${when(item.due_at)}`,`<div class="field"><label for="opsProposed">Proposed due date</label><input id="opsProposed" type="datetime-local" required></div><div class="field"><label for="opsReason">Reason</label><textarea id="opsReason" required></textarea></div>`,async()=>{await call('extension_request',{itemId,proposedDueAt:new Date($('opsProposed').value).toISOString(),reason:$('opsReason').value});toast('Extension sent for approval')})}
  async function decideActivityExtension(extensionId,approved){try{await call('extension_decide',{extensionId,approved});toast(approved?'Extension approved':'Extension declined');await refreshDaily()}catch(e){toast(e.message)}}
  async function endActivitySeries(seriesId){if(!confirm('End this recurring series? Past check records will remain.'))return;try{await call('series_end',{seriesId,endsOn:today()});toast('Series ended');await loadSeries()}catch(e){toast(e.message)}}
  let rosterEditing=null,rosterCoverage=null,showCoverage=false,rosterRequest=0,coverageRequest=0,coverageDay=null;
  let editRosterKey=null,personalRoster=true;
  const shortTime=value=>String(value||'').slice(0,5);
  function rosterClock(value){const [hour,minute]=shortTime(value).split(':').map(Number);return (hour%12||12)+(minute?':'+String(minute).padStart(2,'0'):'')+(hour<12?' AM':' PM')}
  function rosterDate(value){return new Date(value+'T00:00:00Z').toLocaleDateString('en-IN',{day:'numeric',month:'short',timeZone:'UTC'})}
  function shiftLabel(cell,date){if(!cell)return'—';if(cell.kind==='off')return'Off';if(cell.kind==='leave')return'Leave';const start=shortTime(cell.start),end=shortTime(cell.end),overnight=end<=start;return `${rosterClock(start)}–${rosterClock(end)}${overnight?' · +1 day':''}`}
  function rosterCell(userId,date,publishedOnly=false){
    const pub=roster.publishedRows.find(r=>r.user_id===userId&&r.work_date===date);
    if(!publishedOnly&&roster.editable.includes(userId)){const draft=roster.draftRows.find(r=>r.user_id===userId&&r.work_date===date);if(draft)return{kind:draft.kind,start:draft.start_time,end:draft.end_time};if(roster.week.draft_revision>0&&roster.week.draft_mode==='replace')return{kind:'off',start:null,end:null}}
    return pub?{kind:pub.published_kind,start:pub.published_start,end:pub.published_end}:null;
  }
  function rosterChanges(){if(!roster?.canManage||!roster.week.draft_revision)return[];const week=$('rosterWeek').value,changes=[];for(const person of roster.people)for(let day=0;day<7;day++){const date=addDays(week,day),now=rosterCell(person.id,date),before=rosterCell(person.id,date,true);if((now?.kind||'off')!==(before?.kind||'off')||shortTime(now?.start)!==shortTime(before?.start)||shortTime(now?.end)!==shortTime(before?.end))changes.push({person,date,before,now})}return changes}
  async function openRoster(){if(!allowed('roster'))return;activate('rosterView');if(!$('rosterWeek').value)$('rosterWeek').value=monday(today());try{await ensureBasics();await loadRoster()}catch(e){$('rosterError').textContent=e.message}}
  function rosterKey(){return roster?.teamId+'|'+$('rosterWeek').value}
  function rosterIsEditing(){return roster?.canManage&&(Boolean(roster.week.draft_revision)||editRosterKey===rosterKey())}
  function updateRosterButtons(){
    $('editRosterButton').hidden=!roster?.canManage||rosterIsEditing();
    $('copyRosterButton').hidden=!rosterIsEditing();
    $('publishRosterButton').hidden=!rosterIsEditing();
    $('publishRosterButton').disabled=!roster?.week.draft_revision;
    $('rosterHistoryWrap').hidden=!roster?.canManage;
  }
  function beginRosterEdit(){
    if(!roster?.canManage)return;
    editRosterKey=rosterKey();
    updateRosterButtons();
    showRosterPlanner(false);
    renderRoster();
  }
  function showPersonalRoster(personal){
    personalRoster=personal;
    for(const [id,active] of [['rosterMineTab',personal],['rosterTeamTab',!personal]]){
      $(id).classList.toggle('active',active);
      $(id).setAttribute('aria-pressed',String(active));
    }
    renderRoster();
  }
  async function loadRoster(){
    if(!allowed('roster'))return;
    const request=++rosterRequest;
    ++coverageRequest;
    rosterCoverage=null;
    const week=monday($('rosterWeek').value||today()),teamId=$('rosterTeam').value||roster?.teamId||null;
    $('rosterWeek').value=week;$('rosterGrid').textContent='Loading roster…';$('rosterCoverage').textContent='Loading coverage…';
    $('rosterCheckSummary').hidden=true;$('rosterError').textContent='';
    for(const id of ['editRosterButton','copyRosterButton','publishRosterButton'])$(id).hidden=true;
    try{
      const data=await call('roster_week',{week,teamId});
      if(request!==rosterRequest)return;
      roster=data;
      const teamSelect=$('rosterTeam');
      teamSelect.innerHTML=roster.teams.map(team=>`<option value="${esc(team.id)}">${esc(team.name)}</option>`).join('');
      teamSelect.value=roster.teamId;$('rosterTeamWrap').hidden=roster.teams.length<=1;
      updateRosterButtons();
      $('rosterPlannerTabs').hidden=!roster.canManage;
      $('rosterReaderTabs').hidden=canManage();
      showRosterPlanner(showCoverage,false);
      showPersonalRoster(personalRoster);
      if(roster.canManage)await previewRoster();
      if(request===rosterRequest&&roster.canManage&&$('rosterHistoryWrap').open)await loadRosterHistory();
    }catch(error){if(request===rosterRequest){$('rosterGrid').textContent=error.message;$('rosterError').textContent=error.message}}
  }
  function showRosterPlanner(coverage,load=true){
    showCoverage=Boolean(coverage&&roster?.canManage);
    $('rosterSheet').hidden=showCoverage;$('rosterCoverage').hidden=!showCoverage;
    for(const [id,active] of [['rosterShiftsTab',!showCoverage],['rosterCoverageTab',showCoverage]]){
      $(id).classList.toggle('active',active);
      if(active)$(id).setAttribute('aria-current','page');else $(id).removeAttribute('aria-current');
    }
    if(showCoverage&&load){if(rosterCoverage)renderCoverage();else previewRoster()}
  }
  function rosterThisWeek(){$('rosterWeek').value=monday(today());loadRoster()}
  function rosterStepWeek(direction){$('rosterWeek').value=addDays(monday($('rosterWeek').value||today()),direction*7);loadRoster()}
  function renderRoster(){
    if(!roster)return;
    const week=$('rosterWeek').value,end=addDays(week,6),editing=rosterIsEditing();
    const mine=!canManage()&&personalRoster;
    const people=roster.people.filter(person=>!mine||person.id===getUser()?.id)
      .sort((left,right)=>left.display_name.localeCompare(right.display_name));
    $('rosterWeekLabel').textContent=`${rosterDate(week)}–${rosterDate(end)} ${end.slice(0,4)}`;
    const version=Number(roster.week.active_version||0),revision=Number(roster.week.draft_revision||0);
    $('rosterState').textContent=revision?'Draft · published roster still active':version?`Published v${version}`:'Unpublished';
    $('rosterState').classList.toggle('published',version>0&&!revision);
    $('rosterSheetTitle').textContent=mine?'My shifts':'Team shifts';
    $('rosterSheetHelp').textContent=editing?'Select a shift to edit the draft.':'Published shifts';
    $('rosterShiftLegend').innerHTML=shiftLegend();
    const dates=Array.from({length:7},(_,index)=>addDays(week,index));
    const head=dates.map(date=>`<th scope="col" class="${date===today()?'ops-roster-today':''}">${esc(new Date(date+'T00:00:00Z').toLocaleDateString('en-IN',{weekday:'short',timeZone:'UTC'}))}<span class="ops-roster-day">${esc(rosterDate(date))}</span></th>`).join('');
    const body=people.map(person=>{
      const editable=editing&&roster.editable.includes(person.id);
      const cells=dates.map(date=>{
        const cell=rosterCell(person.id,date,!editing);
        const tone=classifyShift(cell?.kind,cell?.start,cell?.end),label=!cell&&editable?'Add shift':shiftLabel(cell,date);
        const chip=`class="ops-roster-shift shift-tone shift-${tone.key}" title="${esc(tone.label)}" aria-label="${esc(person.display_name)}, ${date}, ${esc(tone.label+' · '+label)}"`;
        return `<td class="${date===today()?'ops-roster-today':''}">${editable?`<button type="button" ${chip} onclick="openRosterEditor('${person.id}','${date}')">${esc(label)}</button>`:`<span ${chip}>${esc(label)}</span>`}</td>`;
      }).join('');
      return `<tr class="${person.id===getUser()?.id?'ops-roster-self':''}"><th scope="row">${esc(person.display_name)}<small>${esc(person.job_role||'')}</small></th>${cells}</tr>`;
    }).join('');
    $('rosterGrid').innerHTML=people.length?`<table class="ops-roster-table"><thead><tr><th scope="col">Team member</th>${head}</tr></thead><tbody>${body}</tbody></table>`:
      `<p class="empty">${mine?'Your shift is not listed for this week.':'No team members in this roster team.'}</p>`;
    const shiftCount=people.reduce((count,person)=>count+dates.filter(date=>rosterCell(person.id,date,!editing)?.kind==='work').length,0);
    const changeCount=rosterChanges().length;
    $('rosterFooter').innerHTML=`<span>${shiftCount} working shift${shiftCount===1?'':'s'}</span><span>${revision?`${changeCount} pending change${changeCount===1?'':'s'}`:version?`Published ${esc(when(roster.week.published_at))}`:''}</span>`;
  }
  function openRosterEditor(userId,date){if(!rosterIsEditing()||!roster.editable.includes(userId))return;const person=roster.people.find(p=>p.id===userId);if(!person)return toast('This person is outside the selected team');
    rosterEditing={userId,date};const cell=rosterCell(userId,date),start=shortTime(cell?.start)||'08:00',end=shortTime(cell?.end)||'18:00';let preset=cell?.kind==='off'?'off':cell?.kind==='leave'?'leave':Object.keys(rosterPresets).find(key=>rosterPresets[key][0]===start&&rosterPresets[key][1]===end)||'custom';if(!cell)preset='day';
    $('rosterEditorPerson').textContent=person.display_name+' · '+new Date(date+'T00:00:00Z').toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'short',timeZone:'UTC'});$('rosterEditStart').value=start;$('rosterEditEnd').value=end;$('rosterPreset').value=preset;
    $('rosterEditDays').innerHTML=Array.from({length:7},(_,i)=>{const day=addDays($('rosterWeek').value,i);return `<label><input type="checkbox" value="${day}" ${day===date?'checked':''}> ${esc(new Date(day+'T00:00:00Z').toLocaleDateString('en-IN',{weekday:'short',timeZone:'UTC'}))}</label>`}).join('');$('rosterEditorError').textContent='';toggleRosterPreset();$('rosterEditor').showModal()}
  function updateRosterEndDay(){
    const start=$('rosterEditStart').value,end=$('rosterEditEnd').value;
    $('rosterEndDay').hidden=!(start&&end&&end<start);
    const preset=$('rosterPreset').value;
    const kind=rosterPresets[preset]||preset==='custom'?'work':preset;
    const tone=classifyShift(kind,start,end);
    const valid=kind!=='work'||Boolean(start&&end&&start!==end);
    $('rosterShiftPreview').innerHTML=valid?`<span class="shift-tone shift-${tone.key}">${esc(tone.label)}${kind==='work'?' · '+esc(shiftLabel({kind,start,end})):''}</span>`:'<p class="hint">Choose different start and end times.</p>';
  }
  function toggleRosterPreset(){
    const preset=$('rosterPreset').value;
    const custom=preset==='custom';
    $('rosterCustomTimes').hidden=!custom;
    if(rosterPresets[preset])[$('rosterEditStart').value,$('rosterEditEnd').value]=rosterPresets[preset];
    for(const id of ['rosterEditStart','rosterEditEnd']){$(id).readOnly=!custom;$(id).required=custom}
    updateRosterEndDay();
  }
  async function saveRosterEditor(event){event.preventDefault();if(!rosterEditing||!roster)return;const preset=$('rosterPreset').value,dates=[...$('rosterEditDays').querySelectorAll('input:checked')].map(x=>x.value),hours=preset==='custom'?[$('rosterEditStart').value,$('rosterEditEnd').value]:rosterPresets[preset],kind=['off','leave'].includes(preset)?preset:'work';
    if(!dates.length){$('rosterEditorError').textContent='Select at least one day';return}if(kind==='work'&&(!hours?.[0]||!hours?.[1]||hours[0]===hours[1])){$('rosterEditorError').textContent='Choose different start and end times';return}
    $('rosterApplyButton').disabled=true;try{await call('roster_save',{teamId:roster.teamId,week:$('rosterWeek').value,userId:rosterEditing.userId,dates,kind,start:kind==='work'?hours[0]:null,end:kind==='work'?hours[1]:null,expectedVersion:roster.week.active_version,expectedRevision:roster.week.draft_revision});$('rosterEditor').close();await loadRoster();toast('Draft updated')}catch(e){$('rosterEditorError').textContent=e.message;if(/roster changed|newer roster/i.test(e.message)){await loadRoster();$('rosterEditor').close()}}finally{$('rosterApplyButton').disabled=false}}
  function copyRoster(){
    if(!rosterIsEditing())return;
    const replace=Boolean(roster.week.draft_revision);
    const payload={teamId:roster.teamId,week:$('rosterWeek').value,expectedVersion:roster.week.active_version,expectedRevision:roster.week.draft_revision,replace};
    dialog('Copy previous week',replace?'Replace the current draft with the previous week’s published shifts?':'Copy the previous week’s published shifts into this team’s draft?','',async()=>{
      await call('roster_copy',payload);
      await loadRoster();toast('Previous week copied to draft');
    },{label:'Copy shifts',refreshActivity:false});
  }
  function reviewRosterGap(userId,date){if(roster?.canManage&&!rosterIsEditing())beginRosterEdit();if(userId&&roster?.editable.includes(userId))openRosterEditor(userId,date);else{showRosterPlanner(false);toast('Add or extend an eligible shift on '+rosterDate(date))}}
  function coverageClock(minutes){return String(Math.floor(minutes/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0')}
  function staffingPlanner(days,markers){
    if(!days?.length)return '';
    if(coverageDay&&!days.some(day=>day.date===coverageDay))coverageDay=null;
    const dayOptions=days.map(day=>`<option value="${day.date}" ${coverageDay===day.date?'selected':''}>${esc(rosterDate(day.date))}</option>`).join('');
    const axis=Array.from({length:24},(_,hour)=>`<span>${hour%3===0?coverageClock(hour*60).slice(0,2):''}</span>`).join('');
    const rows=days.map((day,dayIndex)=>{
      if(coverageDay&&day.date!==coverageDay)return '';
      const covered=day.hours.reduce((sum,band)=>sum+band.coveredMinutes,0);
      const label=`${new Date(day.date+'T00:00:00Z').toLocaleDateString('en-IN',{weekday:'short',timeZone:'UTC'})} ${rosterDate(day.date)}`;
      const peak=Math.max(1,...day.hours.map(band=>band.peak));
      return `<div class="staffing-row ${coverageDay?'staffing-day':''}"><span><strong>${esc(label)}</strong><small>${Math.round(covered/14.4)}% covered</small></span>${day.hours.map((band,hour)=>{
        const tone=band.coveredMinutes===60?'covered':band.coveredMinutes?'partial':'gap';
        const title=`${label} ${coverageClock(hour*60)} IST · ${band.coveredMinutes}/60 minutes covered · Peak ${band.peak} on shift`;
        return `<button type="button" class="staffing-band ${tone} ${band.peak>1?'overlap':''}" aria-label="${esc(title)}" title="${esc(title)}" onclick="showStaffingHour(${dayIndex},${hour},this)" aria-pressed="false" aria-controls="staffingHour">${coverageDay?`<span class="staffing-height" style="--height:${100*band.peak/peak}%"></span>`:''}<span>${band.peak||'–'}</span></button>`;
      }).join('')}</div>`;
    }).join('');
    const activeMarkers=coverageDay?(markers||[]).filter(marker=>marker.date===coverageDay):[];
    const plot=coverageDay?`<div class="staffing-marker-row"><span>Checks</span><div class="staffing-marker-track">${activeMarkers.map((marker,index)=>{
      const local=new Date(Date.parse(marker.time)+330*60000);
      const minute=local.getUTCHours()*60+local.getUTCMinutes();
      return `<button type="button" class="staffing-marker ${marker.reason?'gap':'covered'}" style="--left:${minute/14.4}%;--offset:${index%3}" onclick="showCoverageCheck('${marker.id}')" aria-label="${esc(coverageClock(minute)+' IST · '+marker.check)}" title="${esc(coverageClock(minute)+' IST · '+marker.check)}">●</button>`;
    }).join('')}</div></div>`:'';
    return `<section class="ops-roster-coverage"><div class="ops-roster-coverage-head"><div><h3>Staffing coverage</h3><span>${rosterProjectionLabel()} · IST</span></div><div class="ops-coverage-switch" role="group" aria-label="Coverage period"><button type="button" class="secondary" aria-pressed="${!coverageDay}" onclick="selectCoverageDay('')">Weekly</button><button type="button" class="secondary" aria-pressed="${Boolean(coverageDay)}" onclick="openDailyCoverage()">Daily</button>${coverageDay?`<label>Day <select onchange="selectCoverageDay(this.value)">${dayOptions}</select></label>`:''}</div></div>
      <div class="staffing-legend"><span class="covered">Covered</span><span class="partial">Partly covered</span><span class="gap">Uncovered</span><span class="overlap">Overlapping shifts</span><span>Number = peak people on shift</span></div>
      <div class="staffing-scroll" tabindex="0" role="region" aria-label="Hourly staffing coverage"><div class="staffing-row staffing-axis" aria-hidden="true"><span>Hour</span>${axis}</div>${rows}${plot}</div>
      <div id="staffingHour" class="staffing-detail" aria-live="polite">Select an hour or check for details.</div></section>`;
  }
  function rosterProjectionLabel(){
    return roster?.week.draft_revision?'Draft preview':'Published projection';
  }
  function openDailyCoverage(){
    const days=rosterCoverage?.staffing||[];
    const first=days.find(day=>day.date===today())||days[0];
    if(first)selectCoverageDay(first.date);
  }
  function inspectRosterCheck(id,date){
    showRosterPlanner(true,false);
    selectCoverageDay(date);
    showCoverageCheck(id);
  }
  function openRecordedGap(date){
    if(!allowed('daily_activity'))return;
    activityFilters={status:'coverage'};
    $('opsDate').value=date;
    setActivityKind('check');
    openDaily('team');
  }
  function renderRosterCheckSummary(){
    const summary=$('rosterCheckSummary'),data=rosterCoverage;
    summary.hidden=!data;
    if(!data)return;
    const gaps=data.gaps||[],recorded=(data.recordedGaps||[])[0];
    const title=gaps.length?`${gaps.length} uncovered check${gaps.length===1?'':'s'}`:data.checks?`${data.checks} scheduled check${data.checks===1?'':'s'}`:'No recurring checks scheduled';
    summary.classList.toggle('ops-inline-alert',gaps.length>0);
    summary.innerHTML=`<strong>${title}</strong> · ${rosterProjectionLabel()}
      ${gaps.length?`<div class="ops-summary-links">${gaps.slice(0,4).map(gap=>`<button type="button" class="ops-link-button" onclick="inspectRosterCheck('${gap.id}','${gap.date}')">${esc(quickDateTime(gap.time))} · ${esc(gap.check)}</button>`).join('')}${gaps.length>4?'<button type="button" class="ops-link-button" onclick="showRosterPlanner(true)">See all coverage gaps</button>':''}</div>`:''}
      ${recorded&&allowed('daily_activity')?`<button type="button" class="ops-link-button ops-recorded-gap" onclick="openRecordedGap('${recorded.date}')">View recorded coverage gaps · ${esc(rosterDate(recorded.date))}</button>`:''}`;
  }
  function selectCoverageDay(date){coverageDay=date||null;renderCoverage()}
  function showCoverageCheck(id){
    const entry=rosterCoverage?.markers?.find(check=>check.id===id);
    if(!entry)return;
    const people=(entry.people||[]).filter(Boolean);
    const blockedStaff=entry.staffWithoutActivityAccess||[];
    $('staffingHour').innerHTML=`<strong>${esc(entry.check)} · ${esc(quickDateTime(entry.time))}</strong>
      <div>${esc(entry.customer||'Customer')} · ${esc(roster.teams.find(team=>team.id===roster.teamId)?.name||'Team')}</div>
      <div>${entry.reason?esc(entry.reason):'Assignee · '+esc(entry.assignee)}</div>
      ${people.length?`<div>Eligible staff on shift · ${esc(people.join(', '))}</div>`:''}
      ${blockedStaff.length?`<div>On shift without Daily Activity access · ${esc(blockedStaff.join(', '))}</div>`:''}
      ${entry.reason&&entry.suggestion?`<div>${esc(entry.suggestion)}</div>`:''}`;
    $('staffingHour').scrollIntoView({block:'nearest'});
  }
  function showStaffingHour(dayIndex,hour,button){
    const day=rosterCoverage?.staffing?.[dayIndex],band=day?.hours[hour];
    if(!band)return;
    if(!coverageDay){
      selectCoverageDay(day.date);
      button=$('rosterCoverage').querySelectorAll('.staffing-day .staffing-band')[hour];
      button?.focus();
    }
    for(const active of $('rosterCoverage').querySelectorAll('.staffing-band[aria-pressed="true"]'))active.setAttribute('aria-pressed','false');
    button?.setAttribute('aria-pressed','true');
    const people=band.people.map(id=>names.get(id)||roster.people.find(person=>person.id===id)?.display_name).filter(Boolean).sort();
    const gaps=band.gaps.map(([start,end])=>`${coverageClock(start)}–${coverageClock(end)}`).join(', ');
    $('staffingHour').innerHTML=`<strong>${esc(rosterDate(day.date))} · ${coverageClock(hour*60)}–${coverageClock((hour+1)*60)} IST</strong>
      <div>${people.length?`Scheduled: ${esc(people.join(', '))}`:'No one is scheduled.'}</div>${gaps?`<div>Uncovered: ${esc(gaps)}</div>`:''}`;
  }
  function renderCoverage(){
    const data=rosterCoverage;if(!data)return;
    const changes=rosterChanges();
    const warning=(entry,style,detail)=>`<div class="${style}"><span><strong>${esc(entry.time?quickDateTime(entry.time):rosterDate(entry.date))} · ${esc(entry.customer||'Customer')} · ${esc(entry.check)}</strong><br>${esc(detail)}</span>
      <button type="button" class="secondary" onclick="showCoverageCheck('${entry.id}')">Details</button>
      <button type="button" class="secondary" onclick="reviewRosterGap('${entry.userId||''}','${entry.date}')">Review shift</button></div>`;
    const markers=(data.markers||[]).filter(check=>!coverageDay||check.date===coverageDay);
    const gaps=data.gaps.filter(check=>!coverageDay||check.date===coverageDay);
    const early=data.early.filter(check=>!coverageDay||check.date===coverageDay);
    const status=!markers.length?'<p class="hint">No recurring checks scheduled for this selection.</p>'
      :markers.every(check=>!check.reason)?'<p class="ops-roster-ok">All scheduled checks are covered.</p>':'';
    const checkList=markers.map(check=>`<li><button type="button" class="ops-link-button" onclick="showCoverageCheck('${check.id}')">${esc(quickDateTime(check.time))} · ${esc(check.check)}</button> · ${esc(check.assignee||'Coverage gap')}</li>`).join('');
    $('rosterCoverage').innerHTML=`${staffingPlanner(data.staffing,data.markers)}<section class="ops-roster-coverage"><div class="ops-roster-coverage-head"><h3>Activity coverage</h3><span>${markers.length} scheduled checks · ${changes.length} draft changes</span></div>
        ${gaps.map(gap=>warning(gap,'ops-roster-alert',`${gap.reason}. ${gap.suggestion||'Add or extend a shift for a team member with Daily Activity access.'}`)).join('')}
        ${early.map(check=>warning(check,'ops-roster-early',`${check.reason} at ${when(check.deadline)} IST`)).join('')}${status}
        ${markers.length?`<details ${coverageDay?'open':''}><summary>Scheduled checks</summary><ul class="ops-coverage-check-list">${checkList}</ul></details>`:''}</section>`;
  }
  async function previewRoster(){
    if(!roster?.canManage)return null;
    const request=++coverageRequest;
    try{
      const data=await call('roster_preview',{teamId:roster.teamId,week:$('rosterWeek').value});
      if(request!==coverageRequest)return null;
      rosterCoverage=data;renderRosterCheckSummary();renderCoverage();return data;
    }catch(error){if(request===coverageRequest){$('rosterCoverage').textContent='';$('rosterError').textContent=error.message}return null}
  }
  async function publishRoster(){
    if(!rosterIsEditing()||!roster.week.draft_revision)return;
    const preview=await previewRoster();
    if(!preview)return;
    if(preview.gaps.length){
      coverageDay=null;renderCoverage();showRosterPlanner(true,false);
      $('rosterCoverage').scrollIntoView({behavior:'smooth',block:'start'});
      return toast('Resolve coverage gaps before publishing');
    }
    const changes=rosterChanges(),week=$('rosterWeek').value;
    const payload={teamId:roster.teamId,week,expectedVersion:roster.week.active_version,expectedRevision:roster.week.draft_revision};
    dialog('Publish changes',`Publish ${changes.length} shift change${changes.length===1?'':'s'} for ${rosterDate(week)}–${rosterDate(addDays(week,6))}?`,
      '<p>The public roster will update when the draft is published.</p>',async()=>{
        const result=await call('roster_publish',payload);
        editRosterKey=null;
        toast(`Roster published · version ${result.version}`);
        await loadRoster();
      },{label:'Publish',refreshActivity:false});
  }
  async function loadRosterHistory(){if(!roster?.canManage)return;$('rosterHistory').textContent='Loading history…';try{const rows=await call('roster_history',{teamId:roster.teamId,week:$('rosterWeek').value});$('rosterHistory').innerHTML=rows.length?rows.map(pub=>`<article class="ops-roster-history-item"><strong>Version ${pub.version}</strong> · ${esc(when(pub.published_at))} · ${esc(names.get(pub.published_by)||'Former publisher')}<p>${pub.changes.length} shift change${pub.changes.length===1?'':'s'}</p>${pub.changes.slice(0,12).map(c=>`<div>${esc(names.get(c.user_id)||'Team member')} · ${esc(rosterDate(c.work_date))}: ${esc(shiftLabel({kind:c.previous_kind,start:c.previous_start,end:c.previous_end},c.work_date))} → ${esc(shiftLabel({kind:c.kind,start:c.start_time,end:c.end_time},c.work_date))}</div>`).join('')}${pub.changes.length>12?`<small>and ${pub.changes.length-12} more changes</small>`:''}</article>`).join(''):'No published versions yet.'}catch(e){$('rosterHistory').textContent=e.message}}
  async function openInbox(){activate('inboxView');await refreshInbox()}
  async function refreshInbox(){if(!getUser())return;try{inbox=await call('inbox');lastInboxCheck=Date.now();const unread=inbox.filter(x=>!x.read_at).length;$('inboxCount').textContent=unread||'';$('inboxButton').setAttribute('aria-label',unread?`Inbox, ${unread} unread messages`:'Inbox');$('inboxList').innerHTML=inbox.length?inbox.map(m=>`<article class="panel ops-inbox-item ${m.read_at?'':'unread'}"><div><strong>${esc(m.title)}</strong><p>${esc(m.body)}</p><small>${esc(when(m.created_at))}</small></div><button type="button" class="secondary" onclick="openInboxMessage('${m.id}')">${m.read_at?'Open':'Mark read & open'}</button></article>`).join(''):'<div class="panel empty">Your inbox is empty.</div>'}catch(e){$('inboxList').textContent=e.message}}
  async function openInboxMessage(id){const message=inbox.find(x=>x.id===id);if(!message)return;try{await call('inbox_read',{id});if(message.target==='roster')await openRoster();else await openDaily('mine')}catch(e){toast(e.message)}}
  function supportsNotifications(){
    return 'serviceWorker'in navigator&&'PushManager'in window&&'Notification'in window;
  }
  async function getWorklogSubscription(){
    const registration=await navigator.serviceWorker.getRegistration();
    return registration?.pushManager.getSubscription()||null;
  }
  async function refreshNotificationSettings(){
    const button=$('notificationToggle');
    button.disabled=true;
    if(!supportsNotifications()){
      $('notificationStatus').textContent='Desktop reminders are unavailable in this browser.';
      return;
    }
    try{
      const subscription=await getWorklogSubscription();
      const blocked=Notification.permission==='denied';
      button.textContent=subscription?'Disable reminders':'Enable reminders';
      button.disabled=blocked&&!subscription;
      $('notificationStatus').textContent=blocked?'Desktop notifications are blocked in your browser settings.':
        subscription?'Desktop reminders are enabled in this browser.':'Receive desktop reminders for WorkLog in this browser.';
    }catch(error){$('notificationStatus').textContent=error.message}
  }
  function openNotificationSettings(){
    $('notificationDialog').showModal();
    refreshNotificationSettings();
  }
  async function toggleWorklogPush(){
    $('notificationToggle').disabled=true;
    try{
      if(!supportsNotifications())throw Error('Desktop reminders are unavailable in this browser.');
      const current=await getWorklogSubscription();
      if(current){
        await call('push_unsubscribe',{endpoint:current.endpoint});
        await current.unsubscribe();
      }else{
        if(await Notification.requestPermission()!=='granted')throw Error('Notification permission was not granted.');
        const {publicKey}=await call('push_key');
        if(!publicKey)throw Error('Push notifications are not configured.');
        const registration=await navigator.serviceWorker.register('./worklog-sw.js');
        const raw=atob(publicKey.replace(/-/g,'+').replace(/_/g,'/'));
        const key=Uint8Array.from(raw,character=>character.charCodeAt(0));
        const subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
        try{await call('push_subscribe',{subscription:subscription.toJSON()})}
        catch(error){await subscription.unsubscribe();throw error}
      }
      await refreshNotificationSettings();
    }catch(error){
      $('notificationStatus').textContent=error.message;
      $('notificationToggle').disabled=false;
    }
  }
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&getUser()&&Date.now()-lastInboxCheck>5*60000)refreshInbox()});
  navigator.serviceWorker?.addEventListener('message',event=>{if(event.data?.type==='worklog-notification'){if(event.data.target==='roster')openRoster();else openDaily('mine')}});
  const api={onBootstrap(fromSignIn=false){if(getUser()){if(!$('opsDate').value)$('opsDate').value=today();if(!$('rosterWeek').value)$('rosterWeek').value=monday(today());refreshInbox();if(allowed('daily_activity'))loadShiftHandover().then(report=>{if(report.shift&&(fromSignIn||report.incoming.length||report.completed.length))showShiftHandover(report)}).catch(error=>toast('Unable to load shift handover: '+error.message));if(location.hash==='#roster'&&allowed('roster'))queueMicrotask(openRoster);else if(location.hash==='#daily_activity'&&allowed('daily_activity'))queueMicrotask(()=>openDaily('mine'))}},openDaily,openRoster,openInbox,openShiftHandover,viewHandoverActivity,refreshDaily,renderDaily,filterDaily,activityDateChanged,setActivityToday,openActivityFilters,applyActivityFilters,clearActivityFilters,filterActivityStatus,sortActivities,setActivityKind,stepActivityPage,openActivityDetails,openQuickAdd,closeQuickAdd,toggleQuickMode,toggleQuickType,renderQuickOwners,updateQuickDue,toggleQuickFrequency,updateQuickRepeatSummary,addQuickCheck,submitQuickAdd,completeActivity,requestActivityExtension,decideActivityExtension,adoptSeries,endActivitySeries,previewSeries,loadRoster,renderRoster,rosterThisWeek,rosterStepWeek,openRosterEditor,toggleRosterPreset,updateRosterEndDay,saveRosterEditor,copyRoster,reviewRosterGap,previewRoster,publishRoster,beginRosterEdit,showPersonalRoster,showRosterPlanner,showStaffingHour,selectCoverageDay,openDailyCoverage,inspectRosterCheck,openRecordedGap,showCoverageCheck,loadRosterHistory,refreshInbox,openInboxMessage,openNotificationSettings,toggleWorklogPush};
  Object.assign(window,api);window.WorkLogOps=api;return api;
}
