# Deploy the relay

Build from this directory with Wrangler. The deployer uploads the JavaScript program and the phone assets. The build below does not need Cloudflare credentials.

```sh
npx --yes wrangler@4.80.0 deploy --config wrangler.jsonc --dry-run --outdir dist
```

| Setting | Value |
| --- | --- |
| Existing Worker | `human-use-relay` |
| Custom domain | `unit.humanuse.dev` |
| Main module | `dist/worker.js` |
| Compatibility date | `2026-04-08` |
| Durable Object binding | `CHANNELS` → `Channel` in this Worker |
| Initial migration | `v1` with `new_sqlite_classes: ["Channel"]` |
| Static assets binding | `ASSETS` with `run_worker_first: true`, `html_handling: "none"` |
| Version metadata binding | `VERSION` |

Upload these ten files from `../assets` at the origin root: `unit.html`, `ui.css`, `relay-client.mjs`, `relay-wire.mjs`, `relay-sw.js`, `manifest.webmanifest`, `icon-192.png`, `icon-512.png`, `jsqr.js` (the pairing QR scanner) and `jsqr.LICENSE.txt`. `.assetsignore` keeps `owner.html` and the type declarations out. With the Cloudflare API, upload the assets first and include the resulting assets JWT and the `ASSETS` binding in the Worker upload metadata. Keep the existing custom domain on the Worker. Wrangler's source map is optional.

The Worker injects `data-relay` into the HTML it serves at `/`, set to the deploy's version id. The page asks for `ui.css` and `relay-client.mjs` with `?v=<that id>`, and the Worker rewrites the client's import of `relay-wire.mjs` to carry the same id, so one page never loads files from two deploys (an iPhone once paired a new client with a cached old wire module). URLs naming the current deploy are cached as immutable; any other `?v=` gets `no-store`. It also sends a `Content-Security-Policy` built from the page being served: the hashes of its inline script and style, same-origin everything else, WebSocket only to this host. The browser reads the secret from the fragment. The Durable Object stores two SHA-256 token hashes and forwards binary application frames.

`POST /channel/<id>/retire` with the runtime's bearer token replaces the stored hashes with a tombstone and closes every socket on the channel with code 4003. After that, registration answers 410 and a phone socket is accepted only to be closed with 4003, which the page shows as a replaced link. The runtime calls it when the lead asks for a new link for a unit. Each unit has its own channel, so retiring one leaves the other units connected.

The try-it panel on `humanuse.dev` acts as a runtime from the browser. `register` and `retire` answer CORS preflights and carry `Access-Control-Allow-Origin: *`; nothing on the relay uses cookies, so no origin gains anything a script outside a browser lacks. A registration with `X-Human-Use-Trial: 1` sets a Durable Object alarm one hour out, which closes the channel's sockets with 4003 and deletes its storage. The panel's phone link ends in `.try`: the phone page does not save it, does not set up notifications, and on 4003 says the trial ended.

The `humanuse.dev` zone has one rate-limiting rule: paths starting with `/channel/` are limited to 30 requests per IP per 10 seconds, blocked for 10 seconds after that.

Without Wrangler credentials, deploy through the API: open an assets upload session with the manifest (hash is the first 32 hex characters of SHA-256 over the base64 content plus the extension without the dot), upload only the buckets it returns, then PUT the script as multipart with `main_module`, the three bindings (`durable_object_namespace`, `assets`, `version_metadata`) and `assets: { jwt, config }`. Leave out `migrations` on updates. The phone link grants the phone role and contains the encryption secret. The runtime derives its authorization token from a separate local secret. The phone page and scripts are served by the relay origin, so the browser trusts that origin to serve the expected client code.

The runtime stores each unit's pairing identity and push subscription under `HUMAN_USE_HOME/units/<id>/`, and one set of VAPID keys in `HUMAN_USE_HOME`. Push subscriptions go to the runtime over the encrypted connection, and the runtime sends the generic notification directly to the browser's push provider. The Android/iOS acceptance tests use `https://unit.humanuse.dev`, with the iPhone page added to the Home Screen.

For a local test, start Wrangler from this directory:

```sh
npx --yes wrangler@4.80.0 dev --config wrangler.jsonc --port 7390
```

From the repository root, run `npm run build` followed by `node scripts/relay-check.mjs http://127.0.0.1:7390`. The check uses its own runtime state, a scripted driver and a simulated push provider.

The lead page listens on the runtime's loopback address (default `http://127.0.0.1:7337/`). It uses `GET /owner/status`, `POST /owner/units` (add a unit by name), `GET /owner/pair?unit=<name>`, `POST /owner/pair/new` (body `{"unit": "<name>"}`), `GET /owner/goals`,
 `POST /owner/goals`, `POST /owner/goals/cancel`, `GET /owner/evidence/<id>` and `POST /owner/settings`. The `human-use goal` commands use the same goal endpoints. The call log records runtime requests and responses in the local database. Saved settings take effect when the runtime next starts. Environment variables still take precedence.
