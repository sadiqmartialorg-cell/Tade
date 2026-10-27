# TADE

Adhoc Tracker is a module inside Talview TADE. The frontend is a static HTML app backed by the separate TADE Supabase project (`edlpujkyxjcubvjdcmle`).

## Deploy on Vercel

The live app is at **https://tade-one.vercel.app/**. The Vercel `tade` project is connected to this GitHub repository; pushes to `main` deploy automatically. `vercel.json` copies the static app into `dist`, the only directory Vercel publishes.

The TADE Supabase Auth **Site URL** and an allowed redirect URL are set to `https://tade-one.vercel.app/`. The browser uses only the Supabase publishable key. Keep service-role/secret keys in Supabase Edge Function secrets; never add them to this repository or Vercel's frontend build environment.

## Supabase setup

See [SUPABASE_SETUP.md](SUPABASE_SETUP.md) for the new-project details, Auth setup, initial admin, and lookup configuration. The existing booking/proctor Supabase project is separate and is not used by this app.

## Local preview

Serve the repository root with any static HTTP server, then open the served URL. For example, with Python installed:

```sh
python3 -m http.server 8080
```
