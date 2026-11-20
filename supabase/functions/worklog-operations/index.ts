import { createClient } from 'npm:@supabase/supabase-js@2.57.0'
import webPush from 'npm:web-push@3.6.7'
import {scheduledIdentity,vapidKeys} from './security.ts'
import {addDays,istDate,istStamp,monday,startEnd,ownerFor,buildCheckRows,coverage} from './schedule.ts'

const CORS = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info', 'Access-Control-Allow-Methods':'POST,OPTIONS' }
const reply = (body: unknown, status=200) => new Response(JSON.stringify(body), { status, headers:{ ...CORS, 'Content-Type':'application/json' } })
const projectUrl = Deno.env.get('SUPABASE_URL') ?? ''
const publishable = Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? ''
const secret = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY') ?? ''
const admin = createClient(projectUrl, secret, { auth:{ persistSession:false, autoRefreshToken:false } })
const validDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s+'T00:00:00Z'))
const uuid = (v: unknown): v is string => typeof v==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)
const result = async (query: PromiseLike<{data:any,error:any}>) => { const {data,error}=await query; if(error) throw error; return data }
type Person = { id:string; display_name:string; manager_id:string|null; job_role:string|null; active:boolean; tier?:number }
type Context = { actor:Person; people:Person[]; byId:Map<string,Person>; scope:Set<string>; tier:number; grants:Set<string> }

