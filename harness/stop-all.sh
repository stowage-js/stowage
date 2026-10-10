#!/bin/sh

set -eu

cd "$(dirname "$0")"

for EMULATOR in azure-blob gcs s3; do
  ./${EMULATOR}/stop.sh
done
