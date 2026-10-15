#!/usr/bin/env bash
# One-time Ubuntu bootstrap; uses official Ubuntu Buildx and checksum-pinned Moby binaries.
set -euo pipefail
. /etc/os-release
[[ "$ID" == ubuntu && "$(uname -m)" == x86_64 ]] || { echo 'Ubuntu amd64 required' >&2; exit 1; }
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
run_docker() { sg docker -c "$(/usr/bin/python3 -c 'import shlex,sys; print(shlex.join(["/usr/bin/docker","--host","unix:///var/run/docker.sock"]+sys.argv[1:]))' "$@")"; }
bootstrap_dir="$(mktemp -d "${TMPDIR:-/tmp}/mw-buildkit-bootstrap.XXXXXXXX")"
trap 'rm -rf -- "$bootstrap_dir"' EXIT
if ! run_docker buildx version >/dev/null 2>&1; then
  (cd "$bootstrap_dir" && apt-get download docker-buildx)
  for package in "$bootstrap_dir"/docker-buildx*.deb; do
    dpkg-deb -x "$package" "$bootstrap_dir/package"
  done
  plugin="$(find "$bootstrap_dir/package" -type f -name docker-buildx -print -quit)"
  mkdir -p "$HOME/.docker/cli-plugins"
  install -m 0755 "$plugin" "$HOME/.docker/cli-plugins/docker-buildx"
fi
if ! run_docker image inspect market-watch-buildkit:0.33.1-official >/dev/null 2>&1; then
  run_docker image inspect postgres:14.24-bookworm@sha256:993166bee3ea12e2baa70f47efe7ba4a191b3e92f44f9767eaefbb6194f53872 >/dev/null
  curl -fL --retry 2 --connect-timeout 15 --max-time 180 \
    -o "$bootstrap_dir/buildkit.tar.gz" \
    https://github.com/moby/buildkit/releases/download/v0.33.1/buildkit-v0.33.1.linux-amd64.tar.gz
  printf '%s  %s\n' 4e044bcd62a0c0bbe6a8c94d73989de2bfe4c04dbc0f9d6021cf96b72cd1d965 \
    "$bootstrap_dir/buildkit.tar.gz" | sha256sum --check
  tar -xzf "$bootstrap_dir/buildkit.tar.gz" -C "$bootstrap_dir"
  cat > "$bootstrap_dir/Dockerfile" <<'EOF'
FROM postgres:14.24-bookworm@sha256:993166bee3ea12e2baa70f47efe7ba4a191b3e92f44f9767eaefbb6194f53872
COPY bin/buildkitd bin/buildctl bin/buildkit-runc /usr/local/bin/
ENTRYPOINT ["/usr/local/bin/buildkitd"]
CMD []
LABEL io.market-watch.infrastructure="ubuntu-builder" org.opencontainers.image.version="0.33.1" org.opencontainers.image.source="https://github.com/moby/buildkit" io.market-watch.source-sha256="4e044bcd62a0c0bbe6a8c94d73989de2bfe4c04dbc0f9d6021cf96b72cd1d965"
EOF
  # Only infrastructure bootstrap uses legacy builder, once; normal project builds never do.
  sg docker -c "$(/usr/bin/python3 -c 'import shlex,sys; print("DOCKER_BUILDKIT=0 "+shlex.join(["/usr/bin/docker","--host","unix:///var/run/docker.sock","build","--pull=false","--rm","-t","market-watch-buildkit:0.33.1-official",sys.argv[1]]))' "$bootstrap_dir")"
fi
bash "$repo_dir/deploy/ubuntu/install.sh"
