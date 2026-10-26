# Adhoc Tracker — conversation context and Supabase handoff

## What the user wants

Move the existing Google Sheets Adhoc Tracker into a Supabase Free tier account. The UI should be a desktop two-column work surface: **Task Builder** on the left and **Task Runner** on the right. The user asked for the full chat context and the HTML file to carry the work forward.

## Conversation history and decisions

1. The original tracker was a Google Apps Script web app backed by Google Sheets. The user asked for both `Code.gs` and HTML, with Start and End buttons that use server time, a live timer, refresh persistence, and a best-effort keep-awake behavior.
2. The user then proposed a different workflow: Task Builder on the left; Task Runner on the right; start/stop first, then fill in department and other task details after stopping. They want multiple runner cards.
3. The agreed enhancement was to support runner states (ready, running, paused, stopped/awaiting details, submitted), pause/resume, and at most one actively running timer per account to avoid double-counting. Switching work means pause one runner and start/resume another.
4. Prior app behavior the user wanted preserved: login; role-based reporting hierarchy; Dashboard; owner-only task edits; Department/Customer/Task configuration; fast login and reporting.
5. The requested Apps Script implementation added a `Task Sessions` sheet, server timestamps for timer operations, accumulated active seconds, a stopped-session queue, moving a stopped runner into Task Builder, saving a final task to `Adhoc Log` with session linkage, restoration after refresh, Wake Lock where supported, concurrency locking, duplicate-submit protection, and caching.
6. In the current conversation, the user asked whether the Google Sheet would be changed. The answer was: not by generating these files; the sheet changes only when setup is run (to create missing tabs) and when the app is used to save tasks. The user also asked how multiple runners work; the answer clarified they may create multiple runners but only one can count time at a time.
7. The latest request is to carry the chat context and HTML into a Supabase Free tier migration.

## Current delivered files

- `Index.html` — current Apps Script front end.
- `Code.gs` — current standalone Apps Script backend.
- `Adhoc_Tracker_GAS_Files.zip` — both Apps Script files.

The HTML is provided separately at `Index.html` so it can be inspected and used as a visual/behavioral reference during a rewrite.

## Important migration note

The existing HTML is **not a Supabase-ready client**. It invokes Apps Script through `google.script.run` and depends on the functions in `Code.gs`. The Supabase migration needs a replacement backend integration, not merely a configuration change. Reuse the UI and workflow as a reference, replace the RPC calls with Supabase Auth and database/RPC calls, and remove Apps Script-only APIs.

Do not expose a Supabase service-role/secret key in browser code. Use the public/publishable client key in the browser and enforce data access with Row Level Security (RLS). The Edge Function uses a server-side service-role/secret key only for Auth Admin invitations. Keep authorization roles in trusted database data or server-controlled app metadata, not user-editable profile metadata.

## Suggested Supabase data model

- `profiles`: `id` (same UUID as `auth.users.id`), display name, role, manager relationship, active flag.
- `departments`, `customers`, `tasks`: lookup/configuration tables with active flags and ordering as needed.
- `task_sessions`: owner UUID, runner name, state, start/resume/stop timestamps, accumulated active seconds, work date, and optional submitted log reference.
- `adhoc_logs`: owner UUID, work date, department/customer/task references or text snapshots, start/end timestamps, active duration seconds, remarks, linked session UUID, created/updated timestamps.

Add database constraints/indexes for valid session states and to enforce at most one `running` session per user (for example a partial unique index). Timer transitions and final submission should be atomic database operations so concurrent tabs or requests cannot start two timers or submit the same stopped session twice. RLS should enforce row ownership; manager/admin reporting access should be implemented deliberately and tested against the reporting hierarchy. Edits to log rows should be owner-only unless a separately specified administrator policy is desired.

## Migration goals/checklist

1. Preserve the two-column Task Builder / multi-runner experience and its responsive behavior.
2. Replace login with Supabase Auth; plan password migration/reset because the current app has its own password field and hash compatibility path. Never move plaintext passwords or reusable legacy hashes into a public table.
3. Preserve Department/Customer/Task configuration and reporting roles/hierarchy.
4. Persist runner state in Postgres, with server/database timestamps and accumulated active seconds.
5. Restore ready/running/paused/stopped runners after reload; provide best-effort Screen Wake Lock only in the browser.
6. Move a stopped runner into Task Builder, then atomically create the final log and mark its session submitted.
7. Keep Dashboard lazy-loaded and restrict rows through RLS / safe server-side queries.
8. Decide whether existing Sheets data should be imported. No spreadsheet has been edited or connected by the work in this chat.
9. Verify current Supabase limits and product guidance at implementation time; free-tier limits and dashboard settings can change.

## What has and has not happened

The Apps Script files remain a prototype/reference for the migration and should not be represented as the Supabase implementation.

## Supabase continuation (2026-10-26)

The project now includes a first Supabase implementation in this folder:

- `index.html` now uses Supabase Auth and invokes the `adhoc-api` Edge Function instead of `google.script.run`.
- `supabase/migrations/20261026090229_adhoc_tracker_core.sql` defines `adhoc_`-prefixed tables, RLS, reporting helpers, and atomic timer/submission functions.
- `supabase/functions/adhoc-api/index.ts` implements bootstrap, runner actions, task submission, dashboard, and recent activity.
- `SUPABASE_SETUP.md` contains migration, provisioning, and setup steps.

The Supabase connector showed one pre-existing project, `sadiq.a@talview.com's Project` (`uktjswryldxxxspuwdqq`), which contains a separate booking/proctor application. At the user's direction, a separate project was created and used instead. The existing project was not changed.

## New Supabase project deployment (2026-10-26)

- Project: `Adhoc Tracker` (`edlpujkyxjcubvjdcmle`) in `talview-Operations`, region `ap-south-1` (Mumbai).
- Quoted project cost at creation: `$0/month`.
- Migration `adhoc_tracker_core` applied successfully.
- Follow-up migrations added foreign-key indexes and moved internal reporting/admin RLS helpers to a non-exposed schema.
- Edge Function `adhoc-api` deployed and active with JWT verification enabled.
- `index.html` is configured with the new project's API URL and publishable key.
- The login screen is branded **Talview TADE** and identifies Adhoc Tracker as a module. The Supabase dashboard project rename to **TADE** is still pending; the dashboard currently reports the project name as **Adhoc Tracker**.
- `SUPABASE_SETUP.md` describes initial Auth user provisioning and adding lookup data.
- Six tables exist in the new project's `public` schema: `adhoc_profiles`, `adhoc_departments`, `adhoc_customers`, `adhoc_tasks`, `adhoc_task_sessions`, and `adhoc_logs`. The lookup tables start empty, so the dropdowns show no options until an admin adds records.
- The HTML sidebar is organized under the **ADHOC TRACKER** app heading and includes **Work**, **Dashboard**, **Settings**, and **Users**. Settings manages Departments, Customers, and Tasks; active records populate their corresponding Task Builder dropdowns. Users invites people by email and assigns one of the ten requested business roles.
- Settings and Users are admin-only. The first profile in this project is currently an active employee profile with no job role, so those entries remain hidden until an admin is designated. The setup guide contains the promotion SQL.

No Google Sheet has been modified and no legacy data or passwords have been imported. Initial setup is still needed: designate the first admin, then seed departments/customers/tasks and invite team users. An automatic approval review rejected promoting the only existing profile because no target account had been explicitly authorized for that privilege change. Ask the user to confirm the account email before promoting it.
