module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).json({ message: "Webhook is live ✅, but use POST" });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    console.log("Incoming Tally payload:", body);
    return res.status(200).json({ ok: true, received: body });
  } catch (e) {
    console.error("JSON parse error:", e);
    return res.status(400).json({ ok: false, error: "Invalid JSON" });
  }
};
