#!/usr/bin/env bash
#
# One command for the one-VPS deployment of z402 on Zcash testnet behind Caddy (compose.vps.yaml). The runbook is
# docs/deploy-vps.md. It needs bash, docker with the compose plugin, and openssl for init, and it never prints a token
# or a key. Run `scripts/vps.sh help` for the commands.
#
# Environment: Z402_WAIT_SECONDS is how long `up` waits for the services (600). COMPOSE_PROJECT_NAME, COMPOSE_PROFILES and
# the Z402_* settings of .env.vps win over the file when they are set in the environment, as they do for docker compose.

set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$root"

env_file=.env.vps
template=.env.vps.example
backup_dir=.data/backups
wait_seconds=${Z402_WAIT_SECONDS:-600}
# The temporary file of a rewrite of .env.vps, which holds secrets and is removed again whatever happens
tmp_env=""
trap '[ -z "$tmp_env" ] || rm -f "$tmp_env"' EXIT

die() {
  printf 'vps.sh: %s\n' "$*" >&2
  exit 1
}

warn() {
  printf 'vps.sh: warning: %s\n' "$*" >&2
}

usage() {
  cat <<'EOF'
usage: scripts/vps.sh <command>

  init [domain]          write .env.vps (mode 0600) from .env.vps.example, with new random tokens
  keys [file | -]        explain how to make the operator's view-only keys on your laptop; given that file
                         (or - for stdin), import them into .env.vps
  up                     build and start everything, then wait until every service is healthy
  status                 the services and their health; exits 1 unless every one is healthy
  logs [--no-follow] [service...]
  down                   remove the containers and keep every volume
  update                 git pull --ff-only, then up
  backup                 a tar.gz of the ledger and the registered providers, in .data/backups/
  restore <file>         empty the facilitator's data volume and put a backup in it

The runbook is docs/deploy-vps.md, and every setting is in .env.vps.example.
EOF
}

# .env.vps ------------------------------------------------------------------------------------------------------------

# The value of NAME in .env.vps (the last line that sets it, one pair of quotes dropped), or nothing
env_get() {
  local line value
  [ -f "$env_file" ] || return 0
  line=$(grep -E "^$1=" "$env_file" | tail -n 1 || true)
  value=${line#*=}
  value=${value%$'\r'}
  case $value in
    \"*\") value=${value#\"} value=${value%\"} ;;
    \'*\') value=${value#\'} value=${value%\'} ;;
  esac
  printf '%s' "$value"
}

# NAME as docker compose reads it: the environment first, then .env.vps
setting() {
  local name=$1
  printf '%s' "${!name:-$(env_get "$name")}"
}

# Replaces the NAME= lines of .env.vps, or adds them: set_env NAME VALUE [NAME VALUE]... A value never reaches a command
# line, and the file is replaced by a rename of a mode-0600 temporary one
set_env() {
  local names=() values=() written=() line i found
  while [ $# -ge 2 ]; do
    names+=("$1")
    values+=("$2")
    written+=(0)
    shift 2
  done
  tmp_env=$(umask 077 && mktemp "$env_file.XXXXXX")
  while IFS= read -r line || [ -n "$line" ]; do
    found=0
    for i in "${!names[@]}"; do
      case $line in
        "${names[$i]}="*)
          found=1
          # A name that is set twice keeps its first line
          if [ "${written[$i]}" = 0 ]; then printf '%s=%s\n' "${names[$i]}" "${values[$i]}"; fi
          written[i]=1
          ;;
      esac
    done
    if [ "$found" = 0 ]; then printf '%s\n' "$line"; fi
  done <"$env_file" >"$tmp_env"
  for i in "${!names[@]}"; do
    if [ "${written[$i]}" = 0 ]; then printf '%s=%s\n' "${names[$i]}" "${values[$i]}" >>"$tmp_env"; fi
  done
  mv "$tmp_env" "$env_file"
  tmp_env=""
}

need_env() {
  [ -f "$env_file" ] || die "$env_file does not exist: run scripts/vps.sh init first"
}

need_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed (docs/deploy-vps.md, Install Docker)"
  docker compose version >/dev/null 2>&1 || die "the docker compose plugin is missing (docs/deploy-vps.md, Install Docker)"
  docker info >/dev/null 2>&1 ||
    die "cannot reach the Docker daemon: is it running, and does this user belong to the docker group (or use sudo)?"
}

