import { eligibleTaskOwners, type TaskPerson } from './task-routing.ts'

function assertEquals(actual:unknown,expected:unknown) {
  if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

const people: TaskPerson[] = [
  { id: 'manager', manager_id: null, tier: 1, active: true },
  { id: 'lead', manager_id: 'manager', tier: 2, active: true },
  { id: 'other-lead', manager_id: 'manager', tier: 2, active: true },
  { id: 'peer', manager_id: 'lead', tier: 3, active: true },
  { id: 'me', manager_id: 'lead', tier: 3, active: true },
  { id: 'reportee', manager_id: 'me', tier: 4, active: true },
  { id: 'other-peer', manager_id: 'manager', tier: 3, active: true },
  { id: 'inactive', manager_id: 'me', tier: 4, active: false },
]
const scope = new Set(['me', 'reportee'])

Deno.test('assignment choices are active lower-tier reportees only', () => {
  assertEquals(eligibleTaskOwners(people, 'me', scope, 'assignment').map(p => p.id), ['reportee'])
})

Deno.test('support choices are active higher-tier people', () => {
  assertEquals(eligibleTaskOwners(people, 'me', scope, 'support').map(p => p.id), ['manager', 'lead', 'other-lead'])
})

Deno.test('dependency choices have the same tier, including the creator', () => {
  assertEquals(eligibleTaskOwners(people, 'me', scope, 'dependency').map(p => p.id), ['peer', 'me', 'other-peer'])
})
