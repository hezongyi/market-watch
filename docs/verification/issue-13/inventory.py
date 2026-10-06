"""Read-only Ubuntu inventory. Never persist container environment or commands."""
import json
import subprocess
import shlex
import shutil
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent


def docker(*args):
    return subprocess.check_output(["sg", "docker", "-c", shlex.join(["docker", *args])], text=True, timeout=45, stderr=subprocess.DEVNULL)


def main():
    for name in ('inventory.json','inventory.md'):
        existing=HERE/name
        if existing.exists():
            at=datetime.fromtimestamp(existing.stat().st_mtime,timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
            archived=HERE/('inventory-'+at+existing.suffix)
            if not archived.exists():shutil.copy2(existing,archived)
    ids = docker("ps", "-aq").split()
    inspected = json.loads(docker("inspect", *ids)) if ids else []
    records = []
    images = {}
    for item in inspected:
        labels = item["Config"].get("Labels") or {}
        project = labels.get("com.docker.compose.project", "")
        config = labels.get("com.docker.compose.project.config_files", "")
        working = labels.get("com.docker.compose.project.working_dir", "")
        host = item["HostConfig"]
        if item["Image"] not in images:
            try:
                images[item["Image"]] = json.loads(docker("image", "inspect", item["Image"]))[0]
            except subprocess.CalledProcessError:
                images[item["Image"]] = {"Config": {}, "missing": True}
        image = images[item["Image"]]
        revision = (image["Config"].get("Labels") or {}).get("org.opencontainers.image.revision")
        records.append(dict(
            name=item["Name"].lstrip("/"), id=item["Id"][:12], project=project,
            service=labels.get("com.docker.compose.service"), working_dir=working,
            config_files=config, image=item["Config"]["Image"], image_id=item["Image"],
            image_revision=revision, image_missing=image.get("missing", False), created=item["Created"], status=item["State"]["Status"],
            started=item["State"]["StartedAt"], exit_code=item["State"]["ExitCode"],
            ports=item["NetworkSettings"]["Ports"], networks=list(item["NetworkSettings"]["Networks"]),
            mounts=[{k: m.get(k) for k in ("Type", "Name", "Source", "Destination", "RW")} for m in item["Mounts"]],
            resources={k: host.get(k) for k in ("NanoCpus", "CpuQuota", "CpuPeriod", "CpuShares", "CpusetCpus", "Memory", "MemorySwap")},
            ownership="Compose labels establish configuration origin; task completion/idle state unverified; retain",
        ))
    stats = []
    for _ in range(3):
        stats.append(dict(at=datetime.now(timezone.utc).isoformat(), containers=[
            json.loads(line) for line in docker("stats", "--no-stream", "--format", "{{json .}}").splitlines()]))
    report = dict(at=datetime.now(timezone.utc).isoformat(), host=subprocess.check_output(["hostname"], text=True).strip(),
                  daemon=docker("info", "--format", "{{.OperatingSystem}}").strip(),
                  containers=records, samples=stats)
    (HERE / "inventory.json").write_text(json.dumps(report, indent=2) + "\n")
    lines = ["# Ubuntu 实例台账", "", f"采样：{report['at']}；主机：{report['host']} / {report['daemon']}。", "",
             "只记录配置来源和资源，不包含环境变量、启动命令或凭据。标签能证明来源，不能证明任务已完成；所有其他项目保留。", "",
             "| Compose project | 配置来源 | 容器数 / running | 短时 CPU 总和（均值） | 内存总和（最后一次） |", "| --- | --- | --- | --- | --- |"]
    for project in sorted({r["project"] for r in records}):
        group = [r for r in records if r["project"] == project]
        names = {r["name"] for r in group}
        cpu = [sum(float(c["CPUPerc"].rstrip("%")) for c in sample["containers"] if c["Name"] in names) for sample in stats]
        mem = [c["MemUsage"].split(" / ")[0] for c in stats[-1]["containers"] if c["Name"] in names]
        lines.append(f"| {project or '(无标签)'} | {group[0]['working_dir']} | {len(group)} / {sum(r['status']=='running' for r in group)} | {sum(cpu)/len(cpu):.1f}% | {' + '.join(mem)} |")
    lines += ["", "Docker CPU 100% 为一个逻辑核。原始三次短采样、精确配置路径、镜像 ID/revision、端口、挂载、网络和配额见 [inventory.json](inventory.json)。", "",
              "未查询其他任务业务数据库或秘密配置，因此无法证明其数据库名、活跃订阅/策略数、任务是否完成。未知归属或闲置状态未核实的资源不能停止。",
              "按台账配置路径确认任务完成后，停止命令模板为 `sg docker -c 'docker compose -p <project> -f <config-file> stop'`；涉及多份配置必须显式指定全部文件。当前没有执行该操作。"]
    (HERE / "inventory.md").write_text("\n".join(lines) + "\n")
    print(f"Recorded {len(records)} containers; no resources changed")


if __name__ == "__main__":
    main()
