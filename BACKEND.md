# Python backend

The backend uses Python 3.10+ standard library and an installed `task` executable. It has no Python package dependencies. Taskwarrior is the source of truth; task mutations, date expressions, hooks, filters, sorting and exports go through the CLI. The server inherits `TASKRC`, `TASKDATA` and the rest of its process environment.

```sh
python3 server.py                         # 127.0.0.1:7834; serves dist/
python3 server.py --host 127.0.0.1 --port 8765 --static-dir dist
python3 server.py --host "$(tailscale ip -4)" --allowed-host "$(hostname -f)"
TASKWEB_HOST=127.0.0.1 TASKWEB_PORT=7834 python3 server.py
TASKWEB_ALLOWED_HOSTS=this-host.example.ts.net,this-host python3 server.py
python3 -m unittest discover -s tests -v
```

Use the machine's Tailscale IPv4 address with `--host` for tailnet access. The loopback default prevents accidental network exposure. This service deliberately has no login: anyone who can reach it can read and change tasks. Keep it on the intended tailnet, not the public Internet. The HTTP server does not terminate TLS or trust forwarded proxy headers.

See [API.md](API.md) for the browser contract. Production assets must be built into `dist/` first. Missing assets return a clear error; extensionless paths fall back to the SPA entry point. Resolved paths, including symlinks, must stay inside the configured static directory.

## Report fidelity

Effective configuration comes from `task _show`, including included config files, custom reports, labels, column styles, UDA definitions, priority values, contexts and `print.empty.columns`. Personal configuration is never bundled.

For Taskwarrior 3, requests execute `task <trusted overrides> export <report>`. Exactly one report argument follows `export`: additional arguments in that position can silently discard the report filter. Report sort remains native, including UDA numeric ordering and collation.

Taskwarrior 3.5's report export ignores the active read context even though a rendered report honors it. The adapter explicitly groups `(context.read) and (report.filter) and (browser filter)` into a transient report-filter override and disables implicit context for that read. Reports with `context=0` omit the context group. This also prevents an `or` in the browser filter from admitting completed/deleted tasks into a pending report.

Configured `limit:*` tokens are stripped, matching VIT's unpaginated task-list behavior. An explicit browser filter such as `limit:3` is retained. Original report metadata is returned unchanged.

Exports that omit pending-task IDs use a fixed two-column UUID/ID report projection to recover actual CLI IDs. Taskwarrior 2 uses that native projection for membership and ordering, then exports the resulting UUIDs. Descriptions, dates and UDAs are never parsed from a rendered table. Nonpositive/missing IDs are omitted; UUIDs are the required identity, while positive IDs are ephemeral display values. No synthetic IDs are invented.

Reads preserve native recurrence generation and garbage collection. Opening a report can materialize due recurring children, just as an ordinary Taskwarrior report does; that legitimate write emits a change event and subsequent reads settle. Working-set IDs can consequently change. UUID-based selection preserves identity. Mutations retain normal CLI behavior and trusted user hooks.

## Command boundary

The backend parses commands with `shlex`, never a shell. Only the documented verbs are dispatched. Add/modify text is emitted as one `description:<literal text>` argument; separately emitted tokens are recognized editable attributes or tag changes. Thus `modify 2 or <other-uuid>` changes the selected description literally, rather than adding selectors. Configuration overrides (`rc.*`, `rc:`, `rc=`), option overrides, unsupported verbs and mutable identity fields are rejected. Shell-looking punctuation, substitutions and code snippets in mutation text remain literal task data; they are never evaluated.

Every selected mutation constructs an explicit parenthesized `uuid:A or uuid:B` allowlist from validated, full UUIDs. Empty selections fail. Numeric IDs never address writes, including after another CLI session renumbers tasks. Missing selected tasks produce a conflict rather than widening the operation. Start/stop toggle reads current task state and partitions the selection into active/inactive groups.

`sync` / `S` runs native Taskwarrior sync without arguments (60-second timeout); other commands have a 30-second timeout. Taskwarrior errors are returned as JSON with non-2xx status. Stdin is disconnected, confirmation is disabled, and output is noninteractive. `tiebreak 1` / `tiebreak -1` requires a configured numeric UDA, defaults an absent/noninteger value to 9, clamps to 0–18, and skips an unchanged value; it never executes a local helper.

Mutation requests require `application/json`, a trusted `Host`, and a matching HTTP `Origin` when supplied. The bound address, `localhost` and the loopback addresses are trusted by default. `--allowed-host HOST` (repeatable) and `TASKWEB_ALLOWED_HOSTS` (comma separated) add exact hostnames, so the app can also be opened through a name that resolves to the same socket, such as this machine's tailnet DNS name. Matching is exact and normalized for case and one trailing dot: an alias never widens trust to a suffix, and wildcards, `0.0.0.0` and `::` are refused. Command-line aliases take precedence over the environment variable. Without a registered alias, only the address URL can submit mutations. Cross-site browser requests are rejected. Non-browser clients may omit `Origin`. JSON requests without an origin still must have a trusted host. A development proxy must rewrite both Host and Origin to its backend target; production uses same-origin requests directly.

## Change detection

One background thread checks file signatures every 0.5 seconds. Unchanged signatures require no CLI invocation or content hashing. Relevant files are the taskrc and recursive includes, Taskwarrior 2 `*.data`, and Taskwarrior 3 `*.sqlite3`, `*.sqlite` or `*.db` with their WAL files (including `taskchampion.sqlite3` and `db.sqlite3`). Lock files and SQLite shared-memory files are excluded.

Changed files are content-fingerprinted. For SQLite, the fingerprint overlays complete committed WAL pages on main-file pages without issuing SQL or using SQLite APIs. A checkpoint only relocates those pages, so it does not change the revision. Empty WAL creation/removal, metadata-only touches, read locks, CLI exports and normal checkpoints do not cause refresh loops. Configuration changes refresh the effective config only when the CLI lock is free; data polling never waits behind a long sync.

SSE sends an initial `ready`, `change` with a revision after content changes, and keepalive comments every 15 seconds. Reconnecting clients receive another ready event and should read the full current view. Request logs omit private filters and command bodies.

## Validation and limits

Integration tests create temporary taskrc/data/static trees and point every CLI process at them. They exercise real add/modify/done/start/stop/toggle/annotate/denotate/delete/undo operations, report and OR-filter fidelity, contexts and context bypass, native UDA sorting, omitted IDs, multi-selection, rejected overrides, origin/host boundaries including registered host aliases, traversal/symlink rejection, external CLI SSE changes, native recurrence materialization and settled read-stable revisions. A separate synthetic SQLite fixture verifies WAL commits and checkpoint stability; tests never connect to the user's database. Sync is mocked to avoid real network activity.

The installed Taskwarrior 3.5 is exercised directly. The Taskwarrior 2 projection branch is exercised against the installed CLI, and v2 file notifications are tested; a separate actual Taskwarrior 2 binary has not been tested. File-image sampling is eventually consistent during concurrent writes: an in-progress external transaction can require the next 0.5-second sample. Large databases are rehashed only when their signatures change, but their read/hash cost adds to notification latency. A snapshot and concurrent external mutation are not one cross-process transaction; SSE reconciles the subsequent view. Native recurrence generation and custom hooks that write during reads can themselves produce legitimate changes.
