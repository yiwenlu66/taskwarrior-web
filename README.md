# Taskwarrior Web

A compact, keyboard-first web interface for [Taskwarrior](https://taskwarrior.org/), inspired by [VIT](https://github.com/vit-project/vit). A dense task list, command prompt and contextual completions keep everyday task management close to the terminal workflow.

**Taskwarrior is the source of truth.** The app reads your installed CLI, reports and configuration, and sends supported changes back through `task`. Keep using Taskwarrior or VIT alongside the browser: changes trigger a refresh without discarding the current selection or command draft.

## Requirements

- Linux with a systemd user manager for the persistent service.
- Python 3.10+ and `task` on your `PATH`; no Python packages are required.
- Node.js 22.12+ and npm to build the React/Vite frontend. Node is not needed to serve a completed build.
- [Tailscale](https://tailscale.com/) connected on the server and the devices that will access it.

Use an existing, working Taskwarrior configuration (`task next` should work). Back up your Taskwarrior data before using a new client that can modify it.

## Install and run

Run as your regular user, **without sudo**:

```sh
git clone https://github.com/yiwenlu66/taskwarrior-web.git
cd taskwarrior-web
npm ci
npm run build

# Foreground production server: bind only the local Tailscale IPv4.
python3 server.py --host "$(tailscale ip -4)" --port 7834 --static-dir dist
```

Open `http://<your-tailscale-ip>:7834` from a device permitted to reach the server by your tailnet policy. Find the address with `tailscale ip -4`. The backend also accepts `TASKWEB_HOST` and `TASKWEB_PORT`; explicit command-line options take precedence.

### Persistent user service

After building, install and start the service:

```sh
./scripts/install-service.sh
# Optional alternate port:
./scripts/install-service.sh --port 7835
```

The installer resolves this checkout's absolute path, validates the bind against the local `tailscale ip -4`, and writes `~/.config/systemd/user/taskwarrior-web.service` (or `$XDG_CONFIG_HOME/systemd/user/`). It enables the unit under `default.target` and restarts it to apply changes. It captures your current `PATH` so the service can find `task`. Keep the checkout at that location; rerun the installer after moving it or changing environment paths.

For a custom Taskwarrior instance, export the same variables you use in your terminal **before installing**:

```sh
export TASKRC="$HOME/.config/task/taskrc"
export TASKDATA="$HOME/.local/share/task"
./scripts/install-service.sh
```

Only explicitly set `TASKRC`/`TASKDATA` are captured; otherwise Taskwarrior uses its normal per-user defaults. Relative paths are resolved at installation time. Rerunning the installer without these variables restores the defaults.

```sh
systemctl --user status taskwarrior-web.service
journalctl --user -u taskwarrior-web.service -f
systemctl --user restart taskwarrior-web.service
```

To start at boot and remain running after logout, enable user lingering:

```sh
loginctl enable-linger "$USER"
loginctl show-user "$USER" -p Linger
```

This may require administrator approval under your distribution's policy. Do not run the app or installer with sudo. The service retries after failure, including when the Tailscale address is not yet available at boot.

For manual installation, see [`deploy/taskwarrior-web.service.example`](deploy/taskwarrior-web.service.example). Replace its address placeholder with `tailscale ip -4`, adjust the checkout/Python paths, then run `systemctl --user daemon-reload` and `systemctl --user enable --now taskwarrior-web.service`.

To remove the service (your tasks and checkout remain untouched):

```sh
systemctl --user disable --now taskwarrior-web.service
rm "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/taskwarrior-web.service"
systemctl --user daemon-reload
```

### Access model: Tailscale, no login

There is **no application authentication**. Anyone who can reach this service can read and modify the selected user's tasks. Bind production only to the server's Tailscale IPv4, and limit access through Tailscale grants/ACLs. The installer refuses wildcard, LAN and public binds, including `0.0.0.0` and `::`.

Do not expose this port through public forwarding, Tailscale Funnel or a public reverse proxy. Same-origin mutation checks are an additional browser boundary, not a substitute for access control. HTTP is carried inside Tailscale's encrypted connection between tailnet devices.

## Using the app

Choose a configured report, select a task, and use the command prompt to act on it. The prompt accepts supported Taskwarrior commands and VIT-style aliases:

```text
:add Prepare a review +work due:tomorrow
:m due:tomorrow
:A Waiting for a response
:r next
:f +work
:context none
```

`modify`, `annotate`, `done`, `delete` and start/stop target the selection by UUID, so changing numeric Taskwarrior IDs does not redirect the action. Done, delete and start/stop ask for confirmation; undo runs directly, following VIT's `u` action. Taskwarrior interprets date expressions; Tab completion suggests commands, attributes, dates, reports, projects and tags rather than replacing its parser.

### Keyboard reference

Shortcuts apply when the task list is focused; text fields retain normal typing. Press **F1** for the in-app reference.

| Keys | Action |
| --- | --- |
| `j` / `k`, `↓` / `↑`, `Space` | Move down / up (`Space` moves down) |
| `gg` / `0`, `G` | First / last task |
| `Ctrl+F` / `Ctrl+B`, `PageDown` / `PageUp` | Page down / up |
| `H` / `M` / `L` | Top / middle / bottom of viewport |
| `Enter` / `=` | Task details |
| `a`, `m`, `A`, `E` | Add, modify, annotate, denotate |
| `d`, `D`, `b` | Done, delete, start/stop (confirm) |
| `u`, `S` | Undo the most recent change; sync with the configured Taskwarrior server |
| `P`, `p`, `T`, `w` | Priority, project, tags, wait |
| `:`, `f`, `c` | Command prompt, filter, context |
| `/` / `?`, `n` / `N` | Search forward/backward, repeat/reverse |
| `Tab` / `Shift+Tab` | Insert / cycle command completions |
| `r`, `v` / `V` | Report picker, toggle mark / clear marks (web additions) |
| `R` | Switch to the `next` report |
| `+` / `-` | Adjust a configured numeric `tiebreak` UDA by one |
| `Esc`, `q` | Dismiss entry or overlays |

Use the **Refresh** button for an explicit refresh; `Ctrl+L` remains the browser's address-bar shortcut. `R` and `+`/`-` mirror optional VIT macros rather than upstream defaults. Tiebreak adjustment requires `uda.tiebreak.type=numeric`; an unset value starts at 9 and adjustments are clamped to 0–18. Its effect on ordering depends on your Taskwarrior urgency/report configuration.

### VIT compatibility

This is an independent web interface, not VIT running in a browser. It follows VIT's task-centric command flow, while browser focus and reserved shortcuts impose differences. The supported command set is intentionally bounded: arbitrary shell execution, Taskwarrior configuration edits and imports are not exposed. Bare `m` opens Modify as in VIT; accepting `:m due:tomorrow` is a web convenience, not native VIT ex-command behavior. VIT's external terminal editor, shell prompts and process-quit actions cannot be reproduced directly in the browser. Consult the in-app F1 help for the implemented keybindings. Personal VIT keybindings, plugins and terminal rendering are not loaded. Taskwarrior report/filter/context configuration remains authoritative; a browser table cannot reproduce every terminal-only formatting feature.

## Development and tests

```sh
npm ci
python3 server.py --host 127.0.0.1 --port 8765 --static-dir dist
# In a second terminal; Vite proxies /api to the backend:
npm run dev
```

The development server is loopback-only. Use the built, same-origin frontend for Tailscale access.

```sh
npm test
npm run build
python3 -m unittest discover -s tests
bash -n scripts/install-service.sh
```

Backend tests use isolated `TASKRC`/`TASKDATA` fixtures and require the real `task` executable. Do not test mutations against your personal tasks. CI installs Taskwarrior from Ubuntu's package repository and runs the commands above. Do not commit personal task exports, configuration, logs, screenshots or environment files.

## Architecture

- **React + TypeScript + Vite** render the dense list and command interface; `npm run build` produces `dist/`.
- **Python standard-library HTTP server** serves `dist/` and `/api` on the same origin. It invokes `task` without a shell and restricts commands to supported task operations.
- **Taskwarrior CLI and local data** own persistence, dates, reports and task semantics. All task queries and mutations go through `task`; the app maintains no second task database.
- **File fingerprints and Server-Sent Events** detect local task/config changes, including concurrent CLI/VIT edits; the browser reloads data on notification or reconnection. The watcher reads file bytes (including SQLite/WAL pages on Taskwarrior 3) to recognize changes without issuing SQL or writing the database. Refresh is not transactional editing: if two clients change the same task, Taskwarrior's resulting state wins. Selection and drafts are preserved where possible, but disappearing tasks can no longer remain selected.

See [`API.md`](API.md) for the browser/server contract. This project is licensed under the [MIT License](LICENSE).
