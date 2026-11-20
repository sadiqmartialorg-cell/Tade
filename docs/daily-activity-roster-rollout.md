# Daily Activity and Roster rollout

## Prepared changes

- Migration `20261120144359_daily_activity_roster.sql` registers two sidebar modules and creates activity schedules, check instances, owner changes, extension requests, roster drafts/published shifts, inbox messages, push subscriptions, audit events, and a generation cursor.
- Existing MS Tracker customer IDs are required on every activity. The migration does not copy or modify customer rows.
- User Admin assigns Daily Activity and Roster sidebar access using the existing user creation/edit controls. No account receives these grants automatically.
- A service-role-only Edge Function handles user actions, roster publish, and reminder ticks. User actions validate Supabase Auth tokens and module grants. The tick validates a short-lived GitHub OIDC identity token.
- A GitHub Actions workflow calls the tick every five minutes. Web push uses a stable, domain-separated VAPID key derived inside the Edge Function from its service-role secret.

## Production sequence after approval

1. Apply the migration in the WorkLog Supabase project `edlpujkyxjcubvjdcmle`.
2. Deploy the updated `adhoc-api` and new `worklog-operations` Edge Functions. Deploy `worklog-operations` with `verify_jwt=false`; its handler validates user JWTs and the scheduled secret itself.
3. Push the reviewed frontend, Edge Function, migration, and GitHub Actions workflow to the WorkLog repository. Vercel deploys the static app from the default branch.
4. Give pilot users the two module grants in Users, then verify the three-check scenario, roster gap preview/publish, extension approval, inbox, and opted-in push on the deployed app.

## Expected behavior and limits

- A completed or missed check remains a separate dated record. Owner changes update only open instances on or after the selected date.
- Roster preview prevents publishing when no primary or backup shift covers a check. It also shows early primary and final coverage cutoffs. Overnight shifts use the date on which the shift starts.
- Reminder generation stores a 14-day horizon and advances it once per day. GitHub's scheduler can delay or drop runs under load, and public-repository schedules are disabled after 60 days of repository inactivity. It is suitable for approximate five-minute reminders, not a strict SLA.
- Rotating the Supabase service-role key also rotates the derived VAPID key. Users must enable push again after such a rotation.
- The migration preserves activity and audit records when a user is deleted by setting user references to null. It removes that user's roster rows, inbox messages, and push subscriptions.
