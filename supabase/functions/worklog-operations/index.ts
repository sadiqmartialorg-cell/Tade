import { createClient } from 'npm:@supabase/supabase-js@2.57.0'
import webPush from 'npm:web-push@3.6.7'
import {isBrowserPushEndpoint,scheduledIdentity,vapidKeys} from './security.ts'
import {addDays,istDate,istStamp,monday,startEnd,nextPublishedShiftEnd,ownerFor,buildCheckRows,coverage,staffingWeek} from './schedule.ts'
import {eligibleTaskOwners,type OneTimeKind} from './task-routing.ts'
import {canCarryCheck,handoverShifts,type Transfer} from './handover.ts'
import {editableRosterMembers,rosterTeam,shiftAt,shiftsAt,shiftSpans,shiftRecord,type WorkingShift} from './roster-routing.ts'

const CORS = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info', 'Access-Control-Allow-Methods':'GET,POST,OPTIONS' }
const reply = (body: unknown, status=200) => new Response(JSON.stringify(body), { status, headers:{ ...CORS, 'Content-Type':'application/json' } })
const projectUrl = Deno.env.get('SUPABASE_URL') ?? ''
const publishable = Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY') ?? ''
const admin = createClient(projectUrl, secret, { auth:{ persistSession:false, autoRefreshToken:false } })
const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s+'T00:00:00Z'))
const uuid = (v: unknown): v is string => typeof v==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
const result = async (query: PromiseLike<{data:any,error:any}>) => { const {data,error}=await query; if(error) throw error; return data }
async function collectRows(query:()=>any) {
  const rows:any[]=[]
  for(let start=0;;start+=500){
    const batch=await result(query().range(start,start+499))
    rows.push(...batch)
    if(batch.length<500)return rows
  }
}
type Person = { id:string; display_name:string; manager_id:string|null; job_role:string|null; active:boolean; tier?:number }
type Context = { actor:Person; people:Person[]; byId:Map<string,Person>; scope:Set<string>; tier:number; grants:Set<string> }

async function context(userId: string): Promise<Context> {
  const [people,roles,modules,activeModules]=await Promise.all([
    result(admin.from('adhoc_profiles').select('id,display_name,manager_id,job_role,active')),
    result(admin.from('Work_log_roles').select('name,rank').eq('is_access_role',false)),
    result(admin.from('worklog_user_modules').select('module_key').eq('user_id',userId)),
    result(admin.from('worklog_modules').select('key').eq('active',true)),
  ])
  const rank=new Map(roles.map((r:any)=>[r.name,r.rank]))
  for(const p of people) p.tier=rank.get(p.job_role)??9999
  const byId=new Map<string,Person>(people.map((p:Person)=>[p.id,p]))
  const actor=byId.get(userId)
  if(!actor?.active) throw Error('Account is inactive')
  const scope=new Set<string>([userId])
  let changed=true
  while(changed){changed=false;for(const p of people)if(p.active&&p.manager_id&&scope.has(p.manager_id)&&!scope.has(p.id)){scope.add(p.id);changed=true}}
  const active=new Set(activeModules.map((m:any)=>m.key))
  return {actor,people,byId,scope,tier:actor.tier??9999,grants:new Set(modules.map((m:any)=>m.module_key).filter((key:string)=>active.has(key)))}
}
function requireModule(ctx:Context,key:'daily_activity'|'roster') { if(!ctx.grants.has(key)) throw Error('This module is not enabled for your account') }
function requireManager(ctx:Context,key:'daily_activity'|'roster') { requireModule(ctx,key);if(ctx.tier>2)throw Error('Tier 1 or 2 access required') }
function requirePerson(ctx:Context,id:unknown) { if(!uuid(id)||!ctx.byId.get(id)?.active)throw Error('Choose an active user');return ctx.byId.get(id)! }
function assertInTeam(ctx:Context,id:string) { if(!ctx.scope.has(id))throw Error('Choose a person in your reporting team') }
function rosterTeamFor(ctx:Context,personId:string) {
  return rosterTeam(ctx.byId,personId)
}
function rosterTeamPeople(ctx:Context,teamId:string) {
  return ctx.people.filter(person=>person.active && rosterTeamFor(ctx,person.id)===teamId)
}
function editablePeople(ctx:Context,teamId:string) {
  return editableRosterMembers(ctx.people,ctx.actor.id,ctx.tier,teamId)
}
function allowedRosterTeams(ctx:Context) {
  const ownTeam = rosterTeamFor(ctx,ctx.actor.id)
  const managers = ctx.people.filter(person=>person.active && (person.tier??9999)<=2)
  const visible = new Set([ctx.tier<=2 ? ctx.actor.id : ownTeam])
  if (ctx.tier===1) for (const person of managers) { if(ctx.scope.has(person.id)) visible.add(person.id) }
  if (ctx.tier===2) for (const person of managers) { if(person.tier===2) visible.add(person.id) }
  return [...visible].map(id=>({
    id,name:id===ctx.actor.id&&ctx.tier<=2?'My team':(ctx.byId.get(id)?.display_name||'Team')+' team',
    canManage:id===ctx.actor.id&&ctx.tier<=2,
  })).sort((a,b)=>Number(b.canManage)-Number(a.canManage)||a.name.localeCompare(b.name))
}
function requireRosterTeam(ctx:Context,teamId:unknown,manage=false) {
  requireModule(ctx,'roster')
  const team=allowedRosterTeams(ctx).find(t=>t.id===teamId)
  if(!team||manage&&!team.canManage)throw Error('This roster is outside your editing scope')
  return team
}
function activityTeams(ctx:Context) {
  return ctx.people.filter(person=>person.active && (person.tier??9999)<=2 &&
    (person.id===ctx.actor.id || ctx.tier===1 && ctx.scope.has(person.id)))
    .map(person=>({id:person.id,name:person.display_name+' team'}))
    .sort((a,b)=>Number(b.id===ctx.actor.id)-Number(a.id===ctx.actor.id)||a.name.localeCompare(b.name))
}
function canManageSeries(ctx:Context,series:any,checks:any[]) {
  if(ctx.tier>2)return false
  if(series.roster_team_id)return activityTeams(ctx).some(team=>team.id===series.roster_team_id)
  return series.created_by===ctx.actor.id || checks.some(check=>check.series_id===series.id &&
    [check.primary_owner_id,check.backup_owner_id].some(owner=>ctx.scope.has(owner)))
}
async function note(recipient:string,key:string,kind:string,title:string,body:string,itemId:string|null=null,target='daily_activity') {
  const {error}=await admin.from('worklog_inbox').insert({recipient_id:recipient,delivery_key:key,kind,title,body,item_id:itemId,target})
  if(error&&error.code!=='23505')throw error
}
async function assertDailyRecipient(id:string) {
  const grant=await result(admin.from('worklog_user_modules').select('user_id').eq('user_id',id).eq('module_key','daily_activity').maybeSingle())
  if(!grant)throw Error('The selected person needs Daily Activity access')
}
async function audit(event:string,actor:string|null,itemId:string|null,details:Record<string,unknown>={}) {
  await result(admin.from('worklog_activity_audit').insert({event,actor_id:actor,item_id:itemId,details}))
}
async function ensureChecks(from:string,to:string) {
  const series=await result(admin.from('worklog_activity_series').select('*').eq('active',true).lte('starts_on',to).or(`ends_on.is.null,ends_on.gte.${from}`))
  if(!series.length)return
  const ids=series.map((s:any)=>s.id)
  const checks=await result(admin.from('worklog_activity_checks').select('*').in('series_id',ids))
  if(!checks.length)return
  const changes=await result(admin.from('worklog_activity_owner_changes').select('*').in('check_id',checks.map((c:any)=>c.id)))
  const rows=buildCheckRows(series,checks,changes,from,to)
  const assigned=rows.filter(row=>row.roster_team_id)
  if(assigned.length) {
    const routing=await loadShiftRouting(from,to)
    for(const row of assigned)setInitialAssignment(row,routing)
  }
  for(let i=0;i<rows.length;i+=100)await result(admin.from('worklog_activity_items').upsert(rows.slice(i,i+100),{onConflict:'check_id,scheduled_date',ignoreDuplicates:true}))
}
async function rosterRows(from:string,to:string) { return await result(admin.from('worklog_roster_shifts').select('*').gte('work_date',addDays(from,-1)).lte('work_date',addDays(to,1))) }

