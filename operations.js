export function setupOperations({supabase,getUser,getModules,toast,closeUserDrawer}) {
  const $=id=>document.getElementById(id);
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const today=()=>new Date(Date.now()+330*60000).toISOString().slice(0,10);
  const addDays=(day,n)=>new Date(Date.parse(day+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
  const monday=day=>addDays(day,-((new Date(day+'T00:00:00Z').getUTCDay()+6)%7));
  const when=iso=>iso?new Date(iso).toLocaleString('en-IN',{timeZone:'Asia/Kolkata',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'—';
  const names=new Map();let basics=null,activity=null,series=null,roster=null,inbox=[],mode='mine',lastInboxCheck=0;
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
    $('dailyFilters').hidden=tab!=='team';$('dailyList').hidden=tab==='series';$('dailySummary').hidden=tab==='series';$('seriesList').hidden=tab!=='series';$('dailyViewActions').hidden=tab==='series';$('enablePushButton').hidden=tab!=='mine';
    if(!$('opsDate').value)$('opsDate').value=today();
    try{await ensureBasics();$('dailySeriesTab').hidden=!canManage();select('opsCustomerFilter',basics.customers,'All customers');select('opsOwnerFilter',basics.people.filter(p=>p.inTeam),'All owners');if(tab==='series')await loadSeries();else await refreshDaily();}
    catch(e){$('dailyList').textContent=e.message;toast(e.message)}
  }
  async function refreshDaily(){if(!allowed('daily_activity'))return;const from=$('opsDate').value||today();$('dailyList').textContent='Loading activities…';try{activity=await call('activity_list',{from,to:addDays(from,13)});renderDaily()}catch(e){$('dailyList').textContent=e.message}}
  function status(item){if(item.status==='cancelled')return'Cancelled';if(item.status==='completed')return'Completed';if(item.status==='missed')return item.completed_at?'Missed · recovered':'Missed';if(item.prerequisite_id&&activity?.items.find(x=>x.id===item.prerequisite_id)?.status!=='completed')return'Blocked';if(item.kind==='check'&&item.coverage_gap)return'Coverage gap';if(item.kind==='check'&&item.primary_cutoff_at&&Date.now()>=Date.parse(item.primary_cutoff_at)&&Date.now()<Date.parse(item.final_cutoff_at))return'Overdue';if(Date.parse(item.due_at)<Date.now())return'Overdue';if(item.window_start_at&&Date.parse(item.window_start_at)>Date.now())return'Upcoming';return'Open'}
  function itemCard(item){const customer=activity.customers.find(c=>c.id===item.customer_id)?.name||'Customer',state=status(item),mine=[item.owner_id,item.backup_owner_id].includes(getUser()?.id),pending=activity.extensions.find(e=>e.item_id===item.id),mayApprove=pending?.approver_id===getUser()?.id;
    return `<article class="ops-card"><div class="ops-card-main"><div class="ops-card-top"><span class="ops-kind">${esc(item.kind==='check'?'Recurring check':item.kind)}</span><span class="ops-status ${state.toLowerCase().split(' ')[0]}">${esc(state)}</span></div><h3>${esc(item.title)}</h3><p class="ops-card-meta">${esc(customer)} · ${esc(names.get(item.owner_id)||'Owner')} · Due ${esc(when(item.due_at))}${item.backup_owner_id?' · Backup '+esc(names.get(item.backup_owner_id)||''):''}</p>${item.instructions?`<p>${esc(item.instructions)}</p>`:''}${item.prerequisite_id?`<p class="ops-dependency">Prerequisite: ${esc(activity.items.find(x=>x.id===item.prerequisite_id)?.title||'Linked task')}</p>`:''}${pending?`<p class="ops-extension">Extension requested to ${esc(when(pending.proposed_due_at))}; current deadline remains ${esc(when(item.due_at))}.</p>`:''}${item.completed_at?`<p class="ops-card-meta">Completed by ${esc(names.get(item.completed_by)||'Team member')} on ${esc(when(item.completed_at))}${item.recovery_reason?' · Recovery: '+esc(item.recovery_reason):''}</p>`:''}</div><div class="ops-card-actions">${mine&&['open','missed'].includes(item.status)?`<button type="button" onclick="completeActivity('${item.id}')">${item.status==='missed'?'Record late recovery':'Complete'}</button>`:''}${item.kind!=='check'&&item.owner_id===getUser()?.id&&item.status==='open'&&!pending?`<button type="button" class="secondary" onclick="requestActivityExtension('${item.id}')">Request extension</button>`:''}${mayApprove?`<button type="button" onclick="decideActivityExtension('${pending.id}',true)">Approve</button><button type="button" class="secondary" onclick="decideActivityExtension('${pending.id}',false)">Decline</button>`:''}</div></article>`
  }
  function renderDaily(){if(!activity)return;const me=getUser()?.id,from=$('opsDate').value||today(),customer=$('opsCustomerFilter').value,owner=$('opsOwnerFilter').value,state=$('opsStatusFilter').value;
    let rows=activity.items.filter(x=>mode==='team'?true:[x.owner_id,x.backup_owner_id].includes(me)||x.approver_id===me&&activity.extensions.some(e=>e.item_id===x.id));
    if(mode==='team'){rows=rows.filter(x=>(!customer||x.customer_id===customer)&&(!owner||x.owner_id===owner)&&(!state||status(x).toLowerCase().startsWith(state)))}
    const counts={open:0,completed:0,missed:0,overdue:0,blocked:0,coverage:0};for(const x of rows){const s=status(x).toLowerCase().split(' ')[0];if(counts[s]!=null)counts[s]++}
    $('dailySummary').innerHTML=`<div class="ops-stat"><strong>${rows.length}</strong><span>Activities</span></div><div class="ops-stat"><strong>${counts.open+counts.overdue+counts.blocked+counts.coverage}</strong><span>Outstanding</span></div><div class="ops-stat"><strong>${counts.completed}</strong><span>Completed</span></div><div class="ops-stat alert"><strong>${counts.missed}</strong><span>Missed</span></div>`;
    $('dailyList').innerHTML=rows.length?rows.map(itemCard).join(''):'<div class="panel empty">No activities match this view.</div>';
    select('quickPrerequisite',activity.items.filter(x=>x.kind!=='check'&&x.status!=='cancelled').map(x=>({id:x.id,name:x.title+' · '+(names.get(x.owner_id)||'Owner')})),'Select prerequisite');
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
    for(const row of $('quickCheckRows').children){row.querySelector('.quick-check-time').required=repeat;row.querySelector('.quick-check-owner').required=repeat}
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
    const options=basics.people.filter(p=>p.inTeam).map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
    const row=document.createElement('div');row.className='ops-quick-check';
    row.innerHTML=`<div class="ops-check-heading"><strong class="quick-check-title"></strong><button type="button" class="secondary quick-check-remove" aria-label="Remove check">Remove</button></div><div class="ops-quick-check-main"><label>Time · IST<input class="quick-check-time" type="time"></label><label>Owner<select class="quick-check-owner"><option value="">Choose owner</option>${options}</select></label></div><p class="quick-check-window hint"></p><details><summary>Window &amp; backup</summary><div class="ops-quick-check-main"><label>Window · minutes<input class="quick-check-duration" type="number" min="5" max="1439" value="60"></label><label>Backup<select class="quick-check-backup"><option value="">No backup</option>${options}</select></label></div><label>Check label · optional<input class="quick-check-label" maxlength="120" placeholder="e.g. Booking review"></label></details>`;
    row.querySelector('.quick-check-owner').value=basics.people.some(p=>p.id===getUser().id&&p.inTeam)?getUser().id:'';
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
        await call('one_create',{...common,kind,ownerIds,dueMode:choice,dueAt,prerequisiteId:kind==='dependency'?$('quickPrerequisite').value:null});
        closeQuickAdd();toast(ownerIds.length>1?`${ownerIds.length} tasks added`:'Task added');
        if(mode==='mine'&&!ownerIds.includes(getUser().id))await openDaily('team');else await refreshDaily();
      }else{
        const frequency=$('quickFrequency').value,days=frequency==='weekdays'?[1,2,3,4,5]:frequency==='selected'?[...$('quickDaysWrap').querySelectorAll('input:checked')].map(x=>Number(x.value)):[];
        if(frequency==='selected'&&!days.length)throw Error('Select at least one repeat day');
        if($('quickEnd').value==='date'&&!$('quickEndDate').value){$('quickMore').open=true;throw Error('Choose an end date')}
        const checks=[...$('quickCheckRows').children].map((row,index)=>{const start=row.querySelector('.quick-check-time').value,minutes=Number(row.querySelector('.quick-check-duration').value);if(!start||!Number.isInteger(minutes)||minutes<5||minutes>1439)throw Error('Choose a valid time and window for each check');const owner=row.querySelector('.quick-check-owner').value,backup=row.querySelector('.quick-check-backup').value;if(!owner||backup===owner)throw Error('Choose an owner and a different backup');return{label:row.querySelector('.quick-check-label').value.trim()||`Check ${index+1}`,start,end:quickWindow(start,minutes).end,primaryOwnerId:owner,backupOwnerId:backup||null}});
        if(!checks.length)throw Error('Add at least one check');
        await call('series_create',{...common,scheduleKind:frequency==='daily'?'daily':'weekdays',weekdays:days,startsOn:$('quickStart').value,endsOn:$('quickEnd').value==='date'?$('quickEndDate').value:null,reminderMinutes:Number($('quickReminder').value),checks});
        closeQuickAdd();toast('Recurring schedule added');await openDaily('series');
      }
    }catch(e){$('quickError').textContent=e.message}finally{button.disabled=false}
  }
  async function loadSeries(){try{series=await call('series_list');renderSeries()}catch(e){$('seriesList').textContent=e.message}}
  function renderSeries(){const customers=new Map(basics.customers.map(c=>[c.id,c.name]));$('seriesList').innerHTML=series.series.length?series.series.map(s=>`<article class="panel ops-series"><div><span class="ops-kind">${esc(s.schedule_kind)}</span><h3>${esc(s.title)}</h3><p class="ops-card-meta">${esc(customers.get(s.customer_id)||'Customer')} · ${esc(s.starts_on)} to ${esc(s.ends_on||'until ended')} · ${s.active?'Active':'Ended'}</p></div><div>${series.checks.filter(c=>c.series_id===s.id).map(c=>`<div class="ops-series-check"><strong>${esc(c.label)}</strong> ${esc(c.window_start.slice(0,5))}–${esc(c.window_end.slice(0,5))} IST · ${esc(names.get(c.primary_owner_id)||'Owner')}${c.backup_owner_id?' · Backup '+esc(names.get(c.backup_owner_id)):''}${canManage()&&s.active?` <button type="button" class="secondary" onclick="reassignCheck('${c.id}')">Change owner</button>`:''}</div>`).join('')}</div><button type="button" class="secondary" onclick="previewSeries('${s.id}')">Preview next 14 days</button>${canManage()&&s.active?`<button type="button" class="secondary" onclick="endActivitySeries('${s.id}')">End series</button>`:''}<div id="seriesPreview_${s.id}" class="ops-series-preview" hidden></div></article>`).join(''):'<div class="panel empty">No recurring schedules yet.</div>'}
  async function previewSeries(seriesId){const node=$('seriesPreview_'+seriesId);if(!node.hidden){node.hidden=true;return}node.hidden=false;node.textContent='Loading upcoming checks…';try{const rows=await call('series_preview',{seriesId});node.innerHTML=rows.length?rows.map(r=>`<p><strong>${esc(r.date)}</strong> · ${esc(r.title)} · ${esc(names.get(r.owner_id)||'Unassigned')} · ${esc(when(r.window_start_at))}–${esc(when(r.window_end_at))}</p>`).join(''):'No checks in the next 14 days.'}catch(e){node.textContent=e.message}}
  function dialog(title,help,fields,submit){$('opsDialogTitle').textContent=title;$('opsDialogHelp').textContent=help;$('opsDialogFields').innerHTML=fields;$('opsDialogError').textContent='';$('opsDialogForm').onsubmit=async event=>{event.preventDefault();$('opsDialogSubmit').disabled=true;try{await submit();$('opsDialog').close();await refreshDaily();if(mode==='series')await loadSeries()}catch(e){$('opsDialogError').textContent=e.message}finally{$('opsDialogSubmit').disabled=false}};$('opsDialog').showModal()}
  function completeActivity(itemId){const item=activity.items.find(x=>x.id===itemId);if(!item)return;const late=item.status==='missed'||item.kind==='check'&&Date.parse(item.due_at)<Date.now();const fields=`${(item.steps||[]).map((step,i)=>`<label class="ops-check"><input type="checkbox" data-step="${i}"> ${esc(step)}</label>`).join('')}<div class="field"><label for="opsEvidence">Evidence ${item.evidence_required?'(required)':'(optional)'}</label><textarea id="opsEvidence" ${item.evidence_required?'required':''}></textarea></div>${late?'<div class="field"><label for="opsRecovery">Late recovery reason</label><textarea id="opsRecovery" required></textarea></div>':''}`;dialog(late?'Record late recovery':'Complete activity',item.title,fields,async()=>{await call('item_complete',{itemId,completedSteps:[...$('opsDialogFields').querySelectorAll('[data-step]:checked')].map(x=>Number(x.dataset.step)),evidence:$('opsEvidence').value,recoveryReason:$('opsRecovery')?.value||''});toast('Completion recorded')})}
  function requestActivityExtension(itemId){const item=activity.items.find(x=>x.id===itemId);dialog('Request extension',`Current deadline: ${when(item.due_at)}`,`<div class="field"><label for="opsProposed">Proposed due date</label><input id="opsProposed" type="datetime-local" required></div><div class="field"><label for="opsReason">Reason</label><textarea id="opsReason" required></textarea></div>`,async()=>{await call('extension_request',{itemId,proposedDueAt:new Date($('opsProposed').value).toISOString(),reason:$('opsReason').value});toast('Extension sent for approval')})}
  async function decideActivityExtension(extensionId,approved){try{await call('extension_decide',{extensionId,approved});toast(approved?'Extension approved':'Extension declined');await refreshDaily()}catch(e){toast(e.message)}}
  function reassignCheck(checkId){const check=series.checks.find(c=>c.id===checkId),people=basics.people.filter(p=>p.inTeam),options=people.map(p=>`<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');dialog('Change check owner','Choose this date only or this check and all future dates.',`<div class="ops-form-grid"><div class="field"><label for="opsChangeDate">Effective date</label><input id="opsChangeDate" type="date" value="${today()}" required></div><div class="field"><label for="opsChangeScope">Apply to</label><select id="opsChangeScope"><option value="date">This check only</option><option value="future">This check and future dates</option></select></div><div class="field"><label for="opsChangePrimary">Primary owner</label><select id="opsChangePrimary" required>${options}</select></div><div class="field"><label for="opsChangeBackup">Backup owner</label><select id="opsChangeBackup"><option value="">No backup</option>${options}</select></div></div>`,async()=>{await call('owner_change',{checkId,date:$('opsChangeDate').value,scope:$('opsChangeScope').value,primaryOwnerId:$('opsChangePrimary').value,backupOwnerId:$('opsChangeBackup').value||null});toast('Owner change saved')});$('opsChangePrimary').value=check.primary_owner_id;$('opsChangeBackup').value=check.backup_owner_id||''}
  async function endActivitySeries(seriesId){if(!confirm('End this recurring series? Past check records will remain.'))return;try{await call('series_end',{seriesId,endsOn:today()});toast('Series ended');await loadSeries()}catch(e){toast(e.message)}}
  const rosterPresets={day:['09:00','18:00'],early:['08:00','17:00'],late:['11:00','20:00']};
  let rosterEditing=null,rosterCoverage=null;
  const shortTime=value=>String(value||'').slice(0,5);
  function rosterClock(value){const [hour,minute]=shortTime(value).split(':').map(Number);return (hour%12||12)+(minute?':'+String(minute).padStart(2,'0'):'')+(hour<12?' AM':' PM')}
  function rosterDate(value){return new Date(value+'T00:00:00Z').toLocaleDateString('en-IN',{day:'numeric',month:'short',timeZone:'UTC'})}
  function shiftLabel(cell,date){if(!cell)return'Add shift';if(cell.kind==='off')return'Off';if(cell.kind==='leave')return'Leave';const start=shortTime(cell.start),end=shortTime(cell.end),overnight=end<=start;return `${rosterClock(start)}–${rosterClock(end)}${overnight?' · next day '+rosterDate(addDays(date,1)):''}`}
  function rosterCell(userId,date,publishedOnly=false){
    const pub=roster.publishedRows.find(r=>r.user_id===userId&&r.work_date===date);
    if(!publishedOnly&&roster.canManage){const draft=roster.draftRows.find(r=>r.user_id===userId&&r.work_date===date);if(draft)return{kind:draft.kind,start:draft.start_time,end:draft.end_time};if(roster.week.draft_revision>0&&roster.week.draft_mode==='replace')return{kind:'off',start:null,end:null}}
    return pub?{kind:pub.published_kind,start:pub.published_start,end:pub.published_end}:null;
  }
  function rosterChanges(){if(!roster?.canManage||!roster.week.draft_revision)return[];const week=$('rosterWeek').value,changes=[];for(const person of roster.people)for(let day=0;day<7;day++){const date=addDays(week,day),now=rosterCell(person.id,date),before=rosterCell(person.id,date,true);if((now?.kind||'off')!==(before?.kind||'off')||shortTime(now?.start)!==shortTime(before?.start)||shortTime(now?.end)!==shortTime(before?.end))changes.push({person,date,before,now})}return changes}
  async function openRoster(){if(!allowed('roster'))return;activate('rosterView');if(!$('rosterWeek').value)$('rosterWeek').value=monday(today());try{await ensureBasics();await loadRoster()}catch(e){$('rosterError').textContent=e.message}}
  async function loadRoster(){if(!allowed('roster'))return;const week=monday($('rosterWeek').value||today()),teamId=$('rosterTeam').value||roster?.teamId||null;$('rosterWeek').value=week;$('rosterGrid').textContent='Loading roster…';$('rosterError').textContent='';try{
    roster=await call('roster_week',{week,teamId});const teamSelect=$('rosterTeam');teamSelect.innerHTML=roster.teams.map(team=>`<option value="${esc(team.id)}">${esc(team.name)}</option>`).join('');teamSelect.value=roster.teamId;$('rosterTeamWrap').hidden=roster.teams.length<=1;
    $('copyRosterButton').hidden=!roster.canManage;$('publishRosterButton').hidden=!roster.canManage;$('publishRosterButton').disabled=!roster.week.draft_revision;$('rosterShowAllWrap').hidden=!roster.canManage;$('rosterHistoryWrap').hidden=!roster.canManage;
    renderRoster();if(roster.canManage)await previewRoster();else $('rosterCoverage').innerHTML='';if(roster.canManage&&$('rosterHistoryWrap').open)await loadRosterHistory();
  }catch(e){$('rosterGrid').textContent=e.message;$('rosterError').textContent=e.message}}
  function rosterThisWeek(){$('rosterWeek').value=monday(today());loadRoster()}
  function rosterStepWeek(direction){$('rosterWeek').value=addDays(monday($('rosterWeek').value||today()),direction*7);loadRoster()}
  function renderRoster(){if(!roster)return;const week=$('rosterWeek').value,end=addDays(week,6),manager=roster.canManage,all=roster.people;
    const leads=all.filter(p=>/team lead/i.test(p.job_role||''));const shown=manager&&!$('rosterShowAll').checked&&leads.length?leads:all;
    const people=[...shown].sort((a,b)=>Number(/team lead/i.test(b.job_role||''))-Number(/team lead/i.test(a.job_role||''))||a.display_name.localeCompare(b.display_name));
    $('rosterWeekLabel').textContent=`${rosterDate(week)}–${rosterDate(end)} ${end.slice(0,4)}`;
    const version=Number(roster.week.active_version||0),revision=Number(roster.week.draft_revision||0);
    $('rosterState').textContent=revision?version?`Draft from published v${version}`:'Draft':version?`Published v${version}`:'No roster yet';$('rosterState').classList.toggle('published',version>0&&!revision);
    $('rosterSheetHelp').textContent=manager?'Select a shift to edit the draft. Published shifts stay active until you publish.':'Published shifts for your week.';
    const head=Array.from({length:7},(_,i)=>{const date=addDays(week,i);return `<th class="${i>4?'weekend':''}">${esc(new Date(date+'T00:00:00Z').toLocaleDateString('en-IN',{weekday:'short',timeZone:'UTC'}))}<span class="ops-roster-day">${esc(rosterDate(date))}</span></th>`}).join('');
    $('rosterGrid').innerHTML=`<table class="ops-roster-table"><thead><tr><th>Team member</th>${head}</tr></thead><tbody>${people.map(p=>{const initials=p.display_name.split(' ').slice(0,2).map(word=>word[0]).join('');return `<tr><th scope="row"><span class="ops-roster-person"><span class="ops-roster-avatar">${esc(initials)}</span><span>${esc(p.display_name)}<small>${esc(p.job_role||'')}</small></span></span></th>${Array.from({length:7},(_,i)=>{const date=addDays(week,i),cell=rosterCell(p.id,date),label=shiftLabel(cell,date),tone=!cell?'empty':cell.kind==='work'&&shortTime(cell.start)==='11:00'?'late':cell.kind;return `<td class="${i>4?'weekend':''}">${manager?`<button type="button" class="ops-roster-shift ${esc(tone)}" onclick="openRosterEditor('${p.id}','${date}')" aria-label="${esc(p.display_name)}, ${date}, ${esc(label)}">${esc(label)}</button>`:`<span class="ops-roster-shift ${esc(tone)}" aria-label="${esc(p.display_name)}, ${date}, ${esc(label)}">${esc(label)}</span>`}</td>`}).join('')}</tr>`}).join('')}</tbody></table>`;
    if(!people.length)$('rosterGrid').innerHTML='<div class="panel empty">No team members in this roster team.</div>';
    const shiftCount=all.reduce((count,p)=>count+Array.from({length:7},(_,i)=>rosterCell(p.id,addDays(week,i))?.kind==='work'?1:0).reduce((a,b)=>a+b,0),0),changeCount=rosterChanges().length;
    $('rosterFooter').innerHTML=`<span>${shiftCount} working shift${shiftCount===1?'':'s'}${manager&&shown.length<all.length?` · ${all.length-shown.length} other team members hidden`:''}</span><span>${revision?`Draft revision ${revision} saved · ${changeCount} change${changeCount===1?'':'s'} pending`:version?`Published ${esc(when(roster.week.published_at))}`:'Add shifts to start a draft'}</span>`;
  }
  function openRosterEditor(userId,date){if(!roster?.canManage)return;const person=roster.people.find(p=>p.id===userId);if(!person)return toast('This person is outside the selected team');if(!$('rosterShowAll').checked&&!/team lead/i.test(person.job_role||'')){$('rosterShowAll').checked=true;renderRoster()}
    rosterEditing={userId,date};const cell=rosterCell(userId,date),start=shortTime(cell?.start)||'09:00',end=shortTime(cell?.end)||'18:00';let preset=cell?.kind==='off'?'off':cell?.kind==='leave'?'leave':Object.keys(rosterPresets).find(key=>rosterPresets[key][0]===start&&rosterPresets[key][1]===end)||'custom';if(!cell)preset='day';
    $('rosterEditorPerson').textContent=person.display_name+' · '+new Date(date+'T00:00:00Z').toLocaleDateString('en-IN',{weekday:'long',day:'numeric',month:'short',timeZone:'UTC'});$('rosterEditStart').value=start;$('rosterEditEnd').value=end;$('rosterEditorForm').querySelector(`[name="rosterPreset"][value="${preset}"]`).checked=true;
    $('rosterEditDays').innerHTML=Array.from({length:7},(_,i)=>{const day=addDays($('rosterWeek').value,i);return `<label><input type="checkbox" value="${day}" ${day===date?'checked':''}> ${esc(new Date(day+'T00:00:00Z').toLocaleDateString('en-IN',{weekday:'short',timeZone:'UTC'}))}</label>`}).join('');$('rosterEditorError').textContent='';toggleRosterPreset();$('rosterEditor').showModal()}
  function toggleRosterPreset(){const custom=$('rosterEditorForm').querySelector('[name="rosterPreset"]:checked')?.value==='custom';$('rosterCustomTimes').hidden=!custom;$('rosterEditStart').required=custom;$('rosterEditEnd').required=custom}
  async function saveRosterEditor(event){event.preventDefault();if(!rosterEditing||!roster)return;const preset=$('rosterEditorForm').querySelector('[name="rosterPreset"]:checked')?.value,dates=[...$('rosterEditDays').querySelectorAll('input:checked')].map(x=>x.value),hours=preset==='custom'?[$('rosterEditStart').value,$('rosterEditEnd').value]:rosterPresets[preset],kind=['off','leave'].includes(preset)?preset:'work';
    if(!dates.length){$('rosterEditorError').textContent='Select at least one day';return}if(kind==='work'&&(!hours?.[0]||!hours?.[1]||hours[0]===hours[1])){$('rosterEditorError').textContent='Choose different start and end times';return}
    $('rosterApplyButton').disabled=true;try{await call('roster_save',{teamId:roster.teamId,week:$('rosterWeek').value,userId:rosterEditing.userId,dates,kind,start:kind==='work'?hours[0]:null,end:kind==='work'?hours[1]:null,expectedVersion:roster.week.active_version,expectedRevision:roster.week.draft_revision});$('rosterEditor').close();await loadRoster();toast('Draft updated')}catch(e){$('rosterEditorError').textContent=e.message;if(/roster changed|newer roster/i.test(e.message)){await loadRoster();$('rosterEditor').close()}}finally{$('rosterApplyButton').disabled=false}}
  async function copyRoster(){if(!roster?.canManage)return;const replace=roster.week.draft_revision>0;if(replace&&!confirm('Replace the existing draft shifts with the previous published week?'))return;$('rosterError').textContent='';try{await call('roster_copy',{teamId:roster.teamId,week:$('rosterWeek').value,expectedVersion:roster.week.active_version,expectedRevision:roster.week.draft_revision,replace});await loadRoster();toast('Previous week copied to draft')}catch(e){$('rosterError').textContent=e.message;if(/roster changed|newer roster/i.test(e.message))await loadRoster()}}
  function reviewRosterGap(userId,date){if(userId&&roster?.people.some(p=>p.id===userId))openRosterEditor(userId,date);else if(allowed('daily_activity'))openDaily('series');else toast('Review this check owner in Daily Activity')}
  async function previewRoster(){if(!roster?.canManage)return;try{rosterCoverage=await call('roster_preview',{teamId:roster.teamId,week:$('rosterWeek').value});const data=rosterCoverage,changes=rosterChanges();$('rosterCoverage').innerHTML=`<section class="ops-roster-coverage"><div class="ops-roster-coverage-head"><h3>${data.gaps.length?`Coverage gaps · ${data.gaps.length}`:'Activity coverage'}</h3><span>${data.checks} scheduled checks · ${changes.length} draft changes</span></div>${data.gaps.map(g=>`<div class="ops-roster-alert"><span><strong>${esc(rosterDate(g.date))} · ${esc(g.customer||'Customer')} · ${esc(g.check)}</strong><br>${esc(g.reason)}</span>${g.userId?`<button type="button" class="secondary" onclick="reviewRosterGap('${g.userId}','${g.date}')">Review shift</button>`:''}</div>`).join('')}${data.early.map(g=>`<div class="ops-roster-early"><span><strong>${esc(rosterDate(g.date))} · ${esc(g.customer||'Customer')} · ${esc(g.check)}</strong><br>${esc(g.reason)} at ${esc(when(g.deadline))}</span>${g.userId?`<button type="button" class="secondary" onclick="reviewRosterGap('${g.userId}','${g.date}')">Review shift</button>`:''}</div>`).join('')}${!data.gaps.length&&!data.early.length?'<p class="ops-roster-ok">All recurring checks have an on-shift owner.</p>':''}</section>`;return data}catch(e){$('rosterError').textContent=e.message;return null}}
  async function publishRoster(){if(!roster?.canManage||!roster.week.draft_revision)return;const preview=await previewRoster();if(!preview)return;if(preview.gaps.length){$('rosterCoverage').scrollIntoView({behavior:'smooth',block:'start'});toast('Resolve coverage gaps before publishing');return}const changes=rosterChanges();if(!confirm(`Publish ${rosterDate($('rosterWeek').value)} week with ${changes.length} shift change${changes.length===1?'':'s'}?`))return;try{const result=await call('roster_publish',{teamId:roster.teamId,week:$('rosterWeek').value,expectedVersion:roster.week.active_version,expectedRevision:roster.week.draft_revision});toast(`Roster published · version ${result.version}`);await loadRoster();await loadRosterHistory()}catch(e){$('rosterError').textContent=e.message;if(/roster changed|newer roster|coverage gap/i.test(e.message))await loadRoster()}}
  async function loadRosterHistory(){if(!roster?.canManage)return;$('rosterHistory').textContent='Loading history…';try{const rows=await call('roster_history',{teamId:roster.teamId,week:$('rosterWeek').value});$('rosterHistory').innerHTML=rows.length?rows.map(pub=>`<article class="ops-roster-history-item"><strong>Version ${pub.version}</strong> · ${esc(when(pub.published_at))} · ${esc(names.get(pub.published_by)||'Former publisher')}<p>${pub.changes.length} shift change${pub.changes.length===1?'':'s'}</p>${pub.changes.slice(0,12).map(c=>`<div>${esc(names.get(c.user_id)||'Team member')} · ${esc(rosterDate(c.work_date))}: ${esc(shiftLabel({kind:c.previous_kind,start:c.previous_start,end:c.previous_end},c.work_date))} → ${esc(shiftLabel({kind:c.kind,start:c.start_time,end:c.end_time},c.work_date))}</div>`).join('')}${pub.changes.length>12?`<small>and ${pub.changes.length-12} more changes</small>`:''}</article>`).join(''):'No published versions yet.'}catch(e){$('rosterHistory').textContent=e.message}}
  async function openInbox(){activate('inboxView');await refreshInbox()}
  async function refreshInbox(){if(!getUser())return;try{inbox=await call('inbox');lastInboxCheck=Date.now();const unread=inbox.filter(x=>!x.read_at).length;$('inboxCount').textContent=unread||'';$('inboxButton').setAttribute('aria-label',unread?`Inbox, ${unread} unread messages`:'Inbox');$('inboxList').innerHTML=inbox.length?inbox.map(m=>`<article class="panel ops-inbox-item ${m.read_at?'':'unread'}"><div><strong>${esc(m.title)}</strong><p>${esc(m.body)}</p><small>${esc(when(m.created_at))}</small></div><button type="button" class="secondary" onclick="openInboxMessage('${m.id}')">${m.read_at?'Open':'Mark read & open'}</button></article>`).join(''):'<div class="panel empty">Your inbox is empty.</div>'}catch(e){$('inboxList').textContent=e.message}}
  async function openInboxMessage(id){const message=inbox.find(x=>x.id===id);if(!message)return;try{await call('inbox_read',{id});if(message.target==='roster')await openRoster();else await openDaily('mine')}catch(e){toast(e.message)}}
  async function enableWorklogPush(){try{if(!('serviceWorker'in navigator)||!('PushManager'in window))throw Error('Push is unavailable in this browser');const permission=await Notification.requestPermission();if(permission!=='granted')throw Error('Push permission was not granted');const {publicKey}=await call('push_key');if(!publicKey)throw Error('Web push is not configured yet');const registration=await navigator.serviceWorker.register('./worklog-sw.js');const raw=atob(publicKey.replace(/-/g,'+').replace(/_/g,'/')),key=Uint8Array.from(raw,c=>c.charCodeAt(0));const subscription=await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});await call('push_subscribe',{subscription:subscription.toJSON()});toast('Push notifications enabled')}catch(e){toast(e.message)}}
  document.addEventListener('visibilitychange',()=>{if(!document.hidden&&getUser()&&Date.now()-lastInboxCheck>5*60000)refreshInbox()});
  navigator.serviceWorker?.addEventListener('message',event=>{if(event.data?.type==='worklog-notification'){if(event.data.target==='roster')openRoster();else openDaily('mine')}});
  const api={onBootstrap(){if(getUser()){if(!$('opsDate').value)$('opsDate').value=today();if(!$('rosterWeek').value)$('rosterWeek').value=monday(today());refreshInbox();if(location.hash==='#roster'&&allowed('roster'))queueMicrotask(openRoster);else if(location.hash==='#daily_activity'&&allowed('daily_activity'))queueMicrotask(()=>openDaily('mine'))}},openDaily,openRoster,openInbox,refreshDaily,renderDaily,openQuickAdd,closeQuickAdd,toggleQuickMode,toggleQuickType,updateQuickDue,toggleQuickFrequency,updateQuickRepeatSummary,addQuickCheck,submitQuickAdd,completeActivity,requestActivityExtension,decideActivityExtension,reassignCheck,endActivitySeries,previewSeries,loadRoster,renderRoster,rosterThisWeek,rosterStepWeek,openRosterEditor,toggleRosterPreset,saveRosterEditor,copyRoster,reviewRosterGap,previewRoster,publishRoster,loadRosterHistory,refreshInbox,openInboxMessage,enableWorklogPush};
  Object.assign(window,api);window.WorkLogOps=api;return api;
}
