# TalentBridge Agency

TalentBridge is a manpower and talent-sourcing platform for collecting company staffing requests, managing candidate profiles, reviewing matches, and tracking agency fees.

## Required Vercel environment variables

Configure these in **Vercel → Project → Settings → Environment Variables** before production deployment:

- `ADMIN_PASS`: a unique random secret of at least 20 characters. Store it as a **Sensitive** value for Preview and Production.
- `DATABASE_URL`: Neon Postgres connection string. The app checks connectivity during startup and fails closed for business writes if the database is unavailable.
- `PAYPAL_EMAIL`: optional business payment address for internal invoice records. Do not use a personal address unless that is intentional.

Redeploy after changing environment variables. Never commit secrets to GitHub or put them in public frontend code.

## Access and privacy

- Public visitors can browse agency-approved candidate profiles and submit a company manpower request.
- The admin dashboard, job-lead list, candidate creation, matching, invoice list, statistics and payment-status updates require a signed bearer token.
- Admin tokens are signed with `ADMIN_PASS` and expire after eight hours. Changing the secret invalidates previous tokens.
- Client contact information is only returned by the authenticated admin job-list endpoint. Do not expose contact email, phone, or exact location on public pages.
- Public request forms reject oversized or malformed data. All dynamic text rendered in the browser must be HTML-escaped.
- The prior demo seed candidates are being removed by an exact-match cleanup; real candidate rows with different identifying fields are not affected.

## Data and payments

- Company manpower requests are stored as leads until the agency contacts the requester and confirms details.
- Do not promise candidate availability before confirming consent, skills, identity, work eligibility and availability.
- “Mark Paid” is an internal bookkeeping action only. Confirm settlement with the relevant provider or bank first; the app does not itself collect or verify a real payment.
- The default agency fee is currently modeled as 22% in the matching code. Review and agree commercial terms with each client before using the platform for real placements.

## Before launch

- Verify Preview environment configuration and the database health endpoint.
- Set `ADMIN_PASS` in Production before merging/deploying the security branch.
- Test admin login, protected-route denial, company request submission, private lead viewing, candidate creation, matching and invoice updates.
- Confirm retention, privacy notice/consent, and Philippine recruitment/manpower licensing and employment requirements with a qualified professional before accepting real client/worker data.
- Do not use synthetic sample data as real candidates. Add genuine candidate profiles only with their consent.
