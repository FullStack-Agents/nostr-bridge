# Nostr OpenClaw Bridge

This service bridges encrypted Nostr direct messages (NIP-04) with an OpenClaw webhook.

- **Inbound:** listens for DMs sent to your bot account on Nostr relays and forwards them to OpenClaw.
- **Outbound:** exposes an HTTP endpoint for OpenClaw replies, encrypts each reply, and publishes it back to Nostr.

## How it works

1. The bridge subscribes to kind `4` events (`NIP-04` encrypted DMs) addressed to your bot pubkey.
2. Incoming DMs are decrypted with your private key.
3. Decrypted text is forwarded to OpenClaw with `userId = senderPubkey`.
4. OpenClaw sends response webhooks to `POST /outbound`.
5. The bridge encrypts that response for the target pubkey and publishes it to relays.

## Requirements

- Node.js 18+ (Node 22 recommended)
- A Nostr private key for the bot (`nsec...` or 64-char hex)
- An OpenClaw inbound webhook URL + token

## Installation

```bash
npm install
```

## Configuration

Copy the example file and update values:

```bash
cp .env-example .env
```

Environment variables:

- `NOSTR_PRIVKEY` (required): bot private key (`nsec...` or hex)
- `OPENCLAW_WEBHOOK_URL` (required): OpenClaw inbound webhook URL
- `OPENCLAW_WEBHOOK_TOKEN` (required): Bearer token for OpenClaw webhook
- `PORT` (optional): local HTTP port for outbound webhooks (default `4000`)
- `NOSTR_RELAYS` (optional): comma-separated relay URLs

Example:

```env
NOSTR_PRIVKEY=nsec1replace_with_your_real_nsec
OPENCLAW_WEBHOOK_URL=http://localhost:3000/api/webhook/YOUR_WEBHOOK_ID
OPENCLAW_WEBHOOK_TOKEN=YOUR_WEBHOOK_TOKEN
PORT=4000
NOSTR_RELAYS=wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band
```

## Run

```bash
npm start
```

When running, the app will:

- connect to configured relays
- start a local webhook server
- log inbound/outbound message activity

## OpenClaw outbound webhook setup

Configure OpenClaw to send outbound replies to:

`http://localhost:<PORT>/outbound`

Payload expected by this bridge:

```json
{
  "userId": "<recipient_pubkey>",
  "text": "Reply message"
}
```

If `userId` or `text` is missing, the bridge returns `400`.

## Notes

- `.env` is loaded automatically via `dotenv`.
- The bridge deduplicates incoming Nostr events to avoid duplicate forwards.
- Keep your private key secret and never commit `.env`.

## Troubleshooting

- **`NOSTR_PRIVKEY is not set`**: add it to `.env`.
- **Invalid key format**: ensure `NOSTR_PRIVKEY` is either `nsec...` or 64-char hex.
- **No inbound messages**: verify relay list, pubkey, and whether DMs are sent to the bot account.
- **Outbound not delivered**: confirm OpenClaw is posting to `/outbound` and payload includes `userId` and `text`.

