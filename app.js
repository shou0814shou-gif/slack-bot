require('dotenv').config();

const { App } = require('@slack/bolt');

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true
});

app.message(async ({ message, say }) => {
  // Bot自身の発言は無視
  if (message.bot_id) return;

  const text = (message.text || '').trim();
  console.log("受信:", text);

  if (text === 'おはよう') {
    await say('こんにちは');
  }
});

(async () => {
  await app.start();
  console.log('Bot起動成功');
})();