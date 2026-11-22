import {startEnd} from './schedule.ts'

type PublishedShift = {
  user_id: string
  work_date: string
  published_kind: string | null
  published_start: string | null
  published_end: string | null
}

export type Transfer = {
  fromId: string
  fromName: string
  toId: string
  toName: string
  at: string
  shiftStart: string
}

export function handoverShifts(rows: PublishedShift[], actorId: string, now: string) {
  const shifts = rows.flatMap(row => {
    if (row.published_kind !== 'work' || !row.published_start || !row.published_end) return []
    return [{id: row.user_id, ...startEnd(row.work_date, row.published_start, row.published_end)}]
  }).sort((a,b) => b.first.localeCompare(a.first))
  const incoming = shifts.find(shift => shift.id === actorId && shift.first <= now && now < shift.last)
  if (!incoming) return null
  const earlier = shifts.filter(shift => shift.first < incoming.first)
  const previousStart = earlier[0]?.first
  const previous = earlier.filter(shift => shift.first === previousStart && shift.id !== actorId)
  return {incoming, previous, earlier, now}
}

export function canCarryCheck(
  item: {owner_id: string; window_start_at: string; window_end_at: string; handover_history: Transfer[] | null},
  shifts: NonNullable<ReturnType<typeof handoverShifts>>,
) {
  if (item.owner_id === shifts.incoming.id || Date.parse(item.window_start_at) > Date.parse(shifts.now)) return false
  const last = item.handover_history?.at(-1)
  if (last) return Date.parse(last.shiftStart) < Date.parse(shifts.incoming.first)
  return shifts.earlier.some(shift => shift.id === item.owner_id &&
    Date.parse(shift.first) < Date.parse(item.window_end_at) && Date.parse(item.window_start_at) < Date.parse(shift.last))
}
