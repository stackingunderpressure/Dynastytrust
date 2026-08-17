#!/usr/bin/env bash
# supabase-auth-deploy.sh -- pushes the branded, code-only login email
# templates in supabase/templates/ to the live project's auth config
# via the Supabase Management API (PATCH /v1/projects/{ref}/config/auth),
# same token-only approach as supabase-migrate.sh, no CLI. Confirmed
# field name for the magic-link template: mailer_templates_magic_link_content
# / mailer_subjects_magic_link; confirmation/recovery below follow the
# same documented naming pattern but were not independently confirmed
# field-by-field -- if the API rejects one of those two field names,
# check the exact name in the Management API reference
# (supabase.com/docs/reference/api) and fix the field name here, the
# request shape itself is right.
#
# Deliberately run by hand only (see the workflow that calls this),
# never automatically on push: this PATCHes real, live auth
# configuration for real users. Every {{ .Token }} in these templates
# is Supabase's own OTP variable -- no {{ .ConfirmationURL }} anywhere,
# so the email never contains a clickable link (operator, 2026-08-17:
# "only codes in email no links").
set -euo pipefail

: "${SUPABASE_ACCESS_TOKEN:?SUPABASE_ACCESS_TOKEN is required}"
: "${SUPABASE_PROJECT_REF:?SUPABASE_PROJECT_REF is required}"
TEMPLATES_DIR="${TEMPLATES_DIR:-supabase/templates}"

API="https://api.supabase.com/v1/projects/${SUPABASE_PROJECT_REF}/config/auth"

for required in magic_link confirmation recovery; do
  if [ ! -f "${TEMPLATES_DIR}/${required}.html" ]; then
    echo "::error::Missing ${TEMPLATES_DIR}/${required}.html" >&2
    exit 1
  fi
  # Strip HTML comments first -- the templates' own header comments explain
  # in prose that they deliberately avoid the ConfirmationURL variable,
  # which otherwise self-trips this literal string search.
  if sed -e '/<!--/,/-->/d' "${TEMPLATES_DIR}/${required}.html" | grep -qi 'ConfirmationURL'; then
    echo "::error::${TEMPLATES_DIR}/${required}.html still references {{ .ConfirmationURL }} -- codes only, no links." >&2
    exit 1
  fi
done

payload=$(jq -n \
  --rawfile magic_link "${TEMPLATES_DIR}/magic_link.html" \
  --rawfile confirmation "${TEMPLATES_DIR}/confirmation.html" \
  --rawfile recovery "${TEMPLATES_DIR}/recovery.html" \
  --arg magic_link_subject "${MAGIC_LINK_SUBJECT:-Your sign-in code}" \
  --arg confirmation_subject "${CONFIRMATION_SUBJECT:-Confirm your account}" \
  --arg recovery_subject "${RECOVERY_SUBJECT:-Your password reset code}" \
  '{
    mailer_templates_magic_link_content: $magic_link,
    mailer_subjects_magic_link: $magic_link_subject,
    mailer_templates_confirmation_content: $confirmation,
    mailer_subjects_confirmation: $confirmation_subject,
    mailer_templates_recovery_content: $recovery,
    mailer_subjects_recovery: $recovery_subject
  }')

echo "Pushing login-code email templates to project ${SUPABASE_PROJECT_REF}..."
response=$(curl -sS -w '\n%{http_code}' \
  --request PATCH "$API" \
  --header "Authorization: Bearer ${SUPABASE_ACCESS_TOKEN}" \
  --header "Content-Type: application/json" \
  --data-binary "$payload")
http_status=$(tail -n1 <<<"$response")
body=$(sed '$d' <<<"$response")

if [ "$http_status" -lt 200 ] || [ "$http_status" -ge 300 ]; then
  echo "::error::Supabase Management API returned HTTP $http_status" >&2
  echo "$body" >&2
  exit 1
fi

echo "Done. Auth email templates updated."
