export function setupRosterReports({call,getUser,today,addDays,rosterDate,shiftLabel,when,esc,csvCell,refreshRoster,refreshInbox}) {
  const $=id=>document.getElementById(id);
  const dateFormat=new Intl.DateTimeFormat('en-IN',{weekday:'short',day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
  const labelDate=date=>dateFormat.format(new Date(`${date}T00:00:00Z`));
  const statusLabels={work:'Scheduled shift',off:'Weekly off',leave:'Leave',unpublished:'No published entry'};
  let summary=null,summaryVersion=0;

  function periodFields(){
    const period=$('summaryPeriod').value;
    $('summaryMonthField').hidden=period!=='month';
    $('summaryDateField').hidden=period!=='day';
    $('summaryDatesField').hidden=period!=='dates';
  }
  function clearSummary(){
    summaryVersion++;
    summary=null;
    $('downloadRosterSummary').disabled=true;
    $('rosterSummaryResults').replaceChildren();
    $('rosterSummaryStatus').textContent='';
  }
  function summaryRange(){
    switch($('summaryPeriod').value){
      case 'day': {
        const date=$('summaryDate').value;
        if(!date)throw Error('Choose a date.');
        return {from:date,to:date};
      }
      case 'dates': {
        const dates=$('summaryDates').value.trim().split(/[\s,]+/).filter(Boolean);
        if(!dates.length||dates.length>31||dates.some(date=>!/^\d{4}-\d{2}-\d{2}$/.test(date)))
          throw Error('Enter up to 31 dates in YYYY-MM-DD format.');
        return {dates};
      }
      default: {
        const month=$('summaryMonth').value;
        if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))throw Error('Enter a month in YYYY-MM format.');
        const [year,number]=month.split('-').map(Number);
        const next=number===12?`${year+1}-01`:`${year}-${String(number+1).padStart(2,'0')}`;
        return {from:`${month}-01`,to:addDays(`${next}-01`,-1)};
      }
    }
  }
  const statusOf=row=>statusLabels[row.shift?.published_kind]||statusLabels.unpublished;
  const shiftTimes=row=>row.shift?.published_kind==='work'?shiftLabel({kind:'work',start:row.shift.published_start,end:row.shift.published_end},row.date):'';
  function renderSummary(data){
    const categories=[['Weekly off',row=>row.shift?.published_kind==='off'],['Leave',row=>row.shift?.published_kind==='leave'],['Extra working days',row=>Boolean(row.extra)]];
    const totals=categories.map(([label,filter])=>{
      const dates=data.rows.filter(filter).map(row=>rosterDate(row.date));
      return `<div class="roster-report-stat"><strong>${dates.length} ${label}</strong><small>${esc(dates.join(', ')||'—')}</small></div>`;
    }).join('');
    const rows=data.rows.map(row=>`<tr><th scope="row">${esc(labelDate(row.date))}</th><td>${esc(statusOf(row))}</td><td>${esc(shiftTimes(row)||'—')}</td><td>${row.extra?`<strong>Approved</strong>${row.extra.reason?`<small>${esc(row.extra.reason)}</small>`:''}`:'—'}</td></tr>`).join('');
    $('rosterSummaryResults').innerHTML=`<div class="roster-report-stats">${totals}</div><div class="scroll roster-report-table" role="region" aria-label="Roster dates" tabindex="0"><table class="activity"><thead><tr><th>Date</th><th>Published roster</th><th>Hours (IST)</th><th>Extra working day</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }
  async function loadSummary(event){
    event?.preventDefault();
    const button=$('loadRosterSummary');
    clearSummary();
    const version=summaryVersion;
    try{
      const range=summaryRange();
      button.disabled=true;
      $('rosterSummaryStatus').textContent='Loading roster…';
      const data=await call('roster_summary',{...range,personId:$('summaryPerson').value||getUser()?.id});
      if(version!==summaryVersion)return;
      summary=data;
      $('summaryPerson').innerHTML=data.people.map(person=>`<option value="${esc(person.id)}">${esc(person.name)}</option>`).join('');
      $('summaryPerson').value=data.person.id;
      $('rosterSummaryStatus').textContent=`${data.person.name} · ${data.rows.length} ${data.rows.length===1?'date':'dates'}`;
      renderSummary(data);
      $('downloadRosterSummary').disabled=false;
    }catch(error){if(version===summaryVersion)$('rosterSummaryStatus').textContent=error.message;}
    finally{button.disabled=false;}
  }
  $('rosterSummaryButton').addEventListener('click',()=>{
    if(!$('summaryMonth').value)$('summaryMonth').value=today().slice(0,7);
    if(!$('summaryDate').value)$('summaryDate').value=today();
    periodFields();
    $('rosterSummaryDialog').showModal();
    loadSummary();
  });
  $('rosterSummaryForm').addEventListener('submit',loadSummary);
  $('rosterSummaryForm').addEventListener('input',()=>{periodFields();clearSummary();});
  $('downloadRosterSummary').addEventListener('click',()=>{
    if(!summary)return;
    const {person,rows}=summary;
    const data=[['Person','Date','Published roster','Shift start (IST)','Shift end (IST)','Ends next day','Extra working day','Extra day note'],...rows.map(row=>{
      const start=row.shift?.published_kind==='work'?row.shift.published_start:'',end=start?row.shift.published_end:'';
      return [person.name,row.date,statusOf(row),start,end,start&&end?(end<start?'Yes':'No'):'',row.extra?'Approved':'',row.extra?.reason];
    })];
    const url=URL.createObjectURL(new Blob(['\uFEFF',data.map(row=>row.map(csvCell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
    const link=document.createElement('a');
    link.href=url;link.download=`worklog-roster-${rows[0].date}.csv`;
    link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  });

  function requestRows(items,review){
    return items.map(row=>`<article class="roster-request-row"><div><strong>${esc(review?`${row.requester} · ${labelDate(row.work_date)}`:labelDate(row.work_date))}</strong><div class="hint">${esc(review?`Requested ${when(row.created_at)}`:row.status==='pending'&&!row.reviewer?'Pending · reviewer unavailable':`${row.status.charAt(0).toUpperCase()+row.status.slice(1)}${row.reviewer?' · '+row.reviewer:''}`)}</div>${row.reason?`<p>${esc(row.reason)}</p>`:''}</div>${review?`<div class="roster-request-buttons"><button type="button" data-request="${esc(row.id)}" data-decision="approved">Approve</button><button type="button" class="secondary" data-request="${esc(row.id)}" data-decision="declined">Decline</button></div>`:''}</article>`).join('');
  }
  async function loadExtraDays(message=''){
    $('extraDayStatus').textContent=message||'Loading requests…';
    try{
      const data=await call('roster_extra_list');
      $('extraDayForm').hidden=!data.canRequest;
      $('submitExtraDay').disabled=!data.manager;
      $('extraDayManager').textContent=data.manager?`Sent to ${data.manager} for approval.`:'Your reporting manager needs to be assigned in the User tree.';
      $('extraDayRequests').innerHTML=`${data.incoming.length?`<section><h3>Awaiting your approval</h3>${requestRows(data.incoming,true)}</section>`:''}${data.canRequest?`<section><h3>My recent requests</h3>${requestRows(data.own,false)||'<p class="hint">No requests yet.</p>'}</section>`:''}`;
      $('extraDayStatus').textContent=message||(!data.canRequest&&!data.incoming.length?'No requests awaiting your approval.':'');
    }catch(error){$('extraDayStatus').textContent=error.message;}
  }
  async function openExtraDays(){
    if(!$('extraDayDate').value)$('extraDayDate').value=today();
    if(!$('rosterExtraDialog').open)$('rosterExtraDialog').showModal();
    await loadExtraDays();
  }
  $('rosterExtraButton').addEventListener('click',openExtraDays);
  $('extraDayForm').addEventListener('submit',async event=>{
    event.preventDefault();
    const button=$('submitExtraDay');
    button.disabled=true;
    try{
      await call('roster_extra_request',{date:$('extraDayDate').value,reason:$('extraDayReason').value});
      $('extraDayReason').value='';
      await loadExtraDays('Request sent for approval.');
    }catch(error){$('extraDayStatus').textContent=error.message;button.disabled=false;}
  });
  $('extraDayRequests').addEventListener('click',async event=>{
    const button=event.target.closest('button[data-request]');
    if(!button)return;
    const buttons=button.parentElement.querySelectorAll('button');
    buttons.forEach(node=>node.disabled=true);
    const approved=button.dataset.decision==='approved';
    try{
      await call('roster_extra_decide',{requestId:button.dataset.request,approved});
      await loadExtraDays(approved?'Approved and recorded on the roster.':'Request declined.');
      if(approved)refreshRoster();
      refreshInbox();
    }catch(error){$('extraDayStatus').textContent=error.message;buttons.forEach(node=>node.disabled=false);}
  });
  return {openExtraDays};
}
