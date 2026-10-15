"""Task-owned Ubuntu previews. No scheduler, global cleanup or production operations."""

import copy
import hashlib
import json
import os
import secrets
import socket
import subprocess
import uuid
from pathlib import Path

NGINX = "nginx:1.28-alpine@sha256:201aafcbd9cdd5385d5aaf610b45389944d8c2269c4a6f10e6fdf39f76cab592"
WORKERS = {
    "chart-history": "alerts.chart_history_worker",
    "chart-aggregation": "alerts.chart_aggregation_worker",
    "market-stream": "alerts.market_stream_worker",
    "native-history": "alerts.native_history_loads",
}


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def task_directory(m, task, project):
    for name in (task, project):
        m.valid_name(name)
        if not name.startswith(("mw-", "market-watch-")) or "production" in name:
            raise ValueError("preview requires an isolated mw-/market-watch- task and project")
    return m.STATE / "previews" / task


def service(image, memory, cpu):
    return {
        "image": image,
        "restart": "no",
        "mem_limit": memory,
        "cpus": cpu,
        "labels": {"market-watch.purpose": "acceptance"},
        "logging": {"driver": "json-file", "options": {"max-size": "10m", "max-file": "3"}},
    }


def gateway_config(ui):
    if ui:
        return 'resolver 127.0.0.11 valid=5s ipv6=off;\nupstream preview_web { zone preview_web 64k; server web:80 resolve; }\nupstream preview_chart { zone preview_chart 64k; server chart-origin:80 resolve; }\nserver { listen 443 ssl; ssl_certificate /certs/cert.pem; ssl_certificate_key /certs/key.pem;\nlocation / { proxy_pass http://preview_web; proxy_set_header Host $http_host;\nproxy_set_header X-Forwarded-Proto https; proxy_http_version 1.1;\nproxy_set_header Connection ""; proxy_buffering off; proxy_read_timeout 3600s; } }\nserver { listen 444 ssl; ssl_certificate /certs/cert.pem; ssl_certificate_key /certs/key.pem;\nlocation / { proxy_pass http://preview_chart; } }\n'
    return 'resolver 127.0.0.11 valid=5s ipv6=off;\nupstream preview_api { zone preview_api 64k; server api:8000 resolve; }\nserver { listen 80;\nlocation / { proxy_pass http://preview_api; proxy_set_header Host $http_host;\nproxy_set_header X-Forwarded-Proto http; proxy_http_version 1.1;\nproxy_set_header Connection ""; proxy_buffering off; proxy_read_timeout 3600s; } }\n'


