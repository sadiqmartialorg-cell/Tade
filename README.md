# Talview TADE · Adhoc Tracker

Adhoc Tracker is a module inside Talview TADE. The frontend is a static HTML app backed by the separate TADE Supabase project (`edlpujkyxjcubvjdcmle`).

## Deploy on Netlify

Connect this repository to Netlify and use the repository root as the publish directory. `netlify.toml` contains the static publish and single-page fallback configuration. Netlify will deploy each push to the connected branch.

After the first deploy, set the Supabase Auth **Site URL** to the Netlify production URL and add that URL to **Redirect URLs**. The browser uses only the Supabase publishable key. Keep service-role/secret keys in Supabase Edge Function secrets; never add them to this repository or Netlify's frontend build environment.

## Supabase setup

See [SUPABASE_SETUP.md](SUPABASE_SETUP.md) for the new-project details, Auth setup, initial admin, and lookup configuration. The existing booking/proctor Supabase project is separate and is not used by this app.

## Local preview

Serve the repository root with any static HTTP server, then open the served URL. For example, with Python installed:

```sh
python3 -m http.server 8080
```
