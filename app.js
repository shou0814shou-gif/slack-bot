const express = require("express");
const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.send("Slack bot is running 🚀");
});

app.post("/slack/events", (req, res) => {
  console.log("===== EVENT RECEIVED =====");
  console.log(JSON.stringify(req.body, null, 2));

  res.status(200).send("ok");
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});