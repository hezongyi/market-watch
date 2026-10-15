#!/usr/bin/env python3
"""Ubuntu-only, task-scoped Market Watch builds, retirement and disk recording."""

import argparse
import contextlib
import datetime as dt
import fcntl
import grp
import hashlib
import importlib.util
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import uuid
from pathlib import Path

BUILDER = "market-watch-ubuntu"
PREFIX = "io.market-watch."
STATE = Path.home() / ".local/share/market-watch-docker"
DOCKER = ["/usr/bin/docker", "--host", "unix:///var/run/docker.sock"]
PG14_IMAGE = "postgres:14.24-bookworm@sha256:993166bee3ea12e2baa70f47efe7ba4a191b3e92f44f9767eaefbb6194f53872"


def now():
    return dt.datetime.now(dt.timezone.utc)


def stamp():
    return now().isoformat()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, indent=2) + "\n")
    tmp.chmod(0o600)
    tmp.replace(path)


def append_record(path, value):
    if path.exists() and path.stat().st_size > 16 * 2**20:
        path.replace(path.with_suffix(".previous.jsonl"))
    with path.open("a") as file:
        file.write(json.dumps(value) + "\n")


def read(path, default=None):
    return json.loads(path.read_text()) if path.exists() else default


def valid_name(value):
    if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,99}", value):
        raise ValueError("Task/project name must be lowercase and contain only a-z, 0-9, _, ., -")
    return value


class Docker:
    def __init__(self):
        if "ID=ubuntu" not in Path("/etc/os-release").read_text().splitlines():
            raise RuntimeError("These tools only run on Ubuntu")
        self.env = {
            k: v
            for k, v in os.environ.items()
            if k
            not in (
                "DOCKER_HOST",
                "DOCKER_CONTEXT",
                "DOCKER_TLS_VERIFY",
                "DOCKER_CERT_PATH",
                "BUILDX_BUILDER",
                "COMPOSE_BAKE",
            )
        }
        self.env.update(DOCKER_BUILDKIT="1", BUILDX_BUILDER=BUILDER, COMPOSE_BAKE="true")
        info = self.json("info", "--format", "{{json .}}")
        if "Ubuntu" not in info.get("OperatingSystem", ""):
            raise RuntimeError("Docker server must be local Ubuntu")

    def command(self, args):
        cmd = DOCKER + list(args)
        gid = grp.getgrnam("docker").gr_gid
        if gid not in os.getgroups() and os.getegid() != gid:
            return ["sg", "docker", "-c", shlex.join(cmd)]
        return cmd

    def run(self, *args, input=None, live=False, check=True, timeout=None):
        q = subprocess.run(
            self.command(args), env=self.env, input=input, capture_output=not live, timeout=timeout
        )
        if check and q.returncode:
            STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
            (STATE / "last-error-private.log").write_bytes((q.stdout or b"") + (q.stderr or b""))
            raise RuntimeError(
                "Docker command failed; see ~/.local/share/market-watch-docker/"
                "last-error-private.log"
            )
        return q

    def out(self, *args, **kw):
        return self.run(*args, **kw).stdout.decode().strip()

    def json(self, *args):
        return json.loads(self.out(*args))

    def containers(self):
        ids = self.out("ps", "-aq").split()
        return self.json("inspect", *ids) if ids else []

    def images(self):
        ids = self.out("image", "ls", "-aq", "--filter", f"label={PREFIX}managed=true").split()
        return self.json("image", "inspect", *sorted(set(ids))) if ids else []


def task_path(task):
    return STATE / "tasks" / (valid_name(task) + ".json")


def register(task, project, purpose):
    p = task_path(task)
    old = read(p, {})
    if old.get("project") not in (None, project) or old.get("purpose") not in (None, purpose):
        raise ValueError("A task cannot change project or purpose; use a new task name")
    if old.get("completed_at"):
        raise ValueError("Task already completed; use a new task name")
    save(
        p,
        {
            **old,
            "task": task,
            "project": project,
            "purpose": purpose,
            "created_at": old.get("created_at", stamp()),
        },
    )


def labels_for(args):
    valid_name(args.task)
    project = valid_name(args.project or args.task)
    repo = Path(args.repo).resolve()
    commit = subprocess.check_output(["git", "-C", str(repo), "rev-parse", "HEAD"]).decode().strip()
    dirty = bool(subprocess.check_output(["git", "-C", str(repo), "status", "--porcelain"]))
    built = now()
    expires = (built + dt.timedelta(days=args.retain_days)).isoformat()
    labels = {
        PREFIX + "managed": "true",
        PREFIX + "task": args.task,
        PREFIX + "project": project,
        PREFIX + "purpose": args.purpose,
        PREFIX + "commit": commit,
        PREFIX + "dirty": str(dirty).lower(),
        PREFIX + "built-at": built.isoformat(),
        PREFIX + "expires-at": expires if args.purpose in ("development", "acceptance") else "",
    }
    for value in getattr(args, "build_arg", []):
        if value.startswith("VITE_ADVANCED_CHART_ORIGIN="):
            labels[PREFIX + "chart-origin"] = value.split("=", 1)[1]
    register(args.task, project, args.purpose)
    return labels


