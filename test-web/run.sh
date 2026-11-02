#!/usr/bin/env bash
# Usage: test-web/run.sh   -> unit tests, then a fresh fork + full browser e2e against the staging page (127.0.0.1:8092)
set -e
cd "$(dirname "$0")"
docker run --rm -v "$PWD/..:/w" -w /w/test-web node:22-alpine node --test market.test.mjs </dev/null | grep -E "^# (pass|fail)"
./seed.sh
docker run --rm --network host -v "$PWD:/t" -w /t mcr.microsoft.com/playwright/python:v1.48.0-jammy \
  sh -c "pip install -q --no-cache-dir playwright==1.48.0 >/dev/null 2>&1; python e2e.py" </dev/null
