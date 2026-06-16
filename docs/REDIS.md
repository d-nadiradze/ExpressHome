# Redis setup

ExpressHome uses **Redis** for:

- **BullMQ** — parse and statement prefill job queues
- **Prefill progress** — live status in the UI (`/api/prefill/status`)

The Next.js app **enqueues** jobs; a separate **worker** process runs them.

## Environment

```env
REDIS_URL="redis://localhost:6379"
```

Production Docker sets `REDIS_URL=redis://redis:6379` automatically in `docker-compose.yml`.

## Local development

### Option A — Docker (recommended)

```bash
npm run redis:up      # starts redis from docker-compose.yml
npm run dev           # terminal 1
npm run worker:dev    # terminal 2 — required for jobs to run
```

Stop Redis: `npm run redis:down`

### Option B — Windows without Docker

1. Install **Memurai** (Redis-compatible for Windows): https://www.memurai.com/  
   Or use **WSL2**: `sudo apt install redis-server && sudo service redis-server start`

2. Confirm Redis responds:

   ```powershell
   # If redis-cli is on PATH:
   redis-cli ping
   # Expected: PONG
   ```

3. Keep `REDIS_URL=redis://localhost:6379` in `.env` and run `npm run worker:dev`.

### Option C — Production VPS

```bash
docker compose up -d
```

Starts `redis`, `app`, `worker`, `mysql`, and `nginx`. No extra Redis install on the host.

## npm scripts

| Script | Purpose |
|--------|---------|
| `npm run redis:up` | Start Redis container |
| `npm run redis:down` | Stop Redis container |
| `npm run redis:logs` | Follow Redis logs |
| `npm run worker` | Run job worker once |
| `npm run worker:dev` | Worker with auto-reload |

## Troubleshooting

- **Prefill stuck on “Queued”** — Redis not running or worker not started.
- **ECONNREFUSED 127.0.0.1:6379** — Start Redis (`npm run redis:up` or Memurai).
- **Production** — Ensure `worker` service is up: `docker compose ps worker`.
