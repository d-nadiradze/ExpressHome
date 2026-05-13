# GitHub CI/CD — step-by-step guide

This project includes two workflows under `.github/workflows/`:

| Workflow | File | When it runs |
|----------|------|----------------|
| **CI** | `ci.yml` | Every push and pull request to `main` or `master` |
| **Deploy** | `deploy.yml` | Only when you run it manually (**Actions → Deploy → Run workflow**) |

---

## Part A — Continuous Integration (CI)

You do not need to configure anything for CI to run after the workflow files are on GitHub.

### Step 1 — Push the workflows

1. Commit the `.github/workflows/` folder (and the rest of your project).
2. Push to GitHub (`git push`).

### Step 2 — Confirm CI on GitHub

1. Open your repository on GitHub.
2. Click the **Actions** tab.
3. Open the latest **CI** run.
4. Wait for the **build** job to finish (green checkmark).

**What CI does:** `npm ci` → `npx prisma generate` → `npm run build` with placeholder environment variables (no real database required).

### Step 3 — If CI fails

- Read the red job log; common issues: TypeScript errors, missing `package-lock.json`, or Prisma schema errors.
- Fix locally, commit, and push again.

---

## Part B — Deploy to your VPS (CD)

Deploy uses SSH: GitHub connects to your server, runs `git pull`, then `sudo docker compose up -d --build app`.

### Step 1 — Server is ready

On the VPS you should already have:

- The app cloned (for example `/opt/myhome-parser`).
- Docker and Docker Compose installed.
- A working `docker compose` stack (`.env` present, containers have started at least once).

### Step 2 — Create an SSH key **only for GitHub Actions**

On your **local computer** (not on the server):

```bash
ssh-keygen -t ed25519 -C "github-actions-deploy" -f ./github_deploy_key -N ""
```

This creates:

- `github_deploy_key` — **private** key (secret; goes to GitHub).
- `github_deploy_key.pub` — **public** key (goes on the server).

### Step 3 — Install the public key on the server

1. Show the public key:

   ```bash
   type github_deploy_key.pub
   ```
   (On macOS/Linux: `cat github_deploy_key.pub`.)

2. SSH to your server as the user that will run deploy (often `ubuntu`):

   ```bash
   ssh ubuntu@YOUR_SERVER_IP
   ```

3. Append the public key to that user’s `authorized_keys`:

   ```bash
   mkdir -p ~/.ssh
   chmod 700 ~/.ssh
   echo "PASTE_PUBLIC_KEY_ONE_LINE_HERE" >> ~/.ssh/authorized_keys
   chmod 600 ~/.ssh/authorized_keys
   ```

4. Test from your PC (should log in without a password, using the **private** key):

   ```bash
   ssh -i ./github_deploy_key ubuntu@YOUR_SERVER_IP
   ```

### Step 4 — Allow Docker commands without a password (recommended)

The deploy script uses `sudo docker compose …`. Either:

**Option A — passwordless sudo for docker** (common on small VPS setups):

On the server:

```bash
sudo visudo -f /etc/sudoers.d/github-deploy
```

Add (replace `ubuntu` with your deploy user):

```
ubuntu ALL=(ALL) NOPASSWD: /usr/bin/docker, /usr/bin/docker-compose, /usr/local/bin/docker-compose
```

If `docker compose` is a plugin, the binary may be `/usr/bin/docker` only — this line often works:

```
ubuntu ALL=(ALL) NOPASSWD: /usr/bin/docker
```

Save and exit. Test:

```bash
sudo docker ps
```

**Option B — add user to `docker` group** and remove `sudo` from the workflow script (advanced; edit `.github/workflows/deploy.yml` accordingly).

### Step 5 — Git must be able to `git pull` on the server

- If the repo is **public**: no extra step.
- If the repo is **private**: on the server, use a deploy key or HTTPS with a credential helper / PAT so `git pull` works for the same user used in Step 3.

### Step 6 — Add GitHub Actions secrets

1. On GitHub: **Repository → Settings → Secrets and variables → Actions**.
2. Open **Secrets** → **New repository secret**.
3. Add exactly these names:

| Secret name | Value |
|-------------|--------|
| `DEPLOY_HOST` | Your server IP or hostname |
| `DEPLOY_USER` | SSH username (e.g. `ubuntu`) |
| `DEPLOY_SSH_KEY` | Full contents of the **private** file `github_deploy_key` (including `-----BEGIN` and `-----END` lines) |

4. (Optional) Under **Variables**, add `DEPLOY_APP_DIR` if the app is **not** in `/opt/myhome-parser` (for example `/home/ubuntu/myhome-parser`).

### Step 7 — Commit and push workflow files

Ensure `.github/workflows/deploy.yml` is on the `default` branch (usually `main`).

### Step 8 — Run a deploy

1. GitHub → **Actions**.
2. Select **Deploy** in the left list.
3. Click **Run workflow**.
4. Choose the branch (default `main`) → **Run workflow**.
5. Open the run and wait until it is green.

On the server, the script effectively runs:

```bash
cd "$DEPLOY_APP_DIR"   # default /opt/myhome-parser
git fetch origin
git checkout <branch>
git pull origin <branch>
sudo docker compose up -d --build app
```

### Step 9 — Verify

```bash
ssh ubuntu@YOUR_SERVER_IP
sudo docker compose ps
curl -sI http://127.0.0.1:3000 | head -5
```

---

## Troubleshooting

| Symptom | What to check |
|---------|----------------|
| SSH step fails | Host, user, key; security group / firewall allows port 22; correct private key in `DEPLOY_SSH_KEY`. |
| `Permission denied` on `sudo docker` | Sudoers file from Step 4; or use docker group without `sudo` in the workflow. |
| `git pull` fails | Private repo credentials on the server; branch name matches GitHub. |
| `no configuration file provided` | `DEPLOY_APP_DIR` must point to the folder that contains `docker-compose.yml`. |
| Build killed / OOM | Add swap on the VPS or use a larger instance for `docker compose build`. |

---

## Security tips

- Use a **dedicated** SSH key only for GitHub Actions; do not reuse your personal key.
- Restrict that key in `authorized_keys` with `from="IP_OF_GITHUB_RUNNER"` only if you accept maintenance when GitHub’s IP ranges change (often people skip this on small projects).
- Rotate `DEPLOY_SSH_KEY` if it is ever exposed.

---

## Files involved

- [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — CI pipeline  
- [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) — SSH deploy pipeline  
