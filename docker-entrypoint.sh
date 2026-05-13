#!/bin/sh
set -e

echo "Running Prisma migrations..."
node node_modules/prisma/build/index.js db push --skip-generate --accept-data-loss 2>&1 || echo "Warning: Prisma db push failed, tables may already exist"

echo "Starting app..."
exec "$@"
