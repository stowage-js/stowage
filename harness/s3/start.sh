#!/bin/sh
# Starts the endpoint of ADR 0012 and creates the bucket the suite runs against, then
# prints the environment the conformance run reads. Its standard output is that
# environment and nothing else, so CI can append it to `GITHUB_ENV`.
set -eu

cd "$(dirname "$0")"

bucket="${STOWAGE_S3_BUCKET:-stowage-conformance}"

docker compose up --detach --wait >&2

# `weed shell` is idempotent about a bucket that is already there, which is what a second
# start of a container that outlived its run meets.
echo "s3.bucket.create -name ${bucket}" | docker compose exec -T s3 weed shell >/dev/null

cat <<ENVIRONMENT
export STOWAGE_S3_ENDPOINT=http://127.0.0.1:8333
export STOWAGE_S3_BUCKET=${bucket}
export STOWAGE_S3_REGION=us-east-1
export STOWAGE_S3_FORCE_PATH_STYLE=true
export AWS_ACCESS_KEY_ID=stowage
export AWS_SECRET_ACCESS_KEY=stowage-secret
ENVIRONMENT
