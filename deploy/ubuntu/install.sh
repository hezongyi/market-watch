#!/usr/bin/env bash
set -euo pipefail
repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
. /etc/os-release
[[ "$ID" == ubuntu ]] || { echo 'Ubuntu only' >&2; exit 1; }
# Host-local socket only. sg also works before the new docker group login takes effect.
run_docker() { sg docker -c "$(/usr/bin/python3 -c 'import shlex,sys; print(shlex.join(["/usr/bin/docker","--host","unix:///var/run/docker.sock"]+sys.argv[1:]))' "$@")"; }
run_docker buildx version
builder_image="${MW_BUILDKIT_IMAGE:-market-watch-buildkit:0.33.1-official}"
if ! run_docker buildx inspect market-watch-ubuntu >/dev/null 2>&1; then
  run_docker buildx create --name market-watch-ubuntu --driver docker-container \
    --driver-opt "image=$builder_image" --driver-opt default-load=true \
    --buildkitd-config "$repo_dir/deploy/ubuntu/buildkitd.toml" \
    unix:///var/run/docker.sock
fi
run_docker buildx use market-watch-ubuntu --default
run_docker buildx inspect market-watch-ubuntu --bootstrap
install_dir="$HOME/.local/lib/market-watch-docker"
bin_dir="$HOME/.local/bin"
unit_dir="$HOME/.config/systemd/user"
state_dir="$HOME/.local/share/market-watch-docker"
mkdir -p "$install_dir" "$bin_dir" "$unit_dir" "$state_dir"
chmod 700 "$state_dir"
install -m 0755 "$repo_dir/deploy/ubuntu/mw_docker.py" "$bin_dir/mw-docker"
install -m 0644 "$repo_dir/deploy/ubuntu/mw_preview.py" "$bin_dir/mw_preview.py"
install -m 0755 "$repo_dir/deploy/ubuntu/docker_guard.py" "$install_dir/docker_guard.py"
# Preserve any existing executable wrapper rather than overwriting another tool.
if [[ -e "$bin_dir/docker" ]] && ! rg -q 'market-watch-docker/docker_guard.py' "$bin_dir/docker"; then
  echo "Existing $bin_dir/docker is not our wrapper; inspect it before installation" >&2
  exit 1
fi
cat > "$bin_dir/docker" <<'EOF'
#!/usr/bin/env bash
exec /usr/bin/python3 "$HOME/.local/lib/market-watch-docker/docker_guard.py" "$@"
EOF
chmod 755 "$bin_dir/docker"
for unit in market-watch-disk-check.service market-watch-disk-check.timer \
            market-watch-disk-daily.service market-watch-disk-daily.timer \
            market-watch-image-cleanup.service market-watch-image-cleanup.timer; do
  install -m 0644 "$repo_dir/deploy/ubuntu/$unit" "$unit_dir/$unit"
done
systemd-analyze --user verify "$unit_dir"/market-watch-disk-*.service \
  "$unit_dir"/market-watch-disk-*.timer "$unit_dir"/market-watch-image-cleanup.*
systemctl --user daemon-reload
systemctl --user enable --now market-watch-disk-check.timer market-watch-disk-daily.timer \
  market-watch-image-cleanup.timer
systemctl --user start market-watch-disk-check.service market-watch-disk-daily.service
systemctl --user list-timers 'market-watch-*'
loginctl show-user "$(id -un)" -p Linger