def dockerfile_bases(path):
    stages = set()
    result = set()
    for line in path.read_text().splitlines():
        match = re.match(
            r"^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?", line, re.IGNORECASE
        )
        if match:
            base, stage = match.groups()
            if base.lower() != "scratch" and base.lower() not in stages:
                if "$" in base:
                    raise ValueError("ARG-based FROM needs --base-source registry")
                result.add(base)
            if stage:
                stages.add(stage.lower())
    return result


def check_build_tag(docker, ref, labels):
    q = docker.run("image", "inspect", ref, check=False)
    if q.returncode:
        return
    existing = json.loads(q.stdout)[0]["Config"].get("Labels") or {}
    if any(
        existing.get(PREFIX + key) != labels[PREFIX + key]
        for key in ("managed", "task", "project", "purpose")
    ):
        raise ValueError(
            f"Image tag belongs to another or untracked task: {ref}; choose a new task tag"
        )


@contextlib.contextmanager
def base_contexts(docker, files, mode):
    if mode == "registry":
        yield {}
        return
    # BuildKit cannot see Docker's image store. Export fixed local base bytes as
    # OCI inputs; remove all temporary input archives and layouts after the build.
    with tempfile.TemporaryDirectory(prefix="base-input-", dir=STATE) as tmp:
        result = {}
        for i, ref in enumerate(sorted({b for f in files for b in dockerfile_bases(f)})):
            q = docker.run("image", "inspect", ref, check=False)
            if q.returncode:
                raise ValueError(
                    f"Local base missing: {ref}; import/pull it on Ubuntu first, "
                    "or explicitly use --base-source registry"
                )
            archive = Path(tmp) / (str(i) + ".tar")
            layout = Path(tmp) / str(i)
            layout.mkdir()
            docker.run("image", "save", "--output", str(archive), ref)
            with tarfile.open(archive) as tar:
                for member in tar:
                    name = member.name
                    if name not in ("index.json", "oci-layout") and not re.fullmatch(
                        r"blobs/sha256/[0-9a-f]{64}", name
                    ):
                        continue
                    if not member.isfile():
                        raise ValueError("Unexpected OCI archive member")
                    dest = layout / name
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    with tar.extractfile(member) as src, dest.open("wb") as out:
                        shutil.copyfileobj(src, out)
            archive.unlink()
            index = read(layout / "index.json")
            if not index or len(index["manifests"]) != 1:
                raise ValueError("Expected one OCI base manifest")
            digest = index["manifests"][0]["digest"]
            result[ref] = f"oci-layout://{layout}@{digest}"
        yield result


def build(docker, args):
    labels = labels_for(args)
    check_build_tag(docker, args.tag, labels)
    repo = Path(args.repo).resolve()
    context = (
        Path(args.context).resolve()
        if args.context
        else (repo / {"api": ".", "web": "web", "chart": "."}[args.component])
    )
    file = (
        Path(args.file).resolve()
        if args.file
        else repo / "advanced-host/Dockerfile"
        if args.component == "chart" and not args.context
        else context / "Dockerfile"
    )
    cmd = [
        "buildx",
        "build",
        "--builder",
        BUILDER,
        "--load",
        "--progress",
        "plain",
        "--tag",
        args.tag,
    ]
    if args.file or file != context / "Dockerfile":
        cmd += ["--file", str(file)]
    for k, v in labels.items():
        cmd += ["--label", k + "=" + v]
    for v in args.build_arg:
        cmd += ["--build-arg", v]
    with base_contexts(docker, [file], args.base_source) as bases:
        for ref, source in bases.items():
            cmd += ["--build-context", ref + "=" + source]
        cmd += [str(context)]
        docker.run(*cmd, live=True)
    print(json.dumps({"task": args.task, "tag": args.tag, "builder": BUILDER}))


