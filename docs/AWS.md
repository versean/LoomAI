# Loom AI on AWS: handover for the AWS team

Loom AI runs fully local today. Moving to AWS means switching environment variables;
no code changes are needed. This page covers what we need from the AWS team, why, and
what to send back.

**Step-by-step deployment, with every value to fill in, is in [`deploy/README.md`](../deploy/README.md).**

## What runs where

| Piece | Local today | On AWS |
| --- | --- | --- |
| Gateway (FastAPI, `loom-server`) | laptop, port 8787 | **EC2**, behind HTTPS |
| Database (PostgreSQL + pgvector) | Docker, port 5433 | **RDS for PostgreSQL** |
| Raw files and sent artifacts | `data/blobs/` | **S3** (SSE-KMS) |
| Embeddings | hashed n-grams | **Bedrock**: Cohere Embed Multilingual v3 |
| Reranking (the "refuse to guess" step) | word overlap | **Bedrock Rerank**: Cohere Rerank 3.5 |
| Answer writing | none / Ollama | **Bedrock**: Claude (fast tier + answer tier) |
| Extra content filter on shared files | none | **Bedrock Guardrails** (optional) |
| Logs | terminal | **CloudWatch** |

Teammates' laptops only talk to the gateway over HTTPS and WebSocket. They never need AWS credentials.

The diagram is [`loom-ai-aws-architecture.drawio`](loom-ai-aws-architecture.drawio). Open it at
[app.diagrams.net](https://app.diagrams.net) (File, Open from, Device) or with the draw.io VS Code extension.

Network layout: an ALB in public subnets across 2 AZs, with the EC2 gateway and RDS in private subnets.
A NAT Gateway gives the private subnets outbound internet. The gateway needs it for Bedrock and S3 API calls
(unless VPC endpoints are added) and for importing repos from `api.github.com`.

## Questions to ask the AWS team

**Account and limits**
1. Which AWS account and **region** do we use? The hackathon account only allows **`us-east-1`**, and every model below is enabled there.
2. Is it a temporary hackathon account (for example Workshop Studio credentials that expire every few hours), or a normal account? This decides whether the gateway can use an EC2 instance role or needs refreshed keys.
3. Is there a budget or service allow-list? We need EC2, RDS, S3, Bedrock, KMS and CloudWatch.

**Bedrock (most important)**
4. Is **model access** enabled in that region for these models?
   - `cohere.embed-multilingual-v3` (embeddings, 1024 dimensions)
   - `cohere.rerank-v3-5:0` (Rerank API)
   - Anthropic Claude: one fast model (Haiku class) and one answer model (Sonnet class)
5. Which **exact model IDs or inference profile IDs** should we use for Claude? Our defaults are `us.anthropic.claude-haiku-4-5-20251001-v1:0` and `us.anthropic.claude-sonnet-4-5-20250929-v1:0`. Tell us if newer ones are enabled.
6. Can they create a **Bedrock Guardrail** that blocks credentials and PII? We need its ID and version. This is optional but strong for the security story.

**Database**
7. Can they create **RDS for PostgreSQL 17** (16.6+ also works) with **pgvector 0.8 or newer**? We rely on its HNSW iterative scan. A `db.t4g.medium` with 20 GB is plenty for the demo.
8. Can it sit in the same VPC as the EC2 instance, reachable on 5432 **only** from the EC2 security group?

**Gateway host**
9. Can they launch an **EC2** instance (Amazon Linux 2023, `t3.medium`/`t4g.medium`) with an **IAM instance role** carrying the policy below, so no access keys are needed?
10. How do we get **HTTPS**? Options:
    - an ALB with an ACM certificate and a domain or subdomain (WebSockets must be allowed), or
    - an Elastic IP plus a hostname, and we run Caddy with Let's Encrypt on the instance.
11. Which inbound ports can be opened? We need 443 to everyone, and SSH or SSM Session Manager for us.

**Storage and secrets**
12. Can they create an **S3 bucket** (private, block public access on) with default **SSE-KMS** encryption? The AWS-managed `aws/s3` key is fine.
13. Where should the **database password** live: Secrets Manager or SSM Parameter Store? Please don't send it over chat.

## IAM policy for the EC2 instance role

Replace `REGION`, `ACCOUNT_ID`, `BUCKET` and `GUARDRAIL_ID`. Claude inference profiles route across US regions, so the foundation-model ARNs use `*` for the region.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockModels",
      "Effect": "Allow",
      "Action": "bedrock:InvokeModel",
      "Resource": [
        "arn:aws:bedrock:*::foundation-model/cohere.embed-multilingual-v3",
        "arn:aws:bedrock:*::foundation-model/cohere.rerank-v3-5:0",
        "arn:aws:bedrock:*::foundation-model/anthropic.claude-*",
        "arn:aws:bedrock:REGION:ACCOUNT_ID:inference-profile/us.anthropic.claude-*"
      ]
    },
    {
      "Sid": "RerankApi",
      "Effect": "Allow",
      "Action": "bedrock:Rerank",
      "Resource": "*"
    },
    {
      "Sid": "Guardrail",
      "Effect": "Allow",
      "Action": "bedrock:ApplyGuardrail",
      "Resource": "arn:aws:bedrock:REGION:ACCOUNT_ID:guardrail/GUARDRAIL_ID"
    },
    {
      "Sid": "Artifacts",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject"],
      "Resource": "arn:aws:s3:::BUCKET/*"
    },
    {
      "Sid": "Logs",
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "*"
    }
  ]
}
```

If they use a customer-managed KMS key instead of `aws/s3`, also add `kms:GenerateDataKey` and `kms:Decrypt` on that key.

## What we need back

| Value | Becomes |
| --- | --- |
| Region | `LOOM_AWS_REGION` |
| RDS endpoint, database name, user (password via Secrets Manager or SSM) | `LOOM_DATABASE_URL=postgresql://USER:PASS@ENDPOINT:5432/DB` |
| S3 bucket name | `LOOM_S3_BUCKET` |
| Claude model or inference-profile IDs | `LOOM_BEDROCK_FAST_MODEL`, `LOOM_BEDROCK_ANSWER_MODEL` |
| Rerank model ARN in our region | `LOOM_BEDROCK_RERANK_MODEL_ARN` |
| Guardrail ID and version (optional) | `LOOM_GUARDRAIL_ID`, `LOOM_GUARDRAIL_VERSION` |
| Public HTTPS URL of the gateway | what teammates pass to `loom join … --server` |
| How to reach the instance (SSH key or SSM) | for deploying |

## Switching over

Follow [`deploy/README.md`](../deploy/README.md). It covers filling in `.env` from `deploy/.env.aws.example`,
running `deploy/setup-ec2.sh` (which installs the server as a systemd service), and the handover to Askar.
Askar then re-creates the team, re-ingests the projects (Bedrock vectors aren't comparable with the local ones)
and re-issues invites, because the cloud database starts empty.
