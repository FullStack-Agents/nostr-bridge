import { SimplePool, nip04, nip19, getPublicKey, finalizeEvent, utils } from 'nostr-tools';
import 'websocket-polyfill'; // Required for nostr-tools in Node.js
import http from 'http';
import dotenv from 'dotenv';

dotenv.config();

// ==========================================
// Configuration
// ==========================================

// Your bot's Nostr private key (hex format)
const NOSTR_PRIVKEY_INPUT = process.env.NOSTR_PRIVKEY;

if(!NOSTR_PRIVKEY_INPUT) {
  throw new Error('NOSTR_PRIVKEY is not set. Pass it in as the NOSTR_PRIVKEY environment variable.');
}

// The relays to connect to
const RELAYS = (process.env.NOSTR_RELAYS || 'wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band')
  .split(',')
  .map(relay => relay.trim())
  .filter(Boolean);

// OpenClaw Inbound Webhook (Where we send messages FROM Nostr)
const OPENCLAW_WEBHOOK_URL = process.env.OPENCLAW_WEBHOOK_URL || 'http://127.0.0.1:18789/nostr/agent';
const OPENCLAW_WEBHOOK_TOKEN = process.env.OPENCLAW_WEBHOOK_TOKEN || 'YOUR_WEBHOOK_TOKEN';
const OPENCLAW_SESSION_TARGET = process.env.OPENCLAW_SESSION_TARGET || 'isolated';

// Local Server Port (Where we receive replies FROM OpenClaw)
const LOCAL_PORT = Number.parseInt(process.env.PORT || '4000', 10);
const OPENCLAW_OUTBOUND_WEBHOOK_URL = process.env.OPENCLAW_OUTBOUND_WEBHOOK_URL
  || `http://127.0.0.1:${LOCAL_PORT}/outbound`;

// ==========================================
// Initialization
// ==========================================

function parsePrivateKey(privateKeyInput) {
  const trimmedKey = privateKeyInput.trim();

  if (trimmedKey.startsWith('nsec1')) {
    const decoded = nip19.decode(trimmedKey);
    if (decoded.type !== 'nsec') {
      throw new Error('NOSTR_PRIVKEY is not a valid nsec key');
    }
    return decoded.data;
  }

  if (/^[a-fA-F0-9]{64}$/.test(trimmedKey)) {
    return utils.hexToBytes(trimmedKey);
  }

  throw new Error('NOSTR_PRIVKEY must be a 64-char hex string or an nsec key');
}

const NOSTR_PRIVKEY = parsePrivateKey(NOSTR_PRIVKEY_INPUT);
const pubkey = getPublicKey(NOSTR_PRIVKEY);
console.log(`Starting bidirectional Nostr bridge for pubkey: ${pubkey}`);

const pool = new SimplePool();

// Keep track of processed event IDs to avoid duplicates
const processedEvents = new Set();

// ==========================================
// 1. Inbound: Listen to Nostr & Forward to OpenClaw
// ==========================================

async function startNostrListener() {
  // Subscribe to NIP-04 Encrypted Direct Messages (kind 4) sent to our pubkey
  const sub = pool.subscribeMany(
    RELAYS,
    {
      kinds: [4],
      '#p': [pubkey],
      since: Math.floor(Date.now() / 1000) // Only listen for new messages
    },
    {
      onevent(event) {
        handleNostrEvent(event);
      },
      oneose() {
        console.log('Connected to relays and listening for inbound DMs...');
      }
    }
  );

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('Shutting down...');
    sub.close();
    pool.close(RELAYS);
    process.exit(0);
  });
}

async function handleNostrEvent(event) {
  // Deduplicate events (relays might send the same event multiple times)
  if (processedEvents.has(event.id)) return;
  processedEvents.add(event.id);
  
  // Keep the set from growing infinitely
  if (processedEvents.size > 1000) {
    const iterator = processedEvents.values();
    processedEvents.delete(iterator.next().value);
  }

  try {
    // Decrypt the NIP-04 message
    const decryptedMessage = await nip04.decrypt(NOSTR_PRIVKEY, event.pubkey, event.content);
    
    console.log(`[INBOUND] Received DM from ${event.pubkey.substring(0, 8)}...: ${decryptedMessage}`);

    // Forward to OpenClaw Webhook
    await forwardToOpenClaw(event.pubkey, decryptedMessage);
    
  } catch (error) {
    console.error(`[INBOUND] Failed to process event ${event.id}:`, error.message);
  }
}

