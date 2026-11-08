#!/usr/bin/env bash
# Installs Loom AI on an Amazon Linux 2023 EC2 instance and runs it as a systemd service.
# Run from the repo root on the instance:  bash deploy/setup-ec2.sh   (safe to re-run after changes)
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_DIR=$(pwd)

if [[ ! -f .env ]]; then
  echo "No .env found. Run:  cp deploy/.env.aws.example .env  and fill in every CHANGE_ME." >&2
  exit 1
fi
if grep -n "^[^#]*CHANGE_ME" .env; then
  echo "Replace the CHANGE_ME values above in .env (see deploy/README.md), then run this again." >&2
  exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "Installing uv..."
  curl -LsSf https://astral.sh/uv/install.sh | sh
  export PATH="$HOME/.local/bin:$PATH"
fi

echo "Installing Loom AI..."
uv sync --frozen --no-dev --package loom-server

echo "Installing the systemd service..."
sed -e "s|__USER__|$(id -un)|g" -e "s|__REPO_DIR__|$REPO_DIR|g" deploy/loom-server.service \
  | sudo tee /etc/systemd/system/loom-server.service >/dev/null
sudo systemctl daemon-reload
# Servers set up before the rename run the old service name; stop it so it frees port 8787.
sudo systemctl disable --now daddy-server 2>/dev/null || true
sudo systemctl enable loom-server >/dev/null
sudo systemctl restart loom-server

echo "Waiting for the gateway..."
for _ in $(seq 1 30); do
  if health=$(curl -fsS http://127.0.0.1:8787/api/health 2>/dev/null); then
    echo "Loom AI is up: $health"
    echo "Next: check https://<your domain>/api/health from your laptop, then send Askar the URL"
    echo "and the bootstrap secret privately (see deploy/README.md, step 5)."
    exit 0
  fi
  sleep 2
done

echo "The gateway did not start. Last log lines:" >&2
sudo journalctl -u loom-server -n 40 --no-pager >&2
exit 1
