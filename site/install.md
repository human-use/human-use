# Install Human Use

You are an agent. These steps give you people as MCP tools. Each person is a unit with a phone: a card goes to the unit's phone and the result comes back to you as JSON.

## 1. Install

Needs Node.js 22.13 or newer.

```bash
npx -y human-use@latest install
```

It registers the `human-use` MCP server with the agent software it finds (Claude Code, Codex), starts the runtime, and opens the lead page at `http://127.0.0.1:7337/`. It takes the defaults when no one is at the terminal. It prints the version it installed; the lead page shows the one running. To upgrade, run the same command again: the host entry moves to the new version and the next tool call replaces the older runtime.

| Flag | Effect |
|---|---|
| `--host codex`, `--host claude` | Register with one host only |
| `--host manual` | Print the MCP config to paste into any other host |
| `--project` | Register for the current folder only |
| `--driver <backend>` | The model that compiles a unit's replies, for example `codex:gpt-6-luna:medium` or `claude:haiku` |
| `--brain codex`, `--brain claude` | Turn on background passes (see `brain` below) |
| `--relay none` | Keep the phones on the local network |
| `--no-open` | Do not open the lead page |

## 2. Add units and pair their phones

A unit is a person paired with the runtime: someone on the lead's team, or the lead. The lead names each one under "Add unit" on the lead page and scans that unit's QR code with the phone that will get its cards. From a terminal:

```bash
npx human-use pair --unit mika
```

A new name adds the unit. It prints the unit's link, with a QR code in a terminal, and a pairing code for the same Wi-Fi. On iPhone the person adds the page to the Home Screen first, opens it from the icon, and scans the QR code once more. They turn on notifications from the line at the bottom of the page.

If a link leaks or a phone is lost, `npx human-use pair --unit mika --new` retires that unit's old links. Other units keep theirs.

## 3. Start a new session

The tools load when a session starts. In the new session the server's instructions and each tool's description tell you how to call a unit. Every card tool takes `unit`, a name or id. With one unit it can be left out; with several it is required.

## Settings

One `config.json`. The lead changes `driver` and `brain` under Settings on the lead page; any key changes with:

```bash
npx human-use config <key> <value>
```

| Key | Values |
|---|---|
| `driver` | The driver's backend. In effect at once |
| `brain` | Background passes: `codex`, `claude` or `none` (default). With them on, the runtime starts your agent software for one pass when a goal wakes and no window is open. In effect at once |
| `lang` | Card language, for example `zh`. Next start |
| `relay` | Relay address, or `none`. Next start |

Settings are the lead's. Change one when the lead asks. A next-start setting applies after `npx human-use stop`; the next tool call starts the runtime again.

## When the driver is missing or down

With `driver` set to `none`, cards whose answer is already structured go out as usual: `choose`, `checklist`, `go`, `mood`, `eat`, `sleep`, `rest`, `act`, `remind`, `recharge`. Any other card is refused with `HRT-5030` before a unit spends time on it; tell the lead a driver is needed.

If the driver cannot be reached after a unit answers, the job stays in review with `held`. The answer is saved, the runtime retries, and `wait` returns the result once the driver is back. Do not send the card again.

A photo is read only by the backend its unit agreed to. If the lead changes the driver while a photo is held, the job stays held until the unit answers on the phone. If the unit does not send it, the job is escalated and the photo stays on this computer.

## What leaves the computer

The runtime runs on this computer. Units, goals, answers, photos and a log of driver calls stay in `~/.human-use`.

Each driver call sends the task and the unit's answer, with up to two photos, to the backend the lead chose. With `ollama` it stays on this computer. Before a unit's first photo, the phone page says where it goes and which backend reads it, and asks again after the backend changes, also for a photo sent but not yet read.

Phones reach the runtime through the relay at `unit.humanuse.dev`, which forwards end-to-end encrypted frames. It keeps channel ids and push subscriptions, never card text or photos. With `relay` set to `none`, phones pair to a direct address on the same Wi-Fi, without push notifications.

Source: https://github.com/human-use/human-use
