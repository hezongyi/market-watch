"""Preview isolation, state preservation and real synthetic data contracts."""

import hashlib
import importlib.util
import json
import socket
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "deploy/ubuntu" / (name + ".py"))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


m = module("mw_docker")
p = module("mw_preview")


class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        patch = mock.patch.object(m, "STATE", Path(self.tmp.name))
        patch.start()
        self.addCleanup(patch.stop)
        self.docker = mock.Mock()
        self.docker.containers.return_value = []
        self.docker.run.return_value = SimpleNamespace(returncode=1)
        self.args = m.parser().parse_args(
            [
                "preview",
                "prepare",
                "--task",
                "mw-preview-test",
                "--project",
                "mw-preview-test",
                "--repo",
                str(ROOT),
                "--api-image",
                "market-watch-api:test",
                "--port",
                "18001",
            ]
        )

    def prepare(self):
        return p.run(self.docker, self.args, m)

    def load(self):
        return p.load(m, self.args)

    def image(self, service, ref):
        if service == "postgres":
            digest = m.PG14_IMAGE.split("@")[1]
            labels = {}
            repo = "postgres"
        elif service == "tls":
            digest = p.NGINX.split("@")[1]
            labels = {}
            repo = "nginx"
        else:
            digest, repo = "sha256:" + "a" * 64, "app"
            labels = {
                m.PREFIX + k: v
                for k, v in dict(
                    managed="true",
                    task=self.args.task,
                    project=self.args.project,
                    purpose="acceptance",
                ).items()
            }
            if service == "web":
                labels[m.PREFIX + "chart-origin"] = "https://localhost:18002"
        return {
            "Id": "sha256:" + hashlib.sha256(ref.encode()).hexdigest(),
            "Config": {"Labels": labels},
            "RepoDigests": [repo + "@" + digest],
        }

    def mock_images(self):
        _, record, _ = self.load()
        config = m.read(Path(record["directory"]) / "compose.json")
        images = {
            s["image"]: self.image(name, s["image"]) for name, s in config["services"].items()
        }
        self.docker.json.side_effect = lambda *cmd: [images[cmd[-1]]]
        return images

    def test_reprepare_preserves_passwords_and_configuration(self):
        self.prepare()
        directory, record, _ = self.load()
        before = {f.name: f.read_bytes() for f in directory.iterdir()}
        self.assertEqual(self.prepare()["state"], "reused")
        self.assertEqual(before, {f.name: f.read_bytes() for f in directory.iterdir()})
        self.assertEqual(record["dataset"], "d1-v1-" + p.digest(directory / "d1_seed.py")[:12])
        self.assertEqual((directory.stat().st_mode & 0o777), 0o700)
        self.assertEqual(((directory / "credentials.json").stat().st_mode & 0o777), 0o600)

    def test_changed_parameters_and_modified_private_files_fail_closed(self):
        self.prepare()
        self.args.port = 18009
        with self.assertRaisesRegex(ValueError, "preserved"):
            self.prepare()
        self.args.port = 18001
        directory, _, _ = self.load()
        (directory / "compose.json").write_text("{}")
        with self.assertRaisesRegex(ValueError, "changed"):
            self.load()

    def test_different_tasks_are_isolated_and_have_different_credentials(self):
        self.prepare()
        _, first, secret1 = self.load()
        self.args.task = self.args.project = "mw-second"
        self.args.port = 18003
        self.prepare()
        _, second, secret2 = self.load()
        self.assertNotEqual(first["directory"], second["directory"])
        self.assertNotEqual(secret1["database_password"], secret2["database_password"])
        self.assertEqual(first["dataset"], second["dataset"])
        for record, secret in [(first, secret1), (second, secret2)]:
            config = p.compose(record, secret, m.PG14_IMAGE)
            self.assertEqual(config["name"], record["project"])
            self.assertTrue(config["networks"]["default"]["internal"])
            self.assertNotIn("name", config["volumes"]["postgres-data"])

    def test_existing_resources_and_production_names_cannot_be_adopted(self):
        for name in ("market-watch", "postgresql14", "mw-production-test", "../mw-task"):
            self.args.project = name
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.prepare()
        self.args.project = self.args.task
        self.docker.run.return_value = SimpleNamespace(returncode=0)
        with self.assertRaisesRegex(ValueError, "volume"):
            self.prepare()

    def test_project_cannot_be_reassigned_to_another_task(self):
        self.prepare()
        self.args.task = "mw-other"
        with self.assertRaisesRegex(ValueError, "another task"):
            self.prepare()

    def test_default_profile_and_ui_workers_have_limits_and_no_production_environment(self):
        self.prepare()
        directory, record, private = self.load()
        config = m.read(directory / "compose.json")
        self.assertEqual(set(config["services"]), {"postgres", "migrate", "seed", "api", "tls"})
        self.assertEqual(config["services"]["seed"]["profiles"], ["tools"])
        record.update(
            ui=True,
            workers=["chart-history", "native-history"],
            web_image="market-watch-web:test",
            chart_image="market-watch-chart:test",
            chart_port=18002,
        )
        config = p.compose(record, private, m.PG14_IMAGE)
        for name, item in config["services"].items():
            self.assertIn("mem_limit", item)
            self.assertIn("cpus", item)
            self.assertEqual(item["logging"]["options"]["max-size"], "10m")
            self.assertNotIn("env_file", item)
            if "environment" in item and name != "postgres":
                for key in (
                    "ALERTS_DELIVERY_ENABLED",
                    "ALERTS_YAHOO_ENABLED",
                    "ALERTS_OANDA_STREAM_ENABLED",
                ):
                    self.assertEqual(item["environment"][key], "false")
                self.assertEqual(item["environment"]["ALERTS_DATABASE_JIT"], "inherit")
        self.assertEqual(
            config["services"]["tls"]["ports"], ["127.0.0.1:18001:443", "127.0.0.1:18002:444"]
        )
        self.assertEqual(
            config["services"]["native-history-worker"]["command"][-1],
            "alerts.native_history_loads",
        )

    def test_start_pins_images_before_mutation_and_never_deletes_volumes(self):
        self.prepare()
        self.mock_images()
        self.args.action = "up"
        with mock.patch.object(p, "preflight"), mock.patch.object(m, "pg", return_value="140024"):
            report = p.run(self.docker, self.args, m)
        self.assertEqual(report["state"], "ready")
        run = m.read(self.load()[0] / "run.json")
        self.assertTrue(all(s["image"].startswith("sha256:") for s in run["services"].values()))
        calls = [c.args for c in self.docker.run.call_args_list]
        self.assertEqual(sum("seed" in cmd for cmd in calls), 1)
        self.assertFalse(any("down" in cmd or "rm" in cmd or "-v" in cmd for cmd in calls))
        self.assertTrue(any("--pull" in cmd and "never" in cmd for cmd in calls))

    def test_foreign_image_rejected_before_up_or_writer_stop(self):
        self.prepare()
        images = self.mock_images()
        images["market-watch-api:test"]["Config"]["Labels"][m.PREFIX + "task"] = "mw-foreign"
        self.args.action = "up"
        with self.assertRaisesRegex(ValueError, "does not belong"):
            p.run(self.docker, self.args, m)
        self.assertFalse(
            any("up" in call.args or "stop" in call.args for call in self.docker.run.call_args_list)
        )

    def test_stop_only_own_project_and_preserves_all_data(self):
        self.prepare()
        self.args.action = "stop"
        result = p.run(self.docker, self.args, m)
        self.assertEqual(result["data"], "preserved")
        command = self.docker.run.call_args.args
        self.assertEqual(command[-1], "stop")
        self.assertEqual(command[command.index("-p") + 1], self.args.project)
        self.assertNotIn("-v", command)

    def test_reset_is_preview_until_apply_and_preserves_previous_database(self):
        self.prepare()
        self.args.action = "reset"
        self.docker.run.reset_mock()
        self.assertFalse(p.run(self.docker, self.args, m)["apply"])
        self.assertFalse(any("up" in call.args for call in self.docker.run.call_args_list))
        self.args.apply = True
        self.mock_images()
        with (
            mock.patch.object(p, "preflight"),
            mock.patch.object(m, "pg", return_value="140024") as query,
        ):
            p.run(self.docker, self.args, m)
        _, record, _ = self.load()
        self.assertNotEqual(record["database"], "preview")
        self.assertEqual(record["reset_history"][0]["previous"], "preview")
        self.assertTrue(any("CREATE DATABASE" in c.args[-1] for c in query.call_args_list))
        self.assertFalse(any("DROP" in c.args[-1] for c in query.call_args_list))

    def test_unowned_volume_rejected(self):
        self.prepare()
        _, record, _ = self.load()
        self.docker.run.return_value = SimpleNamespace(
            returncode=0,
            stdout=json.dumps(
                [{"Name": self.args.project + "_postgres-data", "Labels": {}}]
            ).encode(),
        )
        with self.assertRaisesRegex(ValueError, "Unowned"):
            p.own_containers(self.docker, record, m)

    def test_shared_volume_rejected(self):
        self.prepare()
        _, record, _ = self.load()
        volume = record["project"] + "_postgres-data"
        self.docker.containers.return_value = [
            {"Id": "foreign", "Config": {"Labels": {}}, "Mounts": [{"Name": volume}]}
        ]
        self.docker.run.return_value = SimpleNamespace(
            returncode=0,
            stdout=json.dumps(
                [{"Name": volume, "Labels": {"com.docker.compose.project": record["project"]}}]
            ).encode(),
        )
        with self.assertRaisesRegex(ValueError, "shared"):
            p.own_containers(self.docker, record, m)

    def test_unowned_and_shared_edge_networks_rejected(self):
        self.prepare()
        _, record, _ = self.load()
        for labels, members in (
            ({}, {}),
            ({"com.docker.compose.project": record["project"]}, {"foreign": {}}),
        ):

            def inspect(*cmd, **kwargs):
                if cmd[-1] == record["project"] + "_edge":
                    return SimpleNamespace(
                        returncode=0,
                        stdout=json.dumps(
                            [{"Labels": labels, "Internal": False, "Containers": members}]
                        ).encode(),
                    )
                return SimpleNamespace(returncode=1)

            self.docker.run.side_effect = inspect
            with (
                self.subTest(labels=labels, members=members),
                self.assertRaisesRegex(ValueError, "network"),
            ):
                p.own_containers(self.docker, record, m)

    def test_backend_attached_to_edge_network_rejected(self):
        self.prepare()
        _, record, _ = self.load()
        self.docker.containers.return_value = [
            {
                "Id": "api",
                "Config": {
                    "Labels": {
                        "com.docker.compose.project": record["project"],
                        "com.docker.compose.service": "api",
                    }
                },
                "NetworkSettings": {
                    "Networks": {
                        record["project"] + "_default": {},
                        record["project"] + "_edge": {},
                    }
                },
            }
        ]
        with self.assertRaisesRegex(ValueError, "network isolation"):
            p.own_containers(self.docker, record, m)

    def test_gateway_requires_official_digest_and_matching_actual_id(self):
        self.prepare()
        image = self.image("tls", p.NGINX)
        container = {
            "Image": image["Id"],
            "Config": {"Image": image["Id"], "Labels": {"com.docker.compose.service": "tls"}},
        }
        m.validate_retirement_image(self.args.task, self.args.project, container, image)
        for mutation in ("wrong-digest", "wrong-id", "task-label"):
            import copy

            changed = copy.deepcopy(image)
            if mutation == "wrong-digest":
                changed["RepoDigests"] = ["foreign@" + p.NGINX.split("@")[1]]
            elif mutation == "wrong-id":
                changed["Id"] = "sha256:" + "f" * 64
            else:
                changed["Config"]["Labels"][m.PREFIX + "task"] = self.args.task
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                m.validate_retirement_image(self.args.task, self.args.project, container, changed)

    def test_port_probe_rejects_live_listener_but_allows_recently_stopped_gateway(self):
        self.prepare()
        _, record, _ = self.load()
        with (
            mock.patch.object(p, "own_containers", return_value=[]),
            mock.patch.object(
                p.os, "statvfs", return_value=SimpleNamespace(f_bavail=100 * 2**30, f_frsize=1)
            ),
            mock.patch.object(p.os, "getloadavg", return_value=(0, 0, 0)),
            mock.patch.object(Path, "read_text", return_value="MemAvailable: 16000000 kB"),
        ):
            with socket.socket() as listener:
                listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                listener.bind(("127.0.0.1", 0))
                listener.listen(1)
                record["port"] = listener.getsockname()[1]
                with self.assertRaisesRegex(ValueError, "port .* unavailable"):
                    p.preflight(self.docker, record, m)
                with socket.create_connection(listener.getsockname()) as client:
                    accepted, _ = listener.accept()
                    accepted.close()
                    self.assertEqual(client.recv(1), b"")
            p.preflight(self.docker, record, m)

    def test_migrate_or_seed_failure_leaves_writers_stopped_and_old_database_retained(self):
        self.prepare()
        self.mock_images()
        self.args.action = "reset"
        self.args.apply = True
        for failed_tool in ("migrate", "seed"):
            self.docker.run.reset_mock()

            def fail(*cmd, **kwargs):
                if "run" in cmd and cmd[-1] == failed_tool:
                    raise RuntimeError("tool failed")
                return SimpleNamespace(returncode=1)

            self.docker.run.side_effect = fail
            previous = self.load()[1]["database"]
            with (
                mock.patch.object(p, "preflight"),
                mock.patch.object(m, "pg", return_value="140024") as query,
                self.subTest(tool=failed_tool),
                self.assertRaisesRegex(RuntimeError, "tool failed"),
            ):
                p.run(self.docker, self.args, m)
            record = self.load()[1]
            self.assertEqual(record["reset_history"][-1]["previous"], previous)
            self.assertFalse(any("DROP" in c.args[-1] for c in query.call_args_list))
            starts = [c.args for c in self.docker.run.call_args_list if "up" in c.args]
            self.assertTrue(starts)
            self.assertTrue(all(cmd[-1] == "postgres" for cmd in starts))

    def test_compose_render_api_and_ui_worker_profiles_without_daemon(self):
        self.prepare()
        directory, record, private = self.load()
        for ui in (False, True):
            record.update(
                ui=ui,
                workers=["chart-history"] if ui else [],
                web_image="market-watch-web:test",
                chart_image="market-watch-chart:test",
                chart_port=18002,
            )
            m.save(directory / "test-compose.json", p.compose(record, private, m.PG14_IMAGE))
            # Compose validates bind file existence, not their contents.
            for name in ("tls.conf", "cert.pem", "key.pem"):
                (directory / name).touch()
            import subprocess

            result = subprocess.run(
                [
                    "/usr/bin/docker",
                    "compose",
                    "--env-file",
                    "/dev/null",
                    "-f",
                    str(directory / "test-compose.json"),
                    "config",
                    "--format",
                    "json",
                ],
                capture_output=True,
                text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            rendered = json.loads(result.stdout)
            self.assertTrue(rendered["networks"]["default"]["internal"])
            self.assertEqual(rendered["services"]["postgres"]["image"], m.PG14_IMAGE)
            # `config` re-escapes literal dollars for reuse as Compose input;
            # runtime login is checked in the Ubuntu smoke, including this hash.
            self.assertEqual(
                rendered["services"]["api"]["environment"]["ALERTS_ADMIN_PASSWORD_HASH"],
                private["login_hash"].replace("$", "$$"),
            )


class DatasetTests(unittest.TestCase):
    def test_seed_preserves_user_writes_and_is_bounded_and_repeatable(self):
        from alerts import storage
        from sqlalchemy import create_engine, func, select
        from sqlalchemy.orm import sessionmaker

        d = module("d1_seed")
        engine = create_engine("sqlite://")
        self.addCleanup(engine.dispose)
        factory = sessionmaker(engine, expire_on_commit=False)
        storage.bootstrap(engine)
        with mock.patch.object(storage, "Session", factory):
            self.assertEqual(d.seed("d1-v1-test"), "seeded")
            with storage.transaction() as db:
                self.assertEqual(db.scalar(select(func.count()).select_from(storage.Bar)), 5760)
                self.assertFalse(any(i.enabled for i in db.scalars(select(storage.Instrument))))
                pref = storage.Preference(key="acceptance.user-change", value={"keep": True})
                db.add(pref)
            self.assertEqual(d.seed("d1-v1-test"), "reused")
            with storage.transaction() as db:
                self.assertEqual(
                    db.get(storage.Preference, "acceptance.user-change").value, {"keep": True}
                )
            with self.assertRaisesRegex(ValueError, "Different dataset"):
                d.seed("d1-v1-other")

    def test_seed_refuses_unknown_data(self):
        from alerts import storage
        from sqlalchemy import create_engine
        from sqlalchemy.orm import sessionmaker

        d = module("d1_seed")
        engine = create_engine("sqlite://")
        self.addCleanup(engine.dispose)
        storage.bootstrap(engine)
        with mock.patch.object(storage, "Session", sessionmaker(engine, expire_on_commit=False)):
            with storage.transaction() as db:
                db.add(
                    storage.Bar(
                        instrument_id="BTCUSDT",
                        timeframe="M1",
                        start=0,
                        end=60000,
                        open=1,
                        high=2,
                        low=0,
                        close=1,
                    )
                )
            with self.assertRaisesRegex(ValueError, "Unrecognized"):
                d.seed("d1-v1-test")

    def test_guard_refuses_production_url_and_enabled_notification(self):
        from alerts.config import settings

        d = module("d1_seed")
        values = dict(
            database_url="postgresql+psycopg://preview:pw@postgres/preview",
            database_application_name="mw-test",
            database_expected_version=140024,
            delivery_enabled=False,
            yahoo_enabled=False,
            oanda_stream_enabled=False,
        )
        with (
            mock.patch.multiple(settings, **values),
            mock.patch.dict(
                "os.environ", {"MW_PREVIEW_TASK": "mw-test", "MW_PREVIEW_DATASET": "d1-v1-test"}
            ),
        ):
            self.assertEqual(d.validate(), "d1-v1-test")
            for key, value in [
                ("database_url", "postgresql+psycopg://preview@unraid/preview"),
                ("delivery_enabled", True),
                ("database_expected_version", None),
            ]:
                with mock.patch.object(settings, key, value), self.assertRaises(ValueError):
                    d.validate()


if __name__ == "__main__":
    unittest.main()
