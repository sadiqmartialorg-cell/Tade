import { createClient } from 'npm:@supabase/supabase-js@2.57.0'

const JOB_ROLES = [
  'Manager', 'Senior Team Lead', 'Team Lead', 'Associate Team Lead',
  'Management Trainees', 'Reporting Analyst', 'Workforce Coordinator',
  'Learning and Development', 'Proctor', 'Super Proctor',
]
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
    const assertAdmin = async () => {
      const { data: profile, error } = await supabase.from('adhoc_profiles')
        .select('role,active').eq('id', authData.user.id).maybeSingle()
      if (error) throw error
      if (!profile?.active || profile.role !== 'admin') throw new Error('Administrator access required')
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
        user: { id: profile.id, name: profile.display_name, role: profile.role, jobRole: profile.job_role, email: profile.email ?? authData.user.email },
        config: { departments: departments.data, customers: customers.data, tasks: tasks.data },
        sessions: sessions.data.map(sessionView), serverNow: new Date().toISOString(),
      })
    }

    if (action === 'create_runner') {
      const { data, error } = await supabase.rpc('adhoc_create_session', { p_runner_name: args.name })
      if (error) throw error
      return json({ session: sessionView(data), serverNow: new Date().toISOString() })
    }
    if (action === 'rename_runner') {
      const { data, error } = await supabase.rpc('adhoc_rename_session', { p_session_id: args.id, p_runner_name: args.name })
      if (error) throw error
      return json(sessionView(data))
    }
    if (action === 'timer_action') {
      const { data, error } = await supabase.rpc('adhoc_timer_action', { p_session_id: args.id, p_action: args.action })
      if (error) throw error
      return json({ session: sessionView(data), serverNow: new Date().toISOString() })
    }
    if (action === 'discard_runner') {
      const { error } = await supabase.rpc('adhoc_discard_session', { p_session_id: args.id })
      if (error) throw error
      return json({ ok: true })
    }
    if (action === 'submit_task') {
      const { data, error } = await supabase.rpc('adhoc_submit_task', {
        p_session_id: args.sessionId, p_department_id: args.departmentId,
        p_customer_id: args.customerId, p_task_id: args.taskId, p_remarks: args.remarks ?? '',
      })
      if (error) throw error
      return json({ id: data.id, duration: data.duration_seconds })
    }
    if (action === 'dashboard') {
      const { data, error } = await supabase.rpc('adhoc_dashboard')
      if (error) throw error
      return json(data)
    }
    if (action === 'activity') {
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
      await assertAdmin()
      const { data, error } = await supabase.from('adhoc_profiles')
        .select('id,email,display_name,job_role,manager_id,active').order('display_name')
      if (error) throw error
      return json(data)
    }
    if (action === 'create_user') {
      await assertAdmin()
      const email = String(args.email ?? '').trim().toLowerCase()
      const displayName = String(args.displayName ?? '').trim()
      const password = String(args.password ?? '')
      const jobRole = String(args.jobRole ?? '')
      const managerId = args.managerId ? String(args.managerId) : null
      if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('Enter a valid email address')
      if (!displayName || displayName.length > 120) throw new Error('Enter a name of 1–120 characters')
      if (password.length < 12 || password.length > 128) throw new Error('Use an initial password of 12–128 characters')
      if (!JOB_ROLES.includes(jobRole)) throw new Error('Choose a valid job role')
      if (managerId) {
        const { data: manager, error } = await supabase.from('adhoc_profiles')
          .select('id').eq('id', managerId).eq('active', true).maybeSingle()
        if (error) throw error
        if (!manager) throw new Error('Choose an active reporting manager')
      }
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY') ?? ''
      if (!serviceKey) throw new Error('Supabase Auth user creation is not configured on this project')
      const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email, password, email_confirm: true, user_metadata: { full_name: displayName },
      })
      if (createError) throw createError
      if (!created.user) throw new Error('Supabase Auth did not return the created user')
      const { data: profile, error: profileError } = await admin.from('adhoc_profiles').insert({
        id: created.user.id, email, display_name: displayName, job_role: jobRole,
        manager_id: managerId, role: 'employee',
      }).select('id,email,display_name,job_role,manager_id,active').single()
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
