#!/usr/bin/env bash
# Publishes the five @z402-net packages to npm: protocol, lightwalletd, server, client, service-kit.
#
#   pnpm run publish:packages --dry-run     everything below, but nothing is published
#   pnpm run publish:packages --otp=123456  publish, with a one-time password
#   pnpm run publish:packages               publish; npm asks for the one-time password when it needs one
#
# The only arguments are --dry-run and --otp=<6 digits>, which go to `pnpm publish`; anything else is refused
# (leading `--` arguments are dropped, since `pnpm run script -- args` passes them on). Log in first with
# `npm login`; this script never reads or prints a token.
#
# 1. Refuses to run while the packages, the root package.json or the lockfile have uncommitted changes, so only
#    committed code is published.
# 2. Installs from the lockfile and builds the five packages in dependency order (build:packages removes the
#    old dist/ directories first).
# 3. Packs the five into a temporary directory and checks each tarball: the name is under @z402-net/, no
#    workspace: reference is left, the exports point into dist/, and a README and a LICENSE are in it.
# 4. Publishes with --access public. pnpm publishes in dependency order and skips a version that is already on
#    the registry. Git checks are off because the tree may hold other work and the repository has no remote.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

while [ "${1:-}" = "--" ]; do
  shift
done

PACKAGES=(protocol lightwalletd server client service-kit)
FILTER="./packages/{protocol,lightwalletd,server,client,service-kit}"
SCOPE="@z402-net"

die() {
  echo "publish-packages: $*" >&2
  exit 1
}

# Only these reach pnpm publish, and anything else stops the run before it builds: zsh, by default, passes a
# trailing `# comment` on an interactive line as arguments
for arg in "$@"; do
  case "$arg" in
    --dry-run | --otp=[0-9][0-9][0-9][0-9][0-9][0-9]) ;;
    *) die "unknown argument '$arg': use --dry-run, --otp=123456 or no argument" ;;
  esac
done

echo "==> 1/4 Checking that the published code is committed"
tracked=(package.json pnpm-lock.yaml)
for p in "${PACKAGES[@]}"; do
  tracked+=("packages/$p")
done
dirty=$(git status --porcelain -- "${tracked[@]}")
if [ -n "$dirty" ]; then
  echo "$dirty" >&2
  die "uncommitted changes in the files above; commit or discard them first"
fi

echo "==> 2/4 Installing from the lockfile and building"
pnpm install --frozen-lockfile
pnpm run build:packages

echo "==> 3/4 Packing and checking the tarballs"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
pnpm -r --filter "$FILTER" pack --pack-destination "$tmp" >/dev/null

# Exits 1 and says why unless the manifest on stdin is fit to publish
check_manifest() {
  node -e '
    const m = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    const leaves = (v) => (typeof v === "string" ? [v] : Object.values(v).flatMap(leaves));
    const problems = [];
    if (!String(m.name).startsWith(process.argv[1] + "/")) problems.push("name " + m.name + " is not under " + process.argv[1] + "/");
    if (m.private) problems.push("it is private");
    if (JSON.stringify(m).includes("workspace:")) problems.push("a workspace: reference is left");
    const outside = m.exports ? leaves(m.exports).filter((p) => !p.startsWith("./dist/")) : ["(no exports)"];
    if (outside.length > 0) problems.push("exports outside dist/: " + outside.join(", "));
    if (problems.length > 0) {
      console.error(m.name + ": " + problems.join("; "));
      process.exit(1);
    }
    console.log("    ok " + m.name + "@" + m.version);
  ' "$SCOPE"
}

for p in "${PACKAGES[@]}"; do
  tarballs=("$tmp"/z402-net-"$p"-*.tgz)
  if [ "${#tarballs[@]}" -ne 1 ] || [ ! -f "${tarballs[0]}" ]; then
    die "expected one tarball for $p in $tmp"
  fi
  tgz=${tarballs[0]}
  listing=$(tar -tzf "$tgz")
  for f in package/package.json package/README.md package/LICENSE; do
    grep -qxF "$f" <<<"$listing" || die "$(basename "$tgz") has no $f"
  done
  tar -xzOf "$tgz" package/package.json | check_manifest || die "$(basename "$tgz") is not fit to publish"
done
rm -rf "$tmp"

echo "==> 4/4 Publishing (pnpm publish --access public --no-git-checks $*)"
pnpm -r --filter "$FILTER" publish --access public --no-git-checks "$@"
