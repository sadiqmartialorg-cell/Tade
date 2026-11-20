export const addDays = (date: string, n: number) => new Date(Date.parse(date+'T00:00:00Z')+n*86400000).toISOString().slice(0,10)
export const istDate = (date=new Date()) => new Date(date.getTime()+330*60000).toISOString().slice(0,10)
export const istStamp = (date: string, time: string) => new Date(Date.parse(date+'T'+time.slice(0,5)+':00Z')-330*60000).toISOString()
export const weekday = (date: string) => new Date(date+'T00:00:00Z').getUTCDay()
export const monday = (date: string) => addDays(date,-((weekday(date)+6)%7))
export const startEnd = (date: string, start: string, end: string) => {
  const first=istStamp(date,start), last=istStamp(end<=start?addDays(date,1):date,end)
  return {first,last}
}
export function nextPublishedShiftEnd(shifts:any[],ownerId:string,now=Date.now()) {
  const ends=shifts.filter(s=>s.user_id===ownerId&&s.published_kind==='work'&&s.published_start&&s.published_end)
    .map(s=>startEnd(s.work_date,s.published_start,s.published_end).last)
    .filter(end=>Date.parse(end)>now).sort()
  return ends[0]||null
}
export function matches(series:any,date:string) {
  if(date<series.starts_on||series.ends_on&&date>series.ends_on||!series.active)return false
  if(series.schedule_kind==='daily')return true
  if(series.schedule_kind==='weekdays')return (series.weekdays||[]).includes(weekday(date))
  if(series.schedule_kind==='weekly')return weekday(date)===weekday(series.starts_on)
  return Number(date.slice(8))===Number(series.monthly_day||series.starts_on.slice(8))
}
export function ownerFor(check:any,date:string,changes:any[]) {
  const future=changes.filter(c=>c.check_id===check.id&&c.primary_owner_id&&c.scope==='future'&&c.effective_on<=date).sort((a,b)=>b.effective_on.localeCompare(a.effective_on)||b.created_at.localeCompare(a.created_at))[0]
  const onlyDate=changes.filter(c=>c.check_id===check.id&&c.primary_owner_id&&c.scope==='date'&&c.effective_on===date).sort((a,b)=>b.created_at.localeCompare(a.created_at))[0]
  return onlyDate||future||check
}
export function buildCheckRows(series:any[],checks:any[],changes:any[],from:string,to:string) {
  const bySeries=new Map<string,any[]>()
  for(const check of checks)bySeries.set(check.series_id,[...(bySeries.get(check.series_id)||[]),check])
  const rows=[]
  for(const s of series)for(let date=from;date<=to;date=addDays(date,1))if(matches(s,date))for(const check of bySeries.get(s.id)||[]){
    const owner=ownerFor(check,date,changes),window=startEnd(date,check.window_start,check.window_end)
    rows.push({kind:'check',series_id:s.id,check_id:check.id,scheduled_date:date,customer_id:s.customer_id,title:s.title+' · '+check.label,instructions:s.instructions,steps:s.steps,evidence_required:s.evidence_required,creator_id:s.created_by,owner_id:owner.primary_owner_id,backup_owner_id:owner.backup_owner_id,window_start_at:window.first,window_end_at:window.last,due_at:window.last,original_due_at:window.last})
  }
  return rows
}
export function coverage(item:any,shifts:any[],draft=false) {
  const a=Date.parse(item.window_start_at),b=Date.parse(item.window_end_at),seen=[] as {id:string,start:number,end:number}[]
  for(const id of [item.owner_id,item.backup_owner_id].filter(Boolean))for(const shift of shifts.filter((s:any)=>s.user_id===id)){
    const kind=draft?shift.draft_kind:shift.published_kind,start=draft?shift.draft_start:shift.published_start,end=draft?shift.draft_end:shift.published_end
    if(kind!=='work'||!start||!end)continue
    const span=startEnd(shift.work_date,start,end),left=Math.max(a,Date.parse(span.first)),right=Math.min(b,Date.parse(span.last))
    if(left<right)seen.push({id,start:left,end:right})
  }
  return {covered:seen.length>0,primary:seen.filter(x=>x.id===item.owner_id),backup:seen.filter(x=>x.id===item.backup_owner_id),final:seen.length?Math.max(...seen.map(x=>x.end)):b}
}
