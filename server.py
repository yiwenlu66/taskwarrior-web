#!/usr/bin/env python3
"""Dependency-free HTTP bridge to the installed Taskwarrior CLI."""
from __future__ import annotations

import argparse
from collections.abc import Iterable
import hashlib
import ipaddress
import json
import mimetypes
import os
from pathlib import Path
import re
import shlex
import struct
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit
import uuid


class APIError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]*$")
UUID = re.compile(r"^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$")
ROW = re.compile(r"^\s*([0-9a-fA-F-]{36})\s+(\d+|-)\s*$")
# Report names must not collide with CLI commands or internal helpers.
RESERVED = set("add annotate append prepend config context delete denotate done duplicate edit execute export help import information log modify projects purge reports shell show start stop summary sync tags undo version diagnostics calendar colors commands count ids uuids _show _get".split())
ALIASES = {"a": "add", "m": "modify", "d": "done", "D": "delete", "A": "annotate", "u": "undo", "r": "report", "f": "filter", "s": "toggle", "b": "toggle", "E": "denotate", "S": "sync"}
# A hostname label, and the wildcard addresses that must never be trusted aliases.
HOST_LABEL = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")
ANY_ADDRESS = {"0.0.0.0", "::", "*"}


def normalize_host(value: str) -> str:
    """Case-fold a request hostname and drop one trailing root dot."""
    host = value.strip().lower()
    if host.startswith("[") and host.endswith("]"):
        host = host[1:-1]
    return host[:-1] if host.endswith(".") else host


def parse_allowed_hosts(values: Iterable[str]) -> frozenset[str]:
    """Validate explicitly trusted request hostnames.

    Aliases are exact names. Wildcards, address suffixes and blank entries are
    refused so that a single registered name cannot widen trust to a whole
    domain, and the bound address plus loopback stay trusted by default.
    """
    hosts: set[str] = set()
    if isinstance(values, str):
        values = [values]
    for raw in values:
        for item in str(raw).split(","):
            if not item.strip():
                continue
            host = normalize_host(item)
            if not host or any(ch in host for ch in "*/\\ \t") or host in ANY_ADDRESS:
                raise ValueError(f"Invalid trusted host alias: {item.strip()!r}")
            try:
                ipaddress.ip_address(host)
            except ValueError:
                labels = host.split(".")
                if len(host) > 253 or not all(HOST_LABEL.fullmatch(label) for label in labels):
                    raise ValueError(f"Invalid trusted host alias: {item.strip()!r}") from None
            hosts.add(host)
    return frozenset(hosts)


def uuid_filter(uuids: list[str]) -> list[str]:
    if not uuids:
        raise APIError("An empty UUID filter is never allowed")
    terms = []
    for task_uuid in uuids:
        if terms:
            terms.append("or")
        terms.append("uuid:" + task_uuid)
    return ["(", *terms, ")"]


def split_words(value: str) -> list[str]:
    try:
        return shlex.split(value)
    except ValueError as exc:
        raise APIError(f"Invalid quoting: {exc}") from exc


def check_input(value: str, *, literal: bool = False) -> None:
    if len(value) > 16384 or any(ord(c) < 32 and c not in "\t" for c in value):
        raise APIError("Command/filter is too long or contains control characters")
    for token in split_words(value):
        if re.match(r"^(?:rc(?:[.:=]|$)|--)", token, re.I):
            raise APIError("Taskwarrior configuration and option overrides are not allowed")
        if not literal and (token in {";", "&&", "||", "|", ">", ">>", "<"} or token.startswith(("$(", "`"))):
            raise APIError("Shell operators are not valid filter syntax")


