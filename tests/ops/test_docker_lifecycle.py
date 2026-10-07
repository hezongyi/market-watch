import copy
import datetime as dt
import importlib.util
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
guard = module("docker_guard")


class ImageSafetyTests(unittest.TestCase):
    def setUp(self):
        self.at = dt.datetime(2026, 10, 7, tzinfo=dt.timezone.utc)
        self.image = {
            "Id": "sha256:" + "a" * 64,
            "RepoTags": ["mw-test:old"],
            "RepoDigests": ["mw-test@sha256:" + "b" * 64],
            "Config": {
                "Labels": {
                    m.PREFIX + "managed": "true",
                    m.PREFIX + "task": "mw-test",
                    m.PREFIX + "project": "mw-test",
                    m.PREFIX + "purpose": "acceptance",
                    m.PREFIX + "expires-at": "2026-10-01T00:00:00+00:00",
                }
            },
        }
        self.tasks = {
            "mw-test": {
                "project": "mw-test",
                "purpose": "acceptance",
                "completed_at": "2026-10-02T00:00:00+00:00",
            }
        }

    def plan(self, containers=None):
        return m.candidates([self.image], containers or [], self.tasks, automatic=True, at=self.at)

    def container(self, ref="mw-test:old", image=None):
        return {
            "Image": image or self.image["Id"],
            "Config": {"Image": ref, "Labels": {}},
            "State": {"Status": "exited"},
        }

    def test_only_completed_expired_owned_image_selected(self):
        self.assertEqual(len(self.plan()), 1)

    def test_stopped_container_protects_image(self):
        self.assertEqual(self.plan([self.container()]), [])

    def test_manifest_digest_reference_protected(self):
        self.assertEqual(self.plan([self.container(image=self.image["RepoDigests"][0])]), [])
        digest = self.image["RepoDigests"][0].rsplit("@", 1)[-1]
        self.assertEqual(self.plan([self.container(image=digest)]), [])

    def test_short_fixed_id_protected(self):
        self.assertEqual(self.plan([self.container(ref="a" * 12, image="other")]), [])

    def test_live_task_protected(self):
        self.tasks["mw-test"].pop("completed_at")
        self.assertEqual(self.plan(), [])

    def test_release_never_deleted(self):
        self.image["Config"]["Labels"][m.PREFIX + "purpose"] = "release"
        self.assertEqual(self.plan(), [])

    def test_missing_or_invalid_expiry_protected(self):
        for value in ["", "invalid", "2026-10-01T00:00:00"]:
            self.image["Config"]["Labels"][m.PREFIX + "expires-at"] = value
            self.assertEqual(self.plan(), [])

    def test_future_expiry_protected(self):
        self.image["Config"]["Labels"][m.PREFIX + "expires-at"] = "2027-10-01T00:00:00Z"
        self.assertEqual(self.plan(), [])

    def test_project_mismatch_protected(self):
        self.tasks["mw-test"]["project"] = "other"
        self.assertEqual(self.plan(), [])

    def test_project_container_protects_other_image(self):
        c = self.container(ref="other", image="other")
        c["Config"]["Labels"]["com.docker.compose.project"] = "mw-test"
        self.assertEqual(self.plan([c]), [])

    def test_unmanaged_protected(self):
        self.image["Config"]["Labels"].pop(m.PREFIX + "managed")
        self.assertEqual(self.plan(), [])


