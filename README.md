# PetChef Dashboard

Internal revenue dashboard at `dashboard.petchef.co.in`. Pulls orders from Shopify into a local SQLite file, syncs every night at 02:30 IST, and has a **Sync now** button for anything newer.

No npm dependencies: Node 22 built-ins only (`http`, `node:sqlite`, `fetch`). Nothing to install, nothing to patch.

## What it shows (v1)
- Net revenue, ex-GST, orders, AOV, vs a comparison period (MTD compares with the same days last month)
- New-customer vs repeat revenue (first-ever order = new)
- COD share, cancellations
- Daily chart (new vs repeat), 13-month table
- **Customer Snapshot** tab: new vs returning customers, first vs repeat orders, orders by order number (1st…6th+); filter by day/week/month and all/prepaid/COD

Definitions are on the page under "How these numbers are calculated".

## Data stored
Order-level money, status, payment gateway, and the Shopify **customer ID only**. No names, phones, emails or addresses are ever written to disk.

---

## 1. Shopify app (Dev Dashboard)
1. Scopes on the app version: `read_orders`, `read_all_orders`, `read_customers` (needed only to read the customer ID on each order). `read_reports` is unused in v1 and can be removed.
2. Install the app on the PetChef store. The app and store must be in the same Shopify organization, or the token request fails.
3. Note the **Client ID**, **Client secret**, and the store's `xxx.myshopify.com` domain.

## 2. GitHub
1. Create a **private** repo, e.g. `petchef/petchef-dashboard`.
2. Push this folder:
   ```bash
   git remote add origin git@github.com:<you>/petchef-dashboard.git
   git push -u origin main
   ```

## 3. Coolify
1. **+ New Resource → Private Repository (with GitHub App)** → pick the repo, branch `main`.
2. Build pack: **Dockerfile**. Port: **3000**.
3. **Domains**: `https://dashboard.petchef.co.in`
4. **Persistent Storage → Add volume**: mount path `/data`. *Without this, every deploy wipes the database and triggers a full re-sync.*
5. **Environment variables** (mark secrets as secret):
   | Key | Value |
   |---|---|
   | `SHOPIFY_STORE_DOMAIN` | `xxx.myshopify.com` |
   | `SHOPIFY_CLIENT_ID` | from Dev Dashboard |
   | `SHOPIFY_CLIENT_SECRET` | from Dev Dashboard |
   | `DASHBOARD_PASSWORD` | 12+ chars |
   | `SESSION_SECRET` | output of `openssl rand -hex 32` |
6. Keep it at **1 replica**. The nightly sync runs inside the container.
7. Deploy. The first boot pulls full order history through a Shopify bulk export (a few minutes for ~3.5 years).

## 4. DNS
At your DNS provider, add an **A record**: `dashboard` → your Coolify server IP. If behind Cloudflare, use proxied mode with SSL "Full (strict)" or DNS-only. Coolify issues the HTTPS certificate automatically.

## Operating it
- **Sync now** pulls every order created *or changed* since the last sync, so refunds and cancellations on older orders are picked up.
- Full re-sync: `curl -X POST -H 'X-Requested-With: fetch' -H 'Content-Type: application/json' -d '{"full":true}' --cookie 'pc_session=…' https://dashboard.petchef.co.in/api/sync`, or delete the volume and redeploy.
- Logs: Coolify → the app → Logs. A failed sync shows as "Last sync failed" in the header (hover for the error).

## Optional env
| Key | Default | Use |
|---|---|---|
| `SYNC_AT_IST` | `02:30` | Nightly sync time |
| `COD_GATEWAY_REGEX` | `cod\|cash on delivery` | Adjust if COD runs through a checkout app with a different gateway name |
| `SHOPIFY_API_VERSION` | `2026-07` | Bump yearly |
| `SHOPIFY_ACCESS_TOKEN` | — | Use instead of client ID/secret if you have a legacy `shpat_` token |
| `SESSION_DAYS` | `30` | Login lifetime |

## Known limits
- Won't match Shopify Analytics to the rupee: Shopify books refunds on the refund date, this dashboard books them against the order date.
- COD orders that come back as RTO only leave the numbers once they're cancelled or refunded in Shopify.
- One shared password. Move to Google sign-in if more than the founding team needs access.
