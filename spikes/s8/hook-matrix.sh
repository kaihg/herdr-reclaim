#!/bin/sh
# Isolated fixtures only; never installs hooks in the user's repository.
set -eu
exec python3 "$(dirname "$0")/verify.py"
