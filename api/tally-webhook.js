export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).json({ message: "Webhook is live ✅, but use POST" });
  }
  console.log("Incoming Tally payload:", req.body);
  return res.status(200).json({ ok: true, received: req.body });
}
