const crypto = require("crypto");
const express = require("express");
const { Pool } = require("pg");

const app = express();

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;

if (!SLACK_BOT_TOKEN) console.warn("SLACK_BOT_TOKEN is not set");
if (!SLACK_SIGNING_SECRET) console.warn("SLACK_SIGNING_SECRET is not set");
if (!DATABASE_URL) console.warn("DATABASE_URL is not set");

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS processed_events (
      event_id TEXT PRIMARY KEY,
      processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS tasks (
      thread_ts TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      teacher TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'completed')),
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status_teacher ON tasks (status, teacher);
    CREATE INDEX IF NOT EXISTS idx_tasks_channel_thread ON tasks (channel_id, thread_ts);
  `);

  console.log("Database initialized");
}

const subjectTeachers = {
  "英語": ["真間", "大森", "細山", "莉望", "拓斗", "創詩"],
  "国語": ["創詩", "中村", "大森", "細山", "莉望", "菅野", "三成"],
  "数学": ["北村", "臼井", "難波", "西塚"],
  "物理": ["西塚", "北村", "臼井", "難波"],
  "化学": ["臼井", "難波", "西塚", "北村"],
  "生物": ["濱田"],
  "理科基礎": ["北村", "臼井", "難波", "西塚", "創詩", "宮内", "中村"],
  "日本史": ["真間", "拓斗", "細山"],
  "世界史": ["創詩", "大森"],
  "政治経済": ["宮内"],
  "地理": ["森"],
  "倫理": ["細山"],
  "情報": ["宮内", "難波"],
};

const subjects = Object.keys(subjectTeachers).sort((a, b) => b.length - a.length);

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString("utf8");
  },
}));

app.get("/", (req, res) => {
  console.log("GET / received");
  res.send("Slack bot is running");
});

app.post("/slack/events", async (req, res) => {
  console.log("===== EVENT RECEIVED =====");
  console.log(JSON.stringify(req.body, null, 2));

  if (!verifySlackRequest(req)) {
    return res.status(401).send("invalid signature");
  }

  if (req.body.type === "url_verification") {
    return res.status(200).type("text/plain").send(req.body.challenge);
  }

  res.status(200).send("ok");

  try {
    await handleSlackEvent(req.body);
  } catch (error) {
    console.error("Failed to handle Slack event:", error);
  }
});

function verifySlackRequest(req) {
  if (!SLACK_SIGNING_SECRET) return true;