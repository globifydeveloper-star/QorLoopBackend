# Architecture Decision Record (ADR) 005: Hosting, Subdomain Architecture & Provisioning Tool

- **Status:** Approved
- **Date:** 2026-10-26
- **Context:** Customer Instance Provisioning & Domain Routing
- **Base Domain:** `qorloop.globify.ae`
- **Options Evaluated:** Terraform / Pulumi vs. Docker Compose + Bash CLI Provisioner

## Context & Requirements
1. Customer isolation: Each customer receives an independent instance on its own subdomain (e.g. `dohafresh.qorloop.globify.ae` or `staging.qorloop.globify.ae`), with its own PostgreSQL database, storage volume, and isolated secrets.
2. Single-command provisioning: One command must create an instance, set up subdomain routing, obtain TLS certificates, initialize database migrations, create the tenant row, and send an Owner invitation.
3. Fast execution without cloud vendor lock-in.

## Decision
We select **Docker Compose + Caddy Reverse Proxy + Bash Provisioning CLI (`infra/provision.sh`)**.

## Rationale
- **Subdomain Routing & Automatic TLS:** Caddy automatically issues and renews Let's Encrypt / ZeroSSL TLS certificates on-demand for wildcard/subdomains under `*.qorloop.globify.ae`.
- **Reproducibility:** A bash provisioning script (`provision.sh <subdomain> <customer-name> <owner-email>`) clones the template compose stack, creates isolated database credentials, generates unique secrets, provisions local/S3 volume directories, executes `db:migrate`, seeds the tenant record, and triggers the owner invitation email.
- **Why not Terraform/Pulumi:** For Phase 1 single-host or multi-container VPS staging deployment, Terraform/Pulumi introduces excessive state-file management overhead. A parameterized shell script with Docker Compose provides the fastest, most reliable one-command experience.

## Subdomain & Tenant Mapping
- Base domain: `qorloop.globify.ae`
- Staging instance: `staging.qorloop.globify.ae`
- Customer subdomains: `<tenant>.qorloop.globify.ae`
- Local development: `<tenant>.localhost:4000` / `localhost:4000`