def compose(record, private, pg_image):
    """Generate a standalone config; never load repo .env or production overlays."""
    database, password = record["database"], private["database_password"]
    backend = {
        "ALERTS_DATABASE_URL": f"postgresql+psycopg://preview:{password}@postgres/{database}",
        "ALERTS_DATABASE_APPLICATION_NAME": record["task"],
        "ALERTS_DATABASE_EXPECTED_VERSION": "140024",
        "ALERTS_DATABASE_JIT": "inherit",
        "ALERTS_DATABASE_POOL_SIZE": "1",
        "ALERTS_DATABASE_MAX_OVERFLOW": "0",
        # Compose interpolates dollar signs even in JSON environment values.
        "ALERTS_ADMIN_PASSWORD_HASH": private["login_hash"].replace("$", "$$"),
        "ALERTS_COOKIE_SECURE": "true" if record["ui"] else "false",
        "ALERTS_PUBLIC_URL": record["url"],
        "ALERTS_DELIVERY_ENABLED": "false",
        "ALERTS_YAHOO_ENABLED": "false",
        "ALERTS_OANDA_STREAM_ENABLED": "false",
        "ALERTS_INITIAL_HISTORY_DAYS": "0",
        "ALERTS_MCP_ENABLED": "false",
        "ALERTS_HISTORY_HEALTH_WORKERS": "[]",
        "MW_PREVIEW_TASK": record["task"],
        "MW_PREVIEW_DATASET": record["dataset"],
    }
    api = service(record["api_image"], "512m", 0.3)
    api["environment"] = backend
    migration = copy.deepcopy(api)
    migration.update(command=["alembic", "upgrade", "head"], profiles=["tools"])
    seed = copy.deepcopy(api)
    seed.update(
        command=["python", "/fixture/d1_seed.py"],
        profiles=["tools"],
        volumes=[str(Path(record["directory"]) / "d1_seed.py") + ":/fixture/d1_seed.py:ro"],
    )
    api["healthcheck"] = {
        "test": [
            "CMD",
            "python",
            "-c",
            "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/readyz', timeout=3)",
        ],
        "interval": "3s",
        "timeout": "4s",
        "retries": 20,
        "start_period": "15s",
    }
    postgres = service(pg_image, "768m" if record["workers"] else "512m", 0.3)
    # POSTGRES_DB describes first initialization; resets create another database
    # within this volume. Existing databases and credentials are never discarded.
    postgres.update(
        environment={
            "POSTGRES_DB": record["initial_database"],
            "POSTGRES_USER": "preview",
            "POSTGRES_PASSWORD": password,
        },
        volumes=["postgres-data:/var/lib/postgresql/data"],
        healthcheck={
            "test": [
                "CMD-SHELL",
                'pg_isready -U preview -d "$${POSTGRES_DB}" && test "$$(PGOPTIONS=\'-c jit=on\' psql -U preview -d "$${POSTGRES_DB}" -Atqc "SELECT current_setting(\'server_version_num\') = \'140024\' AND pg_jit_available()")" = t',
            ],
            "interval": "3s",
            "timeout": "3s",
            "retries": 20,
        },
    )
    services = {"postgres": postgres, "migrate": migration, "seed": seed, "api": api}
    tls = service(NGINX, "64m", 0.05)
    tls.update(
        networks=["default", "edge"],
        ports=[f"127.0.0.1:{record['port']}:{443 if record['ui'] else 80}"],
        volumes=[
            str(Path(record["directory"]) / "tls.conf") + ":/etc/nginx/conf.d/default.conf:ro"
        ],
        depends_on={"api": {"condition": "service_healthy"}},
        healthcheck={
            "test": [
                "CMD",
                "wget",
                "--no-check-certificate",
                "-q",
                "-O",
                "/dev/null",
                ("https" if record["ui"] else "http") + "://127.0.0.1/readyz",
            ],
            "interval": "3s",
            "timeout": "4s",
            "retries": 20,
        },
    )
    services["tls"] = tls
    for worker in record["workers"]:
        item = service(record["api_image"], "384m", 0.3)
        item.update(
            environment=backend,
            command=["python", "-m", WORKERS[worker]],
            depends_on={"api": {"condition": "service_healthy"}},
        )
        services[worker + "-worker"] = item
    if record["ui"]:
        web = service(record["web_image"], "64m", 0.05)
        web["depends_on"] = {"api": {"condition": "service_healthy"}}
        chart = service(record["chart_image"], "64m", 0.05)
        tls.update(
            ports=[f"127.0.0.1:{record['port']}:443", f"127.0.0.1:{record['chart_port']}:444"],
            volumes=[
                str(Path(record["directory"]) / name) + ":" + target + ":ro"
                for name, target in [
                    ("tls.conf", "/etc/nginx/conf.d/default.conf"),
                    ("cert.pem", "/certs/cert.pem"),
                    ("key.pem", "/certs/key.pem"),
                ]
            ],
            depends_on=["web", "chart-origin"],
        )
        services.update(web=web, **{"chart-origin": chart, "tls": tls})
    return {
        "name": record["project"],
        "services": services,
        "volumes": {"postgres-data": {}},
        "networks": {"default": {"internal": True}, "edge": {}},
    }


def load(m, args):
    directory = task_directory(m, args.task, args.project)
    record = m.read(directory / "preview.json")
    registered = m.read(m.task_path(args.task), {})
    if (
        not record
        or record["project"] != args.project
        or record["task"] != args.task
        or registered.get("project") != args.project
        or registered.get("purpose") != "acceptance"
        or registered.get("completed_at")
    ):
        raise ValueError("No active preview with the exact registered task/project")
    if str(directory) != record["directory"]:
        raise ValueError("Preview state moved; preserve and inspect it before reuse")
    for name, expected in record["files"].items():
        if digest(directory / name) != expected:
            raise ValueError("Preview input changed: " + name)
    return directory, record, m.read(directory / "credentials.json")


