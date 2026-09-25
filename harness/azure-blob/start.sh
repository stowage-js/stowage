#!/bin/sh
# Starts the endpoint of ADR 0023 and creates the container the suite runs against, then
# prints the environment the conformance run reads. Its standard output is that
# environment and nothing else, so CI can append it to `GITHUB_ENV`.
set -eu

cd "$(dirname "$0")"

container="${STOWAGE_AZURE_BLOB_CONTAINER:-stowage-conformance}"
account=devstoreaccount1
endpoint="https://127.0.0.1:10000/${account}"

# ADR 0023: a certificate of its own on every start, for the loopback address alone. The
# key is readable by the container's user whatever this machine's user is; it signs for
# nothing but a local emulator.
mkdir -p certificate
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=127.0.0.1" \
  -addext "subjectAltName=IP:127.0.0.1,DNS:localhost" \
  -keyout certificate/key.pem -out certificate/cert.pem 2>/dev/null
chmod 644 certificate/key.pem

# A container that outlived its run still serves the certificate it started with.
docker compose up --detach --wait --force-recreate >&2

base64url() {
  base64 | tr '+/' '-_' | tr -d '=\n'
}

# Azurite reads the token's times, issuer and audience and checks no signature, so the
# token the container is created with is minted here, unsigned (ADR 0023), with the claims
# `src/token.ts` mints for the run. The version is the one the adapter pins (spec 8.4).
now="$(date +%s)"
header="$(printf '{"alg":"none","typ":"JWT"}' | base64url)"
claims="$(printf '{"aud":"https://storage.azure.com","iss":"https://sts.windows.net/00000000-0000-0000-0000-000000000000/","iat":%s,"nbf":%s,"exp":%s}' \
  "$((now - 60))" "$((now - 60))" "$((now + 600))" | base64url)"

status="$(curl --silent --output /dev/null --write-out '%{http_code}' \
  --cacert certificate/cert.pem --request PUT \
  --header "Authorization: Bearer ${header}.${claims}." \
  --header "x-ms-version: 2026-04-06" \
  --header "Content-Length: 0" \
  "${endpoint}/${container}?restype=container")"

case "${status}" in
  201 | 409) ;;
  *)
    echo "Creating the container ${container} answered ${status}" >&2
    exit 1
    ;;
esac

cat <<ENVIRONMENT
export STOWAGE_AZURE_BLOB_ENDPOINT=${endpoint}
export STOWAGE_AZURE_BLOB_ACCOUNT=${account}
export STOWAGE_AZURE_BLOB_CONTAINER=${container}
export AZURE_STORAGE_KEY=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==
export NODE_EXTRA_CA_CERTS=$(pwd)/certificate/cert.pem
ENVIRONMENT