class Taskwarrior:
    """Owns CLI serialization; the CLI remains the only database writer/reader."""

    def __init__(self, env: dict[str, str] | None = None, executable: str = "task"):
        self.env = dict(os.environ if env is None else env)
        self.executable = executable
        self.lock = threading.RLock()
        self.version = self.run(["_version"]).strip().split()[0]
        self.config = self.read_config()

    def run(self, args: list[str], *, mutation: bool = False, empty_ok: bool = False) -> str:
        options = ["rc.color=off", "rc._forcecolor=off", "rc.confirmation=no",
                   "rc.dependency.confirmation=no", "rc.recurrence.confirmation=no",
                   "rc.bulk=0", "rc.detection=off", "rc.defaultwidth=200",
                   "rc.json.array=on", "rc.json.depends.array=on"]
        options += ["rc.verbose=affected,new-id"] if mutation else ["rc.verbose=nothing"]
        timeout = 60 if args == ["sync"] else 30
        try:
            with self.lock:
                result = subprocess.run([self.executable, *options, *args], env=self.env,
                                        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True, timeout=timeout,
                                        shell=False)
        except FileNotFoundError as exc:
            raise APIError("Taskwarrior executable was not found", 503) from exc
        except subprocess.TimeoutExpired as exc:
            raise APIError(f"Taskwarrior timed out after {timeout} seconds", 504) from exc
        stderr = "\n".join(line for line in result.stderr.splitlines()
                           if not line.startswith(("TASKRC override:", "TASKDATA override:", "Configuration override ")))
        output = "\n".join(x.strip() for x in (result.stdout, stderr) if x.strip())
        if result.returncode and not (empty_ok and result.returncode == 1 and
                                      not stderr.strip() and
                                      result.stdout.strip() in ("", "No matches.")):
            raise APIError(output or f"Taskwarrior failed (exit {result.returncode})")
        return result.stdout if not mutation else output

    def read_config(self) -> dict[str, str]:
        with self.lock:
            self.config = dict(line.split("=", 1) for line in self.run(["_show"]).splitlines() if "=" in line)
            return dict(self.config)

    @staticmethod
    def reports(config: dict[str, str]) -> list[dict]:
        names = sorted(k[7:-8] for k in config if k.startswith("report.") and k.endswith(".columns"))
        reports = []
        for name in names:
            columns = config[f"report.{name}.columns"]
            if not NAME.fullmatch(name) or name.startswith("_") or name in RESERVED or not columns:
                continue
            prefix = f"report.{name}."
            reports.append({"name": name, "description": config.get(prefix + "description", name),
                            "columns": columns.split(","), "labels": config.get(prefix + "labels", "").split(",") if config.get(prefix + "labels") else [c.title() for c in columns.split(",")],
                            "sort": config.get(prefix + "sort", ""), "filter": config.get(prefix + "filter", ""),
                            "context": config.get(prefix + "context", "1").lower() not in {"0", "no", "off", "false"}})
        return reports

    def attributes(self, config: dict[str, str]) -> list[str]:
        attrs = set(self.run(["_columns"]).splitlines())
        attrs.update(k[4:-5] for k in config if k.startswith("uda.") and k.endswith(".type"))
        return sorted(x for x in attrs if NAME.fullmatch(x))

    @staticmethod
    def contexts(config: dict[str, str]) -> list[str]:
        return sorted({k[8:].rsplit(".", 1)[0] if k.endswith((".read", ".write")) else k[8:]
                       for k in config if k.startswith("context.")})

    def meta(self) -> dict:
        with self.lock:
            config = self.read_config()
            reports = self.reports(config)
            default = split_words(config.get("default.command", "next"))
            default = next((x for x in default if x in {r["name"] for r in reports}), "next")
            if default not in {r["name"] for r in reports}:
                default = reports[0]["name"] if reports else "next"
            contexts = self.contexts(config)
            return {"version": self.version, "defaultReport": default, "reports": reports,
                    "projects": self.run(["_projects"]).splitlines(), "tags": self.run(["_tags"]).splitlines(),
                    "contexts": contexts, "attributes": self.attributes(config),
                    "priorities": [x for x in config.get("uda.priority.values", "H,M,L,").split(",") if x],
                    "printEmptyColumns": config.get("print.empty.columns", "0").lower() in {"1", "on", "yes", "true"},
                    "udas": {k[4:-5]: {"type": v, "label": config.get(k[:-4] + "label", k[4:-5]),
                                       "values": config.get(k[:-4] + "values", "").split(",")}
                             for k, v in config.items() if k.startswith("uda.") and k.endswith(".type")}}

    def report(self, name: str | None, config: dict[str, str]) -> dict:
        available = self.reports(config)
        if not name:
            command = split_words(config.get("default.command", "next"))
            name = next((x for x in command if x in {r["name"] for r in available}), "next")
        found = next((r for r in available if r["name"] == name), None)
        if found is None:
            raise APIError(f"Unknown list report: {name}")
        return found

    def export(self, uuids: list[str]) -> list[dict]:
        tasks = []
        for offset in range(0, len(uuids), 300):
            output = self.run(["rc.context=", *uuid_filter(uuids[offset:offset + 300]), "export"], empty_ok=True)
            try:
                value = json.loads(output or "[]")
            except json.JSONDecodeError as exc:
                raise APIError("Taskwarrior returned invalid export JSON", 502) from exc
            if not isinstance(value, list):
                raise APIError("Taskwarrior export was not a JSON array", 502)
            tasks.extend(value)
        return tasks

    def tasks(self, name: str | None, extra_filter: str = "") -> dict:
        check_input(extra_filter)
        with self.lock:
            config = self.read_config()
            report = self.report(name, config)
            name = report["name"]
            # VIT removes configured row limits; the browser owns scrolling. Preserve
            # quoting while stripping limit tokens, including adjacent parentheses.
            original = re.sub(r'''("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(?<![^\s(])limit:[^\s()]+''',
                              lambda m: m[1] or "", report["filter"])
            active = config.get("context", "")
            context = config.get(f"context.{active}.read", config.get(f"context.{active}", "")) if active and report["context"] else ""
            combined = " and ".join(f"( {part} )" for part in (context, original, extra_filter) if part.strip())
            overrides = ["rc.context=", f"rc.report.{name}.filter={combined}"]
            if int(self.version.split(".")[0]) >= 3:
                # Exactly one argument after export. More silently discards filters
                # in TW3. Export honors native sort but not context, hence grouping above.
                output = self.run([*overrides, "export", name])
                try:
                    result = json.loads(output)
                except json.JSONDecodeError as exc:
                    raise APIError("Taskwarrior returned invalid report JSON", 502) from exc
                if not isinstance(result, list):
                    raise APIError("Taskwarrior report was not a JSON array", 502)
            else:
                # TW2 fallback: parse only a fixed, non-truncating UUID/ID projection,
                # never descriptions/dates/UDAs from an ANSI report table.
                result = []
            if not result and int(self.version.split(".")[0]) >= 3:
                return {"tasks": [], "report": report, "context": active}
            if not result or any(not isinstance(t.get("id"), int) and t.get("status") in {"pending", "waiting", "recurring"} for t in result):
                rows = self.project_ids(name, overrides)
                if not result:
                    exported = {t["uuid"].lower(): t for t in self.export([u for u, _ in rows])}
                    result = [exported[u] for u, _ in rows if u in exported]
                ids = dict(rows)
                for task in result:
                    if task["uuid"].lower() not in ids:
                        raise APIError("Tasks changed while reading IDs; refresh and retry", 409)
                    task["id"] = ids[task["uuid"].lower()]
            for task in result:
                if not isinstance(task.get("id"), int) or task["id"] <= 0:
                    task.pop("id", None)
            return {"tasks": result, "report": report, "context": active}

    def project_ids(self, name: str, overrides: list[str]) -> list[tuple[str, int]]:
        # A private report name avoids user aliases colliding with report commands.
        private = "taskwebids"
        args = ["rc.alias.taskwebids=", "rc.context=",
                f"rc.report.{private}.columns=uuid,id", f"rc.report.{private}.labels=UUID,ID",
                f"rc.report.{private}.filter={overrides[-1].split('=', 1)[1]}",
                f"rc.report.{private}.sort={self.config.get(f'report.{name}.sort', '')}",
                f"rc.report.{private}.context=0", private]
        rows = []
        for line in self.run(args, empty_ok=True).splitlines():
            match = ROW.fullmatch(line)
            if match:
                rows.append((match[1].lower(), int(match[2]) if match[2] != "-" else 0))
        return rows

    def selected(self, value: object) -> list[str]:
        if value is None:
            return []
        if not isinstance(value, list) or len(value) > 500:
            raise APIError("uuids must be an array of at most 500 full UUIDs")
        if any(not isinstance(x, str) or not UUID.fullmatch(x) for x in value):
            raise APIError("Selection must contain only full task UUIDs")
        return list(dict.fromkeys(str(uuid.UUID(x)) for x in value))

    def modifiers(self, words: list[str], config: dict[str, str]) -> list[str]:
        attrs = set(self.attributes(config))
        # Identity and internal bookkeeping are never editable through this surface.
        attrs -= {"id", "uuid", "urgency", "mask", "imask", "parent", "modified"}
        args, description = [], []
        for word in words:
            if ":" in word:
                key, value = word.split(":", 1)
                if key in attrs:
                    args.append(f"{key}:{value}")
                    continue
                if NAME.fullmatch(key) and (key.split(".")[0] in attrs or key in {"uuid", "id"}):
                    raise APIError(f"Not an editable attribute: {key}")
            if re.fullmatch(r"[+-][\w@.-]+", word, re.UNICODE):
                args.append(word)
            else:
                description.append(word)
        if description:
            if any(x.startswith("description:") for x in args):
                raise APIError("Specify the description once, either as text or description:value")
            args.append("description:" + " ".join(description))
        return args

    def command(self, body: object) -> dict:
        if not isinstance(body, dict) or not isinstance(body.get("command"), str):
            raise APIError("Expected a JSON object with a command string")
        command = body["command"].strip().removeprefix(":").lstrip()
        # Text after a supported mutation verb becomes a canonical description or
        # one -- protected annotation argument; shell punctuation is inert data.
        check_input(command, literal=True)
        words = split_words(command)
        if not words:
            raise APIError("Command is empty")
        verb = ALIASES.get(words[0], words[0])
        rest = words[1:]
        uuids = self.selected(body.get("uuids"))
        with self.lock:
            config = self.read_config()
            reports = {r["name"] for r in self.reports(config)}
            if verb in reports and not rest:
                return {"output": "", "changed": False, "report": verb}
            if verb == "report":
                if len(rest) > 1:
                    raise APIError("Usage: report <name>")
                return {"output": "", "changed": False, "report": self.report(rest[0] if rest else body.get("report"), config)["name"]}
            if verb == "filter":
                # Keep original quoting and expression syntax for the native filter parser.
                text = command[len(words[0]):].lstrip()
                return {"output": "", "changed": False, "filter": text}
            if verb == "context":
                names = set(self.contexts(config))
                if len(rest) != 1 or rest[0] not in names | {"none"}:
                    raise APIError("Usage: context <configured-name|none>")
                return {"output": self.run(["context", rest[0]], mutation=True), "changed": True}
            if verb not in {"add", "modify", "done", "delete", "start", "stop", "toggle", "annotate", "denotate", "undo", "sync", "tiebreak"}:
                raise APIError(f"Unsupported command: {words[0]}")
            if verb not in {"add", "undo", "sync"} and not uuids:
                raise APIError("Select at least one task; this command never uses an empty selection")
            if verb in {"done", "delete", "start", "stop", "toggle", "undo", "sync"} and rest:
                raise APIError(f"{verb} does not accept filters, IDs, or extra arguments")
            selected = self.export(uuids) if verb not in {"add", "undo", "sync"} else []
            if verb not in {"add", "undo", "sync"} and {t["uuid"].lower() for t in selected} != set(uuids):
                raise APIError("One or more selected tasks no longer exist; refresh and select again", 409)
            if verb == "tiebreak":
                if config.get("uda.tiebreak.type") != "numeric" or rest not in (["1"], ["-1"]):
                    raise APIError("tiebreak requires a configured numeric UDA and delta 1 or -1")
                output = []
                for task in selected:
                    raw = task.get("tiebreak")
                    current = int(raw) if isinstance(raw, (int, str)) and re.fullmatch(r"[+-]?\d+", str(raw)) else 9
                    updated = max(0, min(18, current + int(rest[0])))
                    if updated != current:
                        output.append(self.run([task["uuid"], "modify", f"tiebreak:{updated}"], mutation=True))
                return {"output": "\n".join(output) or "Tiebreak already at limit", "changed": bool(output)}
            selector = uuid_filter(uuids) if selected else []
            if verb in {"add", "modify"}:
                args = self.modifiers(rest, config)
                if not args or verb == "add" and not any(x.startswith("description:") and x != "description:" for x in args):
                    raise APIError("Add needs a description; modify needs text, attributes, or tags")
            elif verb in {"annotate", "denotate"}:
                if not rest:
                    raise APIError(f"{verb} needs annotation text")
                args = ["--", " ".join(rest)]
            else:
                args = []
            if verb == "toggle":
                output = []
                for action, tasks in (("stop", [t for t in selected if t.get("start")]),
                                      ("start", [t for t in selected if not t.get("start")])):
                    if tasks:
                        output.append(self.run([*uuid_filter([t["uuid"] for t in tasks]), action], mutation=True))
                return {"output": "\n".join(output), "changed": True}
            return {"output": self.run([*selector, verb, *args], mutation=True), "changed": True}

    def watched_paths(self) -> tuple[list[Path], Path]:
        config = self.config
        home = Path(self.env.get("HOME", str(Path.home())))
        default_rc = home / ".taskrc"
        if not default_rc.exists():
            default_rc = Path(self.env.get("XDG_CONFIG_HOME", str(home / ".config"))) / "task" / "taskrc"
        rc = Path(self.env.get("TASKRC", str(default_rc))).expanduser()
        seen: set[Path] = set()

        def include(path: Path) -> None:
            path = path.resolve()
            if path in seen:
                return
            seen.add(path)
            try:
                text = path.read_text()
            except OSError:
                return
            for line in text.splitlines():
                match = re.match(r"^\s*include\s+(.+?)\s*$", line)
                if match:
                    child = Path(os.path.expandvars(match[1])).expanduser()
                    include(child if child.is_absolute() else path.parent / child)
        include(rc)
        data = Path(self.env.get("TASKDATA") or config.get("data.location") or str(home / ".task")).expanduser().resolve()
        return sorted(seen), data


