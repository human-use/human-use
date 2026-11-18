# Deploy the site

`site/` is the whole site at `humanuse.dev`: static files with no build step, served by an assets-only Worker. This directory holds only its Wrangler config, because Wrangler writes its local state next to the config and would otherwise watch its own writes inside the assets.

| Setting | Value |
| --- | --- |
| Worker | `human-use-site`, assets only, no script |
| Custom domain | `humanuse.dev` |
| Compatibility date | `2026-04-08` |
| Assets | every file in `../site` |
| `html_handling` | `auto-trailing-slash`: `/codes` → `/codes/`, `/index.html` → `/` |
| `not_found_handling` | `404-page`: `site/404.html` with status 404 |
| Headers | `site/_headers`: `nosniff`, a referrer policy and a content security policy everywhere; `install.md`, `llms.txt` and `codes.json` get a UTF-8 content type and `Access-Control-Allow-Origin: *` so agents can fetch them from anywhere |

With Wrangler credentials, run from this directory:

```sh
npx --yes wrangler@4.80.0 deploy --config wrangler.jsonc
```

To try it locally, `npx --yes wrangler@4.80.0 dev --config wrangler.jsonc --port 7397`.

Without Wrangler credentials, deploy through the API: open an assets upload session with the manifest of every file in `site/` except `_headers` (hash is the first 32 hex characters of SHA-256 over the base64 content plus the extension without the dot), upload only the buckets it returns, then PUT the Worker with metadata `{ compatibility_date, assets: { jwt, config: { html_handling, not_found_handling, _headers } } }`, where `_headers` is the file's text. Attach `humanuse.dev` as the Worker's custom domain. The zone's MX and TXT records stay as they are.

`www.humanuse.dev` is a proxied `AAAA 100::` record and a zone redirect rule: 301 to `https://humanuse.dev` with the path and query kept.

Three files are generated from the runtime and must be redone when their source changes:

- `site/codes/index.html` from `site/codes.json`: `node scripts/codes-page.mjs`. `test/codes.test.ts` fails when they differ.
- `var CATALOG` in `site/index.html` mirrors `src/catalog.ts`. `test/site.test.ts` fails when they differ.
- `site/og.png`, the link preview, from `scripts/og.html`. The steps are in that file.

The try-it panel in the hero is `site/try.js`. The page runs a runtime with one unit for one visit: it registers a channel on the relay at `unit.humanuse.dev` (the relay answers CORS for `register` and `retire`), shows the phone link as a QR code drawn by `site/qr.js`, and sends three calls whose cards close without a model: `choose`, `mood`, `checklist`. The link ends in `.try`, so the phone page keeps it out of storage and asks for no notifications, and the relay deletes the channel an hour after it was registered. The content security policy allows `https://unit.humanuse.dev` and `wss://unit.humanuse.dev` for this. Served from `127.0.0.1` or `localhost`, the panel uses a local relay on port 7390 instead. `site/relay-wire.mjs` is a copy of `assets/relay-wire.mjs`; `test/qr.test.ts` fails when they differ, and scans the QR codes back with jsQR.

The report bot at `bot.humanuse.dev` reads code names from `https://humanuse.dev/codes.json`, so a new code's name reaches its issue title once the site carries it.