type ShiftRouting = Awaited<ReturnType<typeof loadShiftRouting>>
type ActivityCheck = {
  id?:string
  roster_team_id:string|null
  owner_id:string|null
  backup_owner_id:string|null
  window_start_at:string
  window_end_at:string
  roster_assignment?:Record<string,unknown>|null
  coverage_gap?:boolean|null
  handover_history?:Transfer[]|null
  updated_at?:string
}
function publishedShift(row:any):WorkingShift {
  return {user_id:row.user_id, work_date:row.work_date, kind:row.published_kind,
    start_time:row.published_start,end_time:row.published_end,
    publication_team:row.published_team_id,publication_version:row.published_version}
}
async function readRosterPeople():Promise<Person[]> {
  const [people,roles]=await Promise.all([
    result(admin.from('adhoc_profiles').select('id,display_name,manager_id,job_role,active')),
    result(admin.from('Work_log_roles').select('name,rank').eq('is_access_role',false)),
  ])
  const rank=new Map(roles.map((role:any)=>[role.name,role.rank]))
  return people.map((person:Person)=>({...person,tier:rank.get(person.job_role)??9999}))
}
async function loadShiftRouting(from:string,to:string,rows?:WorkingShift[],people?:Person[]) {
  const [staff,grants,working]=await Promise.all([
    people||readRosterPeople(),
    result(admin.from('worklog_user_modules').select('user_id').eq('module_key','daily_activity')),
    rows||rosterRows(from,to).then(rows=>rows.map(publishedShift)),
  ])
  const enabled=new Set<string>(grants.map((grant:any)=>grant.user_id))
  const byId=new Map<string,Person>(staff.map(person=>[person.id,person]))
  const teams=new Map<string,ReturnType<typeof shiftSpans>>()
  for(const shift of shiftSpans(working)) {
    if(!enabled.has(shift.userId)||!byId.get(shift.userId)?.active)continue
    const team=rosterTeam(byId,shift.userId)
    const spans=teams.get(team)||[]
    spans.push(shift)
    teams.set(team,spans)
  }
  return {teams,byId,enabled}
}
function setInitialAssignment(item:ActivityCheck,routing:ShiftRouting) {
  const shift=shiftAt(routing.teams.get(item.roster_team_id!)||[],Date.parse(item.window_start_at))
  item.owner_id=shift?.userId||null
  item.backup_owner_id=null
  item.roster_assignment=shiftRecord(shift)
  item.coverage_gap=!shift
}
async function reconcileRosterChecks(items:ActivityCheck[],routing:ShiftRouting,now=Date.now()) {
  for(const item of items) {
    const opens=Date.parse(item.window_start_at), closes=Date.parse(item.window_end_at)
    if(!item.roster_team_id||now>=closes)continue
    const shifts=routing.teams.get(item.roster_team_id)||[]
    const gap=!shiftAt(shifts,opens)
    const underway=now>=opens
    const shift=shiftAt(shifts,underway?now:opens,underway?item.owner_id:null)
    const assignment=shiftRecord(shift)
    // Keep the last accountable owner available for the handover when no one is active.
    const nextOwner=shift?.userId||(underway?item.owner_id:null)
    const nextAssignment=assignment||(underway?item.roster_assignment:null)
    const history=item.handover_history||[]
    const move=underway&&item.owner_id&&nextOwner&&item.owner_id!==nextOwner&&shift?{
      fromId:item.owner_id,fromName:routing.byId.get(item.owner_id)?.display_name||'Previous assignee',
      toId:nextOwner,toName:routing.byId.get(nextOwner)?.display_name||'Assignee',
      at:new Date(now).toISOString(),shiftStart:new Date(shift.start).toISOString(),
    }:null
    const sameShift=JSON.stringify(Object.entries(item.roster_assignment||{}).sort())===
      JSON.stringify(Object.entries(nextAssignment||{}).sort())
    if(nextOwner===item.owner_id&&!item.backup_owner_id&&sameShift&&item.coverage_gap===gap)continue
    const saved=await result(admin.from('worklog_activity_items').update({
      owner_id:nextOwner,backup_owner_id:null,roster_assignment:nextAssignment,
      coverage_gap:gap,handover_history:move?[...history,move]:item.handover_history,
      due_at:item.window_end_at,
    }).eq('id',item.id).eq('updated_at',item.updated_at).eq('status','open')
      .is('completed_at',null).select('*').maybeSingle())
    if(saved)Object.assign(item,saved)
  }
}
async function refreshRosterAssignments(from:string,to:string,teamId?:string) {
  const query=admin.from('worklog_activity_items').select('*').eq('kind','check').eq('status','open')
    .not('roster_team_id','is',null).gte('scheduled_date',from).lte('scheduled_date',to)
  if(teamId)query.eq('roster_team_id',teamId)
  const items=await result(query)
  if(items.length)await reconcileRosterChecks(items,await loadShiftRouting(from,to))
}

