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
TASKWEB_ALLOWED_HOSTS adds extra trusted request hostnames (comma separated) on
top of this node's own tailnet name, which is registered automatically.
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

# Trust this node's own tailnet DNS name in addition to the bound address, so
# same-origin mutations work when the app is opened through MagicDNS. Only the
# name `tailscale status --json` reports for this node is registered; a wildcard,
# a bare suffix or an any-host alias is never accepted.
trusted_names=()
if status_json=$(tailscale status --json 2>/dev/null) && [[ -n "$status_json" ]]; then
  while IFS= read -r name; do
    [[ -n "$name" ]] && trusted_names+=("$name")
  done < <(python3 -c '
import json, sys

try:
    status = json.load(sys.stdin)
except ValueError:
    raise SystemExit(0)
node = status.get("Self") or {}
name = (node.get("DNSName") or "").strip()
suffix = (status.get("MagicDNSSuffix") or "").strip()
hostname = (node.get("HostName") or "").strip()
name = name[:-1] if name.endswith(".") else name
suffix = suffix[:-1] if suffix.endswith(".") else suffix
# Require a self-consistent node name before trusting it verbatim.
if not name or not suffix or not hostname or name != hostname + "." + suffix:
    raise SystemExit(0)
print(name)
if hostname != name:
    print(hostname)
' <<<"$status_json")
fi
if [[ -n "${TASKWEB_ALLOWED_HOSTS-}" ]]; then
  IFS=',' read -r -a extra_hosts <<<"$TASKWEB_ALLOWED_HOSTS"
  for name in "${extra_hosts[@]}"; do
    name=${name//[[:space:]]/}
    [[ -n "$name" ]] && trusted_names+=("$name")
  done
fi

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
for value in "$project" "$python" "$PATH" "$unit_dir" "${TASKRC-}" "${TASKDATA-}" ${trusted_names[@]+"${trusted_names[@]}"}; do
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
  printf 'ExecStart=%s %s --host %s --port %s --static-dir dist' \
    "$(quote_exec "$python")" "$(quote_exec "$project/server.py")" "$host" "$port"
  if ((${#trusted_names[@]})); then
    for name in "${trusted_names[@]}"; do
      printf ' --allowed-host %s' "$(quote_exec "$name")"
    done
  fi
  printf '\n'
  printf 'Restart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n'
} >"$tmp"
chmod 600 "$tmp"
mv -f -- "$tmp" "$unit"
systemctl --user daemon-reload
systemctl --user enable taskwarrior-web.service
systemctl --user restart taskwarrior-web.service
printf 'Installed %s\nOpen http://%s:%s from your tailnet.\n' "$unit" "$host" "$port"
if ((${#trusted_names[@]})); then
  printf 'Trusted request hostnames: %s\n' "${trusted_names[*]}"
else
  printf 'No tailnet DNS name registered; mutations require the address URL above.\n'
fi
printf 'Check: systemctl --user status taskwarrior-web.service\n'
printf 'For startup without a login: loginctl enable-linger "$USER" (may require administrator approval).\n'