class RetirementSafetyTests(unittest.TestCase):
    def setUp(self):
        self.c = {
            "Id": "pg",
            "Config": {
                "Image": "postgres:14-bookworm",
                "Labels": {
                    "com.docker.compose.project": "mw-test",
                    "com.docker.compose.service": "postgres",
                },
            },
            "Mounts": [
                {"Type": "volume", "Name": "mw-test_pg", "Destination": "/var/lib/postgresql/data"}
            ],
        }
        self.v = {"Name": "mw-test_pg", "Labels": {"com.docker.compose.project": "mw-test"}}

    def test_owned_pg_volume_allowed(self):
        m.validate_retirement("mw-test", [self.c], [self.v], [self.c])

    def test_pg_service_alias_with_owned_volume_allowed(self):
        self.c["Config"]["Labels"]["com.docker.compose.service"] = "pg"
        m.validate_retirement("mw-test", [self.c], [self.v], [self.c])

    def test_full_fixed_pg_id_with_owned_volume_allowed(self):
        self.c['Image'] = self.c['Config']['Image'] = 'sha256:' + 'a' * 64
        m.validate_retirement('mw-test', [self.c], [self.v], [self.c])

    def test_postgres_service_cannot_hide_unknown_database_image(self):
        self.c["Config"]["Image"] = "unknown:latest"
        with self.assertRaises(ValueError):
            m.validate_retirement("mw-test", [self.c], [self.v], [self.c])

    def test_shared_volume_refused(self):
        other = copy.deepcopy(self.c)
        other["Id"] = "other"
        with self.assertRaises(ValueError):
            m.validate_retirement("mw-test", [self.c], [self.v], [self.c, other])

    def test_external_volume_refused(self):
        with self.assertRaises(ValueError):
            m.validate_retirement("mw-test", [self.c], [], [self.c])

    def test_ephemeral_pg_refused(self):
        self.c["Mounts"] = []
        with self.assertRaises(ValueError):
            m.validate_retirement("mw-test", [self.c], [], [self.c])

    def test_bind_pg_refused(self):
        self.c["Mounts"] = [
            {"Type": "bind", "Source": "/data", "Destination": "/var/lib/postgresql/data"}
        ]
        with self.assertRaises(ValueError):
            m.validate_retirement("mw-test", [self.c], [], [self.c])


class RetirementImageTests(unittest.TestCase):
    def setUp(self):
        self.container = {
            "Image": "sha256:gateway",
            "Config": {
                "Image": "nginx:1.28-alpine",
                "Labels": {
                    "com.docker.compose.project": "mw-test",
                    "com.docker.compose.service": "tls",
                },
            },
        }
        self.image = {
            "Id": "sha256:gateway",
            "Config": {"Labels": {}},
            "RepoDigests": [
                "nginx@sha256:201aafcbd9cdd5385d5aaf610b45389944d8c2269c4a6f10e6fdf39f76cab592"
            ],
        }

    def test_verified_shared_tls_image_allowed(self):
        m.validate_retirement_image("mw-test", "mw-test", self.container, self.image)

    def test_unverified_gateway_digest_refused(self):
        self.image["RepoDigests"] = []
        with self.assertRaises(ValueError):
            m.validate_retirement_image("mw-test", "mw-test", self.container, self.image)

    def test_changed_gateway_image_refused(self):
        self.image["Id"] = "sha256:changed"
        with self.assertRaises(ValueError):
            m.validate_retirement_image("mw-test", "mw-test", self.container, self.image)

    def test_task_or_release_labeled_gateway_refused(self):
        for labels in ({"task": "another-task"}, {"purpose": "release"}):
            self.image["Config"]["Labels"] = {m.PREFIX + k: v for k, v in labels.items()}
            with self.subTest(labels=labels), self.assertRaises(ValueError):
                m.validate_retirement_image("mw-test", "mw-test", self.container, self.image)

    def test_unowned_application_cannot_use_gateway_exception(self):
        self.container["Config"]["Labels"]["com.docker.compose.service"] = "web"
        with self.assertRaises(ValueError):
            m.validate_retirement_image("mw-test", "mw-test", self.container, self.image)

    def test_foreign_task_and_release_images_refused(self):
        self.container["Config"]["Image"] = "market-watch-api:test"
        for task, purpose in [("another-task", "acceptance"), ("mw-test", "release")]:
            self.image["Config"]["Labels"] = {
                m.PREFIX + key: value
                for key, value in {
                    "managed": "true",
                    "project": "mw-test",
                    "task": task,
                    "purpose": purpose,
                }.items()
            }
            with self.assertRaises(ValueError):
                m.validate_retirement_image("mw-test", "mw-test", self.container, self.image)


