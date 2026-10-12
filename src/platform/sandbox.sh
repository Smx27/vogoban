#!/bin/sh
# Confines untrusted repository analysis to a new user+mount+PID+network namespace with no network
# and a pivot_root jail exposing only: the toolchain (read-only), the .NET SDK and NuGet cache,
# the application source (read-only), and exactly one tenant directory (read-write). Everything else
# on the host — other tenants' data, host secrets, /etc, /home, the platform database — is invisible.
# Usage: sandbox.sh <tenant-dir> <app-dir> <dotnet-dir> <nuget-dir> -- <command> [args...]
set -eu
TENANT_DIR=$1 APP_DIR=$2 DOTNET_DIR=$3 NUGET_DIR=$4; shift 4; [ "$1" = "--" ] && shift
NEWROOT=$(mktemp -d)
mount --make-rprivate / 2>/dev/null || true
mount -t tmpfs tmpfs "$NEWROOT"
mkdir -p "$NEWROOT/proc" "$NEWROOT/tmp" "$NEWROOT/etc" "$NEWROOT/dev"
chmod 1777 "$NEWROOT/tmp"
for n in null zero full random urandom tty; do [ -e "/dev/$n" ] && { : > "$NEWROOT/dev/$n"; mount --bind "/dev/$n" "$NEWROOT/dev/$n"; }; done
ln -sf /proc/self/fd "$NEWROOT/dev/fd"
# read-only toolchain
for d in /usr /bin /sbin /lib /lib32 /lib64 /opt; do
  [ -e "$d" ] || continue
  mkdir -p "$NEWROOT$d"; mount --bind "$d" "$NEWROOT$d"; mount -o remount,ro,bind "$NEWROOT$d" 2>/dev/null || true
done
# minimal /etc (DNS is dead anyway; provide passwd so tooling resolving the uid does not crash)
for f in /etc/resolv.conf /etc/nsswitch.conf; do [ -e "$f" ] && { touch "$NEWROOT$f"; mount --bind -o ro "$f" "$NEWROOT$f"; }; done
printf 'root:x:0:0:root:/root:/bin/sh\n' > "$NEWROOT/etc/passwd"
printf 'root:x:0:\n' > "$NEWROOT/etc/group"
# read-only app + SDK, read-write caches and the single tenant directory, at their real paths
bind_ro() { [ -e "$1" ] || return 0; mkdir -p "$NEWROOT$1"; mount --bind "$1" "$NEWROOT$1"; mount -o remount,ro,bind "$NEWROOT$1" 2>/dev/null || true; }
bind_rw() { [ -e "$1" ] || mkdir -p "$1"; mkdir -p "$NEWROOT$1"; mount --bind "$1" "$NEWROOT$1"; }
bind_ro "$APP_DIR"; bind_ro "$DOTNET_DIR"
bind_rw "$NUGET_DIR"; bind_rw "$TENANT_DIR"
cd "$NEWROOT"; mkdir -p oldroot
pivot_root . oldroot
mount -t proc proc /proc || { echo "sandbox: cannot mount /proc in the analysis namespace" >&2; exit 125; }
umount -l /oldroot 2>/dev/null || true; rmdir /oldroot 2>/dev/null || true
export HOME=/tmp TMPDIR=/tmp
cd "$TENANT_DIR"
exec "$@"
