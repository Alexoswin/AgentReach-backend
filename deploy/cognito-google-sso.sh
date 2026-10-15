#!/usr/bin/env bash
# Connects Google sign-in to the ReachConvert Cognito user pool.
#
#   cognito-google-sso.sh google   ask for the Google OAuth client ID and secret
#                                  (the secret is read without echo), add Google
#                                  to the user pool and turn on the app client
#   cognito-google-sso.sh status   show the pool, provider and app client setup
#
# The Google OAuth client (Google Cloud console > APIs & Services > Credentials,
# type "Web application") needs:
#   Authorized JavaScript origin:  https://$DOMAIN
#   Authorized redirect URI:       https://$DOMAIN/oauth2/idpresponse
set -euo pipefail

AWS=${AWS:-$HOME/.local/bin/aws}
REGION=${REGION:-ap-south-1}
POOL_ID=${POOL_ID:-ap-south-1_LtIw3MfwZ}
CLIENT_ID=${CLIENT_ID:-2s32tm07mrvhfugpa5gl35uana}
DOMAIN=${DOMAIN:-reachconvert-auth.auth.ap-south-1.amazoncognito.com}

aws_() { "$AWS" --region "$REGION" "$@"; }

google() {
  read -r -p "Google OAuth client ID: " google_client_id
  read -r -s -p "Google OAuth client secret (hidden): " google_client_secret
  echo
  if [ -z "$google_client_id" ] || [ -z "$google_client_secret" ]; then
    echo "Both the client ID and the secret are required." >&2
    exit 1
  fi

  # The secret goes to the AWS CLI by file, never on the command line.
  umask 077
  details=$(mktemp)
  trap 'rm -f "$details"' EXIT
  jq -n --arg id "$google_client_id" --arg secret "$google_client_secret" \
    '{client_id: $id, client_secret: $secret, authorize_scopes: "openid email profile"}' > "$details"
  unset google_client_secret

  # Without email_verified mapped, Cognito treats every Google email as unverified.
  mapping='email=email,email_verified=email_verified,name=name,given_name=given_name,family_name=family_name,picture=picture,username=sub'

  echo "== Google identity provider"
  if aws_ cognito-idp describe-identity-provider --user-pool-id "$POOL_ID" --provider-name Google >/dev/null 2>&1; then
    aws_ cognito-idp update-identity-provider --user-pool-id "$POOL_ID" --provider-name Google \
      --provider-details "file://$details" --attribute-mapping "$mapping" >/dev/null
    echo "updated"
  else
    aws_ cognito-idp create-identity-provider --user-pool-id "$POOL_ID" --provider-name Google \
      --provider-type Google --provider-details "file://$details" --attribute-mapping "$mapping" >/dev/null
    echo "created"
  fi

  echo "== App client: authorization code + PKCE with Google only"
  # update-user-pool-client replaces the whole configuration, so send back
  # everything describe returned with only the OAuth settings changed.
  current=$(mktemp)
  trap 'rm -f "$details" "$current"' EXIT
  aws_ cognito-idp describe-user-pool-client --user-pool-id "$POOL_ID" --client-id "$CLIENT_ID" \
    --query UserPoolClient --output json |
    jq 'del(.ClientSecret, .CreationDate, .LastModifiedDate)
        | .AllowedOAuthFlowsUserPoolClient = true
        | .AllowedOAuthFlows = ["code"]
        | .AllowedOAuthScopes = ["openid", "email", "profile"]
        | .SupportedIdentityProviders = ["Google"]' > "$current"
  aws_ cognito-idp update-user-pool-client --cli-input-json "file://$current" >/dev/null
  echo "done"
  echo
  status
}

status() {
  echo "== User pool $POOL_ID"
  aws_ cognito-idp describe-user-pool --user-pool-id "$POOL_ID" \
    --query 'UserPool.{Name:Name,Tier:UserPoolTier,Users:EstimatedNumberOfUsers}' --output table
  echo "== Identity providers"
  aws_ cognito-idp list-identity-providers --user-pool-id "$POOL_ID" \
    --query 'Providers[].{Name:ProviderName,Type:ProviderType}' --output table
  echo "== App client $CLIENT_ID"
  aws_ cognito-idp describe-user-pool-client --user-pool-id "$POOL_ID" --client-id "$CLIENT_ID" \
    --query 'UserPoolClient.{OAuth:AllowedOAuthFlowsUserPoolClient,Flows:join(`,`,AllowedOAuthFlows || `[]`),Providers:join(`,`,SupportedIdentityProviders || `[]`),Callbacks:join(`", "`,CallbackURLs)}' \
    --output table
}

"${1:-status}"
