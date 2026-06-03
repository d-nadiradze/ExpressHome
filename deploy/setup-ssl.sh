#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${SSL_DOMAIN:-makler.solutions}"
EMAIL="${1:-}"

if [[ -z "$EMAIL" ]]; then
  echo "Usage: $0 <your-email@example.com>"
  echo "Example: $0 admin@makler.solutions"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

HTTP_CONF="$ROOT/nginx/default.http.conf"
SSL_CONF="$ROOT/nginx/default.ssl.conf"
ACTIVE_CONF="$ROOT/nginx/default.conf"

if [[ ! -f "$HTTP_CONF" || ! -f "$SSL_CONF" ]]; then
  echo "Missing nginx/default.http.conf or nginx/default.ssl.conf"
  exit 1
fi

echo "==> Ensuring HTTP nginx config (required for Let's Encrypt)..."
cp "$HTTP_CONF" "$ACTIVE_CONF"
docker compose up -d nginx app
docker compose restart nginx

echo "==> Requesting certificate for $DOMAIN..."
docker compose run --rm --entrypoint certbot certbot certonly \
  --webroot -w /var/www/certbot \
  -d "$DOMAIN" \
  --email "$EMAIL" \
  --agree-tos \
  --no-eff-email \
  --non-interactive

CERT_PATH="$ROOT/certbot/conf/live/$DOMAIN/fullchain.pem"
if [[ ! -f "$CERT_PATH" ]]; then
  echo "ERROR: Certificate not found at $CERT_PATH"
  echo "Certbot did not issue a certificate. Check the output above."
  exit 1
fi

echo "==> Certificate obtained."
cp "$SSL_CONF" "$ACTIVE_CONF"
docker compose restart nginx

echo "==> Done. Test with:"
echo "    curl -I https://$DOMAIN"
