#!/usr/bin/env bash
# Install a per-user service; never expose this unauthenticated app on a public bind.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/install-service.sh [--host TAILSCALE_IPV4] [--port PORT]

Build first with npm ci && npm run build. The default address is the local
`tailscale ip -4`; the default port is 7834. TASKWEB_HOST/TASKWEB_PORT may
supply defaults. A host override must match this machine's Tailscale IPv4.
Export TASKRC and/or TASKDATA before installing to preserve custom locations.
Run as your regular user, without sudo. Installs and starts a systemd user unit.
EOF
}

fail() { printf 'Error: %s\n' "$*" >&2; exit 1; }
host=${TASKWEB_HOST:-}
port=${TASKWEB_PORT:-7834}
while (($#)); do
  case "$1" in
    --host) (($# >= 2)) || fail '--host needs a value'; host=$2; shift 2 ;;
    --port) (($# >= 2)) || fail '--port needs a value'; port=$2; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) fail "Unknown argument: $1 (use --help)" ;;
  esac
done

((EUID != 0)) || fail 'Run as your regular user, without sudo.'
for tool in python3 task tailscale systemctl; do
  command -v "$tool" >/dev/null || fail "Required command not found: $tool"
done
python=$(command -v python3)
project=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
[[ -f "$project/server.py" ]] || fail 'server.py is missing.'
[[ -f "$project/dist/index.html" ]] || fail 'dist/index.html is missing; run npm ci && npm run build.'
local_ip=$(tailscale ip -4) || fail 'Cannot read Tailscale address; connect Tailscale first.'
# Accept only a single CGNAT IPv4 assigned by the local Tailscale daemon.
python3 -c 'import ipaddress, sys; a = ipaddress.ip_address(sys.argv[1]); sys.exit(0 if a in ipaddress.ip_network("100.64.0.0/10") else 1)' "$local_ip" \
  || fail 'Expected a single Tailscale IPv4 address.'
host=${host:-$local_ip}
[[ "$host" == "$local_ip" ]] || fail 'Host must equal the local `tailscale ip -4`; wildcard, LAN and public binds are refused.'
[[ "$port" =~ ^[0-9]{1,5}$ ]] || fail 'Port must be an integer from 1 to 65535.'
port=$((10#$port))
((port >= 1 && port <= 65535)) || fail 'Port must be an integer from 1 to 65535.'
systemctl --user show-environment >/dev/null || fail 'No systemd user manager is available; use a logged-in user session.'

# systemd unit strings use their own quoting and %-specifier expansion.
quote_unit() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//%/%%}
  printf '"%s"' "$value"
}
quote_exec() {
  local value=$1
  value=${value//\$/\$\$}
  quote_unit "$value"
}

unit_dir=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
for value in "$project" "$python" "$PATH" "$unit_dir" "${TASKRC-}" "${TASKDATA-}"; do
  [[ "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail 'Newlines in paths/environment are unsupported.'
done
for name in TASKRC TASKDATA; do
  if [[ -v "$name" && -n "${!name}" ]]; then
    value=$(python3 -c 'import os, sys; print(os.path.abspath(os.path.expanduser(sys.argv[1])))' "${!name}")
    printf -v "$name" '%s' "$value"
  fi
done
mkdir -p -- "$unit_dir"
unit="$unit_dir/taskwarrior-web.service"
tmp=$(mktemp "$unit_dir/.taskwarrior-web.XXXXXX")
trap '[[ ! -e "$tmp" ]] || rm -f -- "$tmp"' EXIT
{
  printf '[Unit]\nDescription=Taskwarrior Web (Tailscale only)\n\n[Service]\nType=simple\n'
  # WorkingDirectory takes a literal path, unlike ExecStart/Environment strings.
  printf 'WorkingDirectory=%s\n' "${project//%/%%}"
  printf 'Environment=%s\n' "$(quote_unit "PATH=$PATH")"
  for name in TASKRC TASKDATA; do
    if [[ -v "$name" ]]; then
      value=${!name}
      printf 'Environment=%s\n' "$(quote_unit "$name=$value")"
    fi
  done
  printf 'ExecStart=%s %s --host %s --port %s --static-dir dist\n' \
    "$(quote_exec "$python")" "$(quote_exec "$project/server.py")" "$host" "$port"
  printf 'Restart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n'
} >"$tmp"
chmod 600 "$tmp"
mv -f -- "$tmp" "$unit"
systemctl --user daemon-reload
systemctl --user enable taskwarrior-web.service
systemctl --user restart taskwarrior-web.service
printf 'Installed %s\nOpen http://%s:%s from your tailnet.\n' "$unit" "$host" "$port"
printf 'Check: systemctl --user status taskwarrior-web.service\n'
printf 'For startup without a login: loginctl enable-linger "$USER" (may require administrator approval).\n'
