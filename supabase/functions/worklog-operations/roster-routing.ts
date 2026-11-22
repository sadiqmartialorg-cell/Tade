import {startEnd} from './schedule.ts'

export type RosterPerson = {
  id:string
  display_name:string
  manager_id:string|null
  active:boolean
  tier?:number
}

export function rosterTeam(people: Map<string,RosterPerson>, personId:string) {
  let person = people.get(personId)
  const seen = new Set([personId])
  while (person?.manager_id && !seen.has(person.manager_id)) {
    seen.add(person.manager_id)
    person = people.get(person.manager_id)
    if (person?.active && (person.tier ?? 9999) <= 2) return person.id
  }
  return personId
}

export function editableRosterMembers<T extends RosterPerson>(people:T[], actorId:string, actorTier:number, teamId:string) {
  if (actorTier > 2 || actorId !== teamId) return []
  return people.filter(person => person.active && person.manager_id === actorId)
}

export type WorkingShift = {
  user_id:string
  work_date:string
  kind:string|null
  start_time:string|null
  end_time:string|null
  publication_team?:string|null
  publication_version?:number|null
}

export function shiftSpans(rows:WorkingShift[]) {
  return rows.flatMap(row => {
    if (row.kind !== 'work' || !row.start_time || !row.end_time || row.start_time === row.end_time) return []
    const {first,last} = startEnd(row.work_date,row.start_time,row.end_time)
    return [{userId:row.user_id, date:row.work_date,start:Date.parse(first),end:Date.parse(last),
      teamId:row.publication_team || null,version:row.publication_version ?? null}]
  }).sort((a,b) => b.start-a.start || a.userId.localeCompare(b.userId))
}

export type ShiftSpan = ReturnType<typeof shiftSpans>[number]

export function shiftAt(shifts:ShiftSpan[], at:number, preferredId?:string|null) {
  const present = shifts.filter(shift => shift.start <= at && at < shift.end)
  return present.find(shift => shift.userId === preferredId) || present[0] || null
}

export function shiftRecord(shift:ShiftSpan|null) {
  return shift ? {shiftDate:shift.date, startsAt:new Date(shift.start).toISOString(),
    endsAt:new Date(shift.end).toISOString(), publicationTeamId:shift.teamId, rosterVersion:shift.version} : null
}
