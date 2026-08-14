#!/usr/bin/env bash
# Smoke test for the full Phase 4 pipeline.
# Uploads a file to the ingest service, waits for the worker to process it,
# then confirms rows exist in pgvector.
#
# Usage: ./tools/smoke-test.sh
# Requires: docker compose stack running (docker compose -f infra/docker-compose.yml up)

set -euo pipefail

INGEST_URL="${INGEST_URL:-http://localhost:3004}"
TENANT_ID="${TENANT_ID:-tenant-smoke}"
WAIT_SECONDS="${WAIT_SECONDS:-10}"
FILE="${1:-data/ml-systems.txt}"

echo "==> Uploading $FILE to $INGEST_URL/ingest"
RESPONSE=$(curl -sf \
  -F "tenantId=$TENANT_ID" \
  -F "file=@$FILE" \
  "$INGEST_URL/ingest")

echo "    Response: $RESPONSE"

DOCUMENT_ID=$(echo "$RESPONSE" | grep -o '"documentId":"[^"]*"' | cut -d'"' -f4)
if [ -z "$DOCUMENT_ID" ]; then
  echo "ERROR: no documentId in response" >&2
  exit 1
fi

echo "==> Document queued: $DOCUMENT_ID"
echo "==> Waiting ${WAIT_SECONDS}s for worker to process..."
sleep "$WAIT_SECONDS"

echo "==> Checking pgvector for embeddings..."
COUNT=$(docker compose -f infra/docker-compose.yml exec -T postgres \
  psql -U docflow -tAc \
  "SELECT count(*) FROM \"EmbeddedChunk\" WHERE \"documentId\" = '$DOCUMENT_ID';")

echo "    Rows in EmbeddedChunk: $COUNT"

if [ "$COUNT" -gt 0 ]; then
  echo "PASS — $COUNT embedding(s) written to pgvector for document $DOCUMENT_ID"
else
  echo "FAIL — no embeddings found. Check worker logs:" >&2
  echo "  docker compose -f infra/docker-compose.yml logs worker" >&2
  exit 1
fi
