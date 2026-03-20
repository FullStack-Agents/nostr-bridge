import { SimplePool, nip04, nip19, getPublicKey, finalizeEvent, utils } from 'nostr-tools';
import 'websocket-polyfill'; // Required for nostr-tools in Node.js
import { randomUUID } from 'crypto';
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
const OPENCLAW_GATEWAY_BASE_URL = process.env.OPENCLAW_GATEWAY_BASE_URL || 'http://127.0.0.1:18789';
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN;
const OPENCLAW_POLL_INTERVAL_MS = Number.parseInt(process.env.OPENCLAW_POLL_INTERVAL_MS || '1500', 10);
const OPENCLAW_POLL_TIMEOUT_MS = Number.parseInt(process.env.OPENCLAW_POLL_TIMEOUT_MS || '60000', 10);

if (!OPENCLAW_GATEWAY_TOKEN) {
  throw new Error('OPENCLAW_GATEWAY_TOKEN is not set. Pass it in as the OPENCLAW_GATEWAY_TOKEN environment variable.');
}

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

    // Forward to OpenClaw and wait for the assistant reply.
    const replyText = await forwardToOpenClaw(event.pubkey, decryptedMessage);
    if (!replyText) {
      console.warn('[OUTBOUND] No assistant reply extracted from OpenClaw history');
      return;
    }

    await sendNostrReply(event.pubkey, replyText);
    
  } catch (error) {
    console.error(`[INBOUND] Failed to process event ${event.id}:`, error.message);
  }
}

async function forwardToOpenClaw(senderPubkey, text) {
  const requestId = randomUUID();
  const sessionKey = `hook:nostr:${senderPubkey}:${requestId}`;

  try {
    // Format payload for mapped OpenClaw /nostr/agent endpoint
    const payload = {
      message: text,
      senderPubkey,
      requestId
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

    const responseJson = await response.json();
    console.log(`[INBOUND] OpenClaw run accepted (runId=${responseJson.runId || 'unknown'})`);

    const replyText = await waitForOpenClawReply(sessionKey, responseJson.runId);
    if (!replyText) {
      throw new Error('Timed out waiting for assistant reply from OpenClaw');
    }

    return replyText;
    
  } catch (error) {
    console.error('[INBOUND] Failed to forward to OpenClaw:', error.message);
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractTextFromContent(content) {
  if (typeof content === 'string') {
    const text = content.trim();
    return text.length > 0 ? text : null;
  }

  if (Array.isArray(content)) {
    const parts = content
      .map((part) => (typeof part?.text === 'string' ? part.text.trim() : ''))
      .filter(Boolean);
    return parts.length > 0 ? parts.join('\n') : null;
  }

  return null;
}

function extractLatestAssistantReply(historyPayload) {
  const messages = Array.isArray(historyPayload?.messages)
    ? historyPayload.messages
    : Array.isArray(historyPayload?.items)
      ? historyPayload.items
      : [];

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'assistant') continue;

    const text = extractTextFromContent(message?.content);
    if (text) return text;
  }

  return null;
}

async function waitForOpenClawReply(sessionKey, runId) {
  const deadline = Date.now() + OPENCLAW_POLL_TIMEOUT_MS;
  const encodedSessionKey = encodeURIComponent(sessionKey);
  const historyUrl = `${OPENCLAW_GATEWAY_BASE_URL}/sessions/${encodedSessionKey}/history?limit=100`;

  while (Date.now() < deadline) {
    const response = await fetch(historyUrl, {
      headers: {
        'Authorization': `Bearer ${OPENCLAW_GATEWAY_TOKEN}`
      }
    });

    if (response.ok) {
      const payload = await response.json();
      const assistantReply = extractLatestAssistantReply(payload);
      if (assistantReply) {
        console.log(`[INBOUND] Retrieved OpenClaw reply for runId=${runId || 'unknown'}`);
        return assistantReply;
      }
    }

    await sleep(OPENCLAW_POLL_INTERVAL_MS);
  }

  return null;
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

startNostrListener().catch(console.error);
