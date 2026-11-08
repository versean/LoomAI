#!/usr/bin/env bash
# Creates (or updates) the whole AWS setup from deploy/aws/stack.yaml and installs the committed code on it.
# Run from your laptop with AWS credentials loaded:  bash deploy/aws/deploy.sh   (safe to re-run)
# OPEN_SIGNUP=true lets anyone start their own team without the bootstrap secret (how the hosted one runs).
# Takes ~15 minutes the first time (the database and CloudFront are the slow parts), ~2 minutes after.
set -euo pipefail

cd "$(dirname "$0")/../.."
STACK=${STACK:-daddy-full}
OPEN_SIGNUP=${OPEN_SIGNUP:-false}
export AWS_REGION=${AWS_REGION:-us-east-1} AWS_PAGER=""

aws sts get-caller-identity --query Arn --output text >/dev/null \
  || { echo "AWS credentials are missing or expired. Copy fresh ones from the event page." >&2; exit 1; }
[[ -z $(git status --porcelain) ]] || echo "Note: only committed changes are deployed (git archive HEAD)."

# Shared between CloudFront and the load balancer; kept on this laptop only (data/ is gitignored).
ORIGIN_SECRET_FILE=data/aws/$STACK-origin-secret
if [[ ! -s $ORIGIN_SECRET_FILE ]]; then
  mkdir -p "$(dirname "$ORIGIN_SECRET_FILE")"
  (umask 077; openssl rand -hex 24 > "$ORIGIN_SECRET_FILE")
fi
PREFIX_LIST=$(aws ec2 describe-managed-prefix-lists \
  --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing \
  --query 'PrefixLists[0].PrefixListId' --output text)

echo "1/4  Creating or updating stack $STACK in $AWS_REGION (first run ~15 min)..."
aws cloudformation deploy --stack-name "$STACK" --template-file deploy/aws/stack.yaml \
  --capabilities CAPABILITY_NAMED_IAM --no-fail-on-empty-changeset \
  --parameter-overrides "OriginSecret=$(cat "$ORIGIN_SECRET_FILE")" "CloudFrontPrefixList=$PREFIX_LIST"

output() {
  aws cloudformation describe-stacks --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}
URL=$(output Url) BUCKET=$(output BucketName) DB_ENDPOINT=$(output DbEndpoint)
DB_SECRET_ARN=$(output DbSecretArn) BOOTSTRAP_SECRET_ARN=$(output BootstrapSecretArn) INSTANCE=$(output InstanceId)

echo "2/4  Uploading the code to s3://$BUCKET/releases/..."
ARCHIVE=$(mktemp -t loom-ai).tar.gz
git archive --format=tar.gz -o "$ARCHIVE" HEAD
aws s3 cp "$ARCHIVE" "s3://$BUCKET/releases/loom-ai.tar.gz" --only-show-errors
rm -f "$ARCHIVE"

echo "3/4  Installing on $INSTANCE through SSM (no SSH needed)..."
for _ in $(seq 1 60); do
  [[ $(aws ssm describe-instance-information --filters "Key=InstanceIds,Values=$INSTANCE" \
        --query 'InstanceInformationList[0].PingStatus' --output text) == Online ]] && break
  sleep 5
done
APP=/home/ec2-user/loom-ai
CMD="set -e; aws s3 cp s3://$BUCKET/releases/loom-ai.tar.gz /tmp/loom-ai.tar.gz --region $AWS_REGION --only-show-errors; mkdir -p $APP; tar -xzf /tmp/loom-ai.tar.gz -C $APP; bash $APP/deploy/aws/install.sh $AWS_REGION $BUCKET $DB_ENDPOINT $DB_SECRET_ARN $BOOTSTRAP_SECRET_ARN $OPEN_SIGNUP"
COMMAND_ID=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --comment "Install Loom AI" --parameters "{\"commands\":[\"$CMD\"]}" \
  --query Command.CommandId --output text)
STATUS=Pending
while [[ $STATUS == Pending || $STATUS == InProgress || $STATUS == Delayed ]]; do
  sleep 5
  STATUS=$(aws ssm get-command-invocation --command-id "$COMMAND_ID" --instance-id "$INSTANCE" \
    --query Status --output text 2>/dev/null || echo Pending)
done
aws ssm get-command-invocation --command-id "$COMMAND_ID" --instance-id "$INSTANCE" \
  --query '[StandardOutputContent, StandardErrorContent]' --output text
[[ $STATUS == Success ]] || { echo "Install failed ($STATUS)." >&2; exit 1; }

echo "4/4  Checking $URL/api/health ..."
for _ in $(seq 1 30); do
  if health=$(curl -fsS "$URL/api/health" 2>/dev/null); then
    echo "Loom AI is live at $URL : $health"
    echo
    [[ $OPEN_SIGNUP == true ]] && echo "Open sign-up is on: anyone can start a team with  loom init --server $URL"
    echo "Create the team (prints nothing secret):"
    echo "  uv run loom init --server $URL --secret \"\$(aws secretsmanager get-secret-value --region $AWS_REGION --secret-id $BOOTSTRAP_SECRET_ARN --query SecretString --output text)\""
    exit 0
  fi
  sleep 10
done
echo "The server installed but $URL/api/health does not answer yet; check the target group health in the EC2 console." >&2
exit 1
