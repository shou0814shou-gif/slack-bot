const express = require("express");
const app = express();

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

app.use(express.json());

app.get("/", (req, res) => {
  console.log("GET / received");
  res.send("Slack bot is running");
});

app.post("/slack/events", (req, res) => {
  console.log("===== EVENT RECEIVED =====");
  console.log(JSON.stringify(req.body, null, 2));

  if (req.body.type === "url_verification") {
    return res.status(200).type("text/plain").send(req.body.challenge);
  }

  return res.status(200).send("ok");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on ${PORT}`);
});