async function shiftHandover(ctx: Context) {
  requireModule(ctx,'daily_activity')
  const actor = ctx.actor
  const now = new Date().toISOString()
  const date = istDate(new Date(now))
  const team = rosterTeamPeople(ctx,rosterTeamFor(ctx,actor.id))
  const teamIds = team.map(person => person.id)
  const roster = await result(admin.from('worklog_roster_shifts')
    .select('user_id,work_date,published_kind,published_start,published_end')
    .in('user_id',teamIds).eq('published_kind','work')
    .gte('work_date',addDays(date,-7)).lte('work_date',date))
  const shifts = handoverShifts(roster,actor.id,now)
  if (!shifts) return {shift: null, incoming: [], completed: []}
  await refreshRosterAssignments(addDays(date,-1),date,rosterTeamFor(ctx,actor.id))

  const fields = 'id,title,owner_id,customer_id,status,due_at,window_start_at,window_end_at,completed_at,completed_by,handover_history,missed_at,updated_at,roster_team_id,roster_assignment'
  const previousIds = shifts.previous.map(shift => shift.id)
  const oldestRecentShift = shifts.earlier.at(-1)?.first || shifts.incoming.first
  const query = () => admin.from('worklog_activity_items').select(fields).eq('kind','check')
  const pending = () => query().is('completed_at',null).in('status',['open','missed'])
  const [candidates,completed,accepted] = await Promise.all([
    result(pending().in('owner_id',teamIds).lte('window_start_at',now)
      .or(`window_end_at.gt.${oldestRecentShift},handover_history.not.is.null`).order('id')),
    previousIds.length ? result(query().in('completed_by',previousIds).in('owner_id',teamIds)
      .gte('completed_at',shifts.previous[0].first).lte('completed_at',now).order('completed_at')) : [],
    result(query().eq('owner_id',actor.id).not('handover_history','is',null)
      .or(`completed_at.is.null,completed_at.gte.${shifts.incoming.first}`).neq('status','cancelled').order('due_at')),
  ])

  // A concurrent completion, reassignment or handover invalidates the snapshot.
  const incoming = [...accepted]
  for (const item of candidates) {
    if (!canCarryCheck(item,shifts)) continue
    if (item.roster_team_id && (item.roster_team_id!==rosterTeamFor(ctx,actor.id) ||
      (item.status==='open' && Date.parse(item.window_end_at)>Date.parse(now)))) continue
    const move: Transfer = {
      fromId: item.owner_id, fromName: ctx.byId.get(item.owner_id)?.display_name || 'Previous owner',
      toId: actor.id, toName: actor.display_name, at: now, shiftStart: shifts.incoming.first,
    }
    const history = [...(item.handover_history || []), move]
    const isMissed = item.status === 'missed' || Date.parse(item.due_at) <= Date.parse(now)
    const updated = await result(admin.from('worklog_activity_items').update({
      owner_id: actor.id, backup_owner_id: null, handover_history: history,
      status: isMissed ? 'missed' : 'open', missed_at: isMissed ? item.missed_at || item.due_at : null,
    }).eq('id',item.id).eq('owner_id',item.owner_id).eq('updated_at',item.updated_at)
      .is('completed_at',null).in('status',['open','missed']).select(fields).maybeSingle())
    if (updated) incoming.push(updated)
  }
  const done = completed.filter((item:any) => shifts.previous.some(shift =>
    shift.id === item.completed_by && Date.parse(item.completed_at) < Date.parse(shift.last)))
  const customerIds = [...new Set<string>([...incoming,...done].map(item => item.customer_id))]
  const customers = customerIds.length ? await result(admin.from('adhoc_customers').select('id,name').in('id',customerIds)) : []
  const customerNames = new Map(customers.map((customer:any) => [customer.id,customer.name]))
  function reportRow(item:any) {
    return {id:item.id,title:item.title,customer:customerNames.get(item.customer_id),dueAt:item.due_at,
      completedAt:item.completed_at,completedBy:ctx.byId.get(item.completed_by)?.display_name,
      history:item.handover_history || []}
  }
  return {shift:shifts.incoming, incoming:incoming.map(reportRow), completed:done.map(reportRow)}
}
async function rosterPreview(ctx:Context,week:string,teamId:string,includeStaffing=false) {
  requireRosterTeam(ctx,teamId,true)
  const until=addDays(week,6)
  const today=istDate()
  if(until>=today)await ensureChecks(week>=today?week:today,until)
  const editableIds=editablePeople(ctx,teamId).map(person=>person.id)
  const teamIds=new Set(rosterTeamPeople(ctx,teamId).map(person=>person.id))
  const [items,published,effective,customers]=await Promise.all([
    result(admin.from('worklog_activity_items').select('id,title,customer_id,scheduled_date,owner_id,backup_owner_id,window_start_at,window_end_at,status,roster_team_id,coverage_gap').eq('kind','check').gte('scheduled_date',week).lte('scheduled_date',until)),
    rosterRows(week,until),
    editableIds.length?result(admin.rpc('worklog_roster_effective_shifts',{p_team:teamId,p_week:week,p_user_ids:editableIds})):[],
    result(admin.from('adhoc_customers').select('id,name')),
  ])
  const shifts:WorkingShift[]=published.filter((row:any)=>row.published_kind&&!(row.week_start===week&&editableIds.includes(row.user_id)))
    .map(publishedShift).concat(effective)
  const draftCoverage=shifts.map(shift=>({user_id:shift.user_id,work_date:shift.work_date,
    draft_kind:shift.kind||'off',draft_start:shift.start_time,draft_end:shift.end_time}))
  const routing=await loadShiftRouting(week,until,shifts,ctx.people)
  const teamSpans=shiftSpans(shifts.filter(shift=>teamIds.has(shift.user_id)))
  const eligibleSpans=routing.teams.get(teamId)||[]
  const shiftNames=(ids:string[])=>[...new Set(ids)].map(id=>ctx.byId.get(id)?.display_name).filter(Boolean)
  const names=new Map(customers.map((x:any)=>[x.id,x.name]))
  const gaps=[] as any[], early=[] as any[], markers=[] as any[], recordedGaps=[] as any[]
  const scoped=items.filter((item:any)=>item.status!=='cancelled' &&
    (item.roster_team_id===teamId || !item.roster_team_id&&(teamIds.has(item.owner_id)||teamIds.has(item.backup_owner_id))))
  for(const item of scoped){
    const time=Date.parse(item.window_start_at)
    const match=item.roster_team_id?shiftAt(eligibleSpans,time):null
    const legacy=!item.roster_team_id?coverage(item,draftCoverage,true):null
    const eligible=match?.userId||legacy?.primary.find(span=>span.start<=time&&time<span.end)?.id||
      legacy?.backup.find(span=>span.start<=time&&time<span.end)?.id||null
    const blockedStaff=item.roster_team_id?shiftsAt(teamSpans,time).filter(shift=>!routing.enabled.has(shift.userId)):[]
    const noActivityAccess=!eligible&&blockedStaff.length>0
    const userId=eligible&&editableIds.includes(eligible)?eligible:editableIds.includes(item.owner_id)?item.owner_id:null
    const entry={id:item.id,userId,date:item.scheduled_date,time:item.window_start_at,customer:names.get(item.customer_id),
      check:item.title,assignee:ctx.byId.get(eligible||'')?.display_name||null,
      people:shiftNames(shiftsAt(eligibleSpans,time).map(shift=>shift.userId)),
      staffWithoutActivityAccess:shiftNames(blockedStaff.map(shift=>shift.userId)),
      reason:eligible?null:noActivityAccess?'Scheduled staff lack Daily Activity access':'No eligible shift at the scheduled time',
      suggestion:noActivityAccess?'Ask a User Admin to enable Daily Activity for the staff who should take this check.':'Add or extend a shift for a team member with Daily Activity access.'}
    markers.push(entry)
    if(item.coverage_gap && Date.parse(item.window_end_at)<=Date.now())recordedGaps.push({id:item.id,date:entry.date,time:entry.time})
    if(item.status!=='open'||Date.parse(item.window_end_at)<=Date.now())continue
    if(!eligible&&(item.roster_team_id||!legacy?.covered))gaps.push(entry)
    else if(match&&match.end<Date.parse(item.window_end_at)&&!shiftAt(eligibleSpans,match.end)){
      early.push({...entry,deadline:new Date(match.end).toISOString(),reason:'Eligible coverage ends before the window closes'})
    }
  }
  const staffing=includeStaffing?staffingWeek(week,draftCoverage.filter(shift=>teamIds.has(shift.user_id))):undefined
  return {gaps,early,checks:scoped.length,staffing,markers:includeStaffing?markers:undefined,recordedGaps:includeStaffing?recordedGaps:undefined}
}
async function publicRoster(week:string) {
  const current=monday(istDate())
  if(!validDate(week)||monday(week)!==week||week<addDays(current,-28)||week>addDays(current,56))
    throw Error('Choose a roster week within the published range')
  const [people,working,publications]=await Promise.all([
    readRosterPeople(),
    result(admin.from('worklog_roster_shifts').select('user_id,work_date,published_kind,published_start,published_end')
      .eq('published_kind','work').gte('work_date',addDays(week,-1)).lte('work_date',addDays(week,6))),
    result(admin.from('worklog_roster_weeks').select('published_at').in('week_start',[addDays(week,-7),week])
      .eq('state','published').order('published_at',{ascending:false}).limit(1)),
  ])
  const profiles=new Map<string,Person>(people.map(person=>[person.id,person]))
  const staff=working.flatMap((row:any)=>{
    const person=profiles.get(row.user_id)
    if(!person?.active||!row.published_start||!row.published_end)return []
    const manager=profiles.get(rosterTeam(profiles,person.id))
    const shift=startEnd(row.work_date,row.published_start,row.published_end)
    return [{name:person.display_name,team:manager&&manager.id!==person.id?manager.display_name:'Operations',
      date:row.work_date,startsAt:shift.first,endsAt:shift.last}]
  })
  const now=new Date().toISOString()
  return {week,currentWeek:current,updatedAt:publications[0]?.published_at||null,now,shifts:staff,
    teams:people.filter(person=>person.active&&person.tier===2).map(person=>person.display_name)}
}
async function tick() {
  const today=istDate(),horizon=addDays(today,13)
  const generated=await result(admin.from('worklog_activity_generation').select('generated_through').eq('id',1).maybeSingle())
  if(!generated||generated.generated_through<horizon){
    await ensureChecks(generated?addDays(generated.generated_through,1):today,horizon)
    await result(admin.from('worklog_activity_generation').upsert({id:1,generated_through:horizon,updated_at:new Date().toISOString()},{onConflict:'id'}))
  }
  const now=Date.now(),from=addDays(today,-1),to=addDays(today,1)
  const [items,shifts,series,people]=await Promise.all([
    result(admin.from('worklog_activity_items').select('id,kind,status,owner_id,backup_owner_id,window_start_at,window_end_at,due_at,series_id,title,creator_id,updated_at,handover_history,roster_team_id,roster_assignment,coverage_gap').eq('status','open').lte('window_start_at',new Date(now).toISOString()).gte('scheduled_date',from).lte('scheduled_date',to).limit(500)),
    rosterRows(from,to),result(admin.from('worklog_activity_series').select('id,reminder_minutes')),
    result(admin.from('adhoc_profiles').select('id,manager_id,active')),
  ])
  if(items.some((item:any)=>item.roster_team_id))await reconcileRosterChecks(items,await loadShiftRouting(from,to,shifts.map(publishedShift)),now)
  const intervals=new Map(series.map((x:any)=>[x.id,x.reminder_minutes]));const managers=new Map(people.map((x:any)=>[x.id,x.manager_id]))
  for(const item of items){if(item.kind!=='check')continue;const c=coverage(item,shifts),start=Date.parse(item.window_start_at),cutoff=item.roster_team_id?Date.parse(item.window_end_at):item.handover_history?.length?Date.parse(item.due_at):c.final
    if(now>=cutoff){const missed=await result(admin.from('worklog_activity_items').update({status:'missed',missed_at:new Date(now).toISOString()}).eq('id',item.id).eq('updated_at',item.updated_at).eq('status','open').is('completed_at',null).select('id').maybeSingle());const lead=managers.get(item.owner_id)||item.creator_id;if(missed&&lead)await note(lead,`missed:${item.id}`,'missed','Missed check',item.title,item.id);continue}
    const primaryOn=item.owner_id&&c.primary.some(x=>now>=x.start&&now<x.end)
    if(primaryOn){await note(item.owner_id,`open:${item.id}:${item.owner_id}`,'check_open','Check window open',item.title,item.id);const interval=Number(intervals.get(item.series_id)||15)*60000;const slot=Math.floor((now-start)/interval);if(slot>0)await note(item.owner_id,`remind:${item.id}:${item.owner_id}:${slot}`,'reminder','Check still open',item.title,item.id)}
    const backupOn=c.backup.some(x=>now>=x.start&&now<x.end);if(backupOn&&cutoff-now<=15*60000)await note(item.backup_owner_id,`backup:${item.id}`,'backup','Backup check near cutoff',item.title,item.id)
  }
  const due=await result(admin.from('worklog_activity_items').select('id,kind,status,owner_id,title,due_at').neq('kind','check').eq('status','open').lte('due_at',new Date(now+15*60000).toISOString()).order('due_at',{ascending:false}).limit(300))
  for(const item of due){const personal=coverage({...item,window_start_at:new Date(now-60000).toISOString(),window_end_at:new Date(now+60000).toISOString()},shifts)
    if(personal.primary.some(x=>now>=x.start&&now<x.end)){const remaining=now-Date.parse(item.due_at),slot=remaining<0?-1:Math.floor(remaining/(60*60000));await note(item.owner_id,`due:${item.id}:${Date.parse(item.due_at)}:${slot}`,'due',slot<0?'Task due soon':'Task overdue',item.title,item.id)}
  }
  const {publicKey:pub,privateKey:priv}=vapidKeys(secret)
  if(pub&&priv){webPush.setVapidDetails('mailto:sadiq.a@talview.com',pub,priv)
    const pending=await result(admin.from('worklog_inbox').select('*').is('push_sent_at',null).lt('push_attempts',3).order('created_at').limit(80))
    for(const message of pending){
      if(message.item_id&&['assignment','reassignment','check_open','reminder','backup','due'].includes(message.kind)){
        const current=await result(admin.from('worklog_activity_items').select('status,owner_id,backup_owner_id,due_at').eq('id',message.item_id).maybeSingle())
        const intended=message.kind==='backup'?current?.backup_owner_id:current?.owner_id
        if(!current||current.status!=='open'||intended!==message.recipient_id||message.kind==='due'&&Date.parse(current.due_at)>Date.now()+15*60000){await admin.from('worklog_inbox').update({push_sent_at:new Date().toISOString()}).eq('id',message.id);continue}
      }
      const subs=await result(admin.from('worklog_push_subscriptions').select('*').eq('user_id',message.recipient_id));let failed=false
      for(const sub of subs)try{await webPush.sendNotification({endpoint:sub.endpoint,keys:{p256dh:sub.p256dh,auth:sub.auth}},JSON.stringify({id:message.delivery_key,title:message.title,body:message.body,target:message.target}),{TTL:3600})}
      catch(e){if((e as any).statusCode===404||(e as any).statusCode===410)await admin.from('worklog_push_subscriptions').delete().eq('id',sub.id);else failed=true}
      await admin.from('worklog_inbox').update(failed?{push_attempts:message.push_attempts+1}:{push_sent_at:new Date().toISOString(),push_attempts:message.push_attempts+1}).eq('id',message.id)
    }
  }
  return {processed:items.length+due.length}
}

