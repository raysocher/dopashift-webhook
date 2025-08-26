const crypto = require('crypto');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).json({ message: "Webhook is live ✅, but use POST" });
  }

  try {
    const secret = process.env.TALLY_SIGNING_SECRET;
    if (!secret) {
      console.error("Missing TALLY_SIGNING_SECRET");
      return res.status(500).json({ error: "Server not configured" });
    }

    const signatureHeader = req.headers['tally-signature'];
    const rawBody = JSON.stringify(req.body);

    if (!verifyTallySignature(rawBody, signatureHeader, secret)) {
      console.error("❌ Invalid Tally signature");
      return res.status(401).json({ error: "Invalid signature" });
    }

    const body = req.body;
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
      console.error('Missing email in payload:', JSON.stringify(body));
      return res.status(400).json({ ok: false, error: 'Missing email' });
    }

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

    return res.status(200).json({ ok: true, subscribed: { email, group: ML_GROUP }, mailerlite: data });
  } catch (e) {
    console.error("Webhook error:", e);
    return res.status(400).json({ ok: false, error: "Handler error" });
  }
};

function verifyTallySignature(payload, signatureHeader, secret) {
  if (!signatureHeader) return false;
  const parts = signatureHeader.split(',');
  const timestamp = parts[0].split('=')[1];
  const signature = parts[1].split('=')[1];
  const baseString = `${timestamp}.${payload}`;
  const expected = require('crypto').createHmac('sha256', secret).update(baseString).digest('hex');
  try {
    return require('crypto').timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch { return false; }
}
