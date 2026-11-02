"""Real CLI integration tests: every Taskwarrior process uses an isolated fixture."""
import http.client
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from urllib.parse import urlencode

from server import APIError, TaskHTTPServer, Taskwarrior, sqlite_image_digest


@unittest.skipUnless(shutil.which("task"), "Taskwarrior CLI is required")
class ServerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="taskweb-test-")
        self.root = Path(self.temp.name)
        self.rc = self.root / "taskrc"
        self.include = self.root / "reports.rc"
        self.data = self.root / "data"
        self.static = self.root / "dist"
        self.static.mkdir()
        (self.static / "index.html").write_text("<html>fixture</html>")
        (self.static / "asset.js").write_text("console.log('fixture')")
        self.include.write_text("\n".join([
            "report.external.columns=id,tiebreak,project,description",
            "report.external.labels=ID,Order,Project,Description",
            "report.external.filter=( project:alpha or project:beta ) and +PENDING limit:page",
            "report.external.sort=tiebreak-,project+/,description+",
            "report.external.context=1",
            "report.external.description=Fixture external report",
            "report.unscoped.columns=id,description",
            "report.unscoped.filter=+PENDING",
            "report.unscoped.sort=description+",
            "report.unscoped.context=0",
        ]) + "\n")
        self.rc.write_text("\n".join([
            f"data.location={self.data}", f"include {self.include}",
            "confirmation=no", "news.version=3.5.0", "context.work.read=project:alpha",
            "context.work.write=project:alpha", "uda.tiebreak.type=numeric",
            "uda.tiebreak.label=Order", "uda.priority.values=H,M,L,",
            "print.empty.columns=0",
        ]) + "\n")
        self.env = dict(os.environ, TASKRC=str(self.rc), TASKDATA=str(self.data))
        # Never inherit task hooks or config: the fixture rc is the only authority.
        self.task = Taskwarrior(self.env)
        self.server = TaskHTTPServer(("127.0.0.1", 0), self.task, self.static)
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()
        self.port = self.server.server_port
        self.origin = f"http://127.0.0.1:{self.port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def cli(self, *args):
        result = subprocess.run(["task", "rc.verbose=nothing", "rc.confirmation=no", *args],
                                env=self.env, text=True, capture_output=True,
                                stdin=subprocess.DEVNULL, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        return result.stdout

    def request(self, method, path, body=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        default = {"Origin": self.origin, "Content-Type": "application/json"}
        default.update(headers or {})
        payload = json.dumps(body).encode() if isinstance(body, (dict, list)) else body
        connection.request(method, path, body=payload, headers=default)
        response = connection.getresponse()
        data = response.read()
        result_headers = dict(response.getheaders())
        connection.close()
        if "application/json" in result_headers.get("Content-Type", ""):
            data = json.loads(data)
        return response.status, data, result_headers

    def command(self, command, uuids=None, expected=200):
        status, body, _ = self.request("POST", "/api/command", {"command": command, "uuids": uuids or []})
        self.assertEqual(status, expected, body)
        return body

    def tasks(self, report="next", filter=""):
        status, body, _ = self.request("GET", "/api/tasks?" + urlencode({"report": report, "filter": filter}))
        self.assertEqual(status, 200, body)
        return body

    def add(self, text, **attributes):
        self.command("add " + json.dumps(text) + " " + " ".join(f"{k}:{v}" for k, v in attributes.items()))
        return next(t for t in self.tasks("all")["tasks"] if t["description"] == text)

    def wait_revision(self, previous):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            if self.server.monitor.revision != previous:
                return self.server.monitor.revision
            time.sleep(0.025)
        self.fail("No change revision within two seconds")

    def read_event(self, response):
        event, data = None, None
        while True:
            line = response.readline().decode().rstrip("\r\n")
            if not line and event:
                return event, json.loads(data)
            if line.startswith("event: "):
                event = line[7:]
            if line.startswith("data: "):
                data = line[6:]

    def test_metadata_health_and_static_assets(self):
        status, body, _ = self.request("GET", "/api/health")
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertRegex(body["version"], r"^\d+\.")
        status, meta, _ = self.request("GET", "/api/meta")
        self.assertEqual(status, 200)
        external = next(r for r in meta["reports"] if r["name"] == "external")
        self.assertEqual(external["columns"], ["id", "tiebreak", "project", "description"])
        self.assertEqual(external["sort"], "tiebreak-,project+/,description+")
        self.assertEqual(external["labels"], ["ID", "Order", "Project", "Description"])
        self.assertFalse(meta["printEmptyColumns"])
        self.assertEqual(meta["udas"]["tiebreak"]["type"], "numeric")
        self.assertIn("work", meta["contexts"])
        self.assertEqual(meta["priorities"], ["H", "M", "L"])
        self.assertIn("tiebreak", meta["attributes"])
        self.assertEqual(self.request("GET", "/")[0], 200)
        self.assertEqual(self.request("GET", "/nested/route")[0], 200)
        self.assertEqual(self.request("GET", "/missing.js")[0], 404)
        self.assertEqual(self.request("HEAD", "/asset.js")[1], b"")
        self.assertEqual(self.request("GET", "/api/missing")[0], 404)
        self.assertEqual(self.request("OPTIONS", "/api/command")[0], 405)

    def test_add_modify_done_start_stop_annotate_delete_undo(self):
        task = self.add('read "quoted" words and 2 things', project="alpha", priority="H", due="tomorrow")
        u = task["uuid"]
        self.assertIsInstance(task["id"], int)
        self.assertGreater(task["id"], 0)
        self.assertEqual(task["project"], "alpha")
        self.assertIn("due", task)
        self.command('m "replacement text" project:beta +one +two due:later', [u])
        updated = self.tasks()["tasks"][0]
        self.assertEqual(updated["description"], "replacement text")
        self.assertEqual(updated["project"], "beta")
        self.assertEqual(set(updated["tags"]), {"one", "two"})
        self.command("start", [u])
        self.assertIn("start", self.tasks()["tasks"][0])
        self.command("stop", [u])
        self.assertNotIn("start", self.tasks()["tasks"][0])
        self.command("b", [u])
        self.assertIn("start", self.tasks()["tasks"][0])
        self.command("b", [u])
        self.assertNotIn("start", self.tasks()["tasks"][0])
        self.command('A "annotation with spaces and project:literal"', [u])
        annotations = self.tasks()["tasks"][0]["annotations"]
        self.assertEqual(annotations[0]["description"], "annotation with spaces and project:literal")
        self.command('E "annotation with spaces and project:literal"', [u])
        self.assertFalse(self.tasks()["tasks"][0].get("annotations"))
        self.command("d", [u])
        self.assertEqual(self.tasks()["tasks"], [])
        completed = self.tasks("completed")["tasks"][0]
        self.assertEqual(completed["uuid"], u)
        self.assertTrue("id" not in completed or completed["id"] > 0)
        self.command("u")
        self.assertEqual(self.tasks()["tasks"][0]["uuid"], u)
        self.command("D", [u])
        self.assertEqual(self.tasks()["tasks"], [])
        self.assertEqual(self.tasks("all")["tasks"][0]["status"], "deleted")

    def test_native_report_sort_grouped_or_filter_and_context(self):
        alpha = self.add("alpha pending", project="alpha", tiebreak=2)
        beta = self.add("beta pending", project="beta", tiebreak=10)
        self.add("gamma unrelated", project="gamma", tiebreak=18)
        done = self.add("beta completed", project="beta", tiebreak=15)
        self.command("done", [done["uuid"]])
        deleted = self.add("alpha deleted", project="alpha", tiebreak=17)
        self.command("delete", [deleted["uuid"]])
        result = self.tasks("external", "project:alpha or project:beta")
        self.assertEqual([t["uuid"] for t in result["tasks"]], [beta["uuid"], alpha["uuid"]])
        self.command("context work")
        scoped = self.tasks("external", "project:alpha or project:beta")
        self.assertEqual([t["uuid"] for t in scoped["tasks"]], [alpha["uuid"]])
        self.assertEqual(scoped["context"], "work")
        self.assertEqual(len(self.tasks("unscoped")["tasks"]), 3)
        self.command("context none")
        self.assertEqual(len(self.tasks("external")["tasks"]), 2)
        self.assertEqual(self.tasks("next", "description:'alpha pending'")["tasks"][0]["uuid"], alpha["uuid"])

    def test_configured_limits_removed_without_losing_native_sort(self):
        for index in range(30):
            self.cli("add", f"description:row {index:02d}", "project:alpha", f"tiebreak:{index}")
        rows = self.tasks("external")["tasks"]
        self.assertEqual(len(rows), 30)
        self.assertEqual([t["tiebreak"] for t in rows], list(range(29, -1, -1)))
        self.assertEqual(len(self.tasks("external", "limit:3")["tasks"]), 3)
        self.assertEqual(self.tasks("external", "+no_such_tag")["tasks"], [])

    def test_missing_export_ids_and_tw2_projection_fallback(self):
        self.add("first", project="alpha", tiebreak=2)
        second = self.add("second", project="beta", tiebreak=10)
        original = self.task.run
        def omit_ids(args, **kwargs):
            output = original(args, **kwargs)
            if len(args) >= 2 and args[-2:] == ["export", "external"]:
                tasks = json.loads(output)
                for task in tasks:
                    task.pop("id", None)
                return json.dumps(tasks)
            return output
        with patch.object(self.task, "run", side_effect=omit_ids):
            rows = self.task.tasks("external")["tasks"]
            self.assertEqual(rows[0]["uuid"], second["uuid"])
            self.assertTrue(all(isinstance(t["id"], int) and t["id"] > 0 for t in rows))
        # Execute the TW2 branch against the real CLI; actual TW2 binary is not required.
        with patch.object(self.task, "version", "2.6.2"):
            rows = self.task.tasks("external")["tasks"]
            self.assertEqual(rows[0]["uuid"], second["uuid"])
            self.assertTrue(all(t["id"] > 0 for t in rows))

    def test_uuid_selected_mutation_with_numbers_and_other_selectors(self):
        first = self.add("first")
        chosen = self.add("chosen")
        other = self.add("other")
        self.cli(first["uuid"], "done")
        # An external operation changes working-set IDs. The browser selection is UUID-only.
        self.cli("rc.gc=on", "next")
        self.command('modify "buy 2 apples"', [chosen["uuid"]])
        self.command("modify 2 or " + other["uuid"], [chosen["uuid"]])
        rows = {t["uuid"]: t for t in self.tasks()["tasks"]}
        self.assertEqual(rows[chosen["uuid"]]["description"], "2 or " + other["uuid"])
        self.assertEqual(rows[other["uuid"]]["description"], "other")
        self.command("done", [chosen["uuid"]])
        self.assertEqual([t["uuid"] for t in self.tasks()["tasks"]], [other["uuid"]])

    def test_multi_selection_is_an_explicit_uuid_union(self):
        first = self.add("first")
        second = self.add("second")
        untouched = self.add("untouched")
        self.command("modify +picked", [first["uuid"], second["uuid"]])
        rows = {t["uuid"]: t for t in self.tasks()["tasks"]}
        self.assertIn("picked", rows[first["uuid"]]["tags"])
        self.assertIn("picked", rows[second["uuid"]]["tags"])
        self.assertFalse(rows[untouched["uuid"]].get("tags"))
        self.command("b", [first["uuid"], second["uuid"]])
        self.command("done", [first["uuid"], second["uuid"]])
        self.assertEqual([t["uuid"] for t in self.tasks()["tasks"]], [untouched["uuid"]])

    def test_reject_overrides_mass_mutations_and_shell_commands(self):
        task = self.add("untouched")
        for command in ("modify due:tomorrow", "done", "delete", "annotate text", "stop"):
            self.command(command, expected=400)
        for command in ("m rc.data.location:/tmp", "m rc.confirmation=no", "m -- due:tomorrow",
                        "m rc:/tmp/nope", "done 1", "done " + task["uuid"], "config x y",
                        "execute echo nope", "import file", "! echo nope", "m uuid:other"):
            self.command(command, [task["uuid"]], expected=400)
        self.command("m project:alpha", ["1"], expected=400)
        self.command("m project:alpha", ["00000000-0000-0000-0000-000000000000"], expected=409)
        self.command("add", expected=400)
        self.command('add "unclosed', expected=400)
        self.assertEqual(self.tasks()["tasks"][0]["description"], "untouched")
        status, body, _ = self.request("GET", "/api/tasks?" + urlencode({"report": "next", "filter": "rc.data.location:/tmp"}))
        self.assertEqual(status, 400, body)

    def test_shell_looking_text_is_literal_and_never_executes(self):
        marker = self.root / "must-not-exist"
        literal = f"$(touch {marker}) ; && | > `touch {marker}`"
        task = self.add(literal)
        self.assertEqual(task["description"], literal)
        self.assertFalse(marker.exists())
        self.command("modify " + json.dumps(literal + " 2 or 3"), [task["uuid"]])
        self.command("annotate " + json.dumps(literal), [task["uuid"]])
        row = self.tasks()["tasks"][0]
        self.assertEqual(row["description"], literal + " 2 or 3")
        self.assertEqual(row["annotations"][0]["description"], literal)
        self.assertFalse(marker.exists())
        self.command(f"add ordinary ; touch {marker}")
        self.assertFalse(marker.exists())

    def test_recurrence_materializes_natively_and_revision_settles(self):
        self.cli("rc.recurrence=off", "add", "recurring fixture", "due:today", "recur:daily")
        # Settle the parent creation before measuring the query's legitimate write.
        time.sleep(0.6)
        previous = self.server.monitor.revision
        rows = self.tasks()["tasks"]
        self.assertTrue(rows)
        self.assertTrue(all(t.get("parent") and t["status"] == "pending" for t in rows))
        self.wait_revision(previous)
        settled = self.server.monitor.revision
        for _ in range(3):
            self.assertEqual({t["uuid"] for t in self.tasks()["tasks"]}, {t["uuid"] for t in rows})
            time.sleep(0.2)
        time.sleep(0.6)
        self.assertEqual(self.server.monitor.revision, settled)

    def test_origin_host_json_and_asset_path_boundaries(self):
        for origin in ("http://attacker.invalid", "null", self.origin + "/path", "https://127.0.0.1:" + str(self.port)):
            status, _, _ = self.request("POST", "/api/command", {"command": "add should-not-write"}, {"Origin": origin})
            self.assertEqual(status, 403)
        self.assertEqual(self.request("POST", "/api/command", {"command": "add bad"}, {"Host": "attacker.invalid"})[0], 403)
        self.assertEqual(self.request("POST", "/api/command", '{"command":"add bad"}', {"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request("POST", "/api/command", "not json")[0], 400)
        self.assertEqual(self.request("POST", "/api/command", ["add", "bad"])[0], 400)
        secret = self.root / "outside.txt"
        secret.write_text("outside fixture")
        (self.static / "linked.txt").symlink_to(secret)
        (self.static / "dir").mkdir()
        (self.static / "dir" / "index.html").symlink_to(secret)
        for path in ("/%2e%2e/outside.txt", "/../outside.txt", "/linked.txt", "/dir/", "/%2f../outside.txt", "/%00"):
            self.assertEqual(self.request("GET", path)[0], 403, path)
        self.assertEqual(self.tasks()["tasks"], [])

    def test_report_filter_switch_commands_and_clear_errors(self):
        self.assertEqual(self.command(":external")["report"], "external")
        self.assertEqual(self.command(":r external")["report"], "external")
        self.assertEqual(self.command(":f project:alpha or project:beta")["filter"], "project:alpha or project:beta")
        self.assertEqual(self.command(":f")["filter"], "")
        self.command(":r does-not-exist", expected=400)
        self.command("context does-not-exist", expected=400)
        bad = self.command("add text due:not-a-real-date", expected=400)
        self.assertTrue(bad["error"])
        self.assertNotIn("TASKRC override", bad["error"])

    def test_tiebreak_clamps_and_defaults_without_external_helper(self):
        task = self.add("ranked")
        self.command("tiebreak 1", [task["uuid"]])
        self.assertEqual(self.tasks()["tasks"][0]["tiebreak"], 10)
        self.command("modify tiebreak:18", [task["uuid"]])
        self.assertFalse(self.command("tiebreak 1", [task["uuid"]])["changed"])
        self.command("modify tiebreak:0", [task["uuid"]])
        self.assertFalse(self.command("tiebreak -1", [task["uuid"]])["changed"])
        self.command("tiebreak 3", [task["uuid"]], expected=400)
        self.command("tiebreak 1", expected=400)

    def test_external_sse_change_and_read_stability(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=3)
        connection.request("GET", "/api/events")
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        event, ready = self.read_event(response)
        self.assertEqual(event, "ready")
        started = time.monotonic()
        self.cli("add", "external change", "project:external", "+newtag")
        event, change = self.read_event(response)
        self.assertEqual(event, "change")
        self.assertLess(time.monotonic() - started, 2)
        self.assertNotEqual(ready["revision"], change["revision"])
        _, meta, _ = self.request("GET", "/api/meta")
        self.assertIn("external", meta["projects"])
        self.assertIn("newtag", meta["tags"])
        # Full browser refreshes cannot change the content-derived revision.
        previous = self.server.monitor.revision
        for _ in range(4):
            self.tasks()
            self.request("GET", "/api/meta")
            time.sleep(0.2)
        time.sleep(0.6)
        self.assertEqual(self.server.monitor.revision, previous)
        response.close()
        connection.close()

    def test_v2_files_and_live_sqlite_wal_signal_changes(self):
        self.data.mkdir(exist_ok=True)
        previous = self.server.monitor.revision
        (self.data / "pending.data").write_text("synthetic Taskwarrior 2 fixture bytes\n")
        self.wait_revision(previous)
        database = self.data / "db.sqlite3"
        connection = sqlite3.connect(database)
        try:
            connection.execute("pragma journal_mode=wal")
            connection.execute("pragma wal_autocheckpoint=0")
            connection.execute("create table synthetic (value text)")
            previous = self.server.monitor.revision
            connection.commit()
            self.wait_revision(previous)
            previous = self.server.monitor.revision
            connection.execute("insert into synthetic values ('external WAL commit')")
            connection.commit()
            self.wait_revision(previous)
            previous = self.server.monitor.revision
            connection.execute("pragma wal_checkpoint(truncate)")
            time.sleep(0.7)
            self.assertEqual(self.server.monitor.revision, previous)
        finally:
            connection.close()

    def test_sync_is_an_explicit_no_argument_cli_command(self):
        original = self.task.run
        def no_network(args, **kwargs):
            if args == ["sync"]:
                return "Synthetic sync successful"
            return original(args, **kwargs)
        with patch.object(self.task, "run", side_effect=no_network):
            self.assertTrue(self.command("sync")["changed"])
            self.assertTrue(self.command("S")["changed"])
        self.command("sync execute", expected=400)

    def test_included_config_and_external_context_invalidate_revision(self):
        previous = self.server.monitor.revision
        with self.include.open("a") as file:
            file.write("report.external.description=Changed fixture report\n")
        self.wait_revision(previous)
        _, meta, _ = self.request("GET", "/api/meta")
        self.assertEqual(next(r for r in meta["reports"] if r["name"] == "external")["description"], "Changed fixture report")
        previous = self.server.monitor.revision
        self.cli("context", "work")
        self.wait_revision(previous)
        self.assertEqual(self.tasks()["context"], "work")


class SQLiteImageTests(unittest.TestCase):
    def test_wal_commits_detected_checkpoint_and_read_do_not_invalidate(self):
        # A separate synthetic SQLite DB tests the file watcher, never the user's DB.
        with tempfile.TemporaryDirectory(prefix="taskweb-wal-test-") as directory:
            database = Path(directory) / "db.sqlite3"
            connection = sqlite3.connect(database)
            connection.execute("pragma journal_mode=wal")
            connection.execute("pragma wal_autocheckpoint=0")
            connection.execute("create table fixture (value text)")
            connection.commit()
            first = sqlite_image_digest(database)
            connection.execute("insert into fixture values ('a')")
            connection.commit()
            second = sqlite_image_digest(database)
            self.assertNotEqual(first, second)
            connection.execute("select * from fixture").fetchall()
            self.assertEqual(sqlite_image_digest(database), second)
            connection.execute("pragma wal_checkpoint(truncate)")
            self.assertEqual(sqlite_image_digest(database), second)
            connection.close()
            self.assertEqual(sqlite_image_digest(database), second)


if __name__ == "__main__":
    unittest.main()
