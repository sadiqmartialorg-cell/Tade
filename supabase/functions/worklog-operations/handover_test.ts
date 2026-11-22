import assert from 'node:assert/strict'
import {canCarryCheck,handoverShifts,type Transfer} from './handover.ts'
import {istStamp,staffingWeek} from './schedule.ts'

const sunday = '2026-11-22'
const monday = '2026-11-23'
const shift = (id:string, date:string, start:string, end:string) => ({
  user_id:id, work_date:date, published_kind:'work', published_start:start, published_end:end,
})
const published = [shift('day',sunday,'08:00','18:00'),shift('evening',sunday,'17:00','01:30'),shift('night',sunday,'22:00','08:00')]

Deno.test('unfinished check moves during overlap, keeps its trail, and is not reclaimed by an earlier shift', () => {
  const check = {owner_id:'day',window_start_at:istStamp(sunday,'16:00'),
    window_end_at:istStamp(sunday,'17:30'),handover_history:null}
  const evening = handoverShifts(published,'evening',istStamp(sunday,'17:00'))!
  assert.equal(evening.previous[0].id,'day')
  assert.ok(canCarryCheck(check,evening))
  assert.ok(!canCarryCheck({...check,window_start_at:istStamp(sunday,'17:15')},evening))

  const firstMove: Transfer = {fromId:'day',fromName:'Day operator',toId:'evening',toName:'Evening operator',at:evening.now,shiftStart:evening.incoming.first}
  const carried = {...check,owner_id:'evening',handover_history:[firstMove]}
  assert.ok(!canCarryCheck(carried,handoverShifts(published,'day',istStamp(sunday,'17:30'))!))
  assert.equal(handoverShifts(published,'day',istStamp(sunday,'18:00')),null)
  const night = handoverShifts(published,'night',istStamp(sunday,'22:00'))!
  assert.equal(night.previous[0].id,'evening')
  assert.ok(canCarryCheck(carried,night))
  assert.ok(!canCarryCheck(carried,evening))
})

Deno.test('weekly staffing includes Sunday overnight into Monday and identifies partial hours', () => {
  const draft = published.slice(1).map(row=>({...row,draft_kind:'work',draft_start:row.published_start,draft_end:row.published_end}))
  draft.push({...draft[0],user_id:'morning',work_date:monday,draft_start:'08:20',draft_end:'09:00'})
  const [day] = staffingWeek(monday,draft)
  assert.deepEqual(day.hours[0],{coveredMinutes:60,peak:2,people:['evening','night'],gaps:[]})
  assert.equal(day.hours[1].peak,2)
  assert.deepEqual(day.hours[8],{coveredMinutes:40,peak:1,people:['morning'],gaps:[[480,500]]})
  assert.deepEqual(day.hours[9],{coveredMinutes:0,peak:0,people:[],gaps:[[540,600]]})
})
