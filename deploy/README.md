# Deploying Loom AI on AWS

This guide is for the AWS team. Steps 1–5 are yours; step 6 is Askar's.

The diagram is [`docs/loom-ai-aws-architecture.drawio`](../docs/loom-ai-aws-architecture.drawio).
[`docs/AWS.md`](../docs/AWS.md) has the background and the full IAM policy.

> [!IMPORTANT]
> Never paste passwords, the bootstrap secret or a filled-in `.env` into chat, Slack, a commit or Loom AI.
> The server needs **no AWS access keys**: it uses the EC2 instance role.

## Shortcut: one command

[`deploy/aws/deploy.sh`](aws/deploy.sh) does steps 1–5 by itself. Run it from a laptop with AWS credentials loaded:

```bash
bash deploy/aws/deploy.sh
```

It creates the stack in [`deploy/aws/stack.yaml`](aws/stack.yaml): a VPC with NAT, an ALB, EC2 in a private subnet, RDS,
an S3 bucket, the IAM role, and CloudFront. CloudFront gives you HTTPS on a free `*.cloudfront.net` address, so you don't
need a domain or a certificate. The script then installs the committed code on the server through SSM; nobody needs SSH.
Passwords stay in Secrets Manager, and the script prints the `loom init` command at the end. Re-run it to deploy new
commits. The stack is named `daddy-full`; set `STACK=...` to use another name.

The manual steps below are still useful if you want to build the setup yourself.

## 1. Create the AWS resources

Use **`us-east-1`** for everything: the hackathon account blocks every other region. All the Bedrock models below are
already enabled there (tested: embeddings, rerank, Claude Haiku 4.5 and Sonnet 4.5).

| Resource | Settings |
| --- | --- |
| **Bedrock model access** | Enable Cohere Embed Multilingual v3, Cohere Rerank 3.5, and one Claude Haiku-class and one Sonnet-class model. |
| **VPC** | 2 public subnets and 2 private subnets in 2 AZs, plus a **NAT Gateway** so the private subnets can reach the internet. |
| **Security groups** | `loom-alb`: inbound 443 (and 80) from anywhere. `loom-ec2`: inbound 8787 from `loom-alb` only. `loom-rds`: inbound 5432 from `loom-ec2` only. |
| **RDS** | PostgreSQL **17** (latest minor, so pgvector is 0.8+), `db.t4g.medium`, 20 GB, private subnets, SG `loom-rds`, not publicly accessible. Set **Initial database name** to `loom`. pgvector is installed by the app on first start. |
| **S3** | A private bucket (Block Public Access on), default encryption **SSE-KMS** (the `aws/s3` key is fine). |
| **IAM role for EC2** | The policy from `docs/AWS.md` with `REGION`, `ACCOUNT_ID`, `BUCKET` and `GUARDRAIL_ID` replaced (delete the `Guardrail` statement if you skip it), plus `AmazonSSMManagedInstanceCore` so you can connect with Session Manager instead of SSH. |
| **EC2** | Amazon Linux 2023, `t3.medium`, a private subnet, SG `loom-ec2`, the IAM role above. |
| **ACM certificate** | For the hostname you will use, for example `loom.<your-domain>`. |
| **ALB** | Internet-facing, public subnets, SG `loom-alb`. Listener **443** HTTPS with the ACM cert, and listener 80 redirecting to 443. Target group: HTTP port **8787**, target = the EC2 instance, health check path **`/api/health`**. |
| **DNS** | Point the hostname at the ALB (Route 53 alias or a CNAME). |
| **Guardrail** (optional) | A Bedrock Guardrail that blocks credentials and PII. |

## 2. Put the code on the instance

Connect with **EC2 → Connect → Session Manager**, then:

```bash
sudo dnf install -y git
sudo su - ec2-user
git clone https://github.com/versean/LoomAI.git
cd loom-ai
cp deploy/.env.aws.example .env
```

