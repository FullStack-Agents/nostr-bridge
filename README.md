# Nostr OpenClaw Bridge

This service bridges encrypted Nostr direct messages (NIP-04) with an OpenClaw webhook.

- **Inbound:** listens for DMs sent to your bot account on Nostr relays and forwards them to OpenClaw.
- **Outbound:** exposes an HTTP endpoint for OpenClaw replies, encrypts each reply, and publishes it back to Nostr.

## How it works

1. The bridge subscribes to kind `4` events (`NIP-04` encrypted DMs) addressed to your bot pubkey.
2. Incoming DMs are decrypted with your private key.
3. Decrypted text is forwarded to OpenClaw's `/nostr/agent` endpoint.
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
- `OPENCLAW_WEBHOOK_TOKEN` (required): token sent as `X-OpenClaw-Token`
- `OPENCLAW_SESSION_TARGET` (optional): OpenClaw session target value (default `isolated`)
- `OPENCLAW_OUTBOUND_WEBHOOK_URL` (optional): callback URL OpenClaw should deliver to (default `http://127.0.0.1:<PORT>/outbound`)
- `PORT` (optional): local HTTP port for outbound webhooks (default `4000`)
- `NOSTR_RELAYS` (optional): comma-separated relay URLs

Example:

```env
NOSTR_PRIVKEY=nsec1replace_with_your_real_nsec
OPENCLAW_WEBHOOK_URL=http://127.0.0.1:18789/nostr/agent
OPENCLAW_WEBHOOK_TOKEN=YOUR_WEBHOOK_TOKEN
OPENCLAW_SESSION_TARGET=isolated
OPENCLAW_OUTBOUND_WEBHOOK_URL=http://127.0.0.1:4000/outbound
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

The bridge asks OpenClaw to send outbound replies to:

`OPENCLAW_OUTBOUND_WEBHOOK_URL` (defaults to `http://127.0.0.1:<PORT>/outbound`)

Outbound payload parsing is flexible and supports multiple common keys.
At minimum, the payload must include:

```json
{
  "text": "Reply message",
  "metadata": {
    "senderPubkey": "<64-char-hex-pubkey>"
  }
}
```

If no target pubkey or reply text can be extracted, the bridge returns `400`.

## Notes

- `.env` is loaded automatically via `dotenv`.
- The bridge deduplicates incoming Nostr events to avoid duplicate forwards.
- Keep your private key secret and never commit `.env`.

## Troubleshooting

- **`NOSTR_PRIVKEY is not set`**: add it to `.env`.
- **Invalid key format**: ensure `NOSTR_PRIVKEY` is either `nsec...` or 64-char hex.
- **No inbound messages**: verify relay list, pubkey, and whether DMs are sent to the bot account.
- **Outbound not delivered**: confirm OpenClaw is posting to `OPENCLAW_OUTBOUND_WEBHOOK_URL` and includes text + sender pubkey metadata.

