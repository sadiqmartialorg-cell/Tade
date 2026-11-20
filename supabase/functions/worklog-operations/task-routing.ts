export type TaskPerson = {
  id: string
  manager_id: string | null
  tier?: number
  active: boolean
}

export type OneTimeKind = 'assignment' | 'support' | 'dependency'

export function eligibleTaskOwners(
  people: TaskPerson[], actorId: string, scope: Set<string>, kind: OneTimeKind,
): TaskPerson[] {
  const actor = people.find(person => person.id === actorId)
  if (!actor) return []
  const tier = actor.tier ?? 9999
  return people.filter(person => person.active && (
    kind === 'assignment'
      ? person.id !== actorId && scope.has(person.id) && (person.tier ?? 9999) > tier
      : kind === 'support'
        ? (person.tier ?? 9999) < tier
        : (person.tier ?? 9999) === tier
  ))
}