async function context(userId: string): Promise<Context> {
  const [people,roles,modules,activeModules]=await Promise.all([
    result(admin.from('adhoc_profiles').select('id,display_name,manager_id,job_role,active')),
    result(admin.from('tade_roles').select('name,rank').eq('is_access_role',false)),
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
  let person=ctx.byId.get(personId),last=person
  const visited=new Set<string>()
  while(person&&!visited.has(person.id)){
    visited.add(person.id)
    if((person.tier??9999)<=2)return person.id
    last=person
    person=person.manager_id?ctx.byId.get(person.manager_id):undefined
  }
  return last?.id||personId
}
function rosterTeamPeople(ctx:Context,teamId:string) {
  return ctx.people.filter(p=>p.active&&rosterTeamFor(ctx,p.id)===teamId)
}
function allowedRosterTeams(ctx:Context) {
  const scoped=ctx.tier<=2?ctx.people.filter(p=>p.active&&ctx.scope.has(p.id)):[ctx.actor]
  const ids=new Set(scoped.map(p=>rosterTeamFor(ctx,p.id)))
  return [...ids].map(id=>{
    const members=rosterTeamPeople(ctx,id)
    return {id,name:(ctx.byId.get(id)?.display_name||'Team')+' team',
      leadCount:members.filter(p=>/team lead/i.test(p.job_role||'')).length}
  }).sort((a,b)=>b.leadCount-a.leadCount||a.name.localeCompare(b.name))
}
function requireRosterTeam(ctx:Context,teamId:unknown,manage=false) {
  requireModule(ctx,'roster')
  if(manage&&ctx.tier>2)throw Error('Tier 1 or 2 access required')
  const team=allowedRosterTeams(ctx).find(t=>t.id===teamId)
  if(!team)throw Error('This roster team is outside your reporting scope')
  return team
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
  for(let i=0;i<rows.length;i+=100)await result(admin.from('worklog_activity_items').upsert(rows.slice(i,i+100),{onConflict:'check_id,scheduled_date',ignoreDuplicates:true}))
}
async function rosterRows(from:string,to:string) { return await result(admin.from('worklog_roster_shifts').select('*').gte('work_date',addDays(from,-1)).lte('work_date',addDays(to,1))) }
async function rosterPreview(ctx:Context,week:string,teamId:string) {
  requireRosterTeam(ctx,teamId,true)
  const until=addDays(week,6)
  const horizon=addDays(istDate(),13)
  if(until>horizon)await ensureChecks(week>horizon?week:addDays(horizon,1),until)
  const userIds=rosterTeamPeople(ctx,teamId).map(p=>p.id)
  const [items,published,effective,customers]=await Promise.all([
    result(admin.from('worklog_activity_items').select('id,title,customer_id,scheduled_date,owner_id,backup_owner_id,window_start_at,window_end_at,status').eq('kind','check').eq('status','open').gte('scheduled_date',week).lte('scheduled_date',until)),
    rosterRows(week,until),
    result(admin.rpc('worklog_roster_effective_shifts',{p_team:teamId,p_week:week,p_user_ids:userIds})),
    result(admin.from('adhoc_customers').select('id,name')),
  ])
  const ids=new Set(userIds)
  const shifts=published.filter((s:any)=>s.published_kind&&!(s.week_start===week&&ids.has(s.user_id)))
    .map((s:any)=>({...s,draft_kind:s.published_kind,draft_start:s.published_start,draft_end:s.published_end}))
    .concat(effective.map((s:any)=>({user_id:s.user_id,work_date:s.work_date,
      draft_kind:s.kind,draft_start:s.start_time,draft_end:s.end_time})))
  const names=new Map(customers.map((x:any)=>[x.id,x.name]))
  const gaps=[] as any[];const early=[] as any[]
  const scoped=items.filter((item:any)=>ids.has(item.owner_id)||ids.has(item.backup_owner_id))
  for(const item of scoped){const c=coverage(item,shifts,true)
    const personId=ids.has(item.owner_id)?item.owner_id:ids.has(item.backup_owner_id)?item.backup_owner_id:null
    if(!c.covered)gaps.push({id:item.id,userId:personId,date:item.scheduled_date,customer:names.get(item.customer_id),check:item.title,reason:'No eligible primary or backup shift'})
    else {
      const primaryEnd=c.primary.length?Math.max(...c.primary.map(x=>x.end)):null
      if(primaryEnd!==null&&primaryEnd<Date.parse(item.window_end_at))early.push({id:item.id,userId:personId,date:item.scheduled_date,customer:names.get(item.customer_id),check:item.title,deadline:new Date(primaryEnd).toISOString(),reason:'Primary shift ends early'})
      if(c.final<Date.parse(item.window_end_at)&&c.final!==primaryEnd)early.push({id:item.id,userId:personId,date:item.scheduled_date,customer:names.get(item.customer_id),check:item.title,deadline:new Date(c.final).toISOString(),reason:'Final eligible coverage ends early'})
    }
  }
  return {gaps,early,checks:scoped.length}
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
    result(admin.from('worklog_activity_items').select('id,kind,status,owner_id,backup_owner_id,window_start_at,window_end_at,due_at,series_id,title,creator_id').eq('status','open').lte('window_start_at',new Date(now).toISOString()).gte('scheduled_date',from).lte('scheduled_date',to).limit(500)),
    rosterRows(from,to),result(admin.from('worklog_activity_series').select('id,reminder_minutes')),
    result(admin.from('adhoc_profiles').select('id,manager_id,active')),
  ])
  const intervals=new Map(series.map((x:any)=>[x.id,x.reminder_minutes]));const managers=new Map(people.map((x:any)=>[x.id,x.manager_id]))
  for(const item of items){if(item.kind!=='check')continue;const c=coverage(item,shifts),start=Date.parse(item.window_start_at),cutoff=c.final
    if(now>=cutoff){await result(admin.from('worklog_activity_items').update({status:'missed',missed_at:new Date().toISOString()}).eq('id',item.id).eq('status','open'));const lead=managers.get(item.owner_id)||item.creator_id;if(lead)await note(lead,`missed:${item.id}`,'missed','Missed check',item.title,item.id);continue}
    const primaryOn=c.primary.some(x=>now>=x.start&&now<x.end)
    if(primaryOn){await note(item.owner_id,`open:${item.id}`,'check_open','Check window open',item.title,item.id);const interval=Number(intervals.get(item.series_id)||15)*60000;const slot=Math.floor((now-start)/interval);if(slot>0)await note(item.owner_id,`remind:${item.id}:${slot}`,'reminder','Check still open',item.title,item.id)}
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
    if(action==='bootstrap'){
      const customers=await result(admin.from('adhoc_customers').select('id,name').eq('active',true).order('name'))
      return reply({customers,people:ctx.people.filter(p=>p.active).map(p=>({id:p.id,name:p.display_name,tier:p.tier,managerId:p.manager_id,inTeam:ctx.scope.has(p.id)})),tier:ctx.tier,canManage:ctx.tier<=2})
    }
    if(action==='inbox'){const rows=await result(admin.from('worklog_inbox').select('id,kind,title,body,target,created_at,read_at,item_id').eq('recipient_id',id).order('created_at',{ascending:false}).limit(100));return reply(rows)}
    if(action==='inbox_read'){await result(admin.from('worklog_inbox').update({read_at:new Date().toISOString()}).eq('id',args.id).eq('recipient_id',id));return reply({ok:true})}
    if(action==='push_key')return reply({publicKey:vapidKeys(secret).publicKey})
    if(action==='push_subscribe'){const s=args.subscription;if(!s?.endpoint||!s.keys?.p256dh||!s.keys?.auth)throw Error('Invalid push subscription');await result(admin.from('worklog_push_subscriptions').upsert({user_id:id,endpoint:s.endpoint,p256dh:s.keys.p256dh,auth:s.keys.auth,updated_at:new Date().toISOString()},{onConflict:'endpoint'}));return reply({ok:true})}
    if(action==='push_unsubscribe'){await result(admin.from('worklog_push_subscriptions').delete().eq('user_id',id).eq('endpoint',args.endpoint));return reply({ok:true})}
    if(action==='activity_list'){
      requireModule(ctx,'daily_activity');const from=String(args.from||today()),to=String(args.to||addDays(from,13));if(!validDate(from)||!validDate(to)||to<from||Date.parse(to)-Date.parse(from)>31*86400000)throw Error('Choose a range up to 31 days')
      const horizon=addDays(istDate(),13)
      if(to>horizon)await ensureChecks(from>horizon?from:addDays(horizon,1),to)
      const [items,extensions,customers,shifts]=await Promise.all([result(admin.from('worklog_activity_items').select('*').gte('due_at',istStamp(addDays(from,-1),'00:00')).lte('due_at',istStamp(addDays(to,2),'00:00')).order('due_at').limit(1000)),result(admin.from('worklog_activity_extensions').select('*').eq('status','pending')),result(admin.from('adhoc_customers').select('id,name')),rosterRows(from,to)])
      const visible=items.filter((x:any)=>[x.owner_id,x.backup_owner_id,x.creator_id,x.approver_id].includes(id)||ctx.scope.has(x.owner_id))
      for(const item of visible)if(item.kind==='check'&&item.status==='open'){
        const c=coverage(item,shifts),start=Date.parse(item.window_start_at)
        item.coverage_gap=!c.covered
        item.primary_cutoff_at=new Date(c.primary.length?Math.max(...c.primary.map(x=>x.end)):start).toISOString()
        item.final_cutoff_at=new Date(c.final).toISOString()
      }
      return reply({items:visible,extensions:extensions.filter((x:any)=>visible.some((i:any)=>i.id===x.item_id)),customers})
    }
    if(action==='series_list'){requireModule(ctx,'daily_activity');const rows=await result(admin.from('worklog_activity_series').select('*').order('created_at',{ascending:false}).limit(200));const checks=rows.length?await result(admin.from('worklog_activity_checks').select('*').in('series_id',rows.map((x:any)=>x.id))):[];const shown=rows.filter((s:any)=>s.created_by===id||checks.some((c:any)=>c.series_id===s.id&&[c.primary_owner_id,c.backup_owner_id].some(x=>x&&ctx.scope.has(x))));return reply({series:shown,checks:checks.filter((c:any)=>shown.some((s:any)=>s.id===c.series_id))})}
    if(action==='series_preview'){
      requireModule(ctx,'daily_activity');const series=await result(admin.from('worklog_activity_series').select('*').eq('id',args.seriesId).single())
      const checks=await result(admin.from('worklog_activity_checks').select('*').eq('series_id',series.id))
      if(series.created_by!==id&&!checks.some((c:any)=>[c.primary_owner_id,c.backup_owner_id].some(x=>x&&ctx.scope.has(x))))throw Error('Series is outside your team')
      const changes=checks.length?await result(admin.from('worklog_activity_owner_changes').select('*').in('check_id',checks.map((c:any)=>c.id))):[]
      return reply(buildCheckRows([series],checks,changes,istDate(),addDays(istDate(),13)).map(row=>({check_id:row.check_id,date:row.scheduled_date,title:row.title,owner_id:row.owner_id,window_start_at:row.window_start_at,window_end_at:row.window_end_at})))
    }
    if(action==='series_create'){
      requireManager(ctx,'daily_activity');const customer=await result(admin.from('adhoc_customers').select('id').eq('id',args.customerId).eq('active',true).maybeSingle());if(!customer)throw Error('Choose an active MS customer')
      const start=String(args.startsOn||''),end=args.endsOn?String(args.endsOn):null,kind=String(args.scheduleKind||''),days=Array.isArray(args.weekdays)?args.weekdays.map(Number):[]
      if(!validDate(start)||start<istDate()||end&&!validDate(end)||end&&end<start||!['daily','weekdays','weekly','monthly'].includes(kind)||kind==='weekdays'&&(!days.length||days.some((d:number)=>d<0||d>6)))throw Error('Choose a valid future schedule and duration')
      const checks=Array.isArray(args.checks)?args.checks:[];if(!checks.length||checks.length>24)throw Error('Add 1–24 checks per day')
      const steps=Array.isArray(args.steps)?args.steps.map(String).filter(Boolean):[];if(steps.length>20)throw Error('Use at most 20 checklist steps')
      const title=String(args.title||'').trim(),instructions=String(args.instructions||'').trim();if(!title||title.length>160)throw Error('Enter an activity title')
      for(const c of checks){requirePerson(ctx,c.primaryOwnerId);assertInTeam(ctx,c.primaryOwnerId);await assertDailyRecipient(c.primaryOwnerId);if(c.backupOwnerId){requirePerson(ctx,c.backupOwnerId);assertInTeam(ctx,c.backupOwnerId);await assertDailyRecipient(c.backupOwnerId)}if(!/^\d{2}:\d{2}$/.test(c.start)||!/^\d{2}:\d{2}$/.test(c.end)||c.start===c.end)throw Error('Choose a valid time window for every check')}
      const series=await result(admin.from('worklog_activity_series').insert({customer_id:customer.id,title,instructions,steps,evidence_required:!!args.evidenceRequired,schedule_kind:kind,weekdays:days,monthly_day:kind==='monthly'?Number(args.monthlyDay||start.slice(8)):null,starts_on:start,ends_on:end,created_by:id,reminder_minutes:Number(args.reminderMinutes||15)}).select('*').single())
      try{await result(admin.from('worklog_activity_checks').insert(checks.map((c:any,i:number)=>({series_id:series.id,check_number:i+1,label:String(c.label||`Check ${i+1}`).trim(),window_start:c.start,window_end:c.end,primary_owner_id:c.primaryOwnerId,backup_owner_id:c.backupOwnerId||null}))))}
      catch(e){await admin.from('worklog_activity_series').delete().eq('id',series.id);throw e}
      await ensureChecks(start,addDays(start,13));await audit('series_created',id,null,{seriesId:series.id,title});return reply(series)
    }
    if(action==='series_end'){requireManager(ctx,'daily_activity');const on=String(args.endsOn||istDate());if(!validDate(on))throw Error('Choose a valid end date');const existing=await result(admin.from('worklog_activity_series').select('id,starts_on,created_by').eq('id',args.seriesId).single());const checks=await result(admin.from('worklog_activity_checks').select('primary_owner_id').eq('series_id',existing.id));if(existing.created_by!==id&&!checks.some((c:any)=>ctx.scope.has(c.primary_owner_id)))throw Error('Series is outside your team');await result(admin.from('worklog_activity_series').update({ends_on:on<existing.starts_on?existing.starts_on:on,active:false}).eq('id',args.seriesId));await result(admin.from('worklog_activity_items').update({status:'cancelled'}).eq('series_id',args.seriesId).gt('scheduled_date',on).eq('status','open'));await audit('series_ended',id,null,{seriesId:args.seriesId,endsOn:on});return reply({ok:true})}
    if(action==='owner_change'){
      requireManager(ctx,'daily_activity');const check=await result(admin.from('worklog_activity_checks').select('*').eq('id',args.checkId).single());const series=await result(admin.from('worklog_activity_series').select('created_by').eq('id',check.series_id).single());if(series.created_by!==id&&!ctx.scope.has(check.primary_owner_id))throw Error('Check is outside your team');const date=String(args.date||''),scope=String(args.scope||'');if(!validDate(date)||!['date','future'].includes(scope))throw Error('Choose a date and edit scope')
      const primary=requirePerson(ctx,args.primaryOwnerId);assertInTeam(ctx,primary.id);await assertDailyRecipient(primary.id);if(args.backupOwnerId){const backup=requirePerson(ctx,args.backupOwnerId);assertInTeam(ctx,backup.id);await assertDailyRecipient(backup.id);if(backup.id===primary.id)throw Error('Backup must differ from primary')}
      const previous=await result(admin.from('worklog_activity_owner_changes').select('*').eq('check_id',check.id))
      const priorOwner=ownerFor(check,date,previous)
      await result(admin.from('worklog_activity_owner_changes').insert({check_id:check.id,effective_on:date,scope,primary_owner_id:primary.id,backup_owner_id:args.backupOwnerId||null,changed_by:id}))
      const query=admin.from('worklog_activity_items').select('id,scheduled_date,owner_id').eq('check_id',check.id).eq('status','open');const rows=await result(scope==='date'?query.eq('scheduled_date',date):query.gte('scheduled_date',date))
      const changes=await result(admin.from('worklog_activity_owner_changes').select('*').eq('check_id',check.id));for(const item of rows){const next=ownerFor(check,item.scheduled_date,changes);await result(admin.from('worklog_activity_items').update({owner_id:next.primary_owner_id,backup_owner_id:next.backup_owner_id}).eq('id',item.id));if(item.owner_id!==next.primary_owner_id)await note(next.primary_owner_id,`reassign:${item.id}:${primary.id}`,'reassignment','Check reassigned',String(item.scheduled_date),item.id)}
      await audit('owner_changed',id,null,{checkId:check.id,date,scope,previousPrimary:priorOwner.primary_owner_id,previousBackup:priorOwner.backup_owner_id,primary:primary.id,backup:args.backupOwnerId||null});return reply({updated:rows.length})
    }
    if(action==='one_create'){
      requireModule(ctx,'daily_activity');const kind=String(args.kind||'');if(!['assignment','support','dependency'].includes(kind))throw Error('Choose a task type')
      const owner=requirePerson(ctx,args.ownerId),customer=await result(admin.from('adhoc_customers').select('id').eq('id',args.customerId).eq('active',true).maybeSingle());if(!customer)throw Error('Choose an active MS customer')
      await assertDailyRecipient(owner.id)
      if(kind!=='support')assertInTeam(ctx,owner.id)
      if(kind==='assignment'&&(owner.id===id||owner.tier!<=ctx.tier))throw Error('Assignments must go downward within your team')
      const due=new Date(String(args.dueAt||'')),title=String(args.title||'').trim();if(!Number.isFinite(due.getTime())||due.getTime()<Date.now()||!title||title.length>160)throw Error('Enter a title and future due date')
      const approver=args.approverId?requirePerson(ctx,args.approverId):ctx.actor
      await assertDailyRecipient(approver.id)
      let prerequisite=null;if(kind==='dependency'){if(!uuid(args.prerequisiteId))throw Error('Choose a prerequisite');prerequisite=await result(admin.from('worklog_activity_items').select('id,owner_id').eq('id',args.prerequisiteId).single());if(!ctx.scope.has(prerequisite.owner_id))throw Error('Prerequisite is outside your team')}
      const steps=Array.isArray(args.steps)?args.steps.map(String).filter(Boolean):[]
      const item=await result(admin.from('worklog_activity_items').insert({kind,customer_id:customer.id,title,instructions:String(args.instructions||''),steps,evidence_required:!!args.evidenceRequired,creator_id:id,owner_id:owner.id,approver_id:approver.id,prerequisite_id:prerequisite?.id||null,due_at:due.toISOString(),original_due_at:due.toISOString()}).select('*').single())
      await audit('task_created',id,item.id,{kind,ownerId:owner.id});await note(owner.id,`assigned:${item.id}`,'assignment','New '+kind,item.title,item.id);return reply(item)
    }
    if(action==='item_complete'){
      requireModule(ctx,'daily_activity');const item=await result(admin.from('worklog_activity_items').select('*').eq('id',args.itemId).single());if(![item.owner_id,item.backup_owner_id].includes(id))throw Error('Only an assigned owner can complete this activity')
      if(!['open','missed'].includes(item.status))throw Error('This activity is already closed')
      if(item.prerequisite_id){const first=await result(admin.from('worklog_activity_items').select('status').eq('id',item.prerequisite_id).single());if(first.status!=='completed')throw Error('Complete the prerequisite first')}
      const steps=Array.isArray(args.completedSteps)?args.completedSteps.map(Number):[],all=Array.isArray(item.steps)?item.steps.length:0
      if(all&&steps.length!==all)throw Error('Complete every checklist step')
      const evidence=String(args.evidence||'').trim(),recovery=String(args.recoveryReason||'').trim();if(item.evidence_required&&!evidence)throw Error('Evidence is required')
      if(item.kind==='check'&&Date.now()<Date.parse(item.window_start_at))throw Error('This check has not opened yet')
      const late=item.status==='missed'||item.kind==='check'&&Date.now()>Date.parse(item.due_at)
      if(late&&!recovery)throw Error('Enter a reason for late recovery')
      await result(admin.from('worklog_activity_items').update({status:late?'missed':'completed',missed_at:late?item.missed_at||new Date().toISOString():null,completed_by:id,completed_at:new Date().toISOString(),completed_steps:steps,evidence:evidence||null,recovery_reason:recovery||null}).eq('id',item.id))
      await audit(late?'late_recovery':'completed',id,item.id,{evidence:!!evidence,recoveryReason:recovery||null});if(item.creator_id&&item.creator_id!==id)await note(item.creator_id,`completed:${item.id}`,'completed','Activity completed',item.title,item.id);return reply({ok:true})
    }
    if(action==='item_cancel'){requireModule(ctx,'daily_activity');const item=await result(admin.from('worklog_activity_items').select('*').eq('id',args.itemId).single());if(item.creator_id!==id&&(ctx.tier>2||!ctx.scope.has(item.owner_id)))throw Error('Only the creator or a lead in scope can cancel');await result(admin.from('worklog_activity_items').update({status:'cancelled'}).eq('id',item.id).eq('status','open'));await audit('cancelled',id,item.id);return reply({ok:true})}
    if(action==='extension_request'){
      requireModule(ctx,'daily_activity');const item=await result(admin.from('worklog_activity_items').select('*').eq('id',args.itemId).single());if(item.kind==='check'||item.owner_id!==id||item.status!=='open')throw Error('Only the assignee can request an extension for an open one-time task')
      const proposed=new Date(String(args.proposedDueAt||'')),reason=String(args.reason||'').trim();if(!Number.isFinite(proposed.getTime())||proposed.getTime()<=Date.parse(item.due_at)||!reason)throw Error('Choose a later due date and enter a reason')
      const approver=item.approver_id||item.creator_id;if(!approver)throw Error('No approver is available')
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
      requireRosterTeam(ctx,teamId)
      const teamPeople=rosterTeamPeople(ctx,teamId)
      const people=teamPeople
      const userIds=new Set(people.map(p=>p.id))
      const [published,draft,weekRow]=await Promise.all([
        result(admin.from('worklog_roster_shifts').select('user_id,work_date,published_kind,published_start,published_end').eq('week_start',week)),
        ctx.tier<=2?result(admin.from('worklog_roster_draft_shifts').select('user_id,work_date,kind,start_time,end_time').eq('team_id',teamId).eq('week_start',week)):Promise.resolve([]),
        result(admin.from('worklog_roster_team_weeks').select('*').eq('team_id',teamId).eq('week_start',week).maybeSingle()),
      ])
      return reply({
        teamId,teams,people,
        week:weekRow||{active_version:0,draft_base_version:0,draft_revision:0,draft_mode:'overlay',published_at:null},
        publishedRows:published.filter((s:any)=>userIds.has(s.user_id)&&s.published_kind),
        draftRows:draft.filter((s:any)=>userIds.has(s.user_id)),
        canManage:ctx.tier<=2,
      })
    }
    if(action==='roster_save'){
      const week=String(args.week||''),teamId=String(args.teamId||'')
      requireRosterTeam(ctx,teamId,true)
      const owner=requirePerson(ctx,args.userId)
      if(rosterTeamFor(ctx,owner.id)!==teamId)throw Error('Choose a person in this roster team')
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
      const people=rosterTeamPeople(ctx,teamId)
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
      return reply(await rosterPreview(ctx,week,teamId))
    }
    if(action==='roster_publish'){
      const week=String(args.week||''),teamId=String(args.teamId||'')
      requireRosterTeam(ctx,teamId,true)
      if(!validDate(week)||monday(week)!==week)throw Error('Choose a Monday')
      const preview=await rosterPreview(ctx,week,teamId)
      if(preview.gaps.length)return reply({error:'Resolve coverage gaps before publishing',conflicts:preview.gaps},409)
      const people=rosterTeamPeople(ctx,teamId)
      const publication=await result(admin.rpc('worklog_roster_publish_team',{
        p_team:teamId,p_week:week,p_actor:id,
        p_expected_version:Number(args.expectedVersion||0),
        p_expected_revision:Number(args.expectedRevision||0),
        p_user_ids:people.map(p=>p.id),
      }))
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
