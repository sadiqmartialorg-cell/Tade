import assert from 'node:assert/strict'
import {editableRosterMembers,rosterTeam,shiftAt,shiftSpans,shiftRecord,type WorkingShift} from './roster-routing.ts'
import {istStamp,buildCheckRows} from './schedule.ts'

const date='2026-11-23'
function shift(user_id:string, start_time:string,end_time:string,work_date=date,publication_version=1):WorkingShift {
  return {user_id,kind:'work',work_date,start_time,end_time,publication_team:'team',publication_version}
}
const at=(time:string)=>Date.parse(istStamp(date,time))

Deno.test('recurring times resolve one assignee at overlaps and exact shift boundaries',()=>{
  const spans=shiftSpans([shift('day','08:00','18:00'),shift('evening','17:00','01:30'),
    shift('night','22:00','08:00'),shift('night','22:00','08:00','2026-11-22')])
  assert.equal(shiftAt(spans,at('07:59'))?.userId,'night')
  assert.equal(shiftAt(spans,at('08:00'))?.userId,'day')
  assert.equal(shiftAt(spans,at('17:00'))?.userId,'evening')
  assert.equal(shiftAt(spans,at('22:00'))?.userId,'night')
  assert.equal(shiftAt(spans,at('17:59'),'day')?.userId,'day')
  assert.equal(shiftAt(spans,at('18:00'),'day')?.userId,'evening')
  assert.equal(shiftAt(shiftSpans([shift('evening','17:00','01:30')]),at('16:59')),null)
})

Deno.test('a rotation changes shift ownership without editing the recurring template',()=>{
  const template={id:'series',title:'Recurring activity',roster_team_id:'team',schedule_kind:'daily',active:true,starts_on:date}
  const checks=[{id:'a',series_id:'series',label:'Morning',window_start:'08:00',window_end:'09:00'},
    {id:'b',series_id:'series',label:'Evening',window_start:'17:00',window_end:'18:00'},
    {id:'c',series_id:'series',label:'Overnight',window_start:'22:00',window_end:'23:00'}]
  const rows=buildCheckRows([template],checks,[],date,date)
  assert.deepEqual(rows.map(row=>row.roster_team_id),['team','team','team'])
  const original=shiftSpans([shift('a','08:00','18:00'),shift('b','17:00','01:30'),shift('c','22:00','08:00')])
  const republished=shiftSpans([shift('c','08:00','18:00',date,2),shift('a','17:00','01:30',date,2),shift('b','22:00','08:00',date,2)])
  assert.deepEqual(rows.map(row=>shiftAt(original,Date.parse(row.window_start_at))?.userId),['a','b','c'])
  assert.deepEqual(rows.map(row=>shiftAt(republished,Date.parse(row.window_start_at))?.userId),['c','a','b'])
  assert.equal(shiftRecord(shiftAt(republished,at('17:00')))?.rosterVersion,2)
  assert.equal(shiftAt(shiftSpans([shift('z','17:00','01:30'),shift('a','17:00','01:30')]),at('17:00'))?.userId,'a')
})

Deno.test('Tier 1 edits direct reports and Tier 2 edits their whole branch below the next roster lead',()=>{
  const person=(id:string,tier:number,manager_id:string|null)=>({id,display_name:id,tier,manager_id,active:true})
  const people=[person('manager',1,null),person('lead',2,'manager'),person('other',2,'manager'),
    person('analyst',5,'manager'),person('supervisor',3,'lead'),person('operator',5,'supervisor'),
    person('trainee',6,'operator'),person('peerStaff',5,'other'),{...person('inactive',5,'supervisor'),active:false}]
  const byId=new Map(people.map(person=>[person.id,person]))
  assert.equal(rosterTeam(byId,'lead'),'manager')
  assert.equal(rosterTeam(byId,'operator'),'lead')
  assert.deepEqual(editableRosterMembers(people,'manager',1,'manager').map(p=>p.id),['lead','other','analyst'])
  assert.deepEqual(editableRosterMembers(people,'lead',2,'lead').map(p=>p.id),['supervisor','operator','trainee'])
  assert.deepEqual(editableRosterMembers(people,'lead',2,'other'),[])
  assert.deepEqual(editableRosterMembers(people,'other',2,'other').map(p=>p.id),['peerStaff'])
  assert.deepEqual(editableRosterMembers(people,'supervisor',3,'supervisor'),[])
})
