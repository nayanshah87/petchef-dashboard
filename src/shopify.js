// Shopify Admin GraphQL client.
// Auth: client credentials grant (Dev Dashboard app installed on your own store),
// so the app ID + secret are exchanged for a short-lived token that we refresh.
// If you instead have a legacy "shpat_" admin token, set SHOPIFY_ACCESS_TOKEN.

const SHOP = process.env.SHOPIFY_STORE_DOMAIN; // e.g. petchef.myshopify.com (NOT petchef.co.in)
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';
const BASE = process.env.SHOPIFY_BASE_URL || `https://${SHOP}`; // override only for local testing

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let cached = null;

function assertConfig() {
  if (!SHOP) throw new Error('SHOPIFY_STORE_DOMAIN is not set (use the xxx.myshopify.com domain)');
  if (!process.env.SHOPIFY_ACCESS_TOKEN && (!process.env.SHOPIFY_CLIENT_ID || !process.env.SHOPIFY_CLIENT_SECRET)) {
    throw new Error('Set SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET (or SHOPIFY_ACCESS_TOKEN)');
  }
}

async function getToken() {
  assertConfig();
  if (process.env.SHOPIFY_ACCESS_TOKEN) return process.env.SHOPIFY_ACCESS_TOKEN;
  if (cached && cached.expiresAt > Date.now() + 5 * 60 * 1000) return cached.token;

  const res = await fetch(`${BASE}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.SHOPIFY_CLIENT_ID,
      client_secret: process.env.SHOPIFY_CLIENT_SECRET,
    }),
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`Shopify token request failed (${res.status}): ${body}`);
  }
  const j = await res.json();
  cached = {
    token: j.access_token,
    scope: j.scope,
    expiresAt: Date.now() + (Number(j.expires_in) || 86399) * 1000,
  };
  return cached.token;
}

async function gql(query, variables = {}) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const token = await getToken();
    const res = await fetch(`${BASE}/admin/api/${API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
      body: JSON.stringify({ query, variables }),
    });

    if (res.status === 401) { cached = null; await sleep(1000); continue; }
    if (res.status === 429 || res.status >= 500) { await sleep(2000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`Shopify API ${res.status}: ${(await res.text()).slice(0, 300)}`);

    const j = await res.json();
    if (j.errors?.length) {
      if (j.errors.some((e) => e.extensions?.code === 'THROTTLED')) { await sleep(3000); continue; }
      throw new Error(`Shopify GraphQL: ${j.errors.map((e) => e.message).join('; ')}`);
    }
    // Stay well inside the rate-limit bucket.
    const t = j.extensions?.cost?.throttleStatus;
    if (t && t.currentlyAvailable < 300 && t.restoreRate) {
      await sleep(Math.ceil(((300 - t.currentlyAvailable) / t.restoreRate) * 1000));
    }
    return j.data;
  }
  throw new Error('Shopify API: gave up after repeated retries');
}

module.exports = { gql, getToken, sleep, tokenScope: () => cached?.scope ?? null };
