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
  const allowed=key=>getModules().some(m=>m.key===key);
  async function call(action,args={}) {const {data,error}=await supabase.functions.invoke('worklog-operations',{body:{action,args}});if(error){let detail;try{detail=await error.context?.json()}catch(_){}throw Error(detail?.error||error.message)}if(data?.error)throw Error(data.error);return data}
  function activate(id) {
    closeUserDrawer();document.querySelectorAll('.view').forEach(x=>x.classList.remove('active'));$(id).classList.add('active');
    $('trackerTabs').hidden=true;$('usersTabs').hidden=true;$('dailyTabs').hidden=id!=='dailyActivity';
    for(const nav of ['trackerNav','reportingNav','usersNav','dailyNav','rosterNav'])$(nav).classList.toggle('active',nav===(id==='dailyActivity'?'dailyNav':id==='rosterView'?'rosterNav':''));
    $('inboxButton').classList.toggle('active',id==='inboxView');
  }
  async function ensureBasics(){if(!basics){basics=await call('bootstrap');for(const p of basics.people)names.set(p.id,p.name)}return basics}
  function select(id,rows,label='Select…'){const node=$(id),prior=node.value;node.innerHTML='<option value="">'+esc(label)+'</option>'+rows.map(r=>`<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');if(rows.some(r=>r.id===prior))node.value=prior}
  function canManage(){return basics?.canManage===true}
  async function openDaily(tab='mine'){
    if(!allowed('daily_activity'))return;mode=tab;activate('dailyActivity');
    for(const [name,id] of [['mine','dailyMineTab'],['team','dailyTeamTab'],['series','dailySeriesTab']]){$(id).classList.toggle('active',name===tab);$(id).hidden=name==='series'&&!canManage()}
    activityPage=0;$('dailyFilters').hidden=tab==='series';$('opsOwnerFilterWrap').hidden=tab!=='team';$('dailyList').hidden=tab==='series';$('dailyCarryover').hidden=tab!=='mine';$('dailyPagination').hidden=true;$('dailySummary').hidden=tab==='series';$('seriesList').hidden=tab!=='series';$('dailyViewActions').hidden=tab==='series';$('enablePushButton').hidden=tab!=='mine';
    $('handoverButton').hidden=tab!=='mine';
    if(!$('opsDate').value)$('opsDate').value=today();
    try{await ensureBasics();$('dailySeriesTab').hidden=!canManage();select('opsCustomerFilter',basics.customers,'All customers');select('opsOwnerFilter',basics.people,'All assignees');if(tab==='series')await loadSeries();else await refreshDaily();}
    catch(e){$('dailyList').textContent=e.message;toast(e.message)}
  }
  async function refreshDaily(){
    if(!allowed('daily_activity'))return;
    const date=$('opsDate').value||today(),request=++activityRequest;
    $('dailyList').textContent='Loading activities…';$('dailyPagination').hidden=true;$('dailyCarryover').replaceChildren();$('dailySummary').replaceChildren();
    try{
      if(handoverRequest)await handoverRequest.catch(()=>{});
      const data=await call('activity_list',{date});
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
  function filterDaily(){activityPage=0;renderDaily()}
  function stepActivityPage(delta){activityPage+=delta;renderDaily()}
  function findActivity(id){return [...(activity?.items||[]),...(activity?.carryover||[])].find(row=>row.id===id)}
  function openActivityDetails(id){
    const item=findActivity(id);if(!item)return;
    const customer=activity.customers.find(customer=>customer.id===item.customer_id)?.name||'Customer';
    const pending=activity.extensions.find(extension=>extension.item_id===item.id);
    const assignment=item.roster_assignment;
    $('activityDetailsTitle').textContent=item.title;
    $('activityDetailsBody').innerHTML=`<p>${esc(customer)} · ${esc(status(item))}</p>
      <p><strong>Assignee</strong> ${esc(names.get(item.owner_id)||'Unassigned')}</p>
      <p><strong>${item.kind==='check'?'Scheduled':'Due'}</strong> ${esc(quickDateTime(activityTime(item)))}</p>
      ${item.kind==='check'?`<p><strong>Completion window closes</strong> ${esc(quickDateTime(item.window_end_at))}</p>`:''}
      ${item.coverage_gap?'<p class="ops-roster-alert">No eligible shift at the scheduled time.</p>':''}
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
    const me=getUser()?.id,customer=$('opsCustomerFilter').value,owner=mode==='team'&&$('opsOwnerFilter').value;
    const state=$('opsStatusFilter').value,search=$('opsActivitySearch').value.trim().toLowerCase(),sort=$('opsActivitySort').value;
    const customers=new Map(activity.customers.map(customer=>[customer.id,customer.name]));
    const extension=new Map(activity.extensions.map(extension=>[extension.item_id,extension]));
    const rows=activity.items.filter(item=>{
      if(mode==='mine'&&![item.owner_id,item.backup_owner_id].includes(me)&&extension.get(item.id)?.approver_id!==me)return false;
      if(activityKind==='check'&&item.kind!=='check'||activityKind==='one'&&item.kind==='check')return false;
      if(customer&&item.customer_id!==customer||owner&&item.owner_id!==owner)return false;
      if(state==='coverage'?!item.coverage_gap:state&&!status(item).toLowerCase().startsWith(state))return false;
      return !search||[item.title,item.kind,customers.get(item.customer_id),names.get(item.owner_id)]
        .some(value=>String(value||'').toLowerCase().includes(search));
    });
    rows.sort((left,right)=>sort==='title'?left.title.localeCompare(right.title):((Date.parse(activityTime(left))-Date.parse(activityTime(right)))*(sort==='time-desc'?-1:1)));
    const counts={open:0,completed:0,missed:0,overdue:0,blocked:0};
    for(const item of rows){const key=status(item).toLowerCase().split(' ')[0];if(key in counts)counts[key]++}
    $('dailySummary').innerHTML=`<div class="ops-stat"><strong>${rows.length}</strong><span>Activities</span></div><div class="ops-stat"><strong>${counts.open+counts.overdue+counts.blocked}</strong><span>Outstanding</span></div><div class="ops-stat"><strong>${counts.completed}</strong><span>Completed</span></div><div class="ops-stat alert"><strong>${counts.missed}</strong><span>Missed</span></div>`;
    const carryover=activity.carryover||[];
    $('dailyCarryover').innerHTML=mode==='mine'&&activityKind!=='one'&&carryover.length?`<details class="panel ops-carryover" open><summary>Handovers from earlier dates · ${carryover.length}</summary>
      <ul>${carryover.map(item=>`<li><button type="button" class="ops-link-button" onclick="openActivityDetails('${item.id}')">${esc(item.title)}</button> · ${esc(quickDateTime(activityTime(item)))} ${activityActions(item)}</li>`).join('')}</ul></details>`:'';
    activityPage=Math.max(0,Math.min(activityPage,Math.ceil(rows.length/activityPageSize)-1));
    const start=activityPage*activityPageSize;
    const limit=Math.min(start+activityPageSize,rows.length);
    $('dailyList').innerHTML=rows.length?`<div class="ops-activity-scroll panel" role="region" aria-label="Activities" tabindex="0"><table class="ops-activity-table"><thead><tr><th>Activity</th><th>Customer</th><th>Scheduled / due · IST</th><th>Assignee</th><th>Status</th><th>Coverage</th><th>Actions</th></tr></thead>
      <tbody>${rows.slice(start,limit).map(item=>{
        const statusText=status(item);
        const coverage=item.kind!=='check'?'—':item.coverage_gap===true?'Coverage gap':item.coverage_gap===false?'Covered':'—';
        return `<tr><th scope="row"><button type="button" title="Open activity details" class="ops-link-button" onclick="openActivityDetails('${item.id}')">${esc(item.title)}</button><small>${esc(item.kind==='check'?'Recurring check':item.kind)}${item.handover_history?.length?' · Handover':''}</small></th>
          <td>${esc(customers.get(item.customer_id)||'Customer')}</td><td>${esc(when(activityTime(item)))}</td>
          <td>${esc(names.get(item.owner_id)||'Unassigned')}</td><td><span class="ops-status ${statusText.toLowerCase().split(' ')[0]}">${esc(statusText)}</span></td>
          <td>${item.coverage_gap?`<button type="button" class="ops-link-button" onclick="openActivityDetails('${item.id}')">${coverage}</button>`:coverage}</td>
          <td>${activityActions(item,extension.get(item.id))}</td></tr>`;
      }).join('')}</tbody></table></div>`:'<div class="panel empty">No activities match this date and filters.</div>';
    $('dailyPagination').hidden=false;
    $('dailyPageStatus').textContent=rows.length?`Showing ${start+1}–${limit} of ${rows.length}`:'0 activities';
    $('dailyPrevious').disabled=start===0;$('dailyNext').disabled=limit>=rows.length;
  }
  let quickOwnerState={assignment:[],support:[],dependency:[]},lastQuickType='assignment',quickDueRequest=0;
  const quickMode=()=>$('quickAddForm').querySelector('[name="quickMode"]:checked')?.value||'once';
  const quickOwnerIds=()=>$('quickType').value==='assignment'
    ?[...$('quickAssignmentChoices').querySelectorAll('input:checked')].map(input=>input.value)
    :$('quickSingleOwner').value?[$('quickSingleOwner').value]:[];
  function quickClock(time){return new Date('2026-01-01T'+time+':00+05:30').toLocaleTimeString('en-IN',{timeZone:'Asia/Kolkata',hour:'numeric',minute:'2-digit'})}
  function quickDateTime(iso){return new Date(iso).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',hour:'numeric',minute:'2-digit'})+' IST'}
  function openQuickAdd(){
    if(!basics)return toast('Activity is still loading');
    $('quickAddForm').reset();$('quickError').textContent='';$('quickMore').open=false;
    $('quickType').value='assignment';lastQuickType='assignment';quickOwnerState={assignment:[],support:[],dependency:[getUser().id]};$('quickAssignmentChoices').replaceChildren();
    $('quickStart').value=today();$('quickEnd').value='never';$('quickDueMode').value='shift';
    $('quickRecurringOption').hidden=!canManage();
    select('quickCustomer',basics.customers,'Choose customer');
    $('quickCustomer').value=mode==='team'&&$('opsCustomerFilter').value||'';
    select('quickTeam',basics.activityTeams||[],'Choose team');
    $('quickTeam').value=(basics.activityTeams||[]).find(team=>team.id===roster?.teamId)?.id||basics.activityTeams?.[0]?.id||'';
    $('quickCheckRows').replaceChildren();addQuickCheck();
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
    $('quickSingleOwner').required=!repeat&&$('quickType').value!=='assignment';
    $('quickTeam').required=repeat;
    for(const row of $('quickCheckRows').children)row.querySelector('.quick-check-time').required=repeat;
    if(repeat)updateQuickRepeatSummary();else updateQuickDue();
  }
  function toggleQuickType(){
    if(lastQuickType==='assignment')quickOwnerState.assignment=[...$('quickAssignmentChoices').querySelectorAll('input:checked')].map(input=>input.value);
    else quickOwnerState[lastQuickType]=$('quickSingleOwner').value?[$('quickSingleOwner').value]:[];
    const kind=$('quickType').value,ids=basics.oneTimeOwners?.[kind]||[],people=ids.map(id=>basics.people.find(p=>p.id===id)).filter(Boolean);
    const assignment=kind==='assignment';$('quickAssignmentChoices').hidden=!assignment;$('quickSingleOwner').hidden=assignment;
    $('quickOwnerLabel').textContent=assignment?'Assignees · reportees':kind==='support'?'Assignee · higher tier':'Assignee · same tier';
    if(assignment){
      $('quickAssignmentChoices').innerHTML=people.map(p=>`<label><input type="checkbox" value="${esc(p.id)}" onchange="updateQuickDue()" ${quickOwnerState.assignment.includes(p.id)?'checked':''}> ${esc(p.name)} <small>Tier ${esc(p.tier)}</small></label>`).join('');
      $('quickOwnerHelp').textContent=people.length?'Select one or more reportees. Each receives their own task.':'No lower-tier reportees have Daily Activity access. Choose another task type.';
    }else{
      const prior=quickOwnerState[kind]?.[0]|| (kind==='dependency'&&ids.includes(getUser().id)?getUser().id:'');
      $('quickSingleOwner').innerHTML='<option value="">Choose assignee</option>'+people.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} · Tier ${esc(p.tier)}</option>`).join('');
      $('quickSingleOwner').value=ids.includes(prior)?prior:'';
      $('quickOwnerHelp').textContent=people.length?'':'No eligible people with Daily Activity access.';
    }
    $('quickSingleOwner').required=!assignment&&quickMode()==='once';
    $('quickPrerequisiteWrap').hidden=kind!=='dependency'||quickMode()==='repeat';
    lastQuickType=kind;updateQuickDue();
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
  function addQuickCheck(){
    if(!basics||$('quickCheckRows').children.length>=24)return;
    const row=document.createElement('div');row.className='ops-quick-check';
    row.innerHTML=`<div class="ops-check-heading"><strong class="quick-check-title"></strong><button type="button" class="secondary quick-check-remove">Remove</button></div>
      <label>Check time (IST)<input class="quick-check-time" type="time"></label><p class="quick-check-window hint"></p>
      <details><summary>Completion window and label</summary><div class="ops-quick-check-main"><label>Window · minutes<input class="quick-check-duration" type="number" min="5" max="1439" value="60"></label>
      <label>Check label · optional<input class="quick-check-label" maxlength="120" placeholder="e.g. Booking review"></label></div></details>`;
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
    $('seriesList').innerHTML=series.series.length?series.series.map(schedule=>`<article class="panel ops-series">
      <div><span class="ops-kind">${esc(schedule.schedule_kind)}</span><h3>${esc(schedule.title)}</h3>
      <p class="ops-card-meta">${esc(customers.get(schedule.customer_id)||'Customer')} · ${esc(schedule.roster_team_name?schedule.roster_team_name+' team':'Legacy schedule · team review needed')} · ${esc(schedule.starts_on)} to ${esc(schedule.ends_on||'until ended')} · ${schedule.active?'Active':'Ended'}</p></div>
      <div>${series.checks.filter(check=>check.series_id===schedule.id).map(check=>`<div class="ops-series-check"><strong>${esc(check.label)}</strong> · ${esc(check.window_start.slice(0,5))}–${esc(check.window_end.slice(0,5))} IST${schedule.roster_team_id?'':' · '+esc(names.get(check.primary_owner_id)||'Unassigned')}</div>`).join('')}</div>
      <div class="ops-table-actions"><button type="button" class="secondary" onclick="previewSeries('${schedule.id}')">Preview next 14 days</button>
      ${schedule.active&&!schedule.roster_team_id?`<button type="button" class="secondary" onclick="adoptSeries('${schedule.id}')">Assign to team roster</button>`:''}
      ${schedule.active?`<button type="button" class="secondary" onclick="endActivitySeries('${schedule.id}')">End series</button>`:''}</div>
      <div id="seriesPreview_${schedule.id}" class="ops-series-preview" hidden></div></article>`).join(''):'<div class="panel empty">No recurring schedules yet.</div>';
  }
  async function previewSeries(seriesId){
    const node=$('seriesPreview_'+seriesId);if(!node.hidden){node.hidden=true;return}
    node.hidden=false;node.textContent='Loading upcoming checks…';
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
  function dialog(title,help,fields,submit){$('opsDialogTitle').textContent=title;$('opsDialogHelp').textContent=help;$('opsDialogFields').innerHTML=fields;$('opsDialogError').textContent='';$('opsDialogForm').onsubmit=async event=>{event.preventDefault();$('opsDialogSubmit').disabled=true;try{await submit();$('opsDialog').close();await refreshDaily();if(mode==='series')await loadSeries()}catch(e){$('opsDialogError').textContent=e.message}finally{$('opsDialogSubmit').disabled=false}};$('opsDialog').showModal()}
  function completeActivity(itemId){const item=findActivity(itemId);if(!item)return;const late=item.status==='missed'||item.kind==='check'&&Date.parse(item.due_at)<=Date.now();const fields=`${(item.steps||[]).map((step,i)=>`<label class="ops-check"><input type="checkbox" data-step="${i}"> ${esc(step)}</label>`).join('')}<div class="field"><label for="opsEvidence">Evidence ${item.evidence_required?'(required)':'(optional)'}</label><textarea id="opsEvidence" ${item.evidence_required?'required':''}></textarea></div>${late?'<div class="field"><label for="opsRecovery">Late recovery reason</label><textarea id="opsRecovery" required></textarea></div>':''}`;dialog(late?'Record late recovery':'Complete activity',item.title,fields,async()=>{await call('item_complete',{itemId,completedSteps:[...$('opsDialogFields').querySelectorAll('[data-step]:checked')].map(x=>Number(x.dataset.step)),evidence:$('opsEvidence').value,recoveryReason:$('opsRecovery')?.value||''});toast('Completion recorded')})}
  function requestActivityExtension(itemId){const item=findActivity(itemId);dialog('Request extension',`Current deadline: ${when(item.due_at)}`,`<div class="field"><label for="opsProposed">Proposed due date</label><input id="opsProposed" type="datetime-local" required></div><div class="field"><label for="opsReason">Reason</label><textarea id="opsReason" required></textarea></div>`,async()=>{await call('extension_request',{itemId,proposedDueAt:new Date($('opsProposed').value).toISOString(),reason:$('opsReason').value});toast('Extension sent for approval')})}
  async function decideActivityExtension(extensionId,approved){try{await call('extension_decide',{extensionId,approved});toast(approved?'Extension approved':'Extension declined');await refreshDaily()}catch(e){toast(e.message)}}
  async function endActivitySeries(seriesId){if(!confirm('End this recurring series? Past check records will remain.'))return;try{await call('series_end',{seriesId,endsOn:today()});toast('Series ended');await loadSeries()}catch(e){toast(e.message)}}
  const rosterPresets={day:['08:00','18:00'],evening:['16:30','01:00'],night:['22:00','08:00']};
  let rosterEditing=null,rosterCoverage=null,showCoverage=false,rosterRequest=0,coverageRequest=0,coverageDay=null;
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
  async function loadRoster(){if(!allowed('roster'))return;const request=++rosterRequest;++coverageRequest;const week=monday($('rosterWeek').value||today()),teamId=$('rosterTeam').value||roster?.teamId||null;$('rosterWeek').value=week;$('rosterGrid').textContent='Loading roster…';$('rosterCoverage').textContent='Loading coverage…';$('rosterError').textContent='';try{
    const data=await call('roster_week',{week,teamId});if(request!==rosterRequest)return;roster=data;const teamSelect=$('rosterTeam');teamSelect.innerHTML=roster.teams.map(team=>`<option value="${esc(team.id)}">${esc(team.name)}</option>`).join('');teamSelect.value=roster.teamId;$('rosterTeamWrap').hidden=roster.teams.length<=1;
    $('copyRosterButton').hidden=!roster.canManage;$('publishRosterButton').hidden=!roster.canManage;$('publishRosterButton').disabled=!roster.week.draft_revision;$('rosterShowAllWrap').hidden=!roster.canManage;$('rosterHistoryWrap').hidden=!roster.canManage;
    $('rosterPlannerTabs').hidden=!roster.canManage;showRosterPlanner(showCoverage,false);
    renderRoster();if(roster.canManage&&showCoverage)await previewRoster();if(request===rosterRequest&&roster.canManage&&$('rosterHistoryWrap').open)await loadRosterHistory();
  }catch(e){if(request!==rosterRequest)return;$('rosterGrid').textContent=e.message;$('rosterError').textContent=e.message}}
  function showRosterPlanner(coverage,load=true){
    showCoverage=Boolean(coverage&&roster?.canManage);
    $('rosterSheet').hidden=showCoverage;$('rosterCoverage').hidden=!showCoverage;
    for(const [id,active] of [['rosterShiftsTab',!showCoverage],['rosterCoverageTab',showCoverage]]){
      $(id).classList.toggle('active',active);
      if(active)$(id).setAttribute('aria-current','page');else $(id).removeAttribute('aria-current');
    }
    if(showCoverage&&load)previewRoster();
  }
  function rosterThisWeek(){$('rosterWeek').value=monday(today());loadRoster()}
  function rosterStepWeek(direction){$('rosterWeek').value=addDays(monday($('rosterWeek').value||today()),direction*7);loadRoster()}
  function renderRoster(){if(!roster)return;const week=$('rosterWeek').value,end=addDays(week,6),manager=roster.canManage,all=roster.people;
    const shown=manager&&!$('rosterShowAll').checked ? all.filter(person=>person.id===getUser()?.id||roster.editable.includes(person.id)) : all;
    const people=[...shown].sort((a,b)=>Number(/team lead/i.test(b.job_role||''))-Number(/team lead/i.test(a.job_role||''))||a.display_name.localeCompare(b.display_name));
    $('rosterWeekLabel').textContent=`${rosterDate(week)}–${rosterDate(end)} ${end.slice(0,4)}`;
    const version=Number(roster.week.active_version||0),revision=Number(roster.week.draft_revision||0);
    $('rosterState').textContent=revision?version?`Draft from published v${version}`:'Draft':version?`Published v${version}`:'No roster yet';$('rosterState').classList.toggle('published',version>0&&!revision);
    $('rosterSheetHelp').textContent=manager?'Select a shift to edit the draft. Published shifts stay active until you publish.':'Published shifts for your week.';
    const head=Array.from({length:7},(_,i)=>{const date=addDays(week,i);return `<th class="${i>4?'weekend':''}">${esc(new Date(date+'T00:00:00Z').toLocaleDateString('en-IN',{weekday:'short',timeZone:'UTC'}))}<span class="ops-roster-day">${esc(rosterDate(date))}</span></th>`}).join('');
    $('rosterGrid').innerHTML=`<table class="ops-roster-table"><thead><tr><th>Team member</th>${head}</tr></thead><tbody>${people.map(p=>{const initials=p.display_name.split(' ').slice(0,2).map(word=>word[0]).join('');return `<tr><th scope="row"><span class="ops-roster-person"><span class="ops-roster-avatar">${esc(initials)}</span><span>${esc(p.display_name)}<small>${esc(p.job_role||'')}</small></span></span></th>${Array.from({length:7},(_,i)=>{const date=addDays(week,i),cell=rosterCell(p.id,date),editable=roster.editable.includes(p.id),label=!cell&&editable?'Add shift':shiftLabel(cell,date),tone=!cell?'empty':cell.kind==='work'&&shortTime(cell.end)<=shortTime(cell.start)?'late':cell.kind;return `<td class="${i>4?'weekend':''}">${editable?`<button type="button" class="ops-roster-shift ${esc(tone)}" onclick="openRosterEditor('${p.id}','${date}')" aria-label="${esc(p.display_name)}, ${date}, ${esc(label)}">${esc(label)}</button>`:`<span class="ops-roster-shift ${esc(tone)}" aria-label="${esc(p.display_name)}, ${date}, ${esc(label)}">${esc(label)}</span>`}</td>`}).join('')}</tr>`}).join('')}</tbody></table>`;
    if(!people.length)$('rosterGrid').innerHTML='<div class="panel empty">No team members in this roster team.</div>';
    const shiftCount=all.reduce((count,p)=>count+Array.from({length:7},(_,i)=>rosterCell(p.id,addDays(week,i))?.kind==='work'?1:0).reduce((a,b)=>a+b,0),0),changeCount=rosterChanges().length;
    $('rosterFooter').innerHTML=`<span>${shiftCount} working shift${shiftCount===1?'':'s'}${manager&&shown.length<all.length?` · ${all.length-shown.length} other team members hidden`:''}</span><span>${revision?`Draft revision ${revision} saved · ${changeCount} change${changeCount===1?'':'s'} pending`:version?`Published ${esc(when(roster.week.published_at))}`:'Add shifts to start a draft'}</span>`;
  }
  function openRosterEditor(userId,date){if(!roster?.editable.includes(userId))return;const person=roster.people.find(p=>p.id===userId);if(!person)return toast('This person is outside the selected team');if(!$('rosterShowAll').checked&&!/team lead/i.test(person.job_role||'')){$('rosterShowAll').checked=true;renderRoster()}
    rosterEditing={userId,date};const cell=rosterCell(userId,date),start=shortTime(cell?.start)||'08:00',end=shortTime(cell?.end)||'18:00';let preset=cell?.kind==='off'?'off':cell?.kind==='leave'?'leave':Object.keys(rosterPresets).find(key=>rosterPresets[key][0]===start&&rosterPresets[key][1]===end)||'custom';if(!cell)preset='day';
    $('rosterEditorPerson').textContent=person.display_name+' · '+new Date(date+'T00:00:00Z').toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'short',timeZone:'UTC'});$('rosterEditStart').value=start;$('rosterEditEnd').value=end;$('rosterEditorForm').querySelector(`[name="rosterPreset"][value="${preset}"]`).checked=true;
    $('rosterEditDays').innerHTML=Array.from({length:7},(_,i)=>{const day=addDays($('rosterWeek').value,i);return `<label><input type="checkbox" value="${day}" ${day===date?'checked':''}> ${esc(new Date(day+'T00:00:00Z').toLocaleDateString('en-IN',{weekday:'short',timeZone:'UTC'}))}</label>`}).join('');$('rosterEditorError').textContent='';toggleRosterPreset();$('rosterEditor').showModal()}
  function updateRosterEndDay(){
    const start=$('rosterEditStart').value,end=$('rosterEditEnd').value;
    $('rosterEndDay').hidden=!(start&&end&&end<start);
  }
  function toggleRosterPreset(){
    const preset=$('rosterEditorForm').querySelector('[name="rosterPreset"]:checked')?.value;
    const custom=preset==='custom',working=custom||Boolean(rosterPresets[preset]);
    $('rosterCustomTimes').hidden=!working;
    if(rosterPresets[preset])[$('rosterEditStart').value,$('rosterEditEnd').value]=rosterPresets[preset];
    for(const id of ['rosterEditStart','rosterEditEnd']){$(id).readOnly=!custom;$(id).required=custom}
    updateRosterEndDay();
  }
  async function saveRosterEditor(event){event.preventDefault();if(!rosterEditing||!roster)return;const preset=$('rosterEditorForm').querySelector('[name="rosterPreset"]:checked')?.value,dates=[...$('rosterEditDays').querySelectorAll('input:checked')].map(x=>x.value),hours=preset==='custom'?[$('rosterEditStart').value,$('rosterEditEnd').value]:rosterPresets[preset],kind=['off','leave'].includes(preset)?preset:'work';
    if(!dates.length){$('rosterEditorError').textContent='Select at least one day';return}if(kind==='work'&&(!hours?.[0]||!hours?.[1]||hours[0]===hours[1])){$('rosterEditorError').textContent='Choose different start and end times';return}
    $('rosterApplyButton').disabled=true;try{await call('roster_save',{teamId:roster.teamId,week:$('rosterWeek').value,userId:rosterEditing.userId,dates,kind,start:kind==='work'?hours[0]:null,end:kind==='work'?hours[1]:null,expectedVersion:roster.week.active_version,expectedRevision:roster.week.draft_revision});$('rosterEditor').close();await loadRoster();toast('Draft updated')}catch(e){$('rosterEditorError').textContent=e.message;if(/roster changed|newer roster/i.test(e.message)){await loadRoster();$('rosterEditor').close()}}finally{$('rosterApplyButton').disabled=false}}
  async function copyRoster(){if(!roster?.canManage)return;const replace=roster.week.draft_revision>0;if(replace&&!confirm('Replace the existing draft shifts with the previous published week?'))return;$('rosterError').textContent='';try{await call('roster_copy',{teamId:roster.teamId,week:$('rosterWeek').value,expectedVersion:roster.week.active_version,expectedRevision:roster.week.draft_revision,replace});await loadRoster();toast('Previous week copied to draft')}catch(e){$('rosterError').textContent=e.message;if(/roster changed|newer roster/i.test(e.message))await loadRoster()}}
  function reviewRosterGap(userId,date){if(userId&&roster?.editable.includes(userId))openRosterEditor(userId,date);else{showRosterPlanner(false);toast('Add or extend an eligible shift on '+rosterDate(date))}}
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
    return `<section class="ops-roster-coverage"><div class="ops-roster-coverage-head"><h3>Staffing coverage</h3><label>Period <select onchange="selectCoverageDay(this.value)"><option value="">Weekly</option>${dayOptions}</select></label><span>Draft preview · IST</span></div>
      <div class="staffing-legend"><span class="covered">Covered</span><span class="partial">Partly covered</span><span class="gap">Uncovered</span><span class="overlap">Overlapping shifts</span><span>Number = peak people on shift</span></div>
      <div class="staffing-scroll" tabindex="0" role="region" aria-label="Hourly staffing coverage"><div class="staffing-row staffing-axis" aria-hidden="true"><span>Hour</span>${axis}</div>${rows}${plot}</div>
      <div id="staffingHour" class="staffing-detail" aria-live="polite">Select an hour or check for details.</div></section>`;
  }
  function selectCoverageDay(date){coverageDay=date||null;renderCoverage()}
  function showCoverageCheck(id){
    const entry=rosterCoverage?.markers?.find(check=>check.id===id);
    if(!entry)return;
    const people=(entry.people||[]).filter(Boolean);
    $('staffingHour').innerHTML=`<strong>${esc(entry.check)} · ${esc(quickDateTime(entry.time))}</strong>
      <div>${esc(entry.customer||'Customer')} · ${esc(roster.teams.find(team=>team.id===roster.teamId)?.name||'Team')}</div>
      <div>${entry.reason?esc(entry.reason):'Assignee · '+esc(entry.assignee)}</div>
      <div>${people.length?'Eligible staff on shift · '+esc(people.join(', ')):'No eligible staff on shift'}</div>`;
    $('staffingHour').scrollIntoView({block:'nearest'});
  }
  function showStaffingHour(dayIndex,hour,button){
    const day=rosterCoverage?.staffing?.[dayIndex],band=day?.hours[hour];
    if(!band)return;
    for(const active of $('rosterCoverage').querySelectorAll('.staffing-band[aria-pressed="true"]'))active.setAttribute('aria-pressed','false');
    button.setAttribute('aria-pressed','true');
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
        ${gaps.map(gap=>warning(gap,'ops-roster-alert',gap.reason+'. Add a shift or extend the hours of an eligible team member.')).join('')}
        ${early.map(check=>warning(check,'ops-roster-early',`${check.reason} at ${when(check.deadline)} IST`)).join('')}${status}
        ${markers.length?`<details ${coverageDay?'open':''}><summary>Scheduled checks</summary><ul class="ops-coverage-check-list">${checkList}</ul></details>`:''}</section>`;
  }
  async function previewRoster(){
    if(!roster?.canManage)return null;
    const request=++coverageRequest;
    try{
      const data=await call('roster_preview',{teamId:roster.teamId,week:$('rosterWeek').value});
      if(request!==coverageRequest)return null;
      rosterCoverage=data;renderCoverage();return data;
    }catch(error){if(request===coverageRequest){$('rosterCoverage').textContent='';$('rosterError').textContent=error.message}return null}
  }
  async function publishRoster(){if(!roster?.canManage||!roster.week.draft_revision)return;const preview=await previewRoster();if(!preview)return;if(preview.gaps.length){coverageDay=null;renderCoverage();showRosterPlanner(true,false);$('rosterCoverage').scrollIntoView({behavior:'smooth',block:'start'});toast('Resolve coverage gaps before publishing');return}const changes=rosterChanges();if(!confirm(`Publish ${rosterDate($('rosterWeek').value)} week with ${changes.length} shift change${changes.length===1?'':'s'}?`))return;try{const result=await call('roster_publish',{teamId:roster.teamId,week:$('rosterWeek').value,expectedVersion:roster.week.active_version,expectedRevision:roster.week.draft_revision});toast(`Roster published · version ${result.version}`);await loadRoster();await loadRosterHistory()}catch(e){$('rosterError').textContent=e.message;if(/roster changed|newer roster|coverage gap/i.test(e.message))await loadRoster()}}
  async function loadRosterHistory(){if(!roster?.canManage)return;$('rosterHistory').textContent='Loading history…';try{const rows=await call('roster_history',{teamId:roster.teamId,week:$('rosterWeek').value});$('rosterHistory').innerHTML=rows.length?rows.map(pub=>`<article class="ops-roster-history-item"><strong>Version ${pub.version}</strong> · ${esc(when(pub.published_at))} · ${esc(names.get(pub.published_by)||'Former publisher')}<p>${pub.changes.length} shift change${pub.changes.length===1?'':'s'}</p>${pub.changes.slice(0,12).map(c=>`<div>${esc(names.get(c.user_id)||'Team member')} · ${esc(rosterDate(c.work_date))}: ${esc(shiftLabel({kind:c.previous_kind,start:c.previous_start,end:c.previous_end},c.work_date))} → ${esc(shiftLabel({kind:c.kind,start:c.start_time,end:c.end_time},c.work_date))}</div>`).join('')}${pub.changes.length>12?`<small>and ${pub.changes.length-12} more changes</small>`:''}</article>`).join(''):'No published versions yet.'}catch(e){$('rosterHistory').textContent=e.message}}
  async function openInbox(){activate('inboxView');await refreshInbox()}
  async function refreshInbox(){if(!getUser())return;try{inbox=await call('inbox');lastInboxCheck=Date.now();const unread=inbox.filter(x=>!x.read_at).length;$('inboxCount').textContent=unread||'';$('inboxButton').setAttribute('aria-label',unread?`Inbox, ${unread} unread messages`:'Inbox');$('inboxList').innerHTML=inbox.length?inbox.map(m=>`<article class="panel ops-inbox-item ${m.read_at?'':'unread'}"><div><strong>${esc(m.title)}</strong><p>${esc(m.body)}</p><small>${esc(when(m.created_at))}</small></div><button type="button" class="secondary" onclick="openInboxMessage('${m.id}')">${m.read_at?'Open':'Mark read & open'}</button></article>`).join(''):'<div class="panel empty">Your inbox is empty.</div>'}catch(e){$('inboxList').textContent=e.message}}
  async function openInboxMessage(id){const message=inbox.find(x=>x.id===id);if(!message)return;try{await call('inbox_read',{id});if(message.target==='roster')await openRoster();else await openDaily('mine')}catch(e){toast(e.message)}}
  async function enableWorklogPush(){try{if(!('serviceWorker'in navigator)||!('PushManager'in window))throw Error('Push is unavailable in this browser');const permission=await Notification.requestPermission();if(permission!=='granted')throw Error('Push permission was not granted');const {publicKey}=await call('push_key');if(!publicKey)throw Error('Web push is not configured yet');const registration=await navigator.serviceWorker.register('./worklog-sw.js');const raw=atob(publicKey.replace(/-/g,'+').replace(/_/g,'/')),key=Uint8Array.from(raw,c=>c.charCodeAt(0));const subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});await call('push_subscribe',{subscription:subscription.toJSON()});toast('Push notifications enabled')}catch(e){toast(e.message)}}
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&getUser()&&Date.now()-lastInboxCheck>5*60000)refreshInbox()});
  navigator.serviceWorker?.addEventListener('message',event=>{if(event.data?.type==='worklog-notification'){if(event.data.target==='roster')openRoster();else openDaily('mine')}});
  const api={onBootstrap(fromSignIn=false){if(getUser()){if(!$('opsDate').value)$('opsDate').value=today();if(!$('rosterWeek').value)$('rosterWeek').value=monday(today());refreshInbox();if(allowed('daily_activity'))loadShiftHandover().then(report=>{if(report.shift&&(fromSignIn||report.incoming.length||report.completed.length))showShiftHandover(report)}).catch(error=>toast('Unable to load shift handover: '+error.message));if(location.hash==='#roster'&&allowed('roster'))queueMicrotask(openRoster);else if(location.hash==='#daily_activity'&&allowed('daily_activity'))queueMicrotask(()=>openDaily('mine'))}},openDaily,openRoster,openInbox,openShiftHandover,viewHandoverActivity,refreshDaily,renderDaily,filterDaily,setActivityKind,stepActivityPage,openActivityDetails,openQuickAdd,closeQuickAdd,toggleQuickMode,toggleQuickType,updateQuickDue,toggleQuickFrequency,updateQuickRepeatSummary,addQuickCheck,submitQuickAdd,completeActivity,requestActivityExtension,decideActivityExtension,adoptSeries,endActivitySeries,previewSeries,loadRoster,renderRoster,rosterThisWeek,rosterStepWeek,openRosterEditor,toggleRosterPreset,updateRosterEndDay,saveRosterEditor,copyRoster,reviewRosterGap,previewRoster,publishRoster,showRosterPlanner,showStaffingHour,selectCoverageDay,showCoverageCheck,loadRosterHistory,refreshInbox,openInboxMessage,enableWorklogPush};
  Object.assign(window,api);window.WorkLogOps=api;return api;
}
