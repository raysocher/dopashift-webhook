// api/tally-webhook.js
// CommonJS • Vercel Serverless
// Env required (Production): TALLY_SIGNING_SECRET, MAILERLITE_API_KEY, MAILERLITE_GROUP_ID
const crypto = require('crypto');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).json({ message: 'Webhook is live ✅, but use POST' });
  }

  const secret = process.env.TALLY_SIGNING_SECRET;
  const debug = process.env.DEBUG_TALLY === '1';

  try {
    if (!secret) {
      console.error('Missing TALLY_SIGNING_SECRET');
      return res.status(500).json({ error: 'Server not configured' });
    }

    // 1) Read RAW body exactly as Tally sent it
    const rawBuf = await readRawBody(req);
    const raw = rawBuf.toString('utf8');

    // 2) Verify Tally signature (header: "t=timestamp,v1=hex")
    const sigHeader = req.headers['tally-signature'];
    if (!verifyTallySignature(raw, sigHeader, secret)) {
      console.error('❌ Invalid Tally signature');
      if (debug) console.log('tally-signature:', sigHeader, 'rawPreview:', raw.slice(0, 150));
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // 3) Parse AFTER verifying
    const body = JSON.parse(raw);
    const fields = Array.isArray(body?.data?.fields) ? body.data.fields : [];

    // --- Extract values ---
    const email = getEmail(fields);
    const firstName = getFirstName(fields);
    let archetype = getArchetype(fields) || computeArchetypeFromScores(fields);

    if (debug) console.log({ email, firstName, archetype });

    // 4) If no email, return 200 (so Tally is green) but skip MailerLite
    if (!email) {
      console.warn('No email found in submission; skipping MailerLite.');
      return res.status(200).json({ ok: false, reason: 'missing_email', archetype });
    }

    // 5) Push to MailerLite
    const ML_API = process.env.MAILERLITE_API_KEY;
    const ML_GROUP = process.env.MAILERLITE_GROUP_ID;
    if (!ML_API || !ML_GROUP) {
      console.error('Missing MailerLite env vars');
      return res.status(500).json({ ok: false, error: 'MailerLite not configured' });
    }

    const endpoint = 'https://connect.mailerlite.com/api/subscribers';
    const payload = {
      email,
      fields: {
        name: firstName || undefined,
        archetype: archetype || undefined,
        source: 'tally'
      },
      groups: [ML_GROUP],
      resubscribe: true,
      autoresponders: true
    };

    const mlRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ML_API}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const text = await mlRes.text().catch(() => '');
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

    if (!mlRes.ok) {
      console.error('MailerLite error:', mlRes.status, data);
      // Still 200 so Tally doesn’t retry forever
      return res.status(200).json({ ok: false, mailerlite_status: mlRes.status, error: data });
    }

    return res.status(200).json({
      ok: true,
      subscribed: { email, group: ML_GROUP },
      mailerlite: data
    });
  } catch (e) {
    console.error('Webhook error:', e);
    return res.status(400).json({ ok: false, error: 'Handler error' });
  }
};

/* ----------------- Helpers ----------------- */

function readRawBody(req) {
  // Prefer rawBody if available, else reconstruct from stream
  if (req.rawBody) return Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody);
  if (typeof req.body === 'string') return Buffer.from(req.body);
  if (Buffer.isBuffer(req.body)) return req.body;

  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyTallySignature(raw, signatureHeader, secret) {
  if (!signatureHeader) return false;

  // Robustly parse "t=...,v1=..."
  const tMatch = /(?:^|,)\s*t=([^,]+)/.exec(signatureHeader);
  const vMatch = /(?:^|,)\s*v1=([a-f0-9]+)/i.exec(signatureHeader);
  if (!tMatch || !vMatch) return false;

  const t = tMatch[1].trim();
  const v1 = vMatch[1].trim();

  const expectedHex = crypto.createHmac('sha256', secret)
    .update(`${t}.${raw}`)
    .digest('hex');

  try {
    // Compare as binary buffers of equal length
    return crypto.timingSafeEqual(Buffer.from(v1, 'hex'), Buffer.from(expectedHex, 'hex'));
  } catch {
    return false;
  }
}

function getEmail(fields) {
  // Exact email input
  const t = fields.find(f => f.type === 'INPUT_EMAIL' && f.value);
  if (t) return String(t.value).trim();

  // Label containing "email"
  const byLabel = fields.find(f => /email/i.test(f.label || '') && f.value);
  if (byLabel) return String(byLabel.value).trim();

  // Payment block sometimes includes "Payment (email)"
  const payEmail = fields.find(f => f.type === 'PAYMENT' && /email/i.test(f.label || '') && f.value);
  if (payEmail) return String(payEmail.value).trim();

  // Text field that looks like an email
  const emailish = fields.find(f =>
    (f.type === 'INPUT_TEXT' || f.type === 'TEXTAREA') &&
    typeof f.value === 'string' &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.value)
  );
  if (emailish) return emailish.value.trim();

  return null;
}

function getFirstName(fields) {
  const names = ['First name', 'First Name', 'Vorname', 'Name', 'first_name', 'first name'];
  for (const n of names) {
    const f = fields.find(x => (x.label || '').toLowerCase() === n.toLowerCase() && x.value);
    if (f) return String(f.value).trim();
  }
  const payName = fields.find(f => f.type === 'PAYMENT' && /name/i.test(f.label || '') && f.value);
  if (payName) return String(payName.value).trim();
  return undefined;
}

function getArchetype(fields) {
  for (const k of ['Archetype', 'Type', 'Result']) {
    const f = fields.find(x => (x.label || '').toLowerCase() === k.toLowerCase() && x.value);
    if (f) return String(f.value).trim();
  }
  return undefined;
}

function computeArchetypeFromScores(fields) {
  // expects labels like score_scroller, score_binger, ...
  const map = {
    score_scroller: 'Scroller',
    score_binger: 'Binger',
    score_escapist: 'Escapist',
    score_juggler: 'Juggler',
    score_overthinker: 'Overthinker',
    score_chaser: 'Chaser',
    score_muted: 'Muted',
    score_none: 'None'
  };

  let bestKey = null;
  let bestVal = -Infinity;

  for (const f of fields) {
    const label = (f.label || '').toLowerCase();
    if (f.type === 'CALCULATED_FIELDS' && typeof f.value === 'number' && map[label]) {
      if (f.value > bestVal) {
        bestVal = f.value;
        bestKey = label;
      }
    }
  }
  return bestKey ? map[bestKey] : undefined;
}
