#!/usr/bin/env bash

set -euo pipefail

packages="$(go list ./... 2>/dev/null || true)"
if [ -z "${packages}" ]; then
  go mod verify
  printf 'No Go packages are present; module metadata is valid.\n'
  exit 0
fi

go test ./...