def sqlite_image_digest(database: Path) -> bytes:
    """Hash committed file pages, overlaying WAL pages without using SQLite APIs.

    A checkpoint moves bytes from WAL to the main file without changing the image.
    Hashing the image, not mtime/WAL presence, prevents read/checkpoint refresh loops.
    """
    main = database.read_bytes()
    if not main.startswith(b"SQLite format 3\x00") or len(main) < 100:
        return hashlib.sha256(main).digest()
    size = struct.unpack(">H", main[16:18])[0]
    size = 65536 if size == 1 else size
    if size < 512 or size & (size - 1):
        return hashlib.sha256(main).digest()
    pages: dict[int, bytes] = {}
    count = len(main) // size
    try:
        wal = database.with_name(database.name + "-wal").read_bytes()
    except FileNotFoundError:
        wal = b""
    if len(wal) >= 32 and wal[:4] in (b"7\x7f\x06\x82", b"7\x7f\x06\x83") and struct.unpack(">I", wal[8:12])[0] == size:
        frames, committed = [], 0
        for pos in range(32, len(wal) - size - 23, size + 24):
            header = wal[pos:pos + 24]
            if header[8:16] != wal[16:24]:
                break
            page, db_size = struct.unpack(">II", header[:8])
            if not page:
                break
            frames.append((page, wal[pos + 24:pos + 24 + size]))
            if db_size:
                committed, count = len(frames), db_size
        pages = dict(frames[:committed])
    digest = hashlib.sha256()
    for page in range(1, count + 1):
        digest.update(pages.get(page, main[(page - 1) * size:page * size]))
    return digest.digest()