Deno.serve(async request=>{
  if(request.method==='OPTIONS')return new Response('ok',{headers:CORS})
  if(request.method==='GET'){
    const url=new URL(request.url)
    if(url.searchParams.get('view')!=='public_roster')return reply({error:'Not found'},404)
    try{return reply(await publicRoster(url.searchParams.get('week')||monday(istDate())))}
    catch(error){return reply({error:error instanceof Error?error.message:'Unable to load the roster'},400)}
  }
  if(request.method!=='POST')return reply({error:'Method not allowed'},405)
  try{
    const body=await request.json(),action=String(body.action||''),args=body.args||{}
    if(action==='tick'){
      if(!await scheduledIdentity(request))return reply({error:'Not authorized'},401)
      return reply(await tick())
    }
    const token=request.headers.get('Authorization')?.replace(/^Bearer /,'')||''
    if(!token||!publishable)throw Error('Authentication required')
    const client=createClient(projectUrl,publishable,{global:{headers:{Authorization:'Bearer '+token}},auth:{persistSession:false,autoRefreshToken:false}})
    const {data:{user},error:authError}=await client.auth.getUser(token)
    if(authError||!user)throw Error('Invalid session')
    const ctx=await context(user.id),id=user.id
    if(action==='shift_handover') return reply(await shiftHandover(ctx))
    if(action==='bootstrap'){
      const [customers,recipients]=await Promise.all([
        result(admin.from('adhoc_customers').select('id,name').eq('active',true).order('name')),
        result(admin.from('worklog_user_modules').select('user_id').eq('module_key','daily_activity')),
      ])
      const canReceive=new Set(recipients.map((r:any)=>r.user_id))
      const oneTimeOwners=Object.fromEntries((['assignment','support','dependency'] as OneTimeKind[])
        .map(kind=>[kind,eligibleTaskOwners(ctx.people,ctx.actor.id,ctx.scope,kind)
          .filter(person=>canReceive.has(person.id)).map(person=>person.id)]))
      return reply({customers,people:ctx.people.filter(p=>p.active).map(p=>({id:p.id,name:p.display_name,tier:p.tier,managerId:p.manager_id,inTeam:ctx.scope.has(p.id)})),tier:ctx.tier,canManage:ctx.tier<=2,activityTeams:ctx.grants.has('daily_activity')?activityTeams(ctx):[],oneTimeOwners})
    }
    if(action==='due_preview'){
      requireModule(ctx,'daily_activity')
      const kind=String(args.kind||'') as OneTimeKind
      if(!['assignment','support','dependency'].includes(kind))throw Error('Choose a task type')
      const ids:string[]=Array.isArray(args.ownerIds)?[...new Set<string>(args.ownerIds.map((value:unknown)=>String(value)))]:[]
      if(!ids.length||ids.length>10)throw Error('Choose up to 10 assignees')
      const allowed=new Set(eligibleTaskOwners(ctx.people,id,ctx.scope,kind).map(p=>p.id))
      if(ids.some(ownerId=>!allowed.has(ownerId)))throw Error('An assignee is outside the permitted tier or reporting route')
      for(const ownerId of ids)await assertDailyRecipient(ownerId)
      const shifts=await rosterRows(istDate(),addDays(istDate(),14))
      return reply(ids.map(ownerId=>({ownerId,dueAt:nextPublishedShiftEnd(shifts,ownerId)})))
    }
    if(action==='inbox'){const rows=await result(admin.from('worklog_inbox').select('id,kind,title,body,target,created_at,read_at,item_id').eq('recipient_id',id).neq('kind','push_test').order('created_at',{ascending:false}).limit(100));return reply(rows)}
    if(action==='inbox_read'){await result(admin.from('worklog_inbox').update({read_at:new Date().toISOString()}).eq('id',args.id).eq('recipient_id',id));return reply({ok:true})}
    if(action==='push_key')return reply({publicKey:vapidKeys(secret).publicKey})
    if(action==='push_subscribe'){const s=args.subscription;if(!s?.endpoint||!s.keys?.p256dh||!s.keys?.auth)throw Error('Invalid push subscription');await result(admin.from('worklog_push_subscriptions').upsert({user_id:id,endpoint:s.endpoint,p256dh:s.keys.p256dh,auth:s.keys.auth,updated_at:new Date().toISOString()},{onConflict:'endpoint'}));return reply({ok:true})}
    if(action==='push_unsubscribe'){await result(admin.from('worklog_push_subscriptions').delete().eq('user_id',id).eq('endpoint',args.endpoint));return reply({ok:true})}
    if(action==='push_status'||action==='push_test'){
      requireModule(ctx,'daily_activity')
      if(!isBrowserPushEndpoint(args.endpoint))throw Error('This browser push provider is not supported')
      const sub=await result(admin.from('worklog_push_subscriptions').select('id,endpoint,p256dh,auth')
        .eq('user_id',id).eq('endpoint',args.endpoint).maybeSingle())
      if(action==='push_status')return reply({enabled:Boolean(sub)})
      if(!sub)throw Error('Enable reminders in this browser before sending a test')
      if(!uuid(args.testId))throw Error('Invalid test notification')
      const title='WorkLog test notification',body='Browser reminders are reaching this device.'
      const {data:test,error:reserveError}=await admin.from('worklog_inbox').insert({recipient_id:id,
        delivery_key:`push-test:${id}:${Math.floor(Date.now()/60000)}`,kind:'push_test',title,body,
        read_at:new Date().toISOString(),push_attempts:3}).select('id').single()
      if(reserveError?.code==='23505')return reply({error:'Wait until the next minute before sending another test'},429)
      if(reserveError)throw reserveError
      try{
        await webPush.sendNotification({endpoint:sub.endpoint,keys:{p256dh:sub.p256dh,auth:sub.auth}},
          JSON.stringify({id:args.testId,title,body,target:'daily_activity',test:true}),{
            TTL:60,timeout:10000,vapidDetails:{subject:'mailto:sadiq.a@talview.com',...vapidKeys(secret)},
          })
      }catch(error){
        const status=(error as {statusCode?:number}).statusCode
        if(status===404||status===410){
          await result(admin.from('worklog_push_subscriptions').delete().eq('id',sub.id).eq('user_id',id))
          throw Error('This browser subscription expired. Enable reminders again before retrying.')
        }
        throw Error(status?`The push service rejected the test (HTTP ${status}).`:'Could not reach the browser push service.')
      }
      await admin.from('worklog_inbox').update({push_sent_at:new Date().toISOString(),push_attempts:1}).eq('id',test.id)
      return reply({accepted:true})
    }
    if(action==='activity_list'){
      requireModule(ctx,'daily_activity')
      const date=String(args.date||args.from||istDate())
      if(!validDate(date))throw Error('Choose a valid activity date')
      const today=istDate(),next=addDays(date,1)
      if(date>=today)await ensureChecks(date,date)
      if(date===today)await refreshRosterAssignments(date,date,rosterTeamFor(ctx,id))
      const teamScope=activityTeams(ctx).map(team=>team.id)
      const owners=[...ctx.scope].join(',')
      const membership=[`owner_id.in.(${owners})`,`backup_owner_id.eq.${id}`,`creator_id.eq.${id}`,`approver_id.eq.${id}`]
      if(teamScope.length)membership.push(`roster_team_id.in.(${teamScope.join(',')})`)
      const scoped=()=>admin.from('worklog_activity_items').select('*').or(membership.join(','))
      const [checks,oneTime,customers,shifts,carryover,earlierTasks,prerequisites]=await Promise.all([
        collectRows(()=>scoped().eq('kind','check').eq('scheduled_date',date).order('id')),
        collectRows(()=>scoped().neq('kind','check').gte('due_at',istStamp(date,'00:00')).lt('due_at',istStamp(next,'00:00')).order('id')),
        result(admin.from('adhoc_customers').select('id,name')),
        rosterRows(date,date),
        date===today?collectRows(()=>admin.from('worklog_activity_items').select('*').eq('kind','check').eq('owner_id',id)
          .lt('scheduled_date',date).not('handover_history','is',null).is('completed_at',null).in('status',['open','missed']).order('id')):[],
        date===today&&args.includeEarlier===true?collectRows(()=>admin.from('worklog_activity_items').select('*').neq('kind','check')
          .eq('owner_id',id).eq('status','open').is('completed_at',null).lt('due_at',istStamp(date,'00:00')).order('id')):[],
        result(admin.from('worklog_activity_items').select('id,title,owner_id').neq('kind','check').neq('status','cancelled')
          .in('owner_id',[...ctx.scope]).gte('due_at',istStamp(today,'00:00')).lt('due_at',istStamp(addDays(today,14),'00:00'))
          .order('due_at').limit(200)),
      ])
      const items=[...checks,...oneTime].filter(item=>[item.owner_id,item.backup_owner_id,item.creator_id,item.approver_id].includes(id)||
        ctx.scope.has(item.owner_id)||teamScope.includes(item.roster_team_id))
      const earlier=[...carryover,...earlierTasks]
      const visible=[...items,...earlier]
      for(const item of checks)if(item.kind==='check'&&!item.roster_team_id&&item.status==='open'){
        const c=coverage(item,shifts),start=Date.parse(item.window_start_at)
        item.coverage_gap=!c.primary.some(span=>span.start<=start&&start<span.end)&&!c.backup.some(span=>span.start<=start&&start<span.end)
      }
      const ids=visible.map(item=>item.id)
      const dependencyIds=[...new Set(visible.map(item=>item.prerequisite_id).filter(Boolean))]
      const [extensions,dependencies]=await Promise.all([
        ids.length?result(admin.from('worklog_activity_extensions').select('*').in('item_id',ids).eq('status','pending')):[],
        dependencyIds.length?result(admin.from('worklog_activity_items').select('id,status').in('id',dependencyIds)):[],
      ])
      return reply({items,carryover:earlier,extensions,customers,prerequisites,dependencies})
    }
    if(action==='series_list'){
      requireManager(ctx,'daily_activity')
      const rows=await result(admin.from('worklog_activity_series').select('*').order('created_at',{ascending:false}).limit(200))
      const checks=rows.length?await result(admin.from('worklog_activity_checks').select('*').in('series_id',rows.map((x:any)=>x.id)).order('check_number')):[]
      const shown=rows.filter((series:any)=>canManageSeries(ctx,series,checks)).map((series:any)=>({
        ...series,roster_team_name:ctx.byId.get(series.roster_team_id)?.display_name||null,
      }))
      return reply({series:shown,checks:checks.filter((check:any)=>shown.some((series:any)=>series.id===check.series_id))})
    }
    if(action==='series_preview'||action==='series_adopt'||action==='series_end'){
      requireManager(ctx,'daily_activity')
      const series=await result(admin.from('worklog_activity_series').select('*').eq('id',args.seriesId).single())
      const checks=await result(admin.from('worklog_activity_checks').select('*').eq('series_id',series.id).order('check_number'))
      if(!canManageSeries(ctx,series,checks))throw Error('Series is outside your team')
      if(action==='series_adopt'){
        if(series.roster_team_id)throw Error('This schedule already follows a roster')
        if(!activityTeams(ctx).some(team=>team.id===args.teamId))throw Error('Choose a team in your scope')
        await result(admin.from('worklog_activity_series').update({roster_team_id:args.teamId}).eq('id',series.id).is('roster_team_id',null))
        await result(admin.from('worklog_activity_items').update({roster_team_id:args.teamId}).eq('series_id',series.id)
          .eq('status','open').is('completed_at',null))
        await refreshRosterAssignments(addDays(istDate(),-1),addDays(istDate(),13),args.teamId)
        await audit('series_roster_adopted',id,null,{seriesId:series.id,teamId:args.teamId})
        return reply({ok:true})
      }
      if(action==='series_end'){
        const on=String(args.endsOn||istDate())
        if(!validDate(on))throw Error('Choose a valid end date')
        await result(admin.from('worklog_activity_series').update({ends_on:on<series.starts_on?series.starts_on:on,active:false}).eq('id',series.id))
        await result(admin.from('worklog_activity_items').update({status:'cancelled'}).eq('series_id',series.id).gt('scheduled_date',on).eq('status','open'))
        await audit('series_ended',id,null,{seriesId:series.id,endsOn:on})
        return reply({ok:true})
      }
      const changes=checks.length&&!series.roster_team_id?await result(admin.from('worklog_activity_owner_changes').select('*').in('check_id',checks.map((c:any)=>c.id))):[]
      const from=istDate(),to=addDays(from,13)
      const rows=buildCheckRows([series],checks,changes,from,to)
      if(series.roster_team_id){
        const routing=await loadShiftRouting(from,to)
        for(const row of rows)setInitialAssignment(row,routing)
      }
      return reply(rows.map(row=>({date:row.scheduled_date,title:row.title,owner_id:row.owner_id,
        window_start_at:row.window_start_at,window_end_at:row.window_end_at,coverage_gap:row.coverage_gap})))
    }
    if(action==='series_create'){
      requireManager(ctx,'daily_activity')
      const team=activityTeams(ctx).find(team=>team.id===args.teamId)
      if(!team)throw Error('Choose a team in your scope')
      const customer=await result(admin.from('adhoc_customers').select('id').eq('id',args.customerId).eq('active',true).maybeSingle())
      if(!customer)throw Error('Choose an active MS customer')
      const start=String(args.startsOn||''),end=args.endsOn?String(args.endsOn):null,kind=String(args.scheduleKind||''),days=Array.isArray(args.weekdays)?args.weekdays.map(Number):[]
      if(!validDate(start)||start<istDate()||end&&(!validDate(end)||end<start)||!['daily','weekdays','weekly','monthly'].includes(kind)||kind==='weekdays'&&(!days.length||days.some((day:number)=>!Number.isInteger(day)||day<0||day>6)))throw Error('Choose a valid schedule and duration')
      const checks=Array.isArray(args.checks)?args.checks:[]
      if(!checks.length||checks.length>24)throw Error('Add 1–24 checks per day')
      const steps=Array.isArray(args.steps)?args.steps.map(String).filter(Boolean):[]
      if(steps.length>20)throw Error('Use at most 20 checklist steps')
      const title=String(args.title||'').trim(),instructions=String(args.instructions||'').trim()
      if(!title||title.length>160)throw Error('Enter an activity title')
      const time=/^([01]\d|2[0-3]):[0-5]\d$/
      for(const check of checks)if(!time.test(check.start)||!time.test(check.end)||check.start===check.end)
        throw Error('Choose a valid time and completion window for each check')
      if(new Set(checks.map((check:any)=>check.start)).size!==checks.length)throw Error('Use a different time for each check')
      const series=await result(admin.from('worklog_activity_series').insert({customer_id:customer.id,roster_team_id:team.id,title,instructions,steps,
        evidence_required:!!args.evidenceRequired,schedule_kind:kind,weekdays:days,monthly_day:kind==='monthly'?Number(args.monthlyDay||start.slice(8)):null,
        starts_on:start,ends_on:end,created_by:id,reminder_minutes:Number(args.reminderMinutes||15)}).select('*').single())
      try{await result(admin.from('worklog_activity_checks').insert(checks.map((check:any,index:number)=>({
        series_id:series.id,check_number:index+1,label:String(check.label||`Check ${index+1}`).trim(),window_start:check.start,window_end:check.end,
      }))))}catch(error){await admin.from('worklog_activity_series').delete().eq('id',series.id);throw error}
      await ensureChecks(start,addDays(start,13))
      await audit('series_created',id,null,{seriesId:series.id,title,teamId:team.id})
      return reply(series)
    }
    if(action==='one_create'){
      requireModule(ctx,'daily_activity');const kind=String(args.kind||'');if(!['assignment','support','dependency'].includes(kind))throw Error('Choose a task type')
      const ownerIds:string[]=Array.isArray(args.ownerIds)?[...new Set<string>(args.ownerIds.map((value:unknown)=>String(value)))]:args.ownerId?[String(args.ownerId)]:[]
      if(!ownerIds.length||ownerIds.length>10||kind!=='assignment'&&ownerIds.length!==1)throw Error('Choose a valid assignee')
      const allowed=new Set(eligibleTaskOwners(ctx.people,id,ctx.scope,kind as OneTimeKind).map(p=>p.id))
      const owners=ownerIds.map(ownerId=>requirePerson(ctx,ownerId))
      if(owners.some(owner=>!allowed.has(owner.id)))throw Error('An assignee is outside the permitted tier or reporting route')
      for(const owner of owners)await assertDailyRecipient(owner.id)
      const customer=await result(admin.from('adhoc_customers').select('id').eq('id',args.customerId).eq('active',true).maybeSingle());if(!customer)throw Error('Choose an active MS customer')
      const title=String(args.title||'').trim();if(!title||title.length>160)throw Error('Enter a task name')
      const dueMode=String(args.dueMode||'custom')
      if(!['shift','tomorrow','custom'].includes(dueMode))throw Error('Choose a deadline')
      const shifts=dueMode==='shift'?await rosterRows(istDate(),addDays(istDate(),14)):[]
      const customDue=dueMode==='custom'?new Date(String(args.dueAt||'')):null
      if(customDue&&!Number.isFinite(customDue.getTime()))throw Error('Choose a valid deadline')
      const dueByOwner=new Map(owners.map(owner=>[owner.id,
        dueMode==='shift'?nextPublishedShiftEnd(shifts,owner.id):
        dueMode==='tomorrow'?istStamp(addDays(istDate(),1),'18:00'):customDue?.toISOString()||null]))
      if([...dueByOwner.values()].some(due=>!due||Date.parse(due)<=Date.now()))
        throw Error(dueMode==='shift'?'A selected assignee has no upcoming published shift. Choose another deadline.':'Choose a future deadline')
      let prerequisite=null;if(kind==='dependency'){if(!uuid(args.prerequisiteId))throw Error('Choose a prerequisite');prerequisite=await result(admin.from('worklog_activity_items').select('id,owner_id').eq('id',args.prerequisiteId).single());if(!ctx.scope.has(prerequisite.owner_id))throw Error('Prerequisite is outside your team')}
      const steps=Array.isArray(args.steps)?args.steps.map(String).filter(Boolean):[]
      if(steps.length>20)throw Error('Use at most 20 checklist steps')
      const items=await result(admin.from('worklog_activity_items').insert(owners.map(owner=>({
        kind,customer_id:customer.id,title,instructions:String(args.instructions||''),steps,
        evidence_required:!!args.evidenceRequired,creator_id:id,owner_id:owner.id,approver_id:id,
        prerequisite_id:prerequisite?.id||null,due_at:dueByOwner.get(owner.id),
        original_due_at:dueByOwner.get(owner.id),
      }))).select('*'))
      for(const item of items){await audit('task_created',id,item.id,{kind,ownerId:item.owner_id});await note(item.owner_id,`assigned:${item.id}`,'assignment','New '+kind,item.title,item.id)}
      return reply({items})
    }
    if(action==='item_complete'){
      requireModule(ctx,'daily_activity');const item=await result(admin.from('worklog_activity_items').select('*').eq('id',args.itemId).single());if(![item.owner_id,item.backup_owner_id].includes(id))throw Error('Only an assigned owner can complete this activity')
      if(item.completed_at||!['open','missed'].includes(item.status))throw Error('This activity is already closed')
      if(item.prerequisite_id){const first=await result(admin.from('worklog_activity_items').select('status').eq('id',item.prerequisite_id).single());if(first.status!=='completed')throw Error('Complete the prerequisite first')}
      const steps=Array.isArray(args.completedSteps)?args.completedSteps.map(Number):[],all=Array.isArray(item.steps)?item.steps.length:0
      if(all&&steps.length!==all)throw Error('Complete every checklist step')
      const evidence=String(args.evidence||'').trim(),recovery=String(args.recoveryReason||'').trim();if(item.evidence_required&&!evidence)throw Error('Evidence is required')
      if(item.kind==='check'&&Date.now()<Date.parse(item.window_start_at))throw Error('This check has not opened yet')
      const late=item.status==='missed'||item.kind==='check'&&Date.now()>Date.parse(item.due_at)
      if(late&&!recovery)throw Error('Enter a reason for late recovery')
      const saved=await result(admin.from('worklog_activity_items').update({status:late?'missed':'completed',missed_at:late?item.missed_at||new Date().toISOString():null,completed_by:id,completed_at:new Date().toISOString(),completed_steps:steps,evidence:evidence||null,recovery_reason:recovery||null}).eq('id',item.id).eq('updated_at',item.updated_at).is('completed_at',null).select('id').maybeSingle())
      if(!saved)throw Error('This activity changed. Refresh and try again.')
      await audit(late?'late_recovery':'completed',id,item.id,{evidence:!!evidence,recoveryReason:recovery||null});if(item.creator_id&&item.creator_id!==id)await note(item.creator_id,`completed:${item.id}`,'completed','Activity completed',item.title,item.id);return reply({ok:true})
    }
    if(action==='item_cancel'){requireModule(ctx,'daily_activity');const item=await result(admin.from('worklog_activity_items').select('*').eq('id',args.itemId).single());if(item.creator_id!==id&&(ctx.tier>2||!ctx.scope.has(item.owner_id)))throw Error('Only the creator or a lead in scope can cancel');await result(admin.from('worklog_activity_items').update({status:'cancelled'}).eq('id',item.id).eq('status','open'));await audit('cancelled',id,item.id);return reply({ok:true})}
    if(action==='extension_request'){
      requireModule(ctx,'daily_activity');const item=await result(admin.from('worklog_activity_items').select('*').eq('id',args.itemId).single());if(item.kind==='check'||item.owner_id!==id||item.status!=='open')throw Error('Only the assignee can request an extension for an open one-time task')
      const proposed=new Date(String(args.proposedDueAt||'')),reason=String(args.reason||'').trim();if(!Number.isFinite(proposed.getTime())||proposed.getTime()<=Date.parse(item.due_at)||!reason)throw Error('Choose a later due date and enter a reason')
      const approver=item.creator_id||item.approver_id;if(!approver)throw Error('No approver is available')
      const extension=await result(admin.from('worklog_activity_extensions').insert({item_id:item.id,previous_due_at:item.due_at,proposed_due_at:proposed.toISOString(),reason,requested_by:id,approver_id:approver}).select('*').single())
      await audit('extension_requested',id,item.id,{extensionId:extension.id,previous:item.due_at,proposed:proposed.toISOString()});await note(approver,`extension:${extension.id}`,'extension','Extension requested',item.title,item.id);return reply(extension)
    }
    if(action==='extension_decide'){
      requireModule(ctx,'daily_activity');const extension=await result(admin.from('worklog_activity_extensions').select('*').eq('id',args.extensionId).single());if(extension.status!=='pending'||extension.approver_id!==id)throw Error('Only the assigned approver can decide this request')
      const approved=args.approved===true,item=await result(admin.from('worklog_activity_items').select('*').eq('id',extension.item_id).single());if(item.status!=='open')throw Error('The task is closed')
      await result(admin.rpc('worklog_decide_extension',{p_extension:extension.id,p_actor:id,p_approved:approved}))
      await audit(approved?'extension_approved':'extension_declined',id,item.id,{previous:extension.previous_due_at,proposed:extension.proposed_due_at});if(item.owner_id)await note(item.owner_id,`extension_decision:${extension.id}`,'extension',approved?'Extension approved':'Extension declined',item.title,item.id);return reply({ok:true})
    }
    if(action==='roster_week'){
      requireModule(ctx,'roster')
      const week=String(args.week||monday(istDate()))
      if(!validDate(week)||monday(week)!==week)throw Error('Choose a Monday')
      const teams=allowedRosterTeams(ctx),teamId=String(args.teamId||teams[0]?.id||'')
      const team=requireRosterTeam(ctx,teamId)
      const editableMembers=editablePeople(ctx,teamId)
      const editable=editableMembers.map(person=>person.id)
      const people=team.canManage ? editableMembers : rosterTeamPeople(ctx,teamId)
        .filter(person=>ctx.tier>2 || person.id!==id)
      const ids=[...new Set(people.map(person=>person.id))]
      const [published,draft,weekRow]=await Promise.all([
        ids.length?result(admin.from('worklog_roster_shifts').select('user_id,work_date,published_kind,published_start,published_end').eq('week_start',week).in('user_id',ids)):[],
        editable.length?result(admin.from('worklog_roster_draft_shifts').select('user_id,work_date,kind,start_time,end_time').eq('team_id',teamId).eq('week_start',week).in('user_id',editable)):[],
        result(admin.from('worklog_roster_team_weeks').select('*').eq('team_id',teamId).eq('week_start',week).maybeSingle()),
      ])
      const empty={active_version:0,draft_base_version:0,draft_revision:0,draft_mode:'overlay',published_at:null}
      const safeWeek=weekRow&& !team.canManage?{...empty,active_version:weekRow.active_version,published_at:weekRow.published_at}:weekRow
      return reply({teamId,teams,people,editable,week:safeWeek||empty,
        publishedRows:published.filter((shift:any)=>shift.published_kind),draftRows:draft,canManage:team.canManage})
    }
    if(action==='roster_save'){
      const week=String(args.week||''),teamId=String(args.teamId||'')
      requireRosterTeam(ctx,teamId,true)
      const owner=requirePerson(ctx,args.userId)
      if(!editablePeople(ctx,teamId).some(person=>person.id===owner.id))throw Error('This person is outside your editable roster team')
      const dates=Array.isArray(args.dates)?args.dates.map(String):[]
      if(!validDate(week)||monday(week)!==week||!dates.length||dates.length>7
        ||dates.some((date:string)=>!validDate(date)||date<week||date>addDays(week,6)))
        throw Error('Choose one or more dates in the roster week')
      const kind=String(args.kind||'')
      if(!['work','off','leave'].includes(kind)
        ||kind==='work'&&(!/^\d{2}:\d{2}$/.test(args.start)||!/^\d{2}:\d{2}$/.test(args.end)||args.start===args.end))
        throw Error('Choose valid shift hours or day off')
      const revision=await result(admin.rpc('worklog_roster_save_cells',{
        p_team:teamId,p_week:week,p_actor:id,
        p_expected_version:Number(args.expectedVersion||0),
        p_expected_revision:Number(args.expectedRevision||0),
        p_user:owner.id,p_days:dates,p_kind:kind,
        p_start:kind==='work'?args.start:null,p_end:kind==='work'?args.end:null,
      }))
      return reply({revision})
    }
    if(action==='roster_copy'){
      const week=String(args.week||''),teamId=String(args.teamId||'')
      requireRosterTeam(ctx,teamId,true)
      if(!validDate(week)||monday(week)!==week)throw Error('Choose a Monday')
      const people=editablePeople(ctx,teamId)
      const revision=await result(admin.rpc('worklog_roster_copy_previous',{
        p_team:teamId,p_week:week,p_actor:id,
        p_expected_version:Number(args.expectedVersion||0),
        p_expected_revision:Number(args.expectedRevision||0),
        p_user_ids:people.map(p=>p.id),p_replace:args.replace===true,
      }))
      return reply({revision})
    }
    if(action==='roster_preview'){
      const week=String(args.week||''),teamId=String(args.teamId||'')
      if(!validDate(week)||monday(week)!==week)throw Error('Choose a Monday')
      return reply(await rosterPreview(ctx,week,teamId,true))
    }
    if(action==='roster_publish'){
      const week=String(args.week||''),teamId=String(args.teamId||'')
      requireRosterTeam(ctx,teamId,true)
      if(!validDate(week)||monday(week)!==week)throw Error('Choose a Monday')
      const preview=await rosterPreview(ctx,week,teamId)
      if(preview.gaps.length)return reply({error:'Resolve coverage gaps before publishing',conflicts:preview.gaps},409)
      const people=editablePeople(ctx,teamId)
      const publication=await result(admin.rpc('worklog_roster_publish_team',{
        p_team:teamId,p_week:week,p_actor:id,
        p_expected_version:Number(args.expectedVersion||0),
        p_expected_revision:Number(args.expectedRevision||0),
        p_user_ids:people.map(p=>p.id),
      }))
      // The published version is already active. A retry on the scheduler also reconciles any interrupted refresh.
      try{await refreshRosterAssignments(addDays(week,-1),addDays(week,7))}
      catch(error){console.error('Roster assignment refresh will retry',error)}
      return reply({...publication,early:preview.early})
    }
    if(action==='roster_history'){
      const week=String(args.week||''),teamId=String(args.teamId||'')
      requireRosterTeam(ctx,teamId,true)
      if(!validDate(week)||monday(week)!==week)throw Error('Choose a Monday')
      const rows=await result(admin.from('worklog_roster_publications')
        .select('version,base_version,published_by,published_at,changes')
        .eq('team_id',teamId).eq('week_start',week)
        .order('version',{ascending:false}).limit(20))
      return reply(rows)
    }
    throw Error('Unknown action')
  }catch(error){console.error('worklog-operations failed',error);return reply({error:error instanceof Error?error.message:'Request failed'},400)}
})

function today(){return istDate()}
