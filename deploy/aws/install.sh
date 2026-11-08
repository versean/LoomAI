#!/usr/bin/env bash
# Runs on the EC2 instance as root (deploy/aws/deploy.sh sends it through SSM Run Command).
# Writes .env from Secrets Manager and the stack outputs, then runs deploy/setup-ec2.sh as ec2-user.
#   install.sh REGION BUCKET DB_ENDPOINT DB_SECRET_ARN BOOTSTRAP_SECRET_ARN [OPEN_SIGNUP]
set -euo pipefail

REGION=$1 BUCKET=$2 DB_ENDPOINT=$3 DB_SECRET_ARN=$4 BOOTSTRAP_SECRET_ARN=$5 OPEN_SIGNUP=${6:-false}
[[ $OPEN_SIGNUP == true ]] || OPEN_SIGNUP=false
REPO_DIR=$(cd "$(dirname "$0")/../.." && pwd)

secret() { aws secretsmanager get-secret-value --region "$REGION" --secret-id "$1" --query SecretString --output text; }

DATABASE_URL=$(secret "$DB_SECRET_ARN" | DB_ENDPOINT="$DB_ENDPOINT" python3 -c '
import json, os, sys
from urllib.parse import quote
s = json.load(sys.stdin)
print("postgresql://%s:%s@%s:5432/daddy?sslmode=require"
      % (quote(s["username"], safe=""), quote(s["password"], safe=""), os.environ["DB_ENDPOINT"]))')
BOOTSTRAP_SECRET=$(secret "$BOOTSTRAP_SECRET_ARN")

umask 077
sed -e "s|^LOOM_BOOTSTRAP_SECRET=.*|LOOM_BOOTSTRAP_SECRET=$BOOTSTRAP_SECRET|" \
    -e "s|^LOOM_OPEN_SIGNUP=.*|LOOM_OPEN_SIGNUP=$OPEN_SIGNUP|" \
    -e "s|^LOOM_S3_BUCKET=.*|LOOM_S3_BUCKET=$BUCKET|" \
    -e "s|^LOOM_AWS_REGION=.*|LOOM_AWS_REGION=$REGION|" \
    -e "s|^LOOM_BEDROCK_RERANK_MODEL_ARN=.*|LOOM_BEDROCK_RERANK_MODEL_ARN=arn:aws:bedrock:$REGION::foundation-model/cohere.rerank-v3-5:0|" \
    -e "/^LOOM_DATABASE_URL=/d" \
    "$REPO_DIR/deploy/.env.aws.example" > "$REPO_DIR/.env"
printf 'LOOM_DATABASE_URL=%s\n' "$DATABASE_URL" >> "$REPO_DIR/.env"

chown -R ec2-user:ec2-user "$REPO_DIR"
sudo -u ec2-user -H bash "$REPO_DIR/deploy/setup-ec2.sh"