# docker compose with the settings of this deployment. A trial on one machine (Z402_TLS=internal) adds its override
compose() {
  local files=(-f compose.vps.yaml)
  if [ "$(setting Z402_TLS)" = internal ]; then files+=(-f compose.vps.local.yaml); fi
  docker compose "${files[@]}" --env-file "$env_file" "$@"
}

services_on() {
  case ",$(setting COMPOSE_PROFILES)," in
    *,services,* | *,\*,*) return 0 ;;
  esac
  return 1
}

# init ----------------------------------------------------------------------------------------------------------------

# The template with the two tokens filled in, on stdout. printf is a builtin, so no token is ever a process argument
render_env() {
  local facilitator=$1 registration=$2 domain=$3 line
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      Z402_FACILITATOR_TOKEN=*) printf 'Z402_FACILITATOR_TOKEN=%s\n' "$facilitator" ;;
      Z402_REGISTRATION_TOKEN=*) printf 'Z402_REGISTRATION_TOKEN=%s\n' "$registration" ;;
      Z402_DOMAIN=*)
        if [ -n "$domain" ]; then printf 'Z402_DOMAIN=%s\n' "$domain"; else printf '%s\n' "$line"; fi
        ;;
      *) printf '%s\n' "$line" ;;
    esac
  done <"$template"
}