def compose(docker, args):
    labels = labels_for(args)
    if not args.project:
        raise ValueError("Compose builds require an explicit isolated --project")
    cmd = [
        "compose",
        "--project-name",
        valid_name(args.project),
        "--project-directory",
        str(Path(args.repo).resolve()),
    ]
    if args.env_file:
        cmd += ["--env-file", str(Path(args.env_file).resolve())]
    for file in args.file:
        cmd += ["--file", str(Path(file).resolve())]
    config = docker.json(*cmd, "config", "--format", "json")  # Never print config/env.
    services = {
        name: {"build": {"labels": labels}}
        for name, value in config["services"].items()
        if value.get("build")
    }
    if not services:
        raise ValueError("Compose project has no buildable services")
    for name, value in config["services"].items():
        if name in services:
            check_build_tag(docker, value.get("image") or args.project + "-" + name, labels)
    # Compose/Bake consumes a small JSON override, including the image labels.
    files = []
    for value in config["services"].values():
        if value.get("build"):
            b = value["build"]
            files.append(Path(b["context"]) / b.get("dockerfile", "Dockerfile"))
    with base_contexts(docker, files, args.base_source) as bases:
        for value in services.values():
            value["build"]["additional_contexts"] = bases
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json") as f:
            json.dump({"services": services}, f)
            f.flush()
            docker.run(
                *cmd, "--file", f.name, "build", "--builder", BUILDER, *args.services, live=True
            )


def referenced(image, containers):
    ids = {image["Id"]} | set(image.get("RepoDigests") or [])
    ids.update(d.rsplit("@", 1)[-1] for d in image.get("RepoDigests") or [])
    tags = set(image.get("RepoTags") or [])
    for c in containers:
        ref = c["Config"]["Image"]
        ident = c["Image"]
        if ident in ids or ref in tags or ref in ids:
            return True
        if re.fullmatch(r"[0-9a-f]{12,64}", ref) and image["Id"].split(":")[-1].startswith(ref):
            return True
    return False


def candidates(images, containers, tasks, task=None, automatic=False, at=None):
    at = at or now()
    result = []
    for image in images:
        label = image.get("Config", {}).get("Labels") or {}
        name = label.get(PREFIX + "task")
        if label.get(PREFIX + "managed") != "true" or (task and name != task):
            continue
        if label.get(PREFIX + "purpose") not in ("development", "acceptance"):
            continue  # Releases/rollback images are never automatically retired.
        record = tasks.get(name, {})
        if not record.get("completed_at") or record.get("purpose") != label.get(PREFIX + "purpose"):
            continue
        if record.get("project") != label.get(PREFIX + "project"):
            continue
        if referenced(image, containers):
            continue  # Stopped containers protect images too.
        if any(
            (c["Config"].get("Labels") or {}).get("com.docker.compose.project") == record["project"]
            for c in containers
        ):
            continue
        if automatic:
            try:
                expires = dt.datetime.fromisoformat(label[PREFIX + "expires-at"])
                if expires.tzinfo is None or expires > at:
                    continue
            except (KeyError, ValueError):
                continue
        result.append(
            {"id": image["Id"], "task": name, "refs": image.get("RepoTags") or [image["Id"]]}
        )
    return result


def task_records():
    return {p.stem: read(p) for p in (STATE / "tasks").glob("*.json")}


def finish(docker, task):
    path = task_path(task)
    record = read(path)
    if not record:
        raise ValueError("Task not registered")
    cs = docker.containers()
    owned = [
        i for i in docker.images() if (i["Config"].get("Labels") or {}).get(PREFIX + "task") == task
    ]
    if any(
        (c["Config"].get("Labels") or {}).get("com.docker.compose.project") == record["project"]
        for c in cs
    ) or any(referenced(i, cs) for i in owned):
        raise ValueError("Task still has container references; retire its exact project first")
    record["completed_at"] = stamp()
    save(path, record)
    print(json.dumps({"task": task, "completed_at": record["completed_at"]}))


def cleanup(docker, task=None, apply=False, automatic=False, retained_images=()):
    records = task_records()
    protected = set(retained_images) | {image for record in records.values()
                                       for image in record.get('retained_images', [])}
    plan = [row for row in candidates(docker.images(), docker.containers(), records, task, automatic)
            if row['id'] not in protected]
    print(json.dumps({"apply": apply, "automatic": automatic, "images": plan}, indent=2))
    outcomes = []
    if apply:
        for item in plan:
            # Re-resolve every tag and live container before mutation. Never force.
            for ref in item["refs"]:
                q = docker.run("image", "inspect", ref, check=False)
                if q.returncode:
                    outcomes.append({"ref": ref, "status": "already_absent"})
                    continue
                image = json.loads(q.stdout)[0]
                current = candidates(
                    [image], docker.containers(), task_records(), item["task"], automatic
                )
                if image["Id"] != item["id"] or not current:
                    outcomes.append({"ref": ref, "status": "protected_or_changed"})
                    continue
                q = docker.run("image", "rm", ref, check=False)
                outcomes.append(
                    {"ref": ref, "status": "removed" if q.returncode == 0 else "retained_conflict"}
                )
        record = {"at": stamp(), "images": outcomes}
        save(STATE / "last-cleanup.json", record)
        append_record(STATE / "cleanup.jsonl", record)
    return outcomes


