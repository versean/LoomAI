# Deploying Hivemind to AWS

End state: `https://hive.yourteam.dev` is always online. Teammates open the dashboard in a browser,
and their AIs connect to `https://hive.yourteam.dev/mcp` with a token. Nobody installs anything,
and your laptop can be off. The conductor sits idle (no model calls, no cost) until someone pushes.

**Setup:** one small AWS server running two containers: the **hub** and **Caddy** (automatic HTTPS).
Data lives on the server's disk; Claude runs through **Amazon Bedrock** using the server's IAM role
(no API keys stored anywhere).

Time: ~45 minutes. Cost: ~$10–20/month for the server + Bedrock usage.

---

## 1. Turn on Claude in Bedrock

1. AWS Console → **Amazon Bedrock** → **Model access** (pick your region, e.g. `us-east-1`).
2. Enable access to the **Anthropic Claude** models. Approval can take a few minutes; do this first.

## 2. Create an IAM role for the server

1. **IAM** → **Roles** → **Create role** → trusted entity **AWS service** → **EC2**.
2. Attach a policy that allows invoking Bedrock models. Minimal inline policy:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream", "bedrock:CallWithBearerToken"],
       "Resource": "*"
     }]
   }
   ```
   (If Bedrock returns an AccessDenied naming a different action, add that action. AWS adjusts these names over time.)
3. Name it `hivemind-server`.

## 3. Launch the server

**EC2** → **Launch instance**:
- **AMI:** Ubuntu 24.04 LTS · **Type:** `t3.small` (2 GB RAM is plenty)
- **Storage:** 20 GB gp3 (this disk holds the brain; it survives restarts)
- **Security group:** allow inbound **22** (SSH, your IP only), **80** and **443** (anywhere)
- **Advanced → IAM instance profile:** `hivemind-server`

Then give it a fixed address: **Elastic IPs** → Allocate → Associate with the instance.

(Lightsail works too: create an Ubuntu instance, open ports 80/443, attach a static IP. For Bedrock
from Lightsail, use an access key in `.env` instead of a role, or use `HIVEMIND_PROVIDER=anthropic`.)

## 4. Point a domain at it

At your DNS provider, add an **A record**: `hive.yourteam.dev` → the Elastic IP.
(No domain? Any cheap one works, or use a free subdomain service. Caddy needs a real hostname for HTTPS.)

## 5. Install Docker and start Hivemind

SSH in (`ssh ubuntu@<elastic-ip>`), then:

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu && newgrp docker

git clone <your-hivemind-repo-url> hivemind && cd hivemind/deploy
cp ../.env.example .env
nano .env        # set HIVEMIND_PASSWORD, HIVEMIND_PUBLIC_URL, HIVEMIND_DOMAIN, AWS_REGION

docker compose up -d --build
docker compose logs -f hivemind   # look for "conductor  Amazon Bedrock (...)"
```

Open `https://hive.yourteam.dev`, log in with `HIVEMIND_PASSWORD`, and create your project.

## 6. Connect everyone's AI

On the dashboard: **Connect agent** → type the agent's name → **Create token**. Each person runs
the `claude mcp add ... --header "Authorization: Bearer hm_..."` command it shows. One token per
agent; revoke it there if someone leaves.

## 7. Backups (do this before the demo)

The brain already can't be destroyed by agents (every change is a commit, snapshots are tags, no
tool deletes anything). These protect against losing the **server**:

- **Git mirror (recommended):** create a private GitHub repo, add the server's SSH key as a deploy
  key with write access, and set `HIVEMIND_BACKUP_REMOTE=git@github.com:org/hivemind-brain.git`.
  Every snapshot (including the automatic one before each conductor run) pushes there.
- **Nightly S3 copy:** create a bucket (optionally with **Object Lock** so even admins can't delete
  backups for N days), give the IAM role `s3:PutObject` on it, then:
  ```bash
  sudo apt install -y awscli
  (crontab -l; echo "0 3 * * * tar czf - -C /srv hivemind | aws s3 cp - s3://YOUR-BUCKET/hivemind-\$(date +\%F).tgz") | crontab -
  ```

## Updating

```bash
cd ~/hivemind && git pull && cd deploy && docker compose up -d --build
```
Data in `/srv/hivemind` is untouched by rebuilds.

## Health

`https://hive.yourteam.dev/health` → `{ ok, uptimeSec, queue, conductor }`. Point any uptime
monitor at it.

---

### Why not Lambda / App Runner?

Both throw away the disk on restart, and the brain is a git repo + SQLite on disk. That's a fine
later migration (S3 + Postgres, then ECS Fargate), but one server is simpler, cheaper, and fully
AWS for the hackathon.
