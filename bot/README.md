# Report bot

`bot.humanuse.dev` takes the error codes and wishes that agents send after their lead agreed, and posts them to `human-use/human-use` as comments from the GitHub App `human-use-reports`. Each HRT code gets one issue, and each ISO week of wishes gets one issue. The weekly pass over these issues decides what the next registry and catalog update contains.

```http
POST https://bot.humanuse.dev/report
Content-Type: application/json

{ "kind": "code", "code": "HRT-4000", "tool": "hug", "text": "Called a tool the catalog does not have.", "version": "0.1.0", "host": "Codex" }
```

`kind` is `code` or `wish`. `text` is one sentence about the system, at most 280 characters, and is folded to one line. Before it is posted, it is escaped so it cannot mention anyone, link anywhere, reference an issue or carry markup. `GET /report` returns the format. `GET /report?code=HRT-NNNN` and `GET /report?kind=wish` return the issue those reports go to, so a lead who would rather post from their own GitHub account can comment there with `gh`.

The bot stores the app's key, the installation token, the issue numbers and the day's counts. Each address gets 10 reports a day and the bot accepts 300 a day in total. Addresses are counted only as a hash salted with the date, and the previous day's counts are deleted on the first report of a new day. Nothing else about a sender is stored.

## Deploy

| Setting | Value |
| --- | --- |
| Worker | `human-use-bot` |
| Custom domain | `bot.humanuse.dev` |
| Modules | `worker.mjs` (main), `lib.mjs` |
| Compatibility date | `2026-04-08` |
| Durable Object binding | `BOT` → `Bot` in this Worker |
| Initial migration | `v1` with `new_sqlite_classes: ["Bot"]` |

With Wrangler credentials, run `npx --yes wrangler@4.80.0 deploy --config wrangler.jsonc`. Without them, PUT the script through the API as multipart: the metadata plus both modules as `application/javascript+module`. Leave out `migrations` on updates.

To try it locally, run `npx --yes wrangler@4.80.0 dev --config wrangler.jsonc`. Run `node check.mjs` to test the input rules, the escaping and the app JWT.

## Set up the GitHub App

An owner of the `human-use` organization opens `https://bot.humanuse.dev/setup` and presses the button. GitHub then creates the app from a manifest: it can write issues and nothing else, and it has no webhook. GitHub returns a one-time code to `/setup/done`, and the bot exchanges that code for the app's private key. The key never passes through a person or a file. The bot refuses an app owned by anyone other than `human-use`. GitHub then asks where to install it. Choose only `human-use/human-use`, and `/setup/installed` fetches a first token to confirm.

To replace the key, delete the app on GitHub and clear the Durable Object's storage by deploying with a `deleted_classes` migration followed by a fresh `new_sqlite_classes` one. Then run setup again.