def project_inventory(docker, project):
    cs = [
        c
        for c in docker.containers()
        if (c["Config"].get("Labels") or {}).get("com.docker.compose.project") == project
    ]
    vids = docker.out(
        "volume", "ls", "-q", "--filter", "label=com.docker.compose.project=" + project
    ).split()
    ns = docker.out(
        "network", "ls", "-q", "--filter", "label=com.docker.compose.project=" + project
    ).split()
    vs = docker.json("volume", "inspect", *vids) if vids else []
    return cs, vs, ns


def retirement_postgres(container):
    reference = container["Config"]["Image"]
    service = (container["Config"].get("Labels") or {}).get("com.docker.compose.service")
    # A fixed local ID is only a candidate here. The actual inspected image
    # still has to prove the reviewed official RepoDigest before any mutation.
    if re.fullmatch(r"sha256:[a-f0-9]{64}", reference):
        return reference == container["Image"] and service in ("postgres", "pg")
    return bool(
        re.fullmatch(
            r"(?:docker.io/library/)?postgres:(?:14(?:-bookworm)?|14\.24-bookworm)(?:@sha256:[a-f0-9]{64})?",
            container["Config"]["Image"],
        )
    )


def validate_retirement_image(task, project, container, image, retained_images=()):
    if image["Id"] != container["Image"]:
        raise ValueError("Inspected image ID does not match the container's actual image")
    labels = image["Config"].get("Labels") or {}
    # PostgreSQL and the pinned TLS gateway are shared infrastructure images;
    # retire only their project containers, never these unowned base images.
    if retirement_postgres(container):
        trusted = "postgres@sha256:993166bee3ea12e2baa70f47efe7ba4a191b3e92f44f9767eaefbb6194f53872"
        digests = {ref.removeprefix("docker.io/library/") for ref in image.get("RepoDigests", [])}
        if trusted not in digests or any(key.startswith(PREFIX) for key in labels):
            raise ValueError("PostgreSQL must be the reviewed, unowned official PG14 image")
        return
    service = (container["Config"].get("Labels") or {}).get("com.docker.compose.service")
    if service == "tls" and container["Config"]["Image"] in (
        "nginx:1.28-alpine",
        "nginx:1.28-alpine@sha256:201aafcbd9cdd5385d5aaf610b45389944d8c2269c4a6f10e6fdf39f76cab592",
        image["Id"],
    ):
        trusted = "nginx@sha256:201aafcbd9cdd5385d5aaf610b45389944d8c2269c4a6f10e6fdf39f76cab592"
        if any(key.startswith(PREFIX) for key in labels):
            raise ValueError("Shared TLS image must not have task/release ownership labels")
        if trusted in image.get("RepoDigests", []):
            return
    if image["Id"] in retained_images:
        if container["Config"]["Image"] != image["Id"]:
            raise ValueError("Retained dependency must use its exact full image ID")
        ownership = {k: v for k, v in labels.items() if k.startswith(PREFIX)}
        if ownership:
            if labels.get(PREFIX + "purpose") not in ("development", "acceptance") or not all(
                labels.get(PREFIX + key) for key in ("task", "project", "managed")
            ) or labels.get(PREFIX + "managed") != "true":
                raise ValueError("Retained dependency has incomplete, release or rollback ownership")
            if "production" in labels[PREFIX + "project"]:
                raise ValueError("Production dependencies cannot use retirement exceptions")
        return  # Explicit container-only retirement; this image stays protected.
    expected = {"managed": "true", "task": task, "project": project, "purpose": "acceptance"}
    if any(labels.get(PREFIX + key) != value for key, value in expected.items()):
        raise ValueError("Container image does not belong to the registered acceptance task")


def validate_retirement(project, cs, vs, all_cs):
    if not cs:
        raise ValueError("Exact project has no containers")
    ids = {c["Id"] for c in cs}
    volumes = {v["Name"] for v in vs}
    for c in cs:
        if (c["Config"].get("Labels") or {}).get("com.docker.compose.project") != project:
            raise ValueError("Container project mismatch")
        service = (c["Config"].get("Labels") or {}).get("com.docker.compose.service")
        if (service == "postgres" or retirement_postgres(c)) and not any(
            m["Type"] == "volume" and m["Destination"] == "/var/lib/postgresql/data"
            for m in c["Mounts"]
        ):
            raise ValueError("PostgreSQL data must be in its owned volume; refuse deletion")
        for m in c["Mounts"]:
            if m["Type"] == "volume" and m["Name"] not in volumes:
                raise ValueError("External/unowned volume: refuse retirement")
            if m["Type"] == "bind" and (
                m["Destination"].startswith("/var/lib/postgresql")
                or c["Config"]["Image"].startswith("postgres")
            ):
                raise ValueError("Bind-mounted database requires a separate reviewed backup")
    for v in vs:
        if (v.get("Labels") or {}).get("com.docker.compose.project") != project:
            raise ValueError("Volume project mismatch")
        if any(
            c["Id"] not in ids and any(m.get("Name") == v["Name"] for m in c["Mounts"])
            for c in all_cs
        ):
            raise ValueError("Volume shared with another project")
        users = [
            c
            for c in cs
            if any(
                m.get("Name") == v["Name"] and m["Destination"] == "/var/lib/postgresql/data"
                for m in c["Mounts"]
            )
        ]
        if len(users) != 1 or not retirement_postgres(users[0]):
            raise ValueError("Only a single owned PG14 data volume is supported automatically")