class RevisionMonitor:
    def __init__(self, task: Taskwarrior, interval: float = 0.5):
        self.task = task
        self.interval = interval
        self.condition = threading.Condition()
        self.stop_event = threading.Event()
        self.signature = None
        self.config_signature = None
        self.config_dirty = False
        self.revision = ""
        self.scan()
        self.thread = threading.Thread(target=self._loop, name="taskweb-revisions", daemon=True)
        self.thread.start()

    def scan(self) -> str:
        config_paths, data = self.task.watched_paths()
        databases = []
        regular = list(config_paths)
        try:
            for path in data.iterdir():
                if path.is_file() and (path.suffix in {".sqlite3", ".sqlite", ".db"}):
                    databases.append(path)
                elif path.is_file() and path.suffix == ".data":
                    regular.append(path)
        except FileNotFoundError:
            pass
        stat_paths = regular + databases + [x.with_name(x.name + "-wal") for x in databases]
        signature = []
        for path in sorted(stat_paths):
            try:
                stat = path.stat()
                signature.append((str(path), stat.st_ino, stat.st_size, stat.st_mtime_ns))
            except FileNotFoundError:
                signature.append((str(path), None))
        signature = tuple(signature)
        config_signature = tuple(item for item in signature if item[0] in {str(x) for x in config_paths})
        if config_signature != self.config_signature:
            self.config_signature = config_signature
            self.config_dirty = True
        # Data polling never waits behind a long sync/mutation. Refresh effective
        # configuration only when config files changed and the CLI lock is free.
        if self.config_dirty and self.task.lock.acquire(blocking=False):
            try:
                self.task.read_config()
                self.config_dirty = False
            finally:
                self.task.lock.release()
        if signature == self.signature:
            return self.revision
        digest = hashlib.sha256()
        for path in sorted(regular):
            digest.update(str(path).encode())
            try:
                digest.update(path.read_bytes())
            except FileNotFoundError:
                digest.update(b"missing")
        for path in sorted(databases):
            digest.update(str(path).encode())
            digest.update(sqlite_image_digest(path))
        revision = digest.hexdigest()
        previous = self.revision
        with self.condition:
            self.signature, self.revision = signature, revision
            if previous != revision:
                self.condition.notify_all()
        return revision

    def _loop(self) -> None:
        while not self.stop_event.wait(self.interval):
            try:
                self.scan()
            except (OSError, APIError) as exc:
                # A concurrent file replacement can be retried. Do not hide failures.
                print(f"Revision watcher: {exc}", file=__import__("sys").stderr)

    def close(self) -> None:
        self.stop_event.set()
        with self.condition:
            self.condition.notify_all()
        self.thread.join(timeout=2)


class TaskHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], task: Taskwarrior, static_dir: Path,
                 allowed_hosts: Iterable[str] | None = None):
        self.task = task
        self.static_dir = static_dir.resolve()
        self.monitor = RevisionMonitor(task)
        self.allowed_hosts = parse_allowed_hosts(allowed_hosts or ())
        try:
            super().__init__(address, Handler)
        except Exception:
            self.monitor.close()
            raise
        # The bound address and loopback are trusted without configuration; the
        # aliases exist so an operator can also open the app through a name that
        # resolves to the same socket (for example this machine's tailnet name).
        self.trusted_hosts = frozenset(
            {normalize_host(str(self.server_address[0])), "localhost", "127.0.0.1", "::1"}
            | set(self.allowed_hosts))

    def server_close(self) -> None:
        self.monitor.close()
        super().server_close()


class Handler(BaseHTTPRequestHandler):
    server: TaskHTTPServer
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: object) -> None:
        # URLs contain private filters; log only method/status, never command bodies.
        if len(args) >= 2:
            super().log_message("%s %s", self.command, args[1])

    def headers_common(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")

    def json(self, value: dict, status: int = 200) -> None:
        payload = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.headers_common()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def do_GET(self) -> None:
        try:
            url = urlsplit(self.path)
            if url.path == "/api/health":
                self.json({"ok": True, "version": self.server.task.version})
            elif url.path == "/api/meta":
                self.json(self.server.task.meta())
            elif url.path == "/api/tasks":
                query = parse_qs(url.query, keep_blank_values=True)
                # Capture before reading: an event during a read must not be hidden by
                # labeling an older snapshot with a newer database revision.
                revision = self.server.monitor.revision
                result = self.server.task.tasks(query.get("report", [None])[0], query.get("filter", [""])[0])
                result["revision"] = revision
                self.json(result)
            elif url.path == "/api/events":
                self.events()
            elif url.path.startswith("/api/"):
                raise APIError("Unknown API endpoint", 404)
            else:
                self.static(url.path)
        except APIError as exc:
            self.json({"error": str(exc)}, exc.status)
        except (BrokenPipeError, ConnectionResetError):
            pass
        except OSError as exc:
            self.json({"error": f"Filesystem error: {exc.strerror}"}, 500)

    def do_HEAD(self) -> None:
        if urlsplit(self.path).path == "/api/events":
            self.json({"error": "Use GET for events"}, 405)
        else:
            self.do_GET()

    def do_POST(self) -> None:
        try:
            self.check_origin()
            if urlsplit(self.path).path != "/api/command":
                raise APIError("Unknown API endpoint", 404)
            if self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower() != "application/json":
                raise APIError("Content-Type must be application/json", 415)
            if self.headers.get("Transfer-Encoding"):
                raise APIError("Chunked request bodies are not supported")
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError as exc:
                raise APIError("Invalid Content-Length") from exc
            if not 0 < length <= 65536:
                raise APIError("JSON body must be between 1 and 65536 bytes", 413)
            self.connection.settimeout(10)
            try:
                body = json.loads(self.rfile.read(length))
            except (ValueError, UnicodeError) as exc:
                raise APIError("Invalid JSON body") from exc
            finally:
                self.connection.settimeout(None)
            self.json(self.server.task.command(body))
        except APIError as exc:
            # Rejected bodies may not have been consumed; never parse them as requests.
            self.close_connection = True
            self.json({"error": str(exc)}, exc.status)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def method_not_allowed(self) -> None:
        self.close_connection = True
        self.json({"error": "Method not allowed"}, 405)

    do_OPTIONS = method_not_allowed
    do_PUT = method_not_allowed
    do_PATCH = method_not_allowed
    do_DELETE = method_not_allowed

    def check_origin(self) -> None:
        host = self.headers.get("Host", "")
        origin = self.headers.get("Origin")
        try:
            target = urlsplit("http://" + host)
            if not host or target.username or target.password or target.path or target.query or target.fragment or not target.hostname:
                raise ValueError
            target_port = target.port or 80
            target_host = normalize_host(target.hostname)
            # Exact hostname match only: an alias never widens trust to a suffix.
            if target_host not in self.server.trusted_hosts or target_port != self.server.server_port:
                raise ValueError
            if origin is not None:
                source = urlsplit(origin)
                if source.scheme not in {"http", "https"} or source.username or source.password or source.path not in {"", "/"} or source.query or source.fragment:
                    raise ValueError
                if source.scheme != "http" or normalize_host(source.hostname or "") != target_host or (source.port or 80) != target_port:
                    raise ValueError
            if self.headers.get("Sec-Fetch-Site") == "cross-site":
                raise ValueError
        except ValueError as exc:
            raise APIError("Mutation requires a same-origin Origin and trusted Host", 403) from exc

    def events(self) -> None:
        self.send_response(200)
        self.headers_common()
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Accel-Buffering", "no")
        self.send_header("Connection", "close")
        self.end_headers()
        monitor = self.server.monitor
        revision = monitor.revision
        self.wfile.write(("event: ready\ndata: " + json.dumps({"revision": revision}) + "\n\n").encode())
        self.wfile.flush()
        self.close_connection = True
        while not monitor.stop_event.is_set():
            with monitor.condition:
                monitor.condition.wait_for(lambda: monitor.revision != revision or monitor.stop_event.is_set(), timeout=15)
                changed = revision != monitor.revision
                revision = monitor.revision
            if monitor.stop_event.is_set():
                break
            event = "event: change\ndata: " + json.dumps({"revision": revision}) + "\n\n" if changed else ": keepalive\n\n"
            self.wfile.write(event.encode())
            self.wfile.flush()

    def static(self, url_path: str) -> None:
        decoded = unquote(url_path)
        if "\x00" in decoded or "\\" in decoded or ".." in Path(decoded).parts:
            raise APIError("Invalid asset path", 403)
        root = self.server.static_dir
        path = (root / decoded.lstrip("/")).resolve()
        if not path.is_relative_to(root):
            raise APIError("Asset path escapes static directory", 403)
        if path.is_dir():
            path = (path / "index.html").resolve()
            if not path.is_relative_to(root):
                raise APIError("Asset path escapes static directory", 403)
        if not path.is_file():
            # SPA navigation falls back only for extensionless routes.
            if not Path(decoded).suffix and (root / "index.html").is_file():
                path = (root / "index.html").resolve()
                if not path.is_relative_to(root):
                    raise APIError("Asset path escapes static directory", 403)
            else:
                raise APIError("Asset not found; build the frontend first", 404)
        content = path.read_bytes()
        self.send_response(200)
        self.headers_common()
        self.send_header("Content-Type", mimetypes.guess_type(path)[0] or "application/octet-stream")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(content)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=os.environ.get("TASKWEB_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=os.environ.get("TASKWEB_PORT", "7834"))
    parser.add_argument("--static-dir", type=Path, default=Path(__file__).resolve().parent / "dist")
    parser.add_argument("--allowed-host", action="append", metavar="HOST",
                        help="Extra request hostname trusted for same-origin mutations, "
                             "for example this machine's tailnet DNS name (repeatable).")
    args = parser.parse_args()
    aliases = args.allowed_host
    if aliases is None:
        aliases = os.environ.get("TASKWEB_ALLOWED_HOSTS", "")
    try:
        server = TaskHTTPServer((args.host, args.port), Taskwarrior(), args.static_dir, aliases)
    except (APIError, OSError, ValueError) as exc:
        parser.exit(1, f"Cannot start Taskwarrior web: {exc}\n")
    print(f"Taskwarrior {server.task.version} web listening on http://{args.host}:{server.server_port}", flush=True)
    if server.allowed_hosts:
        print("Trusted request hostnames: " + ", ".join(sorted(server.allowed_hosts)), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
