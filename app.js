const express = require("express");
const app = express();

// ⭐️ 超重要：Slackはこれ必須
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 動作確認用
app.get("/", (req, res) => {
  res.send("Slack bot is running 🚀");
});

// Slackイベント
app.post("/slack/events", (req, res) => {
  console.log("BODY:", req.body);

  try {
    // URL検証
    if (req.body && req.body.type === "url_verification") {
      return res.status(200).send(req.body.challenge);
    }

    // イベント受信
    if (req.body && req.body.type === "event_callback") {
      const event = req.body.event;

      if (event.text && event.text.includes("数学")) {
        console.log("数学を検知");
      }
    }

    // 必ず200返す
    return res.status(200).send("ok");

  } catch (e) {
    console.error("ERROR:", e);

    return res.status(200).send("error handled");
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on", PORT);
});

app.post("/slack/events", (req, res) => {
  console.log("===== EVENT RECEIVED =====");
  console.log(JSON.stringify(req.body, null, 2));

  return res.status(200).send("ok");
});