def pg(docker, container, user, database, sql):
    return docker.out(
        "exec",
        container,
        "psql",
        "-U",
        user,
        "-d",
        database,
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        sql,
    )


def table_counts(docker, container, user, database):
    tables = pg(
        docker,
        container,
        user,
        database,
        "SELECT json_build_array(schemaname, tablename)::text FROM pg_tables "
        "WHERE schemaname NOT IN ('pg_catalog', 'information_schema') "
        "AND schemaname NOT LIKE 'pg_toast%' ORDER BY schemaname, tablename",
    )
    result = {}
    for line in tables.splitlines():
        schema, table = json.loads(line)
        qualified = '.'.join('"' + part.replace('"', '""') + '"' for part in (schema, table))
        result[qualified] = int(
            pg(docker, container, user, database, "SELECT count(*) FROM " + qualified)
        )
    return result


def table_fingerprints(docker, container, user, database, tables):
    """Compare restored row content, including custom schemas and duplicates."""
    result = {}
    for qualified in tables:
        content = docker.run('exec', container, 'psql', '-U', user, '-d', database,
            '-q', '-v', 'ON_ERROR_STOP=1', '-c',
            'COPY (SELECT row_to_json(t)::text AS row FROM ' + qualified +
            ' AS t ORDER BY row_to_json(t)::text COLLATE "C") TO STDOUT').stdout
        result[qualified] = hashlib.sha256(content).hexdigest()
    return result


def private_configs(dest, cs):
    paths = set()
    for c in cs:
        label = c["Config"].get("Labels") or {}
        for p in label.get("com.docker.compose.project.config_files", "").split(","):
            if p:
                paths.add(Path(p))
        for m in c["Mounts"]:
            if m["Type"] == "bind":
                paths.add(Path(m["Source"]))

    def safe(member):
        if any(
            p in ("node_modules", ".venv", "charting_library", "__pycache__")
            for p in Path(member.name).parts
        ):
            return None
        return member

    with tarfile.open(dest / "configuration-private.tar.gz", "w:gz") as archive:
        for i, path in enumerate(sorted(paths)):
            if not path.exists():
                raise ValueError("Missing mounted/configuration file; archive before retirement")
            archive.add(path, arcname="input-" + str(i), filter=safe)
    # Env values are preserved in private inspect; env files are discovered from config
    # by operators if stored elsewhere. Do not output env values.
    save(dest / "configuration-sources-private.json", [str(p) for p in sorted(paths)])


