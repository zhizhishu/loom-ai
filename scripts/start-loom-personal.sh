#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec "$root/Manage-Loom.sh" --action portable --package-dir "$root" "$@"