async function forwardToOpenClaw(senderPubkey, text) {
  try {
    // Format payload for OpenClaw /nostr/agent endpoint
    const payload = {
      message: text,
      sessionTarget: OPENCLAW_SESSION_TARGET,
      delivery: {
        mode: 'webhook',
        to: OPENCLAW_OUTBOUND_WEBHOOK_URL
      },
      metadata: {
        source: 'nostr',
        senderPubkey
      }
    };

    const response = await fetch(OPENCLAW_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OpenClaw-Token': OPENCLAW_WEBHOOK_TOKEN
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenClaw responded with ${response.status}: ${errorText}`);
    }

    const responseBody = await response.text();
    console.log(`[INBOUND] Successfully forwarded message to OpenClaw: ${responseBody}`);
    
  } catch (error) {
    console.error('[INBOUND] Failed to forward to OpenClaw:', error.message);
  }
}

function extractTargetPubkey(payload) {
  const candidates = [
    payload?.userId,
    payload?.targetPubkey,
    payload?.pubkey,
    payload?.metadata?.senderPubkey,
    payload?.metadata?.targetPubkey,
    payload?.context?.senderPubkey,
    payload?.context?.targetPubkey,
    payload?.request?.metadata?.senderPubkey,
    payload?.request?.metadata?.targetPubkey
  ];

  return candidates.find((value) => typeof value === 'string' && /^[a-fA-F0-9]{64}$/.test(value));
}

function extractReplyText(payload) {
  const candidates = [
    payload?.text,
    payload?.message,
    payload?.reply,
    payload?.output,
    payload?.content,
    payload?.result?.text,
    payload?.result?.message,
    payload?.data?.text,
    payload?.data?.message
  ];

  return candidates.find((value) => typeof value === 'string' && value.trim().length > 0);
}

// ==========================================
// 2. Outbound: Listen to OpenClaw & Publish to Nostr
// ==========================================

async function sendNostrReply(targetPubkey, text) {
  try {
    // Encrypt the reply using NIP-04
    const encryptedContent = await nip04.encrypt(NOSTR_PRIVKEY, targetPubkey, text);

    // Construct the event
    const eventTemplate = {
      kind: 4,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', targetPubkey]],
      content: encryptedContent,
    };

    // Sign and finalize the event (id, pubkey, sig)
    const event = finalizeEvent(eventTemplate, NOSTR_PRIVKEY);

    console.log(`[OUTBOUND] Publishing reply to ${targetPubkey.substring(0, 8)}...`);

    // Publish to all configured relays
    const pubs = pool.publish(RELAYS, event);
    
    // Wait for at least one relay to accept it
    await Promise.any(pubs);
    console.log(`[OUTBOUND] Reply successfully published to relays`);

  } catch (error) {
    console.error('[OUTBOUND] Failed to send Nostr reply:', error.message);
  }
}

// Create a simple HTTP server to receive webhooks from OpenClaw
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/outbound') {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        
        const targetPubkey = extractTargetPubkey(payload);
        const replyText = extractReplyText(payload);

        if (!targetPubkey || !replyText) {
          res.writeHead(400);
          res.end('Missing target pubkey or reply text');
          return;
        }

        // Send the reply back to Nostr asynchronously
        sendNostrReply(targetPubkey, replyText);

        // Acknowledge receipt to OpenClaw immediately
        res.writeHead(200);
        res.end('OK');
        
      } catch (error) {
        console.error('[OUTBOUND] Failed to parse OpenClaw webhook:', error.message);
        res.writeHead(400);
        res.end('Invalid JSON');
      }
    });
  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

// ==========================================
// Start Everything
// ==========================================

startNostrListener().catch(console.error);

server.listen(LOCAL_PORT, () => {
  console.log(`Local webhook server listening on port ${LOCAL_PORT} for OpenClaw replies`);
  console.log(`Configured OpenClaw outbound webhook callback: ${OPENCLAW_OUTBOUND_WEBHOOK_URL}`);
});
