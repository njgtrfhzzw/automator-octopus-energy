# automator-octopus-energy 🔌

A Cloudflare Worker that automatically joins [Octopus Energy Saving Sessions](https://octopus.energy/saving-sessions/) so you never miss one. Runs every hour via cron.

## How It Works

```
Cron (hourly) → Get sessions → Filter old/stale → Check KV dedup → Join → Email you
```

- Queries `savingSessions` from the Octopus backend GraphQL API
- Skips events older than 5 days
- Skips events already joined (checked via KV and API)
- Handles ineligible accounts gracefully (records in KV, no retries)
- Sends success/error emails via AWS SES (optional — skipped if no creds)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mrdanielmitchell/automator-octopus-energy)

## Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/)
- An [Octopus Energy API key](https://octopus.energy/dashboard/developer/)
- (Optional) AWS SES credentials for email notifications

## Setup

### 1. Click Deploy

Click the **Deploy to Cloudflare** button above, or clone and deploy manually:

```bash
git clone https://github.com/mrdanielmitchell/automator-octopus-energy.git
cd automator-octopus-energy
npm install
```

### 2. Create KV Namespace

```bash
npx wrangler kv namespace create JOINED_SESSIONS
```

Copy the returned ID into `wrangler.jsonc` → `kv_namespaces[0].id`.

### 3. Configure AWS Region (Optional)

Edit `wrangler.jsonc` if you need a different AWS region:

```jsonc
"vars": {
  "AWS_REGION": "eu-west-1"
}
```

### 4. Set Secrets

```bash
# Required
npx wrangler secret put OCTOPUS_API_KEY
npx wrangler secret put ACCOUNT_NUMBER
npx wrangler secret put EMAIL_FROM
npx wrangler secret put EMAIL_TO

# Optional — omit to skip email notifications
npx wrangler secret put AWS_ACCESS_KEY_ID
npx wrangler secret put AWS_SECRET_ACCESS_KEY
```

| Secret | Description |
|--------|-------------|
| `OCTOPUS_API_KEY` | Your Octopus Energy API key |
| `ACCOUNT_NUMBER` | Your Octopus account number (e.g. `A-XXXXXXXX`) |
| `EMAIL_FROM` | Sender address for notification emails |
| `EMAIL_TO` | Recipient for notification emails |
| `AWS_ACCESS_KEY_ID` | (optional) AWS SES access key |
| `AWS_SECRET_ACCESS_KEY` | (optional) AWS SES secret key |

### 5. Deploy

```bash
npx wrangler deploy
```

## Manual Testing

Once deployed, trigger a run manually:

```bash
curl https://automator-octopus-energy.YOUR_SUBDOMAIN.workers.dev/trigger
```

Check the Cloudflare dashboard → Workers → Logs for output.

## Project Structure

```
src/
├── index.ts      # Cron handler + HTTP trigger
├── octopus.ts    # Octopus Energy GraphQL client
├── email.ts      # AWS SES (Signature V4) sender
└── types.ts      # TypeScript types + Env bindings
wrangler.jsonc    # Worker config (vars, KV, cron, secrets)
```

## License

MIT