cmd_init() {
  local domain=${1:-} facilitator registration
  [ $# -le 1 ] || die "usage: scripts/vps.sh init [domain]"
  [ -f "$template" ] || die "$template is missing: run this from a checkout of the repository"
  command -v openssl >/dev/null 2>&1 || die "openssl is needed for the random tokens"
  if [ -e "$env_file" ]; then
    die "$env_file exists, and init never overwrites it (it holds this server's tokens and keys). Edit it, or delete it to start over"
  fi
  if [ -n "$domain" ]; then
    case $domain in
      *[!A-Za-z0-9.-]* | .* | -* | *. | *..*) die "not a domain name: $domain" ;;
      *.* | localhost) ;;
      *) die "not a domain name: $domain" ;;
    esac
  fi
  facilitator=$(openssl rand -hex 32)
  registration=$(openssl rand -hex 32)
  [ ${#facilitator} -eq 64 ] && [ ${#registration} -eq 64 ] || die "openssl did not return a random token"

  tmp_env=$(umask 077 && mktemp "$env_file.XXXXXX")
  render_env "$facilitator" "$registration" "$domain" >"$tmp_env"
  mv "$tmp_env" "$env_file"
  tmp_env=""
  if [ -z "$(env_get Z402_FACILITATOR_TOKEN)" ] || [ -z "$(env_get Z402_REGISTRATION_TOKEN)" ]; then
    rm -f "$env_file"
    die "$template has no Z402_FACILITATOR_TOKEN= and Z402_REGISTRATION_TOKEN= lines to fill"
  fi

  printf 'Wrote %s (mode 0600) with a new facilitator token and a new registration token. Neither is printed.\n' "$env_file"
  printf 'Domain: %s\n\n' "$(env_get Z402_DOMAIN)"
  printf 'Next: scripts/vps.sh keys    explains how to make the operator keys on your laptop, and imports them\n'
  printf '      scripts/vps.sh up\n'
}

# keys ----------------------------------------------------------------------------------------------------------------

keys_help() {
  cat <<'EOF'
The operator's seed controls the account that z402 is paid into, so it is made on your laptop and never reaches this
server. The server gets only the view-only file, which holds the network, the viewing key (it sees deposits and cannot
spend) and the payTo address.

On your laptop, in a checkout of this repository (Node 22 or later, and Rust for the first command):

  cargo build --release --locked --manifest-path crates/zdecrypt/Cargo.toml
  node scripts/merchant-keygen.mjs --network testnet
  node scripts/merchant-keygen.mjs --view-only --from .secrets/merchant-testnet.json

The first file, .secrets/merchant-testnet.json, holds the seed: it is the only backup of the account, so keep it on
the laptop. The second, .secrets/merchant-testnet.view.json, has no seed. Send that one alone and import it here:

  ssh you@server 'cd z402 && scripts/vps.sh keys -' < .secrets/merchant-testnet.view.json

or copy it to the server, import it, and delete the copy:

  scripts/vps.sh keys merchant-testnet.view.json && rm merchant-testnet.view.json

The import refuses a file that holds anything besides those three fields, and so refuses the seed.
EOF
}

# Reads the view-only file in $1 and sets view_address and view_uivk, or dies. It names the problem, never the content
parse_view() {
  local text=$1 compact network pair re
  [ ${#text} -gt 0 ] && [ ${#text} -le 8192 ] ||
    die "the keys file is empty or longer than 8 KiB: it is not a view-only file"
  compact=$(printf '%s' "$text" | tr -d ' \t\r\n')
  # The seed and the full viewing key are what this server must never hold, so say so and not just "invalid"
  case $compact in
    *'"seedHex"'* | *'"ufvk"'*)
      die "this file holds the spending seed or the full viewing key: make the view-only file on your laptop (scripts/vps.sh keys explains) and import that one. If this file was ever copied to a server, treat its seed as exposed"
      ;;
  esac
  # Exactly the three fields that merchant-keygen --view-only writes, and nothing besides
  pair='("network":"[a-z]+"|"uivk":"[0-9a-z]+"|"orchardOnlyAddress":"[0-9a-z]+")'
  re="^\\{$pair,$pair,$pair\\}\$"
  [[ $compact =~ $re ]] ||
    die "not a view-only keys file: expected the JSON of node scripts/merchant-keygen.mjs --view-only, with network, uivk and orchardOnlyAddress only"
  network=$(printf '%s' "$compact" | sed -n 's/.*"network":"\([^"]*\)".*/\1/p')
  view_uivk=$(printf '%s' "$compact" | sed -n 's/.*"uivk":"\([^"]*\)".*/\1/p')
  view_address=$(printf '%s' "$compact" | sed -n 's/.*"orchardOnlyAddress":"\([^"]*\)".*/\1/p')
  [ "$network" = testnet ] || die "the keys are for $network, and this deployment runs on testnet"
  [[ $view_uivk =~ ^(uivktest|uvitest)1[02-9ac-hj-np-z]+$ ]] && [ ${#view_uivk} -le 1024 ] ||
    die "uivk is not a testnet unified incoming viewing key (uivktest1...)"
  [[ $view_address =~ ^(utest|zutest)1[02-9ac-hj-np-z]+$ ]] && [ ${#view_address} -le 1024 ] ||
    die "orchardOnlyAddress is not a testnet shielded-only unified address (utest1...)"
}

cmd_keys() {
  local force=0 source text current view_uivk="" view_address=""
  if [ "${1:-}" = --force ]; then
    force=1
    shift
  fi
  [ $# -le 1 ] || die "usage: scripts/vps.sh keys [--force] [file | -]"
  source=${1:-}
  if [ -z "$source" ]; then
    keys_help
    return 0
  fi
  need_env
  if [ "$source" = - ]; then
    text=$(head -c 8193)
  else
    [ -f "$source" ] || die "no such file: $source"
    text=$(head -c 8193 "$source")
  fi
  parse_view "$text"

  current=$(env_get Z402_PAY_TO)
  if [ -n "$current" ] && [ "$current" != "$view_address" ] && [ "$force" = 0 ]; then
    die "$env_file already holds the keys of another account. A ledger belongs to one payTo, and the facilitator refuses to start on a ledger of another: keep those keys, or import these with --force and delete the facilitator-data volume"
  fi
  set_env Z402_PAY_TO "$view_address" Z402_UIVK "$view_uivk"
  printf 'Imported the view-only keys into %s. Nothing else of the file was kept, and the viewing key is not printed.\n' "$env_file"
  printf 'payTo: %s\n' "$view_address"
  printf 'Compare it with the address merchant-keygen printed on your laptop.\n'
}

# up, status ----------------------------------------------------------------------------------------------------------

# Refuses to start on a setting that would only fail later
preflight() {
  local name registration kind
  need_env
  for name in Z402_DOMAIN Z402_FACILITATOR_TOKEN Z402_REGISTRATION_TOKEN; do
    [ -n "$(env_get "$name")" ] || die "$name is empty in $env_file (scripts/vps.sh init fills the tokens)"
  done
  registration=$(env_get Z402_REGISTRATION_TOKEN)
  [ ${#registration} -ge 32 ] ||
    die "Z402_REGISTRATION_TOKEN has fewer than 32 characters, and the facilitator refuses to start with it"
  if [ -z "$(env_get Z402_PAY_TO)" ] || [ -z "$(env_get Z402_UIVK)" ]; then
    die "the operator's keys are not imported: run scripts/vps.sh keys, which explains how to make them without putting the seed on this server"
  fi
  case $(setting Z402_TLS) in
    '' | acme) ;;
    internal) warn "Z402_TLS=internal: Caddy's own CA signs every site. That is for a trial on localhost; browsers and agents will not trust it" ;;
    *) die "Z402_TLS must be acme or internal" ;;
  esac
  case $(setting COMPOSE_PROFILES) in
    '' | services | '*') ;;
    *) die "COMPOSE_PROFILES must be empty or services: the starter services are the only profile" ;;
  esac
  if services_on; then
    for kind in LLM EMBEDDINGS; do
      for name in "Z402_${kind}_BASE_URL" "Z402_${kind}_MODEL"; do
        [ -n "$(env_get "$name")" ] ||
          die "$name is empty in $env_file: llm and embeddings call a hosted provider, which .env.vps.example shows"
      done
      [ -n "$(env_get "Z402_${kind}_API_KEY")" ] || warn "Z402_${kind}_API_KEY is empty: the hosted provider is called without a key"
    done
  fi
}

# The state of one service: "state health", or "missing" before compose created its container
service_state() {
  local row state health
  row=$(compose ps --all --format '{{.Service}} {{.State}} {{.Health}}' 2>/dev/null | grep -E "^$1 " | head -n 1 || true)
  state=missing health=""
  if [ -n "$row" ]; then read -r _ state health <<<"$row"; fi
  printf '%s %s' "$state" "$health"
}

# Sets ok_count, pending_count, bad_count and terminal_count (a container that exited), and summary, for the services of
# this deployment
check_services() {
  local svc state health line=""
  ok_count=0 pending_count=0 bad_count=0 terminal_count=0
  while IFS= read -r svc; do
    [ -n "$svc" ] || continue
    read -r state health <<<"$(service_state "$svc")"
    case "$state/${health:-}" in
      running/healthy | running/) ok_count=$((ok_count + 1)) ;;
      running/unhealthy | restarting/* | paused/*) bad_count=$((bad_count + 1)) ;;
      exited/* | dead/*)
        bad_count=$((bad_count + 1))
        terminal_count=$((terminal_count + 1))
        ;;
      *) pending_count=$((pending_count + 1)) ;;
    esac
    line="$line $svc=${health:-$state}"
  done < <(compose config --services | sort)
  summary=${line# }
}

# Why the services that are not healthy are not: their state and the end of their logs
diagnose() {
  local svc state health
  compose ps --all >&2 || true
  while IFS= read -r svc; do
    [ -n "$svc" ] || continue
    read -r state health <<<"$(service_state "$svc")"
    case "$state/${health:-}" in
      running/healthy | running/) ;;
      *)
        printf '\n--- %s (%s): the end of its log\n' "$svc" "${health:-$state}" >&2
        compose logs --no-color --tail=30 "$svc" >&2 || true
        ;;
    esac
  done < <(compose config --services | sort)
}

wait_healthy() {
  local deadline=$((SECONDS + wait_seconds)) last="" ok_count pending_count bad_count terminal_count summary
  printf 'Waiting up to %s s for every service to be healthy...\n' "$wait_seconds"
  while :; do
    check_services
    if [ "$summary" != "$last" ]; then
      printf '  %s\n' "$summary"
      last=$summary
    fi
    if [ "$pending_count" = 0 ] && [ "$bad_count" = 0 ]; then
      printf 'All %s services are healthy.\n' "$ok_count"
      return 0
    fi
    if [ "$terminal_count" -gt 0 ]; then
      diagnose
      die "a service exited: the log above says why"
    fi
    if [ "$SECONDS" -ge "$deadline" ]; then
      diagnose
      die "not every service was healthy after $wait_seconds s (Z402_WAIT_SECONDS): the state and logs above say which and why"
    fi
    sleep 3
  done
}

# The origin of a site as agents see it: https://<prefix><domain>, with the HTTPS port when a trial publishes another one
site_url() {
  local port
  port=$(setting Z402_HTTPS_PORT)
  printf 'https://%s%s%s' "$1" "$(setting Z402_DOMAIN)" "${port:+:$port}"
}

cmd_up() {
  local service
  preflight
  need_docker
  # A starter service that an earlier run started stays up when the profile is turned off, since compose leaves the
  # services of a profile that is not enabled alone
  if ! services_on; then
    if [ -n "$(compose --profile services ps --all --quiet llm markdown embeddings dropbox 2>/dev/null)" ]; then
      echo "The services profile is off: removing the starter services' containers (their volumes stay)."
      compose --profile services rm --force --stop llm markdown embeddings dropbox >/dev/null
    fi
  fi
  # The images one after another: the Rust build of the Node image and the Next.js build of the website, side by side,
  # need more memory than a 4 GB server has. up --build then finds every image built
  for service in facilitator web caddy; do
    compose build "$service" || die "the build of $service failed (a network error is retried by running scripts/vps.sh up again; the steps that finished are kept)"
  done
  if ! compose up -d --build --remove-orphans; then
    diagnose
    die "docker compose up failed: the state and logs above say which service and why"
  fi
  wait_healthy

  printf '\nz402 is up on testnet:\n'
  printf '  site         %s\n' "$(site_url "")"
  printf '  facilitator  %s/supported\n' "$(site_url facilitator.)"
  printf '  demo API     %s/chunk   (402 until paid)\n' "$(site_url api.)"
  if services_on; then
    printf '  services     %s %s %s %s\n' "$(site_url llm.)" "$(site_url markdown.)" "$(site_url embeddings.)" "$(site_url dropbox.)"
  else
    printf '  services     off (COMPOSE_PROFILES=services in %s turns on llm, markdown, embeddings and dropbox)\n' "$env_file"
  fi
}

cmd_status() {
  local ok_count pending_count bad_count terminal_count summary
  need_docker
  need_env
  compose ps --all
  check_services
  printf '\n%s\n' "$summary"
  if [ "$pending_count" = 0 ] && [ "$bad_count" = 0 ]; then
    printf 'All %s services are healthy.\n' "$ok_count"
  else
    printf '%s healthy, %s starting, %s failing.\n' "$ok_count" "$pending_count" "$bad_count"
    return 1
  fi
}

# logs, down, update --------------------------------------------------------------------------------------------------

cmd_logs() {
  local follow=-f
  need_docker
  need_env
  if [ "${1:-}" = --no-follow ]; then
    follow=""
    shift
  fi
  compose logs --tail=200 ${follow:+"$follow"} "$@"
}

cmd_down() {
  need_docker
  need_env
  # Every profile, so that starter services that are still running stop too. Never --volumes: they hold the ledger
  compose --profile '*' down --remove-orphans
  echo "The containers are removed. The volumes stay: the certificates, the ledger and the registered providers."
}

cmd_update() {
  need_docker
  need_env
  command -v git >/dev/null 2>&1 || die "git is needed for update"
  [ -e .git ] || die "this is not a git checkout"
  git pull --ff-only
  # The pull may have replaced this script, so the rebuild runs from the new copy
  exec bash "$root/scripts/vps.sh" up
}

# backup, restore -----------------------------------------------------------------------------------------------------

cmd_backup() {
  local out entries
  need_docker
  need_env
  mkdir -p "$backup_dir"
  chmod 700 "$backup_dir"
  out="$backup_dir/z402-vps-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
  # The facilitator's data volume holds the operator's ledger and the providers directory (the registry with every
  # provider's viewing key, their ledgers and the catalog). The archive goes through stdout, so that no host directory
  # is mounted and the file belongs to whoever runs this. A lock file is left out, since it belongs to a process
  if ! (umask 077 && compose run --rm -T --no-deps --entrypoint tar facilitator \
    -czf - --exclude='*.lock' --exclude='*.lock.takeover' -C /data . >"$out"); then
    rm -f "$out"
    die "the backup failed"
  fi
  tar -tzf "$out" >/dev/null 2>&1 || {
    rm -f "$out"
    die "the backup is not a readable archive"
  }
  entries=$(tar -tzf "$out" | grep -c -v '/$' || true)
  [ "$entries" -gt 0 ] || warn "the archive holds no file yet: the facilitator has not written its ledger"
  printf 'Backup: %s (%s bytes, %s files)\n' "$out" "$(wc -c <"$out" | tr -d ' ')" "$entries"
  printf 'It holds every provider'"'"'s viewing key: keep it private, and copy it off this server.\n'
}

cmd_restore() {
  local file=${1:-} answer
  [ $# -eq 1 ] || die "usage: scripts/vps.sh restore <backup file>"
  [ -f "$file" ] || die "no such file: $file"
  tar -tzf "$file" >/dev/null 2>&1 || die "$file is not a readable tar.gz"
  need_docker
  need_env
  printf 'This empties the facilitator'"'"'s data volume (the operator'"'"'s ledger and the registered providers) and puts\n'
  printf '%s in it. Deposits and sessions since that backup are forgotten. Type yes to go on: ' "$file"
  read -r answer
  [ "$answer" = yes ] || die "not restored"
  # Every container off, so that nothing holds the ledger lock
  compose --profile '*' down --remove-orphans
  compose run --rm -T --no-deps --entrypoint sh facilitator -c \
    'find /data -mindepth 1 -delete && tar -xzf - -C /data' <"$file"
  echo "Restored. Start everything again with scripts/vps.sh up."
}

# main ----------------------------------------------------------------------------------------------------------------

main() {
  local command=${1:-help}
  [ $# -eq 0 ] || shift
  case $command in
    init) cmd_init "$@" ;;
    keys) cmd_keys "$@" ;;
    up) cmd_up "$@" ;;
    status) cmd_status "$@" ;;
    logs) cmd_logs "$@" ;;
    down) cmd_down "$@" ;;
    update) cmd_update "$@" ;;
    backup) cmd_backup "$@" ;;
    restore) cmd_restore "$@" ;;
    help | -h | --help) usage ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
}

main "$@"
exit
