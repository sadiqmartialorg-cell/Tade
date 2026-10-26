# Adhoc Tracker — Supabase setup

This folder now contains the first Supabase-backed implementation of the Apps Script tracker.

## Files

- `index.html` — browser UI. Uses Supabase Auth for sign-in and invokes `adhoc-api` for app operations. The old mixed-case local URL still opens on case-insensitive macOS filesystems.
- `supabase/migrations/` — isolated `adhoc_` tables, RLS policies, job roles, and atomic timer/submission RPCs.
- `supabase/functions/adhoc-api/index.ts` — authenticated Edge Function for bootstrap, runners, settings, user invitations, dashboard, and reporting.
- `supabase/config.toml` — enables JWT verification for the function.

## Target project

The Adhoc Tracker module has its own Supabase project in the `talview-Operations` organization. The requested Supabase dashboard project name is **TADE** (the project is currently still named **Adhoc Tracker** in the dashboard):

- Project ref: `edlpujkyxjcubvjdcmle`
- Region: `ap-south-1` (Mumbai)
- API URL: `https://edlpujkyxjcubvjdcmle.supabase.co`
- Quoted project cost at creation: `$0/month`

The existing booking/proctor project (`uktjswryldxxxspuwdqq`) was not changed.

## Apply to the intended project

The initial migration and `adhoc-api` Edge Function have already been applied/deployed to the new project. For later local changes, link the CLI to this project and deploy updates:

```sh
supabase link --project-ref edlpujkyxjcubvjdcmle
supabase db push
supabase functions deploy adhoc-api
```

Most operations use the caller's Authorization header and publishable/anon key, with Postgres RLS enforcing access. The user invitation action also uses a Supabase service-role/secret key from the Edge Function's server-side environment to call the Auth Admin API. Never put that key in `index.html` or any browser code.

## Initial account and configuration

1. Create or invite the first owner account in Supabase Auth and sign into the app once. The `bootstrap` action creates that user's profile.
2. Promote the intended owner to app admin in the SQL editor, replacing the email with the account email:

   ```sql
   update public.adhoc_profiles p
   set role = 'admin'
   from auth.users u
   where p.id = u.id and lower(u.email) = lower('owner@example.com');
   ```

3. Sign out and back in. The **Settings** and **Users** side-nav entries are shown to app admins. Use **Settings** to add Departments, Customers, and Tasks; active entries immediately populate the Task Builder dropdowns. Inactive entries remain available for historical logs. The main side navigation contains **Work**, **Dashboard**, **Settings**, and **Users** under the **ADHOC TRACKER** app heading, leaving room for additional workspace apps later.
4. Use **Users** to invite team members by email, assign a job role, and optionally choose a reporting manager. Supabase sends the invitation email.
5. The job roles are `Manager`, `Senior Team Lead`, `Team Lead`, `Associate Team Lead`, `Management Trainees`, `Reporting Analyst`, `Workforce Coordinator`, `Learning and Development`, `Proctor`, and `Super Proctor`. The internal `admin` role controls settings and invitations; it is separate from the job role and is not selectable in the invitation form.
6. The project's URL and publishable key are configured at the top of `index.html`.
7. Deploy the repository root on Netlify using the included `netlify.toml`. After Netlify assigns the site URL, set Supabase Auth's Site URL and Redirect URLs to that HTTPS origin so sign-in and invitation links return to the app.

If the Users page shows an invitation error, verify that the Edge Function has access to the Supabase service role key. That key must remain server-side and must never be copied into `index.html`.

## Current scope

The timer transitions use database timestamps, a partial unique index enforces one running runner per account, and task submission inserts the log and marks its stopped session submitted in one database transaction. Reporting queries are filtered by the RLS owner/manager hierarchy. Existing Google Sheets rows and legacy password hashes are not imported. Users need Supabase Auth credentials; do not copy legacy hashes into a public table.

Department/customer/task values are managed in the browser Settings tab. Migration of existing Sheets history and any changes to the connected booking/proctor project remain separate work.
