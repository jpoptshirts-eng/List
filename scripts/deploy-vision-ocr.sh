#!/usr/bin/env bash
# Deploy the vision-ocr Supabase Edge Function and store the Google credentials secret.
#
# Prerequisites:
#   1. Get your Supabase access token from https://supabase.com/dashboard/account/tokens
#   2. Run:  export SUPABASE_ACCESS_TOKEN=<your-token>
#   3. Then: bash scripts/deploy-vision-ocr.sh
#
# The script reads the credentials JSON you added at:
#   ~/Downloads/gen-lang-client-0993666103-eae325e9e6c2.json
#
# It stores them as an encrypted Supabase secret (never touches your source code).

set -euo pipefail

PROJECT_REF="dncwllpqoomdcovudmww"
CREDS_FILE="$HOME/Downloads/gen-lang-client-0993666103-eae325e9e6c2.json"

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "❌  SUPABASE_ACCESS_TOKEN is not set."
  echo "   Get yours at: https://supabase.com/dashboard/account/tokens"
  echo "   Then run:  export SUPABASE_ACCESS_TOKEN=<your-token>"
  exit 1
fi

if [[ ! -f "$CREDS_FILE" ]]; then
  echo "❌  Credentials file not found at: $CREDS_FILE"
  echo "   Make sure the Google Vision service account JSON is in ~/Downloads/"
  exit 1
fi

echo "→ Setting GOOGLE_VISION_CREDENTIALS secret on project $PROJECT_REF …"
CREDS_JSON=$(cat "$CREDS_FILE")
npx supabase secrets set GOOGLE_VISION_CREDENTIALS="$CREDS_JSON" \
  --project-ref "$PROJECT_REF"

echo "→ Deploying vision-ocr edge function …"
npx supabase functions deploy vision-ocr \
  --project-ref "$PROJECT_REF" \
  --no-verify-jwt

echo "✅  Done! The vision-ocr function is live and the credentials secret is set."
echo "   You can verify at: https://supabase.com/dashboard/project/$PROJECT_REF/functions"
