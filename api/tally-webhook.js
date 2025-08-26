export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const fields = body?.data?.fields || [];

    const byLabel = (label) =>
      fields.find(x => (x.label || '').toLowerCase() === label.toLowerCase())?.value ?? null;
    const firstOfType = (type) =>
      fields.find(x => x.type === type)?.value ?? null;

    const email = byLabel('Email') || firstOfType('INPUT_EMAIL');
    let archetype =
      byLabel('Archetype') || byLabel('Type') || byLabel('Result') || firstOfType('CALCULATED_FIELDS');

    if (!email || !archetype) {
      return res.status(400).json({ error: 'Missing email or archetype' });
    }

    archetype = String(archetype).trim();

    const ML_KEY = process.env.MAILERLITE_API_KEY;
    const ML_GROUP_ID = process.env.ML_GROUP_ID;

    const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${ML_KEY}` };

    // 1) Upsert subscriber with custom field "archetype"
    const upsert = await fetch('https://api.mailerlite.com/api/v2/subscribers', {
      method: 'POST',
      headers,
      body: JSON.stringify({ email, fields: { archetype }, resubscribe: true })
    });
    if (!upsert.ok) return res.status(502).json({ error: 'MailerLite upsert failed' });

    // 2) Add to group to trigger automation
    const addToGroup = await fetch(`https://api.mailerlite.com/api/v2/groups/${ML_GROUP_ID}/subscribers`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ email })
    });
    if (!addToGroup.ok) return res.status(502).json({ error: 'Add to group failed' });

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Server error' });
  }
}
export const config = { api: { bodyParser: { sizeLimit: '1mb' } } };