def write_config(m, directory, record, private):
    m.save(directory / "compose.json", compose(record, private, m.PG14_IMAGE))
    record["files"] = {
        name: digest(directory / name)
        for name in ["compose.json", "credentials.json", "d1_seed.py", "tls.conf"]
        + (["cert.pem", "key.pem"] if record["ui"] else [])
    }
    m.save(directory / "preview.json", record)


def prepare(docker, args, m):
    directory = task_directory(m, args.task, args.project)
    if not args.api_image:
        raise ValueError("prepare requires --api-image built with mw-docker")
    if (directory / "preview.json").exists():
        _, record, _ = load(m, args)
        # Never silently regenerate credentials or change a saved task's ports.
        requested = (
            str(Path(args.repo).resolve()),
            args.port,
            args.chart_port,
            args.api_image,
            args.web_image,
            args.chart_image,
            sorted(set(args.worker)),
        )
        saved = (
            record["repo"],
            record["port"],
            record["chart_port"],
            record["api_image"],
            record["web_image"],
            record["chart_image"],
            record["workers"],
        )
        if requested != saved:
            raise ValueError("Existing preview preserved; use its saved parameters or a new task")
        return {"task": args.task, "state": "reused", "url": record["url"]}
    if directory.exists():
        raise ValueError("Partial preview directory preserved; inspect it before retrying")
    if not 1024 <= args.port <= 65535 or (args.chart_port and not 1024 <= args.chart_port <= 65535):
        raise ValueError("Ports must be within 1024..65535")
    ui = bool(args.web_image or args.chart_image or args.chart_port)
    if ui and (
        not args.web_image
        or not args.chart_image
        or not args.chart_port
        or args.chart_port == args.port
    ):
        raise ValueError("UI requires web/chart images and distinct TLS/chart ports")
    if len(set(args.worker)) > 3:
        raise ValueError("R1W supports at most three necessary workers")
    if any(
        (r.get("project") == args.project and task != args.task)
        for task, r in m.task_records().items()
    ):
        raise ValueError("Compose project already belongs to another task")
    if any(
        (c["Config"].get("Labels") or {}).get("com.docker.compose.project") == args.project
        for c in docker.containers()
    ):
        raise ValueError("Existing project preserved; preview cannot adopt its resources")
    if (
        docker.run("volume", "inspect", args.project + "_postgres-data", check=False).returncode
        == 0
    ):
        raise ValueError("Existing volume preserved; preview cannot adopt it")
    if docker.run("network", "inspect", args.project + "_default", check=False).returncode == 0:
        raise ValueError("Existing network preserved; preview cannot adopt it")
    if docker.run("network", "inspect", args.project + "_edge", check=False).returncode == 0:
        raise ValueError("Existing edge network preserved; preview cannot adopt it")
    repo = Path(args.repo).resolve()
    seed = repo / "deploy/ubuntu/d1_seed.py"
    from argon2 import PasswordHasher

    password = secrets.token_urlsafe(24)
    private = {
        "database_password": secrets.token_urlsafe(24),
        "login_password": password,
        "login_hash": PasswordHasher().hash(password),
    }
    record = {
        "task": args.task,
        "project": args.project,
        "repo": str(repo),
        "directory": str(directory),
        "port": args.port,
        "chart_port": args.chart_port,
        "ui": ui,
        "workers": sorted(set(args.worker)),
        "api_image": args.api_image,
        "web_image": args.web_image,
        "chart_image": args.chart_image,
        "database": "preview",
        "initial_database": "preview",
        "reset_history": [],
        "dataset": "d1-v1-" + digest(seed)[:12],
        "created_at": m.stamp(),
        "url": f"{'https' if ui else 'http'}://localhost:{args.port}",
    }
    m.register(args.task, args.project, "acceptance")
    directory.mkdir(parents=True, mode=0o700)
    m.save(directory / "credentials.json", private)
    (directory / "d1_seed.py").write_bytes(seed.read_bytes())
    (directory / "d1_seed.py").chmod(0o644)  # read by container uid 10001, parent remains 0700
    (directory / "tls.conf").write_text(gateway_config(ui))
    if ui:
        subprocess.run(
            [
                "openssl",
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "30",
                "-subj",
                "/CN=localhost",
                "-addext",
                "subjectAltName=DNS:localhost,IP:127.0.0.1",
                "-keyout",
                str(directory / "key.pem"),
                "-out",
                str(directory / "cert.pem"),
            ],
            check=True,
            capture_output=True,
        )
        (directory / "key.pem").chmod(0o600)
    write_config(m, directory, record, private)
    return {
        "task": args.task,
        "state": "prepared",
        "url": record["url"],
        "profile": "R1W" if args.worker else "R1",
        "dataset": record["dataset"],
        "credentials_file": str(directory / "credentials.json"),
    }


