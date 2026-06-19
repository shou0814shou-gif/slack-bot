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

    CREATE TABLE IF NOT EXISTS assignment_cursors (
      subject TEXT PRIMARY KEY,
      next_index INTEGER NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_status_teacher ON tasks (status, teacher);
    CREATE INDEX IF NOT EXISTS idx_tasks_channel_thread ON tasks (channel_id, thread_ts);
  `);

  console.log("Database initialized");
}

const subjectTeachers = {
  "\u82f1\u8a9e": ["\u771f\u9593", "\u5927\u68ee", "\u7d30\u5c71", "\u8389\u671b", "\u62d3\u6597", "\u5275\u8a69"],
  "\u56fd\u8a9e": ["\u5275\u8a69", "\u4e2d\u6751", "\u5927\u68ee", "\u7d30\u5c71", "\u8389\u671b", "\u83c5\u91ce", "\u4e09\u6210"],
  "\u6570\u5b66": ["\u5317\u6751", "\u81fc\u4e95", "\u96e3\u6ce2", "\u897f\u585a"],
  "\u7269\u7406": ["\u897f\u585a", "\u5317\u6751", "\u81fc\u4e95", "\u96e3\u6ce2"],
  "\u5316\u5b66": ["\u81fc\u4e95", "\u96e3\u6ce2", "\u897f\u585a", "\u5317\u6751"],
  "\u751f\u7269": ["\u6ff1\u7530"],
  "\u7406\u79d1\u57fa\u790e": ["\u5317\u6751", "\u81fc\u4e95", "\u96e3\u6ce2", "\u897f\u585a", "\u5275\u8a69", "\u5bae\u5185", "\u4e2d\u6751"],
  "\u65e5\u672c\u53f2": ["\u771f\u9593", "\u62d3\u6597", "\u7d30\u5c71"],
  "\u4e16\u754c\u53f2": ["\u5275\u8a69", "\u5927\u68ee"],
  "\u653f\u6c11\u7d4c\u6e08": ["\u5bae\u5185"],
  "\u5730\u7406": ["\u68ee"],
  "\u502b\u7406": ["\u7d30\u5c71"],
  "\u60c5\u5831": ["\u5bae\u5185", "\u96e3\u6ce2"],
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

  if (event.thread_ts && text.includes("\u5b8c\u4e86")) {
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
      text: `\u79d1\u76ee\u540d\u304c\u8907\u6570\u898b\u3064\u304b\u308a\u307e\u3057\u305f: ${matchedSubjects.join("\u3001")}\n\u0031\u3064\u306e\u6295\u7a3f\u306b\u0031\u79d1\u76ee\u3060\u3051\\[...]`
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
    const cursorResult = await client.query(
      `INSERT INTO assignment_cursors (subject, next_index)
       VALUES ($1, 0)
       ON CONFLICT (subject) DO UPDATE SET subject = EXCLUDED.subject
       RETURNING next_index`,
      [subject],
    );
    const startIndex = cursorResult.rows[0].next_index % teachers.length;
    const assignment = findNextAvailableTeacher(teachers, activeTeachers, startIndex);

    if (!assignment) {
      await client.query("COMMIT");
      await postMessage({
        channel,
        thread_ts: threadTs,
        text: `\u79d1\u76ee: ${subject}\n\u73fe\u5728\u3001\u62c5\u5f53\u53ef\u80fd\u306a\u5148\u751f\u304c\u5168\u54e1\u30bf\u30b9\u30af\u4e2d\u3067\u3059\u3002`,
      });
      return;
    }

    const { teacher, index } = assignment;
    const nextIndex = (index + 1) % teachers.length;

    await client.query(
      `INSERT INTO tasks (thread_ts, channel_id, subject, teacher, status, assigned_at)
       VALUES ($1, $2, $3, $4, 'active', NOW())`,
      [threadTs, channel, subject, teacher],
    );

    await client.query(
      `UPDATE assignment_cursors
       SET next_index = $2, updated_at = NOW()
       WHERE subject = $1`,
      [subject, nextIndex],
    );

    await client.query("COMMIT");

    await postMessage({
      channel,
      thread_ts: threadTs,
      text: `\u79d1\u76ee: ${subject}\n\u62c5\u5f53: ${teacher}\u5148\u751f`,
    });
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function findNextAvailableTeacher(teachers, activeTeachers, startIndex) {
  for (let offset = 0; offset < teachers.length; offset += 1) {
    const index = (startIndex + offset) % teachers.length;
    const teacher = teachers[index];
    if (!activeTeachers.has(teacher)) {
      return { teacher, index };
    }
  }

  return null;
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

  // スレッド内にのみ完了メッセージを投稿する（チャンネル全体への投稿は削除）
  await postMessage({
    channel,
    thread_ts: threadTs,
    text: `${subject}\u306e\u5206\u6790\u30b7\u30fc\u30c8\u3092\u5b8c\u4e86\u3068\u3057\u3066\u8a18\u9332\u3057\u307e\u3057\u305f\u3002\n\u62c5\u5f53: ${teacher}\u5148\u751f`,
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