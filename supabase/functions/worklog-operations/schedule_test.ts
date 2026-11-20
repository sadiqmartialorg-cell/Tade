import {buildCheckRows,coverage,nextPublishedShiftEnd} from './schedule.ts'

function assertEquals(actual:unknown,expected:unknown) {
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const series={id:'series',customer_id:'customer',title:'Scheduling Check',instructions:'',steps:[],evidence_required:false,created_by:'lead',schedule_kind:'daily',starts_on:'2026-11-20',ends_on:null,active:true}
const checks=[
  {id:'check-1',series_id:'series',label:'Check 1',window_start:'09:00',window_end:'10:00',primary_owner_id:'X',backup_owner_id:null},
  {id:'check-2',series_id:'series',label:'Check 2',window_start:'13:00',window_end:'14:00',primary_owner_id:'Y',backup_owner_id:null},
  {id:'check-3',series_id:'series',label:'Check 3',window_start:'17:00',window_end:'18:00',primary_owner_id:'Z',backup_owner_id:null},
]

Deno.test('three daily checks remain independent and future owner change affects only Check 2',()=>{
  const changes=[{check_id:'check-2',scope:'future',effective_on:'2026-11-21',primary_owner_id:'A',backup_owner_id:null,created_at:'2026-11-20T10:00:00Z'}]
  const rows=buildCheckRows([series],checks,changes,'2026-11-20','2026-11-21')
  assertEquals(rows.length,6)
  assertEquals(rows.filter(x=>x.scheduled_date==='2026-11-20').map(x=>x.owner_id),['X','Y','Z'])
  assertEquals(rows.filter(x=>x.scheduled_date==='2026-11-21').map(x=>x.owner_id),['X','A','Z'])
  assertEquals(new Set(rows.map(x=>x.check_id+'|'+x.scheduled_date)).size,6)
})

Deno.test('date-only swap overrides the future owner for one day',()=>{
  const changes=[
    {check_id:'check-2',scope:'future',effective_on:'2026-11-21',primary_owner_id:'A',backup_owner_id:null,created_at:'2026-11-20T10:00:00Z'},
    {check_id:'check-2',scope:'date',effective_on:'2026-11-22',primary_owner_id:'B',backup_owner_id:null,created_at:'2026-11-21T10:00:00Z'},
  ]
  const rows=buildCheckRows([series],checks,changes,'2026-11-21','2026-11-23')
  assertEquals(rows.filter(x=>x.check_id==='check-2').map(x=>x.owner_id),['A','B','A'])
})

Deno.test('shift swap exposes a gap and an early cutoff before publish',()=>{
  const item=buildCheckRows([series],[checks[2]],[],'2026-11-20','2026-11-20')[0]
  const full=[{user_id:'Z',work_date:'2026-11-20',draft_kind:'work',draft_start:'09:00',draft_end:'18:00'}]
  assertEquals(coverage(item,full,true).covered,true)
  const swapped=[{user_id:'Z',work_date:'2026-11-20',draft_kind:'off',draft_start:null,draft_end:null}]
  assertEquals(coverage(item,swapped,true).covered,false)
  const early=[{user_id:'Z',work_date:'2026-11-20',draft_kind:'work',draft_start:'09:00',draft_end:'17:30'}]
  assertEquals(new Date(coverage(item,early,true).final).toISOString(),'2026-11-20T12:00:00.000Z')
})

Deno.test('overnight shift covers a check after midnight on the next calendar date',()=>{
  const night={...checks[0],window_start:'00:30',window_end:'01:00'}
  const item=buildCheckRows([series],[night],[],'2026-11-21','2026-11-21')[0]
  const shift=[{user_id:'X',work_date:'2026-11-20',published_kind:'work',published_start:'22:00',published_end:'06:00'}]
  assertEquals(coverage(item,shift).covered,true)
})

Deno.test('end-of-shift deadline uses the current or next published shift, including overnight',()=>{
  const shifts=[
    {user_id:'X',work_date:'2026-11-20',published_kind:'work',published_start:'22:00',published_end:'06:00'},
    {user_id:'X',work_date:'2026-11-21',published_kind:'work',published_start:'09:00',published_end:'18:00'},
    {user_id:'Y',work_date:'2026-11-20',published_kind:'off',published_start:null,published_end:null},
  ]
  assertEquals(nextPublishedShiftEnd(shifts,'X',Date.parse('2026-11-20T18:00:00Z')),'2026-11-21T00:30:00.000Z')
  assertEquals(nextPublishedShiftEnd(shifts,'X',Date.parse('2026-11-21T01:00:00Z')),'2026-11-21T12:30:00.000Z')
  assertEquals(nextPublishedShiftEnd(shifts,'Y',Date.parse('2026-11-20T18:00:00Z')),null)
})