def retire(docker, args):
    project = valid_name(args.project)
    task = valid_name(args.task)
    retained_images = set(args.retain_image)
    if any(not re.fullmatch(r"sha256:[a-f0-9]{64}", value) for value in retained_images):
        raise ValueError("Retained dependencies require full sha256 image IDs")
    record = read(task_path(task))
    if not record or record["project"] != project or record["purpose"] != "acceptance":
        raise ValueError("Only registered acceptance tasks with matching project can retire")
    confirmed_name = getattr(args, "confirm_acceptance_project", None)
    if confirmed_name is not None and (confirmed_name != project or task != project):
        raise ValueError("Acceptance name confirmation must exactly match task and project")
    if not project.startswith(("mw-", "market-watch-")) or (
            "production" in project and confirmed_name != project):
        raise ValueError("Expected an isolated Market Watch acceptance project")
    cs, vs, ns = project_inventory(docker, project)
    if retained_images - {c['Image'] for c in cs}:
        raise ValueError("Retained dependency is not used by this exact project")
    validate_retirement(project, cs, vs, docker.containers())
    for c in cs:
        validate_retirement_image(task, project, c, docker.json("image", "inspect", c["Image"])[0], retained_images)
    print(
        json.dumps(
            {
                "project": project,
                "task": task,
                "apply": args.apply,
                "containers": [c["Name"].lstrip("/") for c in cs],
                "volumes": [v["Name"] for v in vs],
                "networks": ns,
                "retained_images": sorted(retained_images),
            },
            indent=2,
        )
    )
    if not args.apply:
        return
    free = os.statvfs(STATE)
    if free.f_bavail * free.f_frsize < 10 * 2**30:
        raise ValueError("At least 10 GiB free is required for backup/restore validation")
    dest = Path(args.archive_root).expanduser().resolve() / (
        project + "-" + now().strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8]
    )
    dest.mkdir(parents=True, mode=0o700)
    dest.chmod(0o700)
    save(dest / "container-inspect-private.json", cs)
    private_configs(dest, cs)
    pgcs = [
        c
        for c in cs
        if any(
            m.get("Name") in {v["Name"] for v in vs}
            and m["Destination"] == "/var/lib/postgresql/data"
            for m in c["Mounts"]
        )
    ]
    # Check PG executables before stopping any writer; unsupported cases fail closed.
    for c in pgcs:
        docker.run("exec", c["Id"], "pg_dump", "--version")
    started = [c["Id"] for c in cs if c["State"]["Status"] == "running"]
    removed = False
    try:
        writers = [c for c in started if c not in {v["Id"] for v in pgcs}]
        if writers:
            docker.run("stop", "--time", "20", *writers)
        backups = []
        for c in pgcs:
            if c["State"]["Status"] != "running":
                raise ValueError("PostgreSQL must be running for actual restore verification")
            env = dict(s.split("=", 1) for s in c["Config"]["Env"] if "=" in s)
            user = env.get("POSTGRES_USER", "postgres")
            if int(
                pg(
                    docker,
                    c["Id"],
                    user,
                    "postgres",
                    "SELECT count(*) FROM pg_stat_activity WHERE backend_type = "
                    "'client backend' AND pid <> pg_backend_pid()",
                )
            ):
                raise ValueError("Database still has external clients; retirement refused")
            # Explicit custom connections are not supported; PG container env is authoritative.
            databases = pg(
                docker,
                c["Id"],
                user,
                "postgres",
                "SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname",
            )
            for db in databases.splitlines():
                name = hashlib.sha256((c["Id"] + db).encode()).hexdigest()[:16] + ".dump"
                original = table_counts(docker, c["Id"], user, db)
                original_fingerprints = table_fingerprints(docker, c["Id"], user, db, original)
                dump = docker.run(
                    "exec",
                    c["Id"],
                    "pg_dump",
                    "-U",
                    user,
                    "-d",
                    db,
                    "-Fc",
                    "--no-owner",
                    "--no-privileges",
                ).stdout
                (dest / name).write_bytes(dump)
                verify = "mw_restore_" + uuid.uuid4().hex[:16]
                pg(
                    docker,
                    c["Id"],
                    user,
                    "postgres",
                    'CREATE DATABASE "' + verify + '" TEMPLATE template0',
                )
                try:
                    docker.run(
                        "exec",
                        "-i",
                        c["Id"],
                        "pg_restore",
                        "-U",
                        user,
                        "-d",
                        verify,
                        "--no-owner",
                        "--no-privileges",
                        "--exit-on-error",
                        input=dump,
                    )
                    if table_counts(docker, c["Id"], user, verify) != original:
                        raise ValueError("Actual restore row counts differ")
                    if table_fingerprints(docker, c["Id"], user, verify, original) != original_fingerprints:
                        raise ValueError("Actual restore row content differs")
                    if table_counts(docker, c["Id"], user, db) != original:
                        raise ValueError("Source database changed during archive")
                    if table_fingerprints(docker, c["Id"], user, db, original) != original_fingerprints:
                        raise ValueError("Source row content changed during archive")
                finally:
                    pg(docker, c["Id"], user, "postgres", 'DROP DATABASE "' + verify + '"')
                backups.append(
                    {
                        "volume_names": [m["Name"] for m in c["Mounts"] if m["Type"] == "volume"],
                        "database": db,
                        "file": name,
                        "sha256": hashlib.sha256(dump).hexdigest(),
                        "tables": original,
                        "table_fingerprints": original_fingerprints,
                        "actual_restore_verified": True,
                    }
                )
            (dest / (c["Id"][:12] + "-globals-private.sql")).write_bytes(
                docker.run("exec", c["Id"], "pg_dumpall", "-U", user, "--globals-only").stdout
            )
        save(dest / "verified-backups.json", backups)
        fresh_cs, fresh_vs, fresh_ns = project_inventory(docker, project)
        if (
            {c["Id"] for c in cs} != {c["Id"] for c in fresh_cs}
            or {v["Name"] for v in vs} != {v["Name"] for v in fresh_vs}
            or set(ns) != set(fresh_ns)
        ):
            raise ValueError("Project changed while archiving")
        validate_retirement(project, fresh_cs, fresh_vs, docker.containers())
        for c in fresh_cs:
            validate_retirement_image(task, project, c,
                docker.json("image", "inspect", c["Image"])[0], retained_images)
        for v in vs:
            if not any(v["Name"] in b["volume_names"] for b in backups):
                raise ValueError("Volume has no verified restore")
        for n in ns:
            attached = docker.json("network", "inspect", n)[0].get("Containers", {})
            if not set(attached) <= {c["Id"] for c in cs}:
                raise ValueError("Network shared outside project")
        if pgcs:
            docker.run("stop", "--time", "30", *[c["Id"] for c in pgcs])
        docker.run("rm", *[c["Id"] for c in cs])
        removed = True
        for n in ns:
            if docker.json("network", "inspect", n)[0].get("Containers"):
                raise ValueError("Network still has references; retained")
            docker.run("network", "rm", n)
        for v in vs:
            current = docker.json("volume", "inspect", v["Name"])[0]
            if (current.get("Labels") or {}).get("com.docker.compose.project") != project:
                raise ValueError("Volume ownership changed; retained")
            docker.run("volume", "rm", v["Name"])  # Docker also checks live references.
        save(
            dest / "retired.json",
            {
                "project": project,
                "task": task,
                "at": stamp(),
                "containers": len(cs),
                "volumes": [v["Name"] for v in vs],
                "networks": ns,
                "verified_backups": backups,
                "retained_images": sorted(retained_images),
            },
        )
        finish(docker, task)
        completed = read(task_path(task))
        completed['retained_images'] = sorted(retained_images)
        save(task_path(task), completed)
        cleanup(docker, task=task, apply=True, retained_images=retained_images)
        print(json.dumps({"archive": str(dest), "restore_verified": True}))
    except Exception:
        if not removed:
            for c in started:
                docker.run("start", c, check=False)
        raise


