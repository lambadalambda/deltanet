# Integration Tests

DeltaNet keeps Dockerized Pleroma checks opt-in. Default commands such as `pnpm test`, `pnpm run test:e2e`, and `mise run test` only run mocked, deterministic Playwright tests.

## Backend Version

The integration stack builds a small local image from Pleroma's `stable` OTP release artifact for the `amd64` flavour and Postgres `16-alpine`. The expected Pleroma version for the current stable artifact is `2.10.2`.

The Pleroma image is currently amd64-only, so the compose file sets `platform: linux/amd64`. Docker Desktop on Apple Silicon can run it through emulation, but first startup can be slow while migrations run.

## Run

```sh
mise run test:integration
```

The task starts an ephemeral Docker Compose project, waits for `GET /api/v2/instance`, runs `playwright.integration.config.ts`, and then removes containers, networks, and volumes.

The default backend URL is `http://127.0.0.1:4400`. Override the host port when needed:

```sh
PLEROMANET_INTEGRATION_PORT=4401 mise run test:integration
```

## Debug

Run the compose stack manually if you need to inspect the backend before tests:

```sh
docker compose -f tests/integration/pleroma/compose.yaml -p pleromanet-integration up -d --wait --build
```

Inspect logs for the default project:

```sh
docker compose -f tests/integration/pleroma/compose.yaml -p pleromanet-integration logs -f pleroma
```

Run only the integration test suite against an already-running backend:

```sh
PLEROMANET_INTEGRATION_SKIP_DOCKER=1 \
PLEROMANET_INTEGRATION_INSTANCE_URL=http://127.0.0.1:4400 \
pnpm run test:integration
```

## Clean Up

The mise task cleans up automatically. If a run is interrupted or you started the stack manually, remove all integration containers and ephemeral test data with:

```sh
docker compose -f tests/integration/pleroma/compose.yaml -p pleromanet-integration down --volumes --remove-orphans
```
