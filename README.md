# TalentBridge Agency

Talent sourcing and manpower placement platform with candidate matching, job requests, invoicing, and agency commission tracking.

## Required Vercel environment variables

Configure these in **Vercel → Project → Settings → Environment Variables** before deploying:

- `ADMIN_PASS`: a long, unique admin password (do not reuse a password from another service).
- `DATABASE_URL`: Neon Postgres connection string. Without this, the app cannot provide durable storage; configure a database before accepting real client or worker data.
- `PAYPAL_EMAIL`: optional business payment address only. Do not use a personal address unless you intentionally want it displayed on invoices.

After adding or changing variables, redeploy the project.

## Admin access

The admin login uses `ADMIN_PASS` from the deployment environment. There is no default password in the source code. Admin sessions expire after eight hours. Protected routes require the bearer token returned by `/api/login`.

## Before launch

- Confirm the database is connected and data persists across restarts.
- Use only verified candidate profiles and real, consented client requests.
- Review local employment, recruitment, privacy, and placement-fee requirements before charging clients or workers.
- Never treat a displayed invoice or manually marked payment as proof that a payment provider has settled funds.