def validate_images(docker, record, m):
    config = m.read(Path(record["directory"]) / "compose.json")
    for name, spec in config["services"].items():
        image = docker.json("image", "inspect", spec["image"])[0]
        container = {
            "Image": image["Id"],
            "Config": {"Image": spec["image"], "Labels": {"com.docker.compose.service": name}},
        }
        m.validate_retirement_image(record["task"], record["project"], container, image)
        if (
            name == "web"
            and (image["Config"].get("Labels") or {}).get(m.PREFIX + "chart-origin")
            != f"https://localhost:{record['chart_port']}"
        ):
            raise ValueError(
                "Web image must be built for this preview chart origin with mw-docker build"
            )
        # Pin every service to the actual validated bytes, never a mutable tag.
        spec["image"] = image["Id"]
    return config


def own_containers(docker, record, m):
    config = m.read(Path(record["directory"]) / "compose.json")
    containers = [
        c
        for c in docker.containers()
        if (c["Config"].get("Labels") or {}).get("com.docker.compose.project") == record["project"]
    ]
    for c in containers:
        name = (c["Config"].get("Labels") or {}).get("com.docker.compose.service")
        if name not in config["services"]:
            raise ValueError("Unexpected service in saved preview project; preserve it")
        expected_networks = {record["project"] + "_default"}
        if name == "tls":
            expected_networks.add(record["project"] + "_edge")
        if set(c.get("NetworkSettings", {}).get("Networks", {})) != expected_networks:
            raise ValueError("Preview container network isolation changed; preserve it")
        image = docker.json("image", "inspect", c["Image"])[0]
        m.validate_retirement_image(record["task"], record["project"], c, image)
        if name == "postgres" and not any(
            mount["Destination"] == "/var/lib/postgresql/data" for mount in c.get("Mounts", [])
        ):
            raise ValueError("Preview PostgreSQL must have its saved data volume")
        for mount in c.get("Mounts", []):
            if mount["Destination"] == "/var/lib/postgresql/data" and (
                mount["Type"] != "volume" or mount["Name"] != record["project"] + "_postgres-data"
            ):
                raise ValueError("Preview PG volume changed; refuse operations")
    # Detect orphan/external volumes and shared mounts before any writer or PG
    # is started. An identical project name alone is not proof of ownership.
    volume = docker.run("volume", "inspect", record["project"] + "_postgres-data", check=False)
    if volume.returncode == 0:
        value = json.loads(volume.stdout)[0]
        if (value.get("Labels") or {}).get("com.docker.compose.project") != record["project"]:
            raise ValueError("Unowned preview volume preserved")
        ids = {c["Id"] for c in containers}
        if any(
            c["Id"] not in ids and any(v.get("Name") == value["Name"] for v in c.get("Mounts", []))
            for c in docker.containers()
        ):
            raise ValueError("Preview volume is shared with another project")
    for suffix, internal in (("default", True), ("edge", False)):
        network = docker.run("network", "inspect", record["project"] + "_" + suffix, check=False)
        if network.returncode == 0:
            value = json.loads(network.stdout)[0]
            if (value.get("Labels") or {}).get("com.docker.compose.project") != record[
                "project"
            ] or value.get("Internal") is not internal:
                raise ValueError("Preview network isolation changed; preserve it")
            if set(value.get("Containers", {})) - {c["Id"] for c in containers}:
                raise ValueError("Preview network is shared with another project")
    return containers