class RetirementPostgresIdentityTests(unittest.TestCase):
    TRUSTED = "postgres@sha256:993166bee3ea12e2baa70f47efe7ba4a191b3e92f44f9767eaefbb6194f53872"

    def setUp(self):
        self.container = {
            "Image": "sha256:actual-pg",
            "Config": {
                "Image": "postgres:14-bookworm",
                "Labels": {
                    "com.docker.compose.project": "mw-test",
                    "com.docker.compose.service": "pg",
                },
            },
        }
        self.image = {
            "Id": "sha256:actual-pg",
            "RepoDigests": [self.TRUSTED],
            "Config": {"Labels": {}},
        }

    def validate(self):
        m.validate_retirement_image("mw-test", "mw-test", self.container, self.image)

    def test_verified_official_pg_alias_allowed(self):
        self.validate()

    def test_fixed_pg_id_requires_actual_image_and_official_digest(self):
        fixed = 'sha256:' + 'a' * 64
        self.container['Image'] = self.container['Config']['Image'] = fixed
        self.image['Id'] = fixed
        self.assertTrue(m.retirement_postgres(self.container))
        self.validate()
        self.image['RepoDigests'] = []
        with self.assertRaises(ValueError):
            self.validate()

    def test_fixed_pg_id_mismatch_and_wrong_service_are_not_postgres(self):
        self.container['Config']['Image'] = 'sha256:' + 'a' * 64
        self.assertFalse(m.retirement_postgres(self.container))
        self.container['Image'] = self.container['Config']['Image']
        self.container['Config']['Labels']['com.docker.compose.service'] = 'api'
        self.assertFalse(m.retirement_postgres(self.container))

    def test_locally_retagged_pg_refused(self):
        self.image["RepoDigests"] = []
        with self.assertRaises(ValueError):
            self.validate()

    def test_unreviewed_pg_digest_refused(self):
        self.image["RepoDigests"] = ["postgres@sha256:" + "f" * 64]
        with self.assertRaises(ValueError):
            self.validate()

    def test_same_digest_under_other_repository_refused(self):
        self.image["RepoDigests"] = [self.TRUSTED.replace("postgres@", "example/pg@")]
        with self.assertRaises(ValueError):
            self.validate()

    def test_docker_io_normalized_official_digest_allowed(self):
        self.image["RepoDigests"] = ["docker.io/library/" + self.TRUSTED]
        self.validate()

    def test_actual_pg_image_id_mismatch_refused(self):
        self.image["Id"] = "sha256:changed"
        with self.assertRaises(ValueError):
            self.validate()

    def test_foreign_task_or_release_pg_labels_refused(self):
        for labels in (
            {"task": "different-task"},
            {"purpose": "release"},
            {"managed": "true", "task": "mw-test", "project": "mw-test", "purpose": "rollback"},
        ):
            self.image["Config"]["Labels"] = {m.PREFIX + k: v for k, v in labels.items()}
            with self.subTest(labels=labels), self.assertRaises(ValueError):
                self.validate()

    def test_foreign_release_retagged_pg_on_api_service_refused(self):
        self.container["Config"]["Labels"]["com.docker.compose.service"] = "api"
        self.image["RepoDigests"] = []
        self.image["Config"]["Labels"] = {
            m.PREFIX + "task": "foreign-task",
            m.PREFIX + "purpose": "release",
        }
        with self.assertRaises(ValueError):
            self.validate()

    def test_application_actual_image_id_mismatch_refused(self):
        self.container["Config"]["Image"] = "market-watch-api:test"
        self.image["Id"] = "sha256:changed"
        self.image["Config"]["Labels"] = {
            m.PREFIX + k: v
            for k, v in {
                "managed": "true",
                "task": "mw-test",
                "project": "mw-test",
                "purpose": "acceptance",
            }.items()
        }
        with self.assertRaises(ValueError):
            self.validate()


