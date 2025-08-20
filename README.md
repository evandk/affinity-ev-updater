## Affinity EV Updater (Vercel webhook)

This project listens for Affinity webhook events and updates an "Expected Value (USD)" field using the Affinity v2 API.

- Incoming events: Affinity Webhooks (API v1)
- Compute: EV = midpoint(min, max) × likelihood%
- Write: Affinity v2 per-entry field update
- Hosting: Vercel Serverless Function

### Why this design
- **V1 for webhooks, V2 for data**: Affinity v2 doesn’t expose webhook management. Affinity v1 does. We subscribe with v1, then read/write data with v2.
- **Per-entry fetch avoids nulls**: The bulk list-entries endpoint may return null for list-level fields that are actually attached to entities (e.g., organization). Fetching per-entry `/v2/lists/{id}/list-entries/{entryId}/fields` reliably returns values that match the UI.
- **Serverless on Vercel**: Gives us an always-on HTTPS URL with minimal ops, easy env vars, and logs.

---

## Repository layout

- `api/affinity-ev.js`: Serverless handler (entry point)
- `package.json`: ESM + axios dependency
- `.gitignore`: Ignores `.env` and other local artifacts

Deploy is via GitHub (`evandk/affinity-ev-updater`). Vercel deploys on push.

---

## Configuration

### Environment variables (Vercel)
- **AFFINITY_V2_TOKEN**: Affinity v2 Bearer token. Required.
  - Set in Vercel project → Settings → Environment Variables.
  - Make sure it’s set for the environment you’re hitting (Production/Preview).

Notes:
- Do not store any secrets in repo. `.env` is ignored by `.gitignore`.
- If a token was ever exposed, rotate it.

### List and Field IDs
Set inside `api/affinity-ev.js`:
- `LIST_ID = 300305`
- `FID_MIN = 'field-5140816'` (Min Commitment USD)
- `FID_MAX = 'field-5140817'` (Max Commitment USD)
- `FID_P   = 'field-5150465'` (Likelihood %)
- `FID_EV  = 'field-5305096'` (Expected Value USD)

Update these if you move to a different list or fields.

---

## Webhook subscription (Affinity API v1)

Use an Affinity v1 API key (Basic Auth), not your v2 token.

1) Verify your v1 key
```bash
curl "https://api.affinity.co/auth/whoami" -u :$AFFINITY_V1_API_KEY
```

2) Create the subscription (quote `subscriptions[]` to avoid zsh globbing)
```bash
curl -X POST 'https://api.affinity.co/webhook/subscribe' \
  -u :$AFFINITY_V1_API_KEY \
  -d 'webhook_url=https://affinity-ev-updater.vercel.app/api/affinity-ev' \
  -d 'subscriptions[]=field_value.created' \
  -d 'subscriptions[]=field_value.updated'
```

3) List / Delete
```bash
# List
curl 'https://api.affinity.co/webhook' -u :$AFFINITY_V1_API_KEY

# Delete one
curl -X DELETE 'https://api.affinity.co/webhook/<webhook_id>' -u :$AFFINITY_V1_API_KEY
```

Important:
- v1 subscriptions are instance-wide. We filter inside the function to only act on `list_id = 300305` and the relevant fields.

---

## EV calculation

- **Formula**: `EV = midpoint(min, max) × (likelihood / 100)`
  - midpoint(min, max) = `(min + max) / 2`; if only one bound is present, use that.
- **Units**: Likelihood is a percentage (e.g., 60 = 60%).
- **Rounding**: We round to nearest integer dollar.
- **Zero-as-missing rule**: If exactly one bound is zero and the other is > 0, we treat the zero as missing and use the non-zero bound. This avoids averaging a real bound with zero when zero actually means “unset”. See `ZERO_AS_MISSING` in code.

---

## How the function works

Path: `api/affinity-ev.js`

1) Parse the webhook body robustly:
   - Supports JSON, Buffer body, and `application/x-www-form-urlencoded`.
   - Handles Affinity v1 envelope shape `{ type, body: {...} }` and direct JSON.
2) Filter to our list: `list_id == 300305`.
3) Per-entry GET (v2): `/v2/lists/{LIST_ID}/list-entries/{listEntryId}/fields`
4) Compute EV from Min/Max/Likelihood.
5) POST EV (v2): `/v2/lists/{LIST_ID}/list-entries/{listEntryId}/fields/{FID_EV}` with `{ value: { type: 'number', data: ev } }`.
6) Verify by GET with a short retry (eventual consistency).

Why per-entry: bulk pages can return null for fields not set in the current list context, even if visible in the UI. Per-entry returns what the UI shows.

---

## Testing

Quick ping (should skip):
```bash
curl -s -X POST https://affinity-ev-updater.vercel.app/api/affinity-ev \
  -H "Content-Type: application/json" \
  -d '{"ping":true}'
```

Real test for a known entry:
```bash
curl -s -X POST https://affinity-ev-updater.vercel.app/api/affinity-ev \
  -H "Content-Type: application/json" \
  -d '{"list_entry_id":215745884,"field":{"list_id":300305}}'
```

Read-back verification (v2):
```bash
curl -s -H "Authorization: Bearer $AFFINITY_V2_TOKEN" \
  "https://api.affinity.co/v2/lists/300305/list-entries/215745884/fields" \
| jq '.data[] | select(.id=="field-5305096")'
```

Vercel logs: Vercel → Project → Functions → Logs.

---

## Common pitfalls and fixes

- **Using v2 token for v1 API**: v1 webhooks use Basic Auth with a v1 API key. v2 uses Bearer tokens.
- **Zsh eats `subscriptions[]`**: Quote or escape `subscriptions[]` in curl.
- **Event body shape**: Affinity v1 sends `{ type, body: {...} }`. We parse both that and direct JSON.
- **Nulls from bulk endpoints**: Use per-entry field GET to match UI values.
- **Likelihood 0%**: EV will be 0; that’s expected even on success.
- **Eventual consistency**: The verify step retries briefly; UI may lag a few seconds.
- **Env var name is case-sensitive**: `AFFINITY_V2_TOKEN` must match exactly in Vercel.
- **Different list**: We ignore events where `list_id !== 300305`.
- **Permissions/403/401**: Ensure the v2 token has rights to that list and fields; confirm tenant with `auth/whoami`.

---

## Extending to other automations

- Copy the pattern: per-entry fetch → compute → write.
- Add new fields/logic inside `api/affinity-ev.js` or a new function file (e.g., `api/another-automation.js`).
- For batch jobs (backfills), prefer a separate Node script that pages entries, per-entry fetches, computes, and writes with throttling.

---

## Security

- Do not commit secrets. Keep tokens in Vercel env vars. `.env` is ignored.
- Rotate tokens if they were ever displayed publicly.

---

## Support checklist

- [ ] Vercel env `AFFINITY_V2_TOKEN` set (Production)
- [ ] Webhook (v1) subscribed to `field_value.created` and `field_value.updated`
- [ ] List and Field IDs updated if needed
- [ ] Test curl returns `{ ok: true, ... }`
- [ ] Logs show no 4xx/5xx from Affinity v2