def storage_sizes(docker):
    # Read-only exact host mounts via an existing local image; no broad host mount.
    cmd = (
        "for p in /store /store/io.containerd.content.v1.content "
        "/store/io.containerd.snapshotter.v1.overlayfs /data/volumes /data/containers "
        "/logs /logs/journal /data/volumes/*/_data; "
        'do du -x -B1 -s "$p"; done'
    )
    q = docker.run(
        "run",
        "--rm",
        "--name",
        "mw-disk-monitor-probe",
        "--network",
        "none",
        "--read-only",
        "--user",
        "0",
        "--label",
        PREFIX + "monitor=true",
        "--mount",
        "type=bind,src=/var/lib/containerd,dst=/store,readonly",
        "--mount",
        "type=bind,src=/var/lib/docker,dst=/data,readonly",
        "--mount",
        "type=bind,src=/var/log,dst=/logs,readonly",
        "--entrypoint",
        "sh",
        PG14_IMAGE,
        "-c",
        cmd,
        check=False,
        timeout=45,
    )
    sizes = {}
    for line in (q.stdout or b"").decode().splitlines():
        value, _, path = line.partition("\t")
        if value.isdigit():
            sizes[path] = int(value)
    return {"bytes": sizes, "complete": q.returncode == 0}


def monitor(docker, args):
    disk = os.statvfs("/")
    available = disk.f_bavail * disk.f_frsize
    threshold = args.threshold_gib * 2**30
    low = available < threshold
    cs = docker.containers()
    projects = {}
    for c in cs:
        project = (c["Config"].get("Labels") or {}).get("com.docker.compose.project")
        if project:
            projects.setdefault(project, {"running": 0, "other": 0})[
                "running" if c["State"]["Status"] == "running" else "other"
            ] += 1
    record = {
        "at": stamp(),
        "total_bytes": disk.f_blocks * disk.f_frsize,
        "available_bytes": available,
        "low_space": low,
        "threshold_gib": args.threshold_gib,
        "projects": projects,
    }
    if args.detail:
        storage = storage_sizes(docker)
        record["storage_bytes"] = storage["bytes"]
        record["storage_audit_complete"] = storage["complete"]
        rows = docker.out("image", "ls", "-a", "--format", "{{.Repository}}:{{.Tag}}").splitlines()
        record["image_refs"] = len(rows)
        record["dangling_refs"] = sum(r.startswith("<none>:") for r in rows)
        du = subprocess.run(
            ["du", "-x", "-B1", "-s", "/home/quant", "/tmp"], capture_output=True, timeout=90
        )
        record["user_directory_sizes"] = du.stdout.decode().splitlines()
    history = STATE / ("daily.jsonl" if args.detail else "disk.jsonl")
    append_record(history, record)
    save(STATE / "latest-disk.json", record)
    old = read(STATE / "alert.json", {})
    alert = {
        "at": stamp(),
        "active": low,
        "available_gib": round(available / 2**30, 2),
        "threshold_gib": args.threshold_gib,
    }
    save(STATE / "alert.json", alert)
    print(json.dumps(record))
    if low:
        msg = f"Market Watch: Ubuntu可用空间 {available / 2**30:.1f} GiB，低于 {args.threshold_gib} GiB"
        print("LOW_DISK: " + msg, file=sys.stderr)
        if (
            not old.get("active")
            or not old.get("last_notified_at")
            or (now() - dt.datetime.fromisoformat(old["last_notified_at"])).total_seconds() > 21600
        ):
            # Local journal / logged-in terminal only; no external messages.
            subprocess.run(["logger", "-t", "market-watch-disk", msg], check=False)
            subprocess.run(["wall", "--nobanner", msg], check=False, capture_output=True)
            alert["last_notified_at"] = stamp()
        else:
            alert["last_notified_at"] = old["last_notified_at"]
        save(STATE / "alert.json", alert)
        return 3
    return 0