def preflight(docker, record, m):
    disk = os.statvfs(m.STATE)
    if disk.f_bavail * disk.f_frsize < (26 if record["workers"] else 23) * 2**30:
        raise ValueError("Insufficient disk headroom for preview; coordinate with the user")
    memory = dict(line.split(":", 1) for line in Path("/proc/meminfo").read_text().splitlines())
    if int(memory["MemAvailable"].split()[0]) < (5 if record["workers"] else 3.25) * 2**20:
        raise ValueError("Insufficient memory headroom for preview; coordinate with the user")
    if os.getloadavg()[1] > 4:
        raise ValueError("Host load is high; coordinate with the user, no automatic queue")
    live = {
        (c["Config"].get("Labels") or {}).get("com.docker.compose.service")
        for c in own_containers(docker, record, m)
        if c["State"]["Running"]
    }
    if "tls" not in live:
        for port in [record["port"]] + ([record["chart_port"]] if record["ui"] else []):
            try:
                with socket.socket() as sock:
                    # A just-stopped gateway can leave accepted sockets in
                    # TIME_WAIT. Match Docker's reusable listener behavior.
                    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                    sock.bind(("127.0.0.1", port))
            except OSError as exc:
                raise ValueError(
                    f"Preview port {port} unavailable; coordinate with the user"
                ) from exc


def run(docker, args, m):
    if args.action == "prepare":
        return prepare(docker, args, m)
    directory, record, private = load(m, args)
    containers = own_containers(docker, record, m)
    if args.action == "status":
        return {
            "task": record["task"],
            "project": record["project"],
            "url": record["url"],
            "database": record["database"],
            "dataset": record["dataset"],
            "containers": [
                {
                    "id": c["Id"],
                    "state": c["State"]["Status"],
                    "service": c["Config"]["Labels"]["com.docker.compose.service"],
                }
                for c in containers
            ],
        }
    cmd = [
        "compose",
        "--env-file",
        "/dev/null",
        "-p",
        record["project"],
        "-f",
        str(directory / "compose.json"),
    ]
    if args.action == "stop":
        docker.run(*cmd, "stop", live=True)
        return {"task": args.task, "state": "stopped", "data": "preserved"}
    if args.action == "reset" and not args.apply:
        return {
            "task": args.task,
            "apply": False,
            "old_database": record["database"],
            "plan": "Stop only own writers, create and seed a new database; preserve every old database. Use --apply.",
        }
    config = validate_images(docker, record, m)
    preflight(docker, record, m)
    m.save(directory / "run.json", config)
    cmd[-1] = str(directory / "run.json")
    # Never run migrations or seeds against a live writer.
    writers = [
        c["Id"]
        for c in containers
        if c["Config"]["Labels"]["com.docker.compose.service"] != "postgres"
        and c["State"]["Running"]
    ]
    if writers:
        docker.run("stop", "--time", "20", *writers)
    docker.run(*cmd, "up", "-d", "--no-build", "--pull", "never", "--wait", "postgres", live=True)
    pgid = docker.out(*cmd, "ps", "-q", "postgres")
    if m.pg(docker, pgid, "preview", record["database"], "SHOW server_version_num") != "140024":
        raise ValueError("Preview PG is not 14.24")
    if args.action == "reset":
        previous = record["database"]
        new = "preview_" + uuid.uuid4().hex[:12]
        # Retain the old database even if migrate/seed/start fails. The existing
        # retirement entry point already archives and restores all task databases.
        m.pg(docker, pgid, "preview", previous, f'CREATE DATABASE "{new}" OWNER preview')
        record["database"] = new
        record["reset_history"].append({"at": m.stamp(), "previous": previous, "new": new})
        write_config(m, directory, record, private)
        config = validate_images(docker, record, m)
        m.save(directory / "run.json", config)
    for tool in ("migrate", "seed"):
        docker.run(*cmd, "run", "--rm", "--no-deps", "--pull", "never", tool, live=True)
    # Profile tools are excluded from normal up; PG volume remains unchanged.
    docker.run(*cmd, "up", "-d", "--no-build", "--pull", "never", "--wait", live=True)
    report = {
        "task": args.task,
        "project": args.project,
        "state": "ready",
        "at": m.stamp(),
        "url": record["url"],
        "database": record["database"],
        "dataset": record["dataset"],
        "pg_version": "140024",
        "images": {name: s["image"] for name, s in config["services"].items()},
    }
    m.save(directory / "last-run.json", report)
    return report