class RetainedDependencyTests(unittest.TestCase):
    def setUp(self):
        self.ident = 'sha256:' + 'c' * 64
        self.container = {'Image': self.ident, 'Config': {'Image': self.ident,
            'Labels': {'com.docker.compose.service': 'api'}}}
        self.image = {'Id': self.ident, 'Config': {'Labels': {}}}

    def validate(self):
        m.validate_retirement_image('mw-test', 'mw-test', self.container, self.image, {self.ident})

    def test_unowned_fixed_dependency_requires_explicit_retention(self):
        with self.assertRaises(ValueError):
            m.validate_retirement_image('mw-test', 'mw-test', self.container, self.image)
        self.validate()

    def test_other_acceptance_dependency_can_be_retained(self):
        self.image['Config']['Labels'] = {m.PREFIX + k: v for k,v in
            {'managed': 'true', 'task': 'mw-other', 'project': 'mw-other', 'purpose': 'acceptance'}.items()}
        self.validate()

    def test_retention_never_accepts_release_rollback_or_partial_labels(self):
        for labels in [{'purpose': 'release'}, {'purpose': 'rollback'}, {'managed': 'true'}]:
            self.image['Config']['Labels'] = {m.PREFIX + k: v for k,v in labels.items()}
            with self.subTest(labels=labels), self.assertRaises(ValueError):
                self.validate()

    def test_retention_rejects_mutable_tag_and_changed_actual_image(self):
        self.container['Config']['Image'] = 'dependency:latest'
        with self.assertRaises(ValueError):
            self.validate()
        self.container['Config']['Image'] = self.ident
        self.image['Id'] = 'sha256:' + 'd' * 64
        with self.assertRaises(ValueError):
            self.validate()

    def test_automatic_cleanup_preserves_recorded_retained_dependency(self):
        image = {'Id': self.ident}
        docker = SimpleNamespace(images=lambda: [image], containers=lambda: [], run=mock.Mock())
        with mock.patch.object(m, 'task_records', return_value={'mw-test': {'retained_images': [self.ident]}}), \
             mock.patch.object(m, 'candidates', return_value=[{'id': self.ident}]), \
             mock.patch('builtins.print'):
            self.assertEqual(m.cleanup(docker, automatic=True, apply=True), [])
        docker.run.assert_not_called()

    def test_restore_counts_include_nonpublic_schema_and_quote_identifiers(self):
        with mock.patch.object(m, 'pg', side_effect=['["public", "normal"]\n["a\\\"b", "custom"]', '4', '7']) as query:
            counts = m.table_counts(None, 'pg', 'user', 'db')
        self.assertEqual(counts, {'"public"."normal"': 4, '"a""b"."custom"': 7})
        self.assertNotIn("schemaname='public'", query.call_args_list[0].args[-1])
        self.assertEqual(query.call_args_list[2].args[-1], 'SELECT count(*) FROM "a""b"."custom"')

    def test_restore_fingerprints_detect_content_change_at_equal_row_count(self):
        docker = SimpleNamespace(run=mock.Mock(side_effect=[
            SimpleNamespace(stdout=b'{"price":1}\n'), SimpleNamespace(stdout=b'{"price":2}\n')]))
        source = m.table_fingerprints(docker, 'pg', 'user', 'original', {'"custom"."prices"': 1})
        restored = m.table_fingerprints(docker, 'pg', 'user', 'restored', {'"custom"."prices"': 1})
        self.assertNotEqual(source, restored)
        self.assertIn('ORDER BY row_to_json(t)::text COLLATE "C"', docker.run.call_args.args[-1])


