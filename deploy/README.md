# ECS Express Mode deployment

The workflow at `.github/workflows/deploy-ecs-express.yml` builds this backend,
pushes it to Amazon ECR, and creates or updates an Amazon ECS Express Mode
service.

Configure these GitHub settings before running the workflow manually from the
`main` branch:

## Repository variables

- `AWS_REGION` — for example `us-east-1`
- `ECR_REPOSITORY` — defaults to `agentreach-backend`
- `ECS_SERVICE_NAME` — defaults to `agentreach-backend`
- `ECS_CLUSTER` — defaults to `default`
- `ECS_SERVICE_ARN` — leave empty for the first deployment, then save the ARN returned by AWS

## Repository secrets

- `AWS_DEPLOY_ROLE_ARN` — GitHub OIDC deployment role
- `ECS_EXECUTION_ROLE_ARN` — ECS task execution role
- `ECS_INFRASTRUCTURE_ROLE_ARN` — ECS Express Mode infrastructure role
- `ECS_TASK_ROLE_ARN` — optional role used by the application when calling AWS APIs
- `ECS_ENV_JSON` — non-sensitive environment array, for example:

```json
[
  {"name":"NODE_ENV","value":"production"},
  {"name":"CORS_ORIGINS","value":"https://www.example.com"},
  {"name":"PUBLIC_API_URL","value":"https://api.example.com"}
]
```

- `ECS_SECRETS_JSON` — Secrets Manager or SSM references, for example:

```json
[
  {"name":"DATABASE_URL","valueFrom":"arn:aws:secretsmanager:us-east-1:123456789012:secret:agentreach/database"},
  {"name":"JWT_SECRET","valueFrom":"arn:aws:secretsmanager:us-east-1:123456789012:secret:agentreach/jwt"}
]
```

The ECS execution role must be allowed to read the referenced secrets. The
service listens on container port `8080` and uses `/api` as its health check.

After the first deployment, set the frontend build variable:

```env
NEXT_PUBLIC_ECS_API_URL=https://<ecs-service-url>/api
```

The frontend keeps using the primary `/api` proxy and switches to this URL
when the primary backend cannot be reached. For direct cross-origin fallback,
the ECS backend must include the frontend origin in `CORS_ORIGINS`; using a
shared custom API domain is recommended so session cookies remain consistent.
