// api/tally-webhook.js (CommonJS, raw-body verification)
const crypto = require('crypto');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).json({ message: "Webhook is live ✅, but use POST" });
  }

  const secret = process.env.TALLY_SIGNING_SECRET;
  const skipVerify = process.env.SKIP_TALLY_VERIFY === '1'; // optional bypass

  try {
    // 1) Read RAW body as sent by Tally
    const rawBuf = await readRawBody(req);
    const raw = rawBuf.toString('utf8');

    // 2) Verify signature (unless bypassed)
    if (secret && !skipVerify) {
      const ok = verifyTallySignature(raw, req.headers['tally-signature'], secret);
      if (!ok) {
        console.error('❌ Invalid Tally signature');
        return res.status(401).json({ error: 'Invalid signature' });
      }
    }

    // 3) Parse JSON only AFTER verification
    const body = JSON.parse(raw);
    const fields = body?.data?.fields || [];

    const byLabel = (label) =>
      fields.find(x => (x.label || '').toLowerCase() === label.toLowerCase())?.value ?? null;
    const firstOfType = (type) =>
      fields.find(x => x.type === type)?.value ?? null;

    const email =
      byLabel('Email') || firstOfType('INPUT_EMAIL') || firstOfType('EMAIL') || null;

    const firstName =
      byLabel('First name') || byLabel('First Name') || byLabel('Name') || firstOfType('INPUT_TEXT') || undefined;

    const archetype =
      byLabel('Archetype') || byLabel('Type') || byLabel('Result') || firstOfType('CALCULATED_FIELDS') || undefined;

    if (!email) {
      console.error('Missing email in payload');
      return res.status(400).json({ ok: false, error: 'Missing email' });
    }

    // ---- MailerLite ----
    const ML_API = process.env.MAILERLITE_API_KEY;
    const ML_GROUP = process.env.MAILERLITE_GROUP_ID;
    if (!ML_API || !ML_GROUP) {
      console.error('Missing MailerLite env vars');
      return res.status(500).json({ ok: false, error: 'MailerLite not configured' });
    }

    const endpoint = 'https://connect.mailerlite.com/api/subscribers';
    const payload = {
      email,
      fields: { name: firstName, archetype, source: 'tally' },
      groups: [ML_GROUP],
      resubscribe: true,
      autoresponders: true
    };

    const mlRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ML_API}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const text = await mlRes.text().catch(() => '');
    let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }

    if (!mlRes.ok) {
      console.error('MailerLite error:', mlRes.status, data);
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

// ---- Helpers ----
function readRawBody(req) {
  // Try several places; fall back to stream
  if (req.rawBody) {
    return Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody);
  }
  if (typeof req.body === 'string') return Buffer.from(req.body);
  if (Buffer.isBuffer(req.body)) return req.body;

  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyTallySignature(raw, signatureHeader, secret) {
  if (!signatureHeader) return false;
  // header: "t=timestamp,v1=signature"
  const parts = Object.fromEntries(signatureHeader.split(',').map(s => s.split('=')));
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;

  const expected = crypto.createHmac('sha256', secret)
    .update(`${t}.${raw}`)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected));
  } catch {
    return false;
  }
}