def preview_module():
    spec = importlib.util.spec_from_file_location(
        "mw_preview", Path(__file__).with_name("mw_preview.py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parser():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)
    for name in ("build", "compose-build"):
        s = sub.add_parser(name)
        s.add_argument("--task", required=True)
        s.add_argument("--project")
        s.add_argument("--repo", default=".")
        s.add_argument(
            "--purpose",
            choices=["development", "acceptance", "release", "rollback"],
            default="development",
        )
        s.add_argument("--retain-days", type=int, default=7)
        s.add_argument("--base-source", choices=["local", "registry"], default="local")
        if name == "build":
            s.add_argument("--component", choices=["api", "web", "chart"], default="api")
            s.add_argument("--context")
            s.add_argument("--file")
            s.add_argument("--tag", required=True)
            s.add_argument("--build-arg", action="append", default=[])
        else:
            s.add_argument("--file", action="append", required=True)
            s.add_argument("--env-file")
            s.add_argument("services", nargs="*")
    s = sub.add_parser("finish")
    s.add_argument("--task", required=True)
    s = sub.add_parser("cleanup")
    group = s.add_mutually_exclusive_group(required=True)
    group.add_argument("--task")
    group.add_argument("--automatic", action="store_true")
    s.add_argument("--apply", action="store_true")
    s = sub.add_parser("retire")
    s.add_argument("--project", required=True)
    s.add_argument("--task", required=True)
    s.add_argument("--apply", action="store_true")
    s.add_argument("--archive-root", default=str(STATE / "archives"))
    s.add_argument("--confirm-acceptance-project",
                   help="Exact registered task/project name for an acceptance project whose name contains production; all resource/restore checks remain required")
    s.add_argument("--retain-image", action="append", default=[],
                   help="Explicit full-ID dependency: remove only own containers, preserve image")
    s = sub.add_parser("monitor")
    s.add_argument("--detail", action="store_true")
    s.add_argument("--threshold-gib", type=int, default=20)
    s = sub.add_parser("preview", help="Task-owned lightweight Ubuntu preview; manual concurrency")
    s.add_argument("action", choices=["prepare", "up", "status", "stop", "reset"])
    s.add_argument("--task", required=True)
    s.add_argument("--project", required=True)
    s.add_argument("--repo", default=".")
    s.add_argument("--api-image", help="Task-owned API image tag (prepare)")
    s.add_argument("--web-image", help="Optional task-owned web image (prepare)")
    s.add_argument("--chart-image", help="Optional task-owned licensed chart image (prepare)")
    s.add_argument("--port", type=int, default=18443, help="API HTTP or UI HTTPS loopback port")
    s.add_argument("--chart-port", type=int, help="Distinct chart HTTPS port for UI preview")
    s.add_argument("--worker", action="append", default=[], choices=sorted(preview_module().WORKERS))
    s.add_argument("--apply", action="store_true", help="Explicitly reset into a new DB; retain old DB")
    return p


def main():
    os.umask(0o077)
    args = parser().parse_args()
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Serialize our builds, retirements and automatic cleanup; external Docker clients
    # remain protected by fresh reference checks and non-force Docker deletes.
    lock_name = "monitor.lock" if args.command == "monitor" else "ops.lock"
    with (STATE / lock_name).open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        docker = Docker()
        if args.command == "build":
            if args.retain_days < 1:
                raise ValueError("retain-days must be positive")
            build(docker, args)
        elif args.command == "compose-build":
            if args.retain_days < 1:
                raise ValueError("retain-days must be positive")
            compose(docker, args)
        elif args.command == "finish":
            finish(docker, args.task)
        elif args.command == "cleanup":
            cleanup(docker, args.task, args.apply, args.automatic)
        elif args.command == "retire":
            retire(docker, args)
        elif args.command == "preview":
            print(json.dumps(preview_module().run(docker, args, sys.modules[__name__]), indent=2))
        else:
            return monitor(docker, args)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, ValueError, subprocess.TimeoutExpired) as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