class TagOwnershipTests(unittest.TestCase):
    def test_other_task_tag_cannot_be_overwritten(self):
        docker = SimpleNamespace(
            run=lambda *a, **k: SimpleNamespace(returncode=0, stdout=b'[{"Config":{"Labels":{}}}]')
        )
        labels = {
            m.PREFIX + k: v
            for k, v in {
                "managed": "true",
                "task": "mw-test",
                "project": "mw-test",
                "purpose": "acceptance",
            }.items()
        }
        with self.assertRaises(ValueError):
            m.check_build_tag(docker, "market-watch-api:dev", labels)


class MonitorTests(unittest.TestCase):
    def test_low_disk_sets_local_warning_and_returns_nonzero(self):
        with tempfile.TemporaryDirectory() as d:
            disk = SimpleNamespace(f_bavail=19 * 2**30, f_frsize=1, f_blocks=142 * 2**30)
            docker = SimpleNamespace(containers=lambda: [])
            args = SimpleNamespace(threshold_gib=20, detail=False)
            with (
                mock.patch.object(m, "STATE", Path(d)),
                mock.patch.object(m.os, "statvfs", return_value=disk),
                mock.patch.object(m.subprocess, "run") as notify,
                mock.patch("builtins.print"),
            ):
                self.assertEqual(m.monitor(docker, args), 3)
                self.assertTrue(m.read(Path(d) / "alert.json")["active"])
                self.assertEqual(notify.call_count, 2)
                # Repeated warning is throttled; record remains active.
                self.assertEqual(m.monitor(docker, args), 3)
                self.assertEqual(notify.call_count, 2)

    def test_above_threshold_clears_alert_without_notification(self):
        with tempfile.TemporaryDirectory() as d:
            disk = SimpleNamespace(f_bavail=21 * 2**30, f_frsize=1, f_blocks=142 * 2**30)
            with (
                mock.patch.object(m, "STATE", Path(d)),
                mock.patch.object(m.os, "statvfs", return_value=disk),
                mock.patch.object(m.subprocess, "run") as notify,
                mock.patch("builtins.print"),
            ):
                self.assertEqual(
                    m.monitor(
                        SimpleNamespace(containers=lambda: []),
                        SimpleNamespace(threshold_gib=20, detail=False),
                    ),
                    0,
                )
                self.assertFalse(m.read(Path(d) / "alert.json")["active"])
                notify.assert_not_called()


class BaseInputTests(unittest.TestCase):
    def test_multistage_only_external_bases(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "Dockerfile"
            p.write_text(
                "FROM --platform=linux/amd64 node:22 AS assets\n"
                "FROM assets AS test\nFROM scratch\nFROM nginx:1.28-alpine\n"
            )
            self.assertEqual(m.dockerfile_bases(p), {"node:22", "nginx:1.28-alpine"})

    def test_arg_base_fails_closed(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "Dockerfile"
            p.write_text("ARG BASE\nFROM ${BASE}\n")
            with self.assertRaises(ValueError):
                m.dockerfile_bases(p)


class BuildGuardTests(unittest.TestCase):
    def test_untracked_build_blocked(self):
        for args in [
            ["build", "."],
            ["buildx", "build", "."],
            ["compose", "-p", "mw-test", "up", "--build"],
        ]:
            with self.assertRaises(ValueError):
                guard.guarded_args(args, "/home/quant/repos/market-watch-main")

    def test_compose_up_cannot_implicitly_build(self):
        self.assertEqual(
            guard.guarded_args(["compose", "up", "-d"], "/home/quant/repos/market-watch-main"),
            ["compose", "up", "-d", "--no-build"],
        )

    def test_other_tasks_pass_through(self):
        self.assertEqual(guard.guarded_args(["build", "."], "/tmp/other"), ["build", "."])

    def test_readonly_commands_pass_through(self):
        self.assertEqual(guard.guarded_args(["ps"], "/home/quant/repos/market-watch"), ["ps"])


if __name__ == "__main__":
    unittest.main()
