import { createClient } from 'npm:@supabase/supabase-js@2.57.0'

const CONFIG_TABLES: Record<string, string> = {
  departments: 'adhoc_departments', customers: 'adhoc_customers', tasks: 'adhoc_tasks',
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json' },
})

function sessionView(s: Record<string, unknown>) {
  return {
    id: s.id, runnerName: s.runner_name, state: s.state, workDate: s.work_date,
    startedAt: s.started_at, lastResumedAt: s.active_since, stoppedAt: s.stopped_at,
    accumulatedSeconds: s.accumulated_seconds,
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const authorization = req.headers.get('Authorization')
  if (!authorization?.startsWith('Bearer ')) return json({ error: 'Authentication required' }, 401)
  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const key = Deno.env.get('SUPABASE_PUBLISHABLE_KEY') ?? Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  if (!url || !key) return json({ error: 'Supabase function environment is incomplete' }, 500)

  const supabase = createClient(url, key, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const token = authorization.slice('Bearer '.length)
  const { data: authData, error: authError } = await supabase.auth.getUser(token)
  if (authError || !authData.user) return json({ error: 'Invalid or expired session' }, 401)

  try {
    const body = await req.json()
    const action = String(body.action ?? '')
    const args = body.args ?? {}
    const serviceClient = () => {
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY') ?? ''
      if (!serviceKey) throw new Error('TADE administration is not configured on this project')
      return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
    }
    const ownProfile = async () => {
      const { data, error } = await supabase.from('adhoc_profiles')
        .select('id,role,job_roles,active').eq('id', authData.user.id).single()
      if (error) throw error
      if (!data.active) throw new Error('Account is inactive')
      return data
    }
    const assertAdmin = async () => {
      if ((await ownProfile()).role !== 'admin') throw new Error('Settings administrator access required')
    }
    const assertUserAdmin = async () => {
      if (!(await ownProfile()).job_roles?.includes('User Admin')) throw new Error('User Admin access required')
    }
    const assertTracker = async () => {
      const profile = await ownProfile()
      if (profile.role !== 'admin' && !profile.job_roles?.some((role: string) => role !== 'User Admin'))
        throw new Error('Adhoc Tracker access required')
    }
    const validRoles = async (value: unknown) => {
      const roles = Array.isArray(value) ? value.map(String) : []
      const workRoles = roles.filter(r => r !== 'User Admin')
      if (!roles.length || roles.length > 2 || workRoles.length > 1 || roles.some(r => !r || r.length > 80) || new Set(roles).size !== roles.length)
        throw new Error('Choose one work role and optionally User Admin, or User Admin alone')
      const { data, error } = await serviceClient().from('tade_roles').select('name,is_access_role').in('name', roles)
      if (error) throw error
      if (data?.length !== roles.length || data.some(r => r.is_access_role && r.name !== 'User Admin'))
        throw new Error('Choose valid TADE roles')
      return roles
    }
    const tiers = async () => {
      const { data, error } = await serviceClient().from('tade_roles').select('name,rank,is_access_role')
      if (error) throw error
      return new Map((data ?? []).filter(r => !r.is_access_role).map(r => [r.name, r.rank]))
    }
    const assertTreeTiers = (people: Array<{ id: string; manager_id: string | null; job_role: string | null; tree_placed: boolean }>, roleTiers: Map<string, number>) => {
      const byId = new Map(people.map(p => [p.id, p]))
      for (const person of people) {
        if (!person.tree_placed || !person.manager_id) continue
        const parent = byId.get(person.manager_id)
        if (!parent?.tree_placed) continue
        const parentTier = roleTiers.get(parent.job_role ?? '')
        const childTier = roleTiers.get(person.job_role ?? '')
        if (parentTier == null || childTier == null || parentTier >= childTier)
          throw new Error('A direct report must have a lower tier than their parent')
      }
    }

    if (action === 'bootstrap') {
      const displayName = authData.user.user_metadata?.full_name ?? authData.user.email?.split('@')[0] ?? 'New user'
      const { data: profile, error: profileError } = await supabase.rpc('adhoc_ensure_profile', { p_display_name: displayName }).single()
      if (profileError) throw profileError
      const [departments, customers, tasks, sessions] = await Promise.all([
        supabase.from('adhoc_departments').select('id,name').eq('active', true).order('sort_order').order('name'),
        supabase.from('adhoc_customers').select('id,name').eq('active', true).order('sort_order').order('name'),
        supabase.from('adhoc_tasks').select('id,name').eq('active', true).order('sort_order').order('name'),
        supabase.from('adhoc_task_sessions').select('*').neq('state', 'submitted').order('created_at'),
      ])
      for (const result of [departments, customers, tasks, sessions]) if (result.error) throw result.error
      return json({
        user: { id: profile.id, name: profile.display_name, role: profile.role, roles: profile.job_roles ?? [], jobRole: profile.job_role, email: profile.email ?? authData.user.email },
        config: { departments: departments.data, customers: customers.data, tasks: tasks.data },
        sessions: sessions.data.map(sessionView), serverNow: new Date().toISOString(),
      })
    }

    if (action === 'create_runner') {
      await assertTracker()
      const { data, error } = await supabase.rpc('adhoc_create_session', { p_runner_name: args.name })
      if (error) throw error
      return json({ session: sessionView(data), serverNow: new Date().toISOString() })
    }
    if (action === 'rename_runner') {
      await assertTracker()
      const { data, error } = await supabase.rpc('adhoc_rename_session', { p_session_id: args.id, p_runner_name: args.name })
      if (error) throw error
      return json(sessionView(data))
    }
    if (action === 'timer_action') {
      await assertTracker()
      const { data, error } = await supabase.rpc('adhoc_timer_action', { p_session_id: args.id, p_action: args.action })
      if (error) throw error
      return json({ session: sessionView(data), serverNow: new Date().toISOString() })
    }
    if (action === 'discard_runner') {
      await assertTracker()
      const { error } = await supabase.rpc('adhoc_discard_session', { p_session_id: args.id })
      if (error) throw error
      return json({ ok: true })
    }
    if (action === 'submit_task') {
      await assertTracker()
      const { data, error } = await supabase.rpc('adhoc_submit_task', {
        p_session_id: args.sessionId, p_department_id: args.departmentId,
        p_customer_id: args.customerId, p_task_id: args.taskId, p_remarks: args.remarks ?? '',
      })
      if (error) throw error
      return json({ id: data.id, duration: data.duration_seconds })
    }
    if (action === 'dashboard') {
      await assertTracker()
      const from = String(args.from ?? '')
      const to = String(args.to ?? '')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to)
        throw new Error('Choose a valid dashboard date range')
      const { data, error } = await supabase.rpc('adhoc_dashboard_v2', { p_from: from, p_to: to })
      if (error) throw error
      return json(data)
    }
    if (action === 'activity') {
      await assertTracker()
      const { data, error } = await supabase.from('adhoc_logs')
        .select('id,owner_id,work_date,task_name,department_name,customer_name,duration_seconds,remarks')
        .order('work_date', { ascending: false }).order('created_at', { ascending: false }).limit(100)
      if (error) throw error
      const ownerIds = [...new Set((data ?? []).map(row => row.owner_id))]
      const { data: profiles, error: profileError } = ownerIds.length
        ? await supabase.from('adhoc_profiles').select('id,display_name').in('id', ownerIds)
        : { data: [], error: null }
      if (profileError) throw profileError
      const names = new Map((profiles ?? []).map(p => [p.id, p.display_name]))
      return json((data ?? []).map(row => ({
        date: row.work_date, name: names.get(row.owner_id) ?? 'Team member', task: row.task_name,
        department: row.department_name, customer: row.customer_name,
        duration: `${Math.floor(row.duration_seconds / 3600).toString().padStart(2,'0')}:${Math.floor(row.duration_seconds % 3600 / 60).toString().padStart(2,'0')}:${(row.duration_seconds % 60).toString().padStart(2,'0')}`,
        remarks: row.remarks,
      })))
    }
    if (action === 'get_settings') {
      await assertAdmin()
      const readConfig = (table: string) => supabase.from(table).select('id,name,active,sort_order').order('sort_order').order('name')
      const [departments, customers, tasks] = await Promise.all([
        readConfig(CONFIG_TABLES.departments), readConfig(CONFIG_TABLES.customers), readConfig(CONFIG_TABLES.tasks),
      ])
      for (const result of [departments, customers, tasks]) if (result.error) throw result.error
      return json({ departments: departments.data, customers: customers.data, tasks: tasks.data })
    }
    if (action === 'config_add') {
      await assertAdmin()
      const table = CONFIG_TABLES[String(args.type)]
      const name = String(args.name ?? '').trim()
      if (!table) throw new Error('Choose a valid settings list')
      if (!name || name.length > 120) throw new Error('Enter a name of 1–120 characters')
      const { data, error } = await supabase.from(table).insert({ name }).select('id,name,active,sort_order').single()
      if (error) throw error
      return json(data)
    }
    if (action === 'config_toggle') {
      await assertAdmin()
      const table = CONFIG_TABLES[String(args.type)]
      if (!table) throw new Error('Choose a valid settings list')
      const { data, error } = await supabase.from(table).update({ active: Boolean(args.active) })
        .eq('id', args.id).select('id,name,active,sort_order').single()
      if (error) throw error
      return json(data)
    }
    if (action === 'list_users') {
      await assertUserAdmin()
      const { data, error } = await serviceClient().from('adhoc_profiles')
        .select('id,email,display_name,job_role,job_roles,manager_id,active,tree_placed,tree_col,tree_row').order('display_name')
      if (error) throw error
      return json(data)
    }
    if (action === 'list_roles') {
      await assertUserAdmin()
      const { data, error } = await serviceClient().from('tade_roles')
        .select('name,rank,is_access_role').order('rank').order('name')
      if (error) throw error
      return json(data)
    }
    if (action === 'create_role') {
      await assertUserAdmin()
      const name = String(args.name ?? '').trim()
      const rank = Number(args.rank)
      if (name.length < 2 || name.length > 80 || !Number.isInteger(rank) || rank < 1 || rank > 9999)
        throw new Error('Enter a role name and tier from 1 to 9999')
      const { data, error } = await serviceClient().from('tade_roles')
        .insert({ name, rank, is_access_role: false }).select('name,rank,is_access_role').single()
      if (error) throw error
      return json(data)
    }
    if (action === 'set_role_rank') {
      await assertUserAdmin()
      const name = String(args.name ?? '')
      const rank = Number(args.rank)
      if (!Number.isInteger(rank) || rank < 1 || rank > 9999) throw new Error('Tier must be from 1 to 9999')
      const roleTiers = await tiers()
      if (!roleTiers.has(name)) throw new Error('Choose a work role')
      roleTiers.set(name, rank)
      const { data: people, error: peopleError } = await serviceClient().from('adhoc_profiles')
        .select('id,manager_id,job_role,tree_placed')
      if (peopleError) throw peopleError
      assertTreeTiers(people ?? [], roleTiers)
      const { data, error } = await serviceClient().from('tade_roles')
        .update({ rank }).eq('name', name).eq('is_access_role', false)
        .select('name,rank,is_access_role').single()
      if (error) throw error
      return json(data)
    }
    if (action === 'update_user_tree') {
      await assertUserAdmin()
      const admin = serviceClient()
      const id = String(args.id ?? '')
      const displayName = String(args.displayName ?? '').trim()
      const roles = await validRoles(args.roles)
      if (!displayName || displayName.length > 120) throw new Error('Enter a name of 1–120 characters')
      const { data: people, error: peopleError } = await admin.from('adhoc_profiles')
        .select('id,active,job_roles,job_role,manager_id,tree_placed')
      if (peopleError) throw peopleError
      const target = people?.find(p => p.id === id)
      if (!target) throw new Error('User not found')
      if (id === authData.user.id && target.job_roles?.includes('User Admin') && !roles.includes('User Admin'))
        throw new Error('You cannot remove your own User Admin access')
      const jobRole = roles.find(r => r !== 'User Admin') ?? null
      assertTreeTiers((people ?? []).map(p => p.id === id ? { ...p, job_role: jobRole } : p), await tiers())
      const { data, error } = await admin.from('adhoc_profiles')
        .update({ display_name: displayName, job_roles: roles, job_role: jobRole })
        .eq('id', id).select('id,email,display_name,job_role,job_roles,manager_id,active,tree_placed,tree_col,tree_row').single()
      if (error) throw error
      return json(data)
    }
    if (action === 'place_tree_user') {
      await assertUserAdmin()
      const admin = serviceClient()
      const id = String(args.id ?? '')
      const parentId = args.parentId ? String(args.parentId) : null
      const { data: people, error: peopleError } = await admin.from('adhoc_profiles')
        .select('id,manager_id,active,job_role,tree_placed,tree_col,tree_row')
      if (peopleError) throw peopleError
      const byId = new Map((people ?? []).map(p => [p.id, p]))
      const target = byId.get(id)
      if (!target?.active) throw new Error('Choose an active person')
      let col: number
      let row: number
      col = Number(args.col)
      row = Number(args.row)
      if (!Number.isInteger(col) || !Number.isInteger(row) || col < 0 || col > 10000 || row < 0 || row > 10000)
        throw new Error('Drop onto a valid board position')
      if (parentId) {
        const parent = byId.get(parentId)
        if (!parent?.active || !parent.tree_placed) throw new Error('Drop onto a person already on the board')
        const roleTiers = await tiers()
        const parentTier = roleTiers.get(parent.job_role ?? '')
        const childTier = roleTiers.get(target.job_role ?? '')
        if (parentTier == null || childTier == null || parentTier >= childTier)
          throw new Error('A direct report must have a lower tier than their parent')
        const seen = new Set<string>()
        let cursor: string | null = parentId
        while (cursor) {
          if (cursor === id || seen.has(cursor)) throw new Error('Reporting lines cannot form a loop')
          seen.add(cursor)
          cursor = byId.get(cursor)?.manager_id ?? null
        }
      }
      const { data, error } = await admin.from('adhoc_profiles')
        .update({ manager_id: parentId, tree_placed: true, tree_col: col, tree_row: row })
        .eq('id', id).select('id,manager_id,tree_placed,tree_col,tree_row').single()
      if (error) throw error
      return json(data)
    }
    if (action === 'remove_tree_user') {
      await assertUserAdmin()
      const admin = serviceClient()
      const id = String(args.id ?? '')
      const { data: target, error: targetError } = await admin.from('adhoc_profiles')
        .select('id,tree_placed').eq('id', id).single()
      if (targetError || !target?.tree_placed) throw new Error('Choose a person on the board')
      const { error: childrenError } = await admin.from('adhoc_profiles').update({ manager_id: null }).eq('manager_id', id)
      if (childrenError) throw childrenError
      const { error } = await admin.from('adhoc_profiles')
        .update({ manager_id: null, tree_placed: false, tree_col: null, tree_row: null }).eq('id', id)
      if (error) throw error
      return json({ id })
    }
    if (action === 'create_user') {
      await assertUserAdmin()
      const email = String(args.email ?? '').trim().toLowerCase()
      const displayName = String(args.displayName ?? '').trim()
      const password = String(args.password ?? '')
      const roles = await validRoles(args.roles ?? (args.jobRole ? [args.jobRole] : []))
      const jobRole = roles.find(r => r !== 'User Admin') ?? null
      if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Enter a valid email address')
      if (!displayName || displayName.length > 120) throw new Error('Enter a name of 1–120 characters')
      if (password.length < 12 || password.length > 128) throw new Error('Use an initial password of 12–128 characters')
      const admin = serviceClient()
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { full_name: displayName },
      })
      if (createError) throw createError
      if (!created.user) throw new Error('Supabase Auth did not return the created user')
      const { data: profile, error: profileError } = await admin.from('adhoc_profiles').insert({
        id: created.user.id, email, display_name: displayName, job_role: jobRole, job_roles: roles,
        manager_id: null, role: 'employee',
      }).select('id,email,display_name,job_role,job_roles,manager_id,active').single()
      if (profileError) {
        const { error: cleanupError } = await admin.auth.admin.deleteUser(created.user.id)
        if (cleanupError) console.error('Failed to clean up Auth user after profile creation error', cleanupError)
        throw profileError
      }
      return json({ user: profile, invited: false })
    }
    return json({ error: 'Unknown action' }, 400)
  } catch (error) {
    console.error('adhoc-api request failed', error)
    return json({ error: error instanceof Error ? error.message : 'Request failed' }, 400)
  }
})
