#!/bin/sh
# Starts the endpoint of ADR 0034 and creates the bucket the suite runs against, then prints
# the environment the conformance run reads. Its standard output is that environment and
# nothing else, so CI can append it to `GITHUB_ENV`.
set -eu

cd "$(dirname "$0")"

bucket="${STOWAGE_GCS_BUCKET:-stowage-conformance}"
port="${STOWAGE_GCS_PORT:-4443}"
endpoint="http://127.0.0.1:${port}"

# The memory backend starts empty, so a recreated container holds nothing an earlier run
# left behind.
STOWAGE_GCS_PORT="${port}" docker compose up --detach --wait --force-recreate >&2

# fake-gcs-server checks no credential (ADR 0034) and asks for a project where the service
# would read it off the token.
status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --request POST \
  --header "Content-Type: application/json" \
  --data "{\"name\":\"${bucket}\"}" \
  "${endpoint}/storage/v1/b?project=stowage-conformance")"

case "${status}" in
  200 | 409) ;;
  *)
    echo "Creating the bucket ${bucket} answered ${status}" >&2
    exit 1
    ;;
esac

cat <<ENVIRONMENT
export STOWAGE_GCS_ENDPOINT_NAME=fake-gcs-server
export STOWAGE_GCS_ENDPOINT=${endpoint}
export STOWAGE_GCS_BUCKET=${bucket}
ENVIRONMENT
