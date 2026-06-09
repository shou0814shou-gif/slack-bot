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
  
  const timestamp = req.headers["x-slack-request-timestamp"];
  const signature = req.headers["x-slack-signature"];
  if (!timestamp || !signature) return false;

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - Number(timestamp)) > 60 * 5) return false;

  const base = `v0:${timestamp}:${req.rawBody}`;
  const hmac = crypto
    .createHmac("sha256", SLACK_SIGNING_SECRET)
    .update(base)
    .digest("hex");
  const expected = `v0=${hmac}`;

  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

async function handleSlackEvent(body) {
  if (body.type !== "event_callback" || !body.event) return;

  const isFirstProcess = await markEventProcessed(body.event_id);
  if (!isFirstProcess) {
    console.log(`Skipping duplicate event: ${body.event_id}`);
    return;
  }

  const event = body.event;
  if (event.type !== "message") return;
  if (event.bot_id || event.subtype === "bot_message") return;

  const text = normalizeText(event.text || "");
  if (!text) return;

  const channel = event.channel;
  const threadTs = event.thread_ts || event.ts;

  if (event.thread_ts && text.includes("完了")) {
    await completeTask(channel, event.thread_ts);
    return;
  }

  if (event.thread_ts) return;

  const matchedSubjects = findSubjects(text);
  if (matchedSubjects.length === 0) return;

  if (matchedSubjects.length > 1) {
    await postMessage({
      channel,
      thread_ts: threadTs,
      text: `科目名が複数見つかりました: ${matchedSubjects.join("、")}\n1つの投稿に1科目だけ入れてください。`,
    });
    return;
  }

  await assignTask(channel, threadTs, matchedSubjects[0]);
}

async function markEventProcessed(eventId) {
  if (!eventId) return true;

  const result = await pool.query(
    "INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING",
    [eventId],
  );
  return result.rowCount === 1;
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}

function findSubjects(text) {
  return subjects.filter((subject) => text.includes(subject));
}

async function assignTask(channel, threadTs, subject) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const existing = await client.query(
      "SELECT subject, teacher, status FROM tasks WHERE thread_ts = $1 FOR UPDATE",
      [threadTs],
    );

    if (existing.rowCount > 0) {
      await client.query("COMMIT");
      console.log(`Task already exists for thread ${threadTs}`);
      return;
    }

    const teachers = subjectTeachers[subject];
    const active = await client.query(
      "SELECT teacher FROM tasks WHERE status = 'active'",
    );
    thread_ts: threadTs,
    text: `科目名が複数見つかりました: ${matchedSubjects.join("、")}\n1つの投稿に1科目だけ入れてください。`,
  });
  return;
}

await assignTask(channel, threadTs, matchedSubjects[0]);
}

async function markEventProcessed(eventId) {
if (!eventId) return true;

const result = await pool.query(
  "INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING",
  [eventId],
);
return result.rowCount === 1;
}

function normalizeText(text) {
return text.replace(/\s+/g, " ").trim();
}

function findSubjects(text) {
return subjects.filter((subject) => text.includes(subject));
}

async function assignTask(channel, threadTs, subject) {
const client = await pool.connect();

try {
  await client.query("BEGIN");

  const existing = await client.query(
    "SELECT subject, teacher, status FROM tasks WHERE thread_ts = $1 FOR UPDATE",
    [threadTs],
  );

  if (existing.rowCount > 0) {
    await client.query("COMMIT");
    console.log(`Task already exists for thread ${threadTs}`);
    return;
  }

  const teachers = subjectTeachers[subject];
  const active = await client.query(
    "SELECT teacher FROM tasks WHERE status = 'active'",
  );
  const activeTeachers = new Set(active.rows.map((row) => row.teacher));
  const teacher = teachers.find((name) => !activeTeachers.has(name));

  if (!teacher) {
    await client.query("COMMIT");
    await postMessage({
      channel,
      thread_ts: threadTs,
      text: `科目: ${subject}\n現在、担当可能な先生が全員タスク中です。`,
    });
    return;
  }

  await client.query(
    `INSERT INTO tasks (thread_ts, channel_id, subject, teacher, status, assigned_at)
     VALUES ($1, $2, $3, $4, 'active', NOW())`,
    [threadTs, channel, subject, teacher],
  );

  await client.query("COMMIT");

  await postMessage({
    channel,
    thread_ts: threadTs,
    text: `科目: ${subject}\n担当: ${teacher}先生`,
  });
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
}
}

async function completeTask(channel, threadTs) {
const result = await pool.query(
  `UPDATE tasks
   SET status = 'completed', completed_at = NOW()
   WHERE channel_id = $1 AND thread_ts = $2 AND status = 'active'
   RETURNING subject, teacher`,
  [channel, threadTs],
);

if (result.rowCount === 0) {
  console.log(`No active task found for thread ${threadTs}`);
  return;
}

const { subject, teacher } = result.rows[0];

await postMessage({
  channel,
  thread_ts: threadTs,
  text: `${subject}の分析シートを完了として記録しました。\n担当: ${teacher}先生`,
});

await postMessage({
  channel,
  text: `${subject}の分析シートが完了しました。\n担当: ${teacher}先生`,
});
}

async function postMessage(payload) {
const response = await fetch("https://slack.com/api/chat.postMessage", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${SLACK_BOT_TOKEN}`,
    "Content-Type": "application/json; charset=utf-8",
  },
  body: JSON.stringify(payload),
});

const data = await response.json();
if (!data.ok) {
  throw new Error(`Slack chat.postMessage failed: ${data.error}`);
}

return data;
}

const PORT = process.env.PORT || 3000;

initDb()
.then(() => {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on ${PORT}`);
  });
})
.catch((error) => {
  console.error("Failed to initialize database:", error);
  process.exit(1);
});