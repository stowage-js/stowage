#!/bin/sh

# Not `set -e`: one emulator that fails to stop leaves the others to stop, and the run still
# fails at the end.
set -u

cd "$(dirname "$0")"

status=0

for EMULATOR in azure-blob gcs s3; do
  ./${EMULATOR}/stop.sh || status=1
done

exit "${status}"