The repo is private. Ask Askar to add your GitHub account as a collaborator. When `git clone` asks for a password, use a
[personal access token](https://github.com/settings/tokens) with read access to the repo.

## 3. Fill in `.env`

Open `.env` (`nano .env`) and replace **every** `CHANGE_ME`. The setup script refuses to run while any remain.

| In `.env` | What to put | Where to find it |
| --- | --- | --- |
| `CHANGE_ME_BOOTSTRAP_SECRET` | A random secret | Run `openssl rand -hex 24` on the instance. |
| `CHANGE_ME_DB_USER` | RDS master username | RDS → Databases → your DB → Configuration → Master username. |
| `CHANGE_ME_DB_PASSWORD` | RDS master password, URL-encoded if it has `@ : / ? # %` or spaces | The password set at creation, or Secrets Manager if RDS manages it. |
| `CHANGE_ME_RDS_ENDPOINT` | The endpoint, for example `loom-ai-db.abc123.us-east-1.rds.amazonaws.com` | RDS → your DB → Connectivity & security → Endpoint. |
| `CHANGE_ME_DB_NAME` | `loom` (or `postgres` if no initial database name was set) | RDS → your DB → Configuration → DB name. |
| `CHANGE_ME_BUCKET_NAME` | The bucket name only, no `s3://` | S3 → Buckets. |
| Claude model IDs (optional) | Replace only if our defaults aren't enabled | Bedrock → Model catalog (or Cross-region inference) → the model's ID. |
| `CHANGE_ME_GUARDRAIL_ID` (optional) | The guardrail ID, then uncomment both guardrail lines | Bedrock → Guardrails → your guardrail. |

> [!TIP]
> If Bedrock access isn't approved yet, set `LOOM_EMBEDDING_PROVIDER=hash`, `LOOM_RERANK_PROVIDER=lexical` and
> `LOOM_LLM_PROVIDER=none`. Everything works without Bedrock; switch back later and tell Askar to re-ingest.

## 4. Install and start

```bash
bash deploy/setup-ec2.sh
```

This installs `uv` and the server, registers the `loom-server` systemd service (it restarts by itself and keeps running
after you disconnect), and waits for the health check. Success looks like:

```
Loom AI is up: {"status":"ok","embedder":...,"reranker":...,"llm":...}
```

## 5. Check it from outside, then hand over

From your own laptop:

```bash
curl https://CHANGE_ME_YOUR_HOSTNAME/api/health
```

It should print the same JSON. With Bedrock on, the providers no longer say `hash-v1` / `lexical-v1` / `none`.

> [!IMPORTANT]
> Send Askar **privately**: the HTTPS address and the bootstrap secret.

## 6. Askar: create the team on AWS

The cloud database starts empty. From the repo on your laptop:

```bash
uv run loom init --server https://YOUR_HOSTNAME --secret THE_BOOTSTRAP_SECRET
uv run loom project create acmhack
uv run loom ingest .
uv run loom connect cursor --project-dir . --hooks
uv run loom invite teammate@example.com --name Teammate
```

Teammates then run `uv run loom join <code> --server https://YOUR_HOSTNAME`.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Logs | `sudo journalctl -u loom-server -f` |
| Hangs connecting to the database | `loom-rds` doesn't allow 5432 from `loom-ec2`, or the endpoint is wrong. |
| `password authentication failed` | Wrong user or password, or the password needs URL-encoding. |
| `permission denied to create extension "vector"` | Use the RDS master user. |
| `AccessDeniedException` from Bedrock | Model access isn't enabled in this region, or the role lacks the policy. |
| ALB returns 502 or 503 | The target is unhealthy: check `loom-ec2` allows 8787 from `loom-alb`, and that the health path is `/api/health`. |
| `uv` download or `git clone` times out | The private subnet has no route to the NAT Gateway. |

To update after new commits: `git pull && bash deploy/setup-ec2.sh`.
