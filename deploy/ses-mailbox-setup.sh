#!/usr/bin/env bash
# Sets up AWS SES for the ReachConvert mailbox (replies and delivery events).
#
#   ses-mailbox-setup.sh setup      verify domain, SNS topic, SES receipt rule
#   ses-mailbox-setup.sh subscribe  subscribe the API webhook to the topic
#                                   (save the domain and topic ARN in Settings first)
#   ses-mailbox-setup.sh upgrade    after the mailbox backend is deployed:
#                                   store replies in S3 (up to 40 MB instead of
#                                   150 KB) and publish delivery/bounce/complaint
#                                   events to the same topic
#   ses-mailbox-setup.sh status     show what is configured
#
# Override any of the values below with environment variables.
set -euo pipefail

AWS=${AWS:-$HOME/.local/bin/aws}
REGION=${REGION:-us-east-1}
DOMAIN=${DOMAIN:-reply.oswinalex.site}
PARENT_DOMAIN=${PARENT_DOMAIN:-oswinalex.site}
TOPIC_NAME=${TOPIC_NAME:-campaign-replies}
RULE_SET=${RULE_SET:-reachconvert}
RULE_NAME=${RULE_NAME:-campaign-replies}
CONFIG_SET=${CONFIG_SET:-reachconvert}
WEBHOOK=${WEBHOOK:-https://ag-2bf1312f8ce3453e8c76ca79e45a3f08.ecs.ap-south-1.on.aws/api/email-track/inbound}

aws_() { "$AWS" --region "$REGION" "$@"; }

ACCOUNT=$(aws_ sts get-caller-identity --query Account --output text)
TOPIC_ARN="arn:aws:sns:$REGION:$ACCOUNT:$TOPIC_NAME"
BUCKET=${BUCKET:-reachconvert-inbound-$ACCOUNT}

setup() {
  echo "== 1. Verify the reply domain in SES ($REGION)"
  if aws_ sesv2 get-email-identity --email-identity "$PARENT_DOMAIN" >/dev/null 2>&1; then
    echo "$PARENT_DOMAIN is an SES identity; it covers $DOMAIN"
  else
    aws_ sesv2 create-email-identity --email-identity "$DOMAIN" >/dev/null 2>&1 || true
    for t in $(aws_ sesv2 get-email-identity --email-identity "$DOMAIN" --query 'DkimAttributes.Tokens' --output text); do
      echo "  add CNAME  $t._domainkey.$DOMAIN -> $t.dkim.amazonses.com"
    done
  fi

  echo "== 2. SNS topic"
  aws_ sns create-topic --name "$TOPIC_NAME" >/dev/null
  aws_ sns set-topic-attributes --topic-arn "$TOPIC_ARN" --attribute-name Policy \
    --attribute-value "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"AllowSESPublish\",\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"ses.amazonaws.com\"},\"Action\":\"sns:Publish\",\"Resource\":\"$TOPIC_ARN\",\"Condition\":{\"StringEquals\":{\"AWS:SourceAccount\":\"$ACCOUNT\"}}}]}"
  echo "topic: $TOPIC_ARN"

  echo "== 3. Receipt rule (SNS action, UTF-8)"
  local active
  active=$(aws_ ses describe-active-receipt-rule-set --query Metadata.Name --output text 2>/dev/null || true)
  if [ -z "$active" ] || [ "$active" = "None" ]; then
    aws_ ses create-receipt-rule-set --rule-set-name "$RULE_SET" 2>/dev/null || true
    aws_ ses set-active-receipt-rule-set --rule-set-name "$RULE_SET"
    active=$RULE_SET
  fi
  local rule="{\"Name\":\"$RULE_NAME\",\"Enabled\":true,\"ScanEnabled\":true,\"TlsPolicy\":\"Optional\",\"Recipients\":[\"$DOMAIN\"],\"Actions\":[{\"SNSAction\":{\"TopicArn\":\"$TOPIC_ARN\",\"Encoding\":\"UTF-8\"}}]}"
  aws_ ses create-receipt-rule --rule-set-name "$active" --rule "$rule" 2>/dev/null ||
    aws_ ses update-receipt-rule --rule-set-name "$active" --rule "$rule"

  echo
  echo "Add an MX record:  ${DOMAIN%%.$PARENT_DOMAIN} -> inbound-smtp.$REGION.amazonaws.com (priority 10)"
  echo "In Settings > Reply tracking save: domain $DOMAIN, topic $TOPIC_ARN"
  echo "Then run: $0 subscribe"
}

subscribe() {
  aws_ sns subscribe --topic-arn "$TOPIC_ARN" --protocol https \
    --notification-endpoint "$WEBHOOK" --return-subscription-arn \
    --query SubscriptionArn --output text
  sleep 5
  status
}

upgrade() {
  echo "== 1. Private S3 bucket for received emails ($BUCKET)"
  aws_ s3api head-bucket --bucket "$BUCKET" 2>/dev/null || aws_ s3api create-bucket --bucket "$BUCKET" >/dev/null
  aws_ s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws_ s3api put-bucket-policy --bucket "$BUCKET" \
    --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"AllowSESPuts\",\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"ses.amazonaws.com\"},\"Action\":\"s3:PutObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/*\",\"Condition\":{\"StringEquals\":{\"AWS:SourceAccount\":\"$ACCOUNT\"}}}]}"
  # The app copies each email in when it arrives, so S3 only needs a short copy.
  aws_ s3api put-bucket-lifecycle-configuration --bucket "$BUCKET" \
    --lifecycle-configuration '{"Rules":[{"ID":"expire-inbound","Status":"Enabled","Filter":{"Prefix":""},"Expiration":{"Days":30}}]}'

  echo "== 2. Receipt rule: store in S3 and notify the topic"
  local active
  active=$(aws_ ses describe-active-receipt-rule-set --query Metadata.Name --output text)
  aws_ ses update-receipt-rule --rule-set-name "$active" \
    --rule "{\"Name\":\"$RULE_NAME\",\"Enabled\":true,\"ScanEnabled\":true,\"TlsPolicy\":\"Optional\",\"Recipients\":[\"$DOMAIN\"],\"Actions\":[{\"S3Action\":{\"BucketName\":\"$BUCKET\",\"TopicArn\":\"$TOPIC_ARN\"}}]}"

  echo "== 3. Configuration set $CONFIG_SET publishing delivery, bounce and complaint events"
  aws_ sesv2 create-configuration-set --configuration-set-name "$CONFIG_SET" >/dev/null 2>&1 || true
  aws_ sesv2 create-configuration-set-event-destination --configuration-set-name "$CONFIG_SET" \
    --event-destination-name to-reply-topic \
    --event-destination "{\"Enabled\":true,\"MatchingEventTypes\":[\"DELIVERY\",\"BOUNCE\",\"COMPLAINT\"],\"SnsDestination\":{\"TopicArn\":\"$TOPIC_ARN\"}}" \
    2>/dev/null || echo "event destination already exists"

  echo
  echo "Now in Settings > Reply tracking, set SES configuration set: $CONFIG_SET"
  echo "The SES keys saved in Settings need s3:GetObject on arn:aws:s3:::$BUCKET/*"
}

status() {
  echo "== Subscriptions on $TOPIC_ARN"
  aws_ sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" \
    --query 'Subscriptions[].{Endpoint:Endpoint,Arn:SubscriptionArn}' --output table
  echo "== Active receipt rules"
  aws_ ses describe-active-receipt-rule-set \
    --query 'Rules[].{Name:Name,Enabled:Enabled,Recipients:join(`,`,Recipients),Actions:join(`,`,Actions[].keys(@)[0])}' --output table
  echo "== Configuration set $CONFIG_SET"
  aws_ sesv2 get-configuration-set-event-destinations --configuration-set-name "$CONFIG_SET" \
    --query 'EventDestinations[].{Name:Name,Types:join(`,`,MatchingEventTypes)}' --output table 2>/dev/null ||
    echo "not created yet"
}

"${1:-setup}"
