const express = require("express");
const app = express();

app.use(express.json());

// 動作確認
app.get("/", (req, res) => {
  res.send("OK");
});

// Slackイベント
app.post("/slack/events", (req, res) => {
  const body = req.body;

  if (body?.type === "url_verification") {
    return res.send(body.challenge);
  }

  return res.status(200).send("ok");
});

// ⭐️ Render必須形
const PORT = process.env.PORT;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on", PORT);
});