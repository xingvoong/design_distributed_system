#!/usr/bin/env bash
# Smoke test for Phase 5: query service scatter/gather.
# Ingests a document, waits for embeddings to land, then queries for it.
#
# Usage: ./tools/smoke-test-query.sh
# Requires: docker compose stack running (docker compose -f infra/docker-compose.yml up)

set -euo pipefail

INGEST_URL="${INGEST_URL:-http://localhost:3004}"
QUERY_URL="${QUERY_URL:-http://localhost:3005}"
TENANT_ID="${TENANT_ID:-tenant-smoke-query}"
WAIT_SECONDS="${WAIT_SECONDS:-10}"
FILE="${1:-data/ml-systems.txt}"

echo "==> Uploading $FILE"
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
echo "==> Waiting ${WAIT_SECONDS}s for worker to embed..."
sleep "$WAIT_SECONDS"

echo "==> Querying for 'machine learning systems'"
QUERY_RESPONSE=$(curl -sf \
  -X POST "$QUERY_URL/query" \
  -H "Content-Type: application/json" \
  -d "{\"query\": \"machine learning systems\", \"tenantId\": \"$TENANT_ID\", \"topK\": 3}")

echo "    Response: $QUERY_RESPONSE"

RESULT_COUNT=$(echo "$QUERY_RESPONSE" | grep -o '"documentId"' | wc -l | tr -d ' ')

if [ "$RESULT_COUNT" -gt 0 ]; then
  echo "PASS — query returned $RESULT_COUNT result(s)"
else
  echo "FAIL — query returned no results" >&2
  echo "  Check logs: docker compose -f infra/docker-compose.yml logs query-service" >&2
  exit 1
fi
