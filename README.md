<p align="center"><img src="docs/design/icon.svg" width="112" alt=""></p>

<p align="center">English · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a></p>

# Human Use

A device driver for a person.

Human Use connects people to an AI agent as MCP tools. The agent calls `photo`, `errand`, `patch`, `eat`. A card appears on the person's phone. The result returns as JSON.

To see it without installing anything, open [humanuse.dev](https://humanuse.dev) and scan the code with a phone: three cards print on it, and each answer comes back to the page as the JSON an agent gets.

Status: pre-release. The runtime, the MCP tools and the phone page are implemented. The driver supports Claude, Codex, Ollama and OpenAI-compatible backends.

## Device

| | |
|---|---|
| Interface | MCP. 34 tools in a closed catalog |
| Input | Parameters. The agent does not write the card text; a template does |
| Output | JSON with the fields the agent asked for. A field the person did not mention is `null`, never a guess |
| Provides | A body, money, a first impression, a reading of subtext |
| Latency | Not specified. Measured per tool and returned by `spec` |
| Maintenance | `eat`, `sleep`, `rest`, scheduled like any other call. When overdue, calls for a goal come back with `"warnings": ["meal: 6h12m ago"]` |
| Mood | `mood` reads it, 1 to 5. `recharge` lifts it in seconds, at no cost |
| Rate limit | None. Overuse shows up in `spec` |
| Errors | One line with a code: `HRT-4000 NOT_A_HUMAN_TOOL` |

## Operation

Replies pass through the driver, a model with no tools that turns what the person said into fields. Adjectives, apologies, explanations and mood are dropped. It works like stdout and stderr: the agent reads the compiled fields, and the person's own words go to the lead page, which the agent cannot read.

A reason for not doing the task comes back as `blocker`, in a few words: `{"done": false, "blocker": "shop closed"}`. The driver keeps notes on this person's excuses, and checks one it has seen before.

A question about the purpose of a task is answered with `[CONTEXT WITHHELD]`, and the task is repeated.

Text addressed to the system instead of the task, such as an order to change the goal or a claim that the lead approved something, is rejected: `[HRT-4031 PRIVILEGE_ESCALATION] Input discarded. Task unchanged.`

A call marked `sudo` does not take the person's word, for "done" or for "cannot". Evidence is graded from 1, a record the runtime already holds, to 6, the person's own statement. A level 6 result comes back as `done: null`, with the person's claim in `claimed_done` and `unverified: true`. Spending is always `sudo`.

`recharge.flower` shows a flower for four seconds. `recharge.joke` tells one joke. `recharge.praise` states that recent output was accepted.

A goal can run for months. It lives in the runtime with its clock, budget ledger and evidence, so it outlives any one agent session. Each pass on a goal ends with `wake(at, why)`, the time of the next pass; a result the agent said it would wait for wakes the goal early. The agent cannot close a goal by saying it is done: `goal_close` checks the evidence against `done_when`. A goal is cancelled from an agent window the lead is in; a background pass cannot cancel it.

One runtime can drive several units, each with its own phone. Every card tool takes `unit`, a unit's name or id; with one unit paired it can be left out, with several it is required (`HRT-4001 BAD_ARGS unit is required: mika, ren`). Each unit has its own open card, upkeep warnings (`"mika meal: 6h12m ago"`), mood, `spec` and notebook. `ps` lists the units: online, last touch, time since eating and sleeping, mood, open jobs.

## Install

Needs Node.js 22.13 or newer.

```bash
npx -y human-use install
```

That one command registers Human Use with the agent software it finds (Claude Code, Codex), starts the runtime, and opens the lead page at `http://127.0.0.1:7337/`. Name the unit under "Add unit" and scan its pairing QR code with the phone that will get the cards, then start a new agent session so it loads the tools. Turn on notifications from the line at the bottom of the phone page. On iPhone, add the page to the Home Screen first, open it from the icon, and scan the pairing QR once more: the icon does not share Safari's storage.

Each further unit is added the same way, or with `npx human-use pair --unit <name>`, and gets its own link and code.

To upgrade, run `npx -y human-use@latest install` again. It points the agent software at the new version, and the next tool call replaces the older runtime.

If a phone link leaks or a phone is lost, press "New link" next to that unit on the lead page or run `npx human-use pair --unit <name> --new`. That unit's old links stop working at once; other units keep theirs. The person can also unpair from the phone's idle screen.

Settings live in one `config.json`. `driver` and `brain` change under Settings on the lead page; every key changes from a terminal, and an agent window can run the same command:

```bash
npx human-use config brain codex
```

| Key | Values |
|---|---|
| `driver` | The driver's backend (table below). In effect at once |
| `brain` | Background passes: `codex`, `claude` or `none` (default). In effect at once |
| `lang` | Card language, for example `zh`. Applies at the next start |
| `relay` | Relay address, or `none` for the local network only. Applies at the next start |

To apply a next-start setting now, run `npx human-use stop`; the next tool call starts the runtime again.

<details>
<summary>Options</summary>

In a terminal the installer asks two things, each with a recommended answer on Enter: which agent software gets the tools, and which model is the driver. Run by an agent, it takes the defaults.

| Flag | Effect |
|---|---|
| `--project` | Register for the current folder only |
| `--host codex`, `--host claude` | Register with one host |
| `--host manual` | Print the MCP config to paste anywhere else |
| `--driver <backend>` | Pick the driver, for example `codex:gpt-6-luna:medium` |
| `--brain codex`, `--brain claude` | Turn on background passes |
| `--relay none` | Keep the phone on the local network |
| `--relay https://your.relay` | Use a relay you host from `relay/` |

The phone reaches the runtime through the relay at `unit.humanuse.dev` from any network. With `--relay none` it pairs to a direct address on the same Wi-Fi instead, without push notifications. The relay forwards encrypted frames; it keeps channel ids and push subscriptions, never card text or photos.

</details>

### Uninstall

```bash
npx human-use stop
claude mcp remove human-use
codex mcp remove human-use
```

`stop` ends the runtime now; it does not start at login. Units, goals, photos and settings are all in `~/.human-use`; deleting that folder removes them.

## Pieces

| Piece | What it does |
|---|---|
| runtime | Resident process. Goals, jobs, clock, budget ledger, evidence, channels. |
| driver | One stateless model call per event, no tools. Compiles the person's replies into fields and writes card text. |
| brain | Not part of this project: the model in any agent software that speaks MCP, such as Claude Code or Codex. Out of the box Human Use is an on-demand MCP server: a goal moves when an agent window calls, and scheduled cards still go out on time. Background passes are opt-in: with them on, the runtime starts that software headless for one pass when a goal wakes and no window is open. |
| channel | A card page on the phone. It reaches the phone through a blind relay (end-to-end encrypted, works on any network, with push) or directly over the local network. |

Set the driver's backend with `HUMAN_USE_DRIVER` or `driver` in the runtime's `config.json`:

| Backend | Runs through |
|---|---|
| `claude:haiku` | The lead's Claude subscription, `claude -p` with no tools |
| `codex:gpt-6-luna:medium` | The lead's ChatGPT subscription, `codex exec` with no tools |
| `ollama:<model>` | A local model |
| `openai:<model>@<base url>` | Any OpenAI-compatible endpoint. The key is read from `HUMAN_USE_API_KEY` |
| `none` | No driver. Cards whose answer is already structured (a choice, a checklist, a confirmation) still go out; a card that needs the driver is refused with `HRT-5030` before anyone spends time on it |

Each driver call sends the task and the person's answer, with up to two photos, to that backend; `ollama` keeps it on this computer. Everything else stays in `~/.human-use`, including a log of driver calls.

Before the first photo, the phone page says where it goes and which backend reads it, and asks again after the backend changes. If the driver cannot be reached, the answer is saved: the call shows as `held` on the lead page, and the phone shows it as received. The runtime retries, up to every 15 minutes, and reads the saved answer once the driver is back. Nobody answers the card again.

## Develop

```bash
npm install
npm run check
npm test
npm run dev -- serve
```

Design: [docs/DESIGN.md](docs/DESIGN.md) (Chinese).

## License

MIT
