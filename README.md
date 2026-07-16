# Finemark Tracking

Application source for the Finemark Tracking CRM/ERP platform.

## Structure
- `finemark-backend/` — Node / Express / TypeScript API (Postgres)
- `finemark-ui/`      — static HTML/JS admin frontend
- `finemark-portal/`  — customer self-service portal (OTP login)
- `finemark-app/`     — Laravel application
- `docker-compose.yml` — service orchestration

## Setup
1. Copy each service's `.env.example` to `.env` and fill in real values
   (Postgres, JWT, Microsoft Graph, SMS/WhatsApp, eTIMS, …).
2. `docker compose build && docker compose up -d`

> Secrets (`.env` files, private keys) are intentionally excluded from this repository.
