require("./server");

const { Pool } = require("pg");
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  ApplicationIntegrationType,
  InteractionContextType
} = require("discord.js");

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
const DATABASE_URL = process.env.DATABASE_URL;

const OPEN_LOCK_MS = 2 * 60 * 1000; // open後の制限時間（2分）
const BONUS_MULTIPLIER = { 4: 3, 3: 4, 2: 6, 1: 10 }; // 曲名の文字数 -> 得点倍率

console.log("songGuessNK v1.0.0");

if (!TOKEN || !CLIENT_ID || !DATABASE_URL) {
  throw new Error(
    "DISCORD_TOKEN、DISCORD_CLIENT_ID、DATABASE_URL を設定してください。"
  );
}


const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const help = new SlashCommandBuilder()
  .setName("help")
  .setDescription("コマンド一覧を表示します")
  .setIntegrationTypes(
    ApplicationIntegrationType.GuildInstall,
    ApplicationIntegrationType.UserInstall
  )
  .setContexts(
    InteractionContextType.Guild,
    InteractionContextType.BotDM,
    InteractionContextType.PrivateChannel
  );

const ping = new SlashCommandBuilder()
  .setName("ping")
  .setDescription("botの応答速度を計測します")
  .setIntegrationTypes(
    ApplicationIntegrationType.GuildInstall,
    ApplicationIntegrationType.UserInstall
  )
  .setContexts(
    InteractionContextType.Guild,
    InteractionContextType.BotDM,
    InteractionContextType.PrivateChannel
  );

// クイズはチャンネルへの投稿・メッセージ監視が必要なため、サーバー専用
const quiz = new SlashCommandBuilder()
  .setName("quiz")
  .setDescription("曲名クイズを開始します")
  .addStringOption(option =>
    option
      .setName("songname")
      .setDescription("出題する曲名")
      .setRequired(true)
  )
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setContexts(InteractionContextType.Guild);

const rest = new REST({ version: "10" }).setToken(TOKEN);

async function registerCommands() {
  const body = [help.toJSON(), ping.toJSON(), quiz.toJSON()];

  if (GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      {
        body
      }
    );

    console.log("ギルドコマンドを登録しました。");
  } else {
    await rest.put(
      Routes.applicationCommands(CLIENT_ID),
      {
        body
      }
    );

    console.log("グローバルコマンドを登録しました。");
  }
}

// ---------- DB (PostgreSQL) ----------
// localhost 以外は SSL 接続。不要な場合は DATABASE_SSL=false を設定。
const useSsl =
  process.env.DATABASE_SSL !== "false" &&
  !/@(localhost|127\.0\.0\.1)/.test(DATABASE_URL);

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false
});
pool.on("error", e => console.error("pg pool error:", e));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS scores (
      guild_id TEXT NOT NULL,
      user_id  TEXT NOT NULL,
      points   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS games (
      channel_id TEXT PRIMARY KEY,
      data       JSONB NOT NULL
    );
  `);
}

async function addScore(guildId, userId, points) {
  await pool.query(
    `INSERT INTO scores (guild_id, user_id, points) VALUES ($1, $2, $3)
     ON CONFLICT (guild_id, user_id)
     DO UPDATE SET points = scores.points + EXCLUDED.points`,
    [guildId, userId, points]
  );
}

async function getTopScores(guildId, limit = 10) {
  const { rows } = await pool.query(
    `SELECT user_id, points FROM scores
     WHERE guild_id = $1 ORDER BY points DESC LIMIT $2`,
    [guildId, limit]
  );
  return rows;
}

// 進行中クイズの保存（再起動しても続行できるように）。失敗してもbotは止めない。
async function saveGame(channelId, game) {
  try {
    await pool.query(
      `INSERT INTO games (channel_id, data) VALUES ($1, $2::jsonb)
       ON CONFLICT (channel_id) DO UPDATE SET data = EXCLUDED.data`,
      [channelId, JSON.stringify(game.toJSON())]
    );
  } catch (e) {
    console.error("saveGame failed:", e);
  }
}

async function deleteGame(channelId) {
  try {
    await pool.query("DELETE FROM games WHERE channel_id = $1", [channelId]);
  } catch (e) {
    console.error("deleteGame failed:", e);
  }
}

async function loadGames() {
  const { rows } = await pool.query("SELECT channel_id, data FROM games");
  for (const r of rows) {
    games.set(r.channel_id, Game.fromJSON(r.data));
  }
  console.log(`進行中のクイズを ${rows.length} 件復元しました。`);
}

// ---------- クイズ用ユーティリティ ----------
/** 1->① ... 20->⑳, 21->㉑ ... 35->㉟, 36->㊱ ... 50->㊿, 以降は (51) 形式 */
function circled(n) {
  if (n >= 1 && n <= 20) return String.fromCodePoint(0x2460 + n - 1);
  if (n >= 21 && n <= 35) return String.fromCodePoint(0x3251 + n - 21);
  if (n >= 36 && n <= 50) return String.fromCodePoint(0x32b1 + n - 36);
  return `(${n})`;
}

const isSpace = ch => /\s/u.test(ch);
const normChar = ch => ch.normalize("NFKC").toLowerCase();
const normText = s =>
  Array.from(s)
    .filter(c => !isSpace(c))
    .map(normChar)
    .join("");

class Game {
  constructor(hostId, answer) {
    this.hostId = hostId;
    this.answer = answer;
    this.chars = Array.from(answer); // サロゲートペア対応
    this.labels = new Map(); // 正規化した文字 -> 番号
    this.opened = new Set(); // オープン済みの番号
    this.lockUserId = null; // 直前にopenした人
    this.lockUntil = 0; // ロック解除時刻 (ms)
    this.wrongCount = 0; // 不正解の回答の回数（出題者の得点に加算）

    for (const ch of this.chars) {
      if (isSpace(ch)) continue;
      const k = normChar(ch);
      if (!this.labels.has(k)) this.labels.set(k, this.labels.size + 1);
    }
  }

  toJSON() {
    return {
      hostId: this.hostId,
      answer: this.answer,
      opened: [...this.opened],
      lockUserId: this.lockUserId,
      lockUntil: this.lockUntil,
      wrongCount: this.wrongCount
    };
  }

  static fromJSON(d) {
    const g = new Game(d.hostId, d.answer);
    g.opened = new Set(d.opened);
    g.lockUserId = d.lockUserId;
    g.lockUntil = d.lockUntil;
    g.wrongCount = d.wrongCount ?? 0; // 古い保存データには無いため
    return g;
  }

  render() {
    return this.chars
      .map(ch => {
        if (isSpace(ch)) return ch;
        const n = this.labels.get(normChar(ch));
        return this.opened.has(n) ? ch : circled(n);
      })
      .join("");
  }

  // --- ロック（openした人は、他の人がopenするか2分経過するまで回答/open不可） ---
  lockRemaining(userId) {
    if (this.lockUserId !== userId) return 0;
    const left = this.lockUntil - Date.now();
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  setLock(userId) {
    this.lockUserId = userId;
    this.lockUntil = Date.now() + OPEN_LOCK_MS;
  }

  // --- 得点 ---
  titleLength() {
    return this.chars.filter(c => !isSpace(c)).length;
  }

  /** まだ開いていない文字の種類数（同じ文字は1つと数える） */
  hiddenCount() {
    return this.labels.size - this.opened.size;
  }

  multiplier() {
    return BONUS_MULTIPLIER[this.titleLength()] ?? 1;
  }

  points() {
    return this.hiddenCount() * this.multiplier();
  }

  pointsDetail() {
    const m = this.multiplier();
    return m > 1
      ? `${this.hiddenCount()}種類 × ボーナス${m}倍`
      : `${this.hiddenCount()}種類`;
  }

  /** 開いた文字の種類数（同じ文字は1つと数える = sg!open された回数） */
  openedCount() {
    return this.opened.size;
  }

  /** 出題者の得点 = 開いた文字数（種類） + 不正解数 */
  hostPoints() {
    return this.openedCount() + this.wrongCount;
  }

  hostPointsDetail() {
    return `開いた文字${this.openedCount()}種類 + 不正解${this.wrongCount}回`;
  }
}

/** channelId -> Game */
const games = new Map();

async function replyTemp(message, text, ms = 8000) {
  const m = await message.reply(text);
  setTimeout(() => m.delete().catch(() => {}), ms);
}

// ---------- /quiz ----------
async function startQuiz(interaction) {
  const ch = interaction.channel;

  if (!interaction.inGuild() || !ch) {
    await interaction.reply({
      content: "このコマンドはbotが参加しているサーバーのチャンネルで使用してください。",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (games.has(ch.id)) {
    await interaction.reply({
      content: "このチャンネルではすでにクイズが進行中です。",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const songname = interaction.options.getString("songname").trim();
  if (!songname) {
    await interaction.reply({
      content: "曲名を入力してください。",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const game = new Game(interaction.user.id, songname);
  games.set(ch.id, game); // 先に登録して、同時に2回出題されるのを防ぐ

  // 曲名が漏れないよう、出題者への確認は ephemeral、問題文は別メッセージで投稿
  // （3秒以内に返信する必要があるため、DB保存より先に行う）
  try {
    await interaction.reply({
      content:
        `出題を受け付けました。答え: **${game.answer}**\n` +
        "（出題者は `sg_` と `sg!open` を使えません）",
      flags: MessageFlags.Ephemeral
    });
  } catch (error) {
    games.delete(ch.id);
    console.error("quiz reply failed:", error);
    return;
  }

  const bonus =
    game.multiplier() > 1 ? ` × ボーナス **${game.multiplier()}倍**` : "";
  const embed = new EmbedBuilder()
      .setColor("#673bb7")
      .setDescription(
        `# ${game.render()}\n` +
          "`sg_答え` で回答 / `sg!open n` で n番の文字をオープン\n" +
          `・正解時の得点 = 開いていない文字種の数（現在 **${game.hiddenCount()}** 種類）${bonus}\n` +
          "・openした人は、他の人がopenするか2分経過するまで回答・openできません\n\n" +
          "・正解が出るまたは全文字が開くと出題者にも開いた文字種の数+不正解数の点数が入ります\n" +
          `出題者: ${interaction.user}`
      );

  try {
    await ch.send({ embeds: [embed] });
  } catch (error) {
    games.delete(ch.id); // 投稿できなかった場合は、出題を取り消す
    console.error("quiz send failed:", error);
    await interaction
      .followUp({
        content:
          "問題の投稿に失敗しました。botに、このチャンネルでの「メッセージを送信」と「埋め込みリンク」の権限があるか確認してください。",
        flags: MessageFlags.Ephemeral
      })
      .catch(() => {});
    return;
  }

  await saveGame(ch.id, game);
}

// ---------- クイズのメッセージ処理 (sg_ / sg!open / sg!leaderboard) ----------
async function handleQuizMessage(message) {
  const content = message.content.trim();

  // ランキング
  if (content === "sg!leaderboard") {
    const top = await getTopScores(message.guild.id);
    if (top.length === 0) {
      await message.channel.send("まだ記録がありません。");
      return;
    }
    const lines = top.map(
      (r, i) => `**${i + 1}位** <@${r.user_id}> — ` + (r.points == 1 ? `${r.points}pt` : `${r.points}pts`)
    );
    const embed = new EmbedBuilder()
      .setColor(0x00aaff)
      .setTitle("ランキング")
      .setDescription(lines.join("\n"));
    await message.reply({ embeds: [embed] });
    return;
  }

  const isAnswer = content.startsWith("sg_");
  const isOpen = content === "sg!open" || content.startsWith("sg!open ");
  if (!isAnswer && !isOpen) return;

  const game = games.get(message.channel.id);
  if (!game) {
    await message.reply(
      "進行中のクイズはありません。`/quiz` で開始できます。"
    );
    return;
  }

  if (content === "sg!fuck") {
    await message.react("<:crying_uyuyu:1565519672864932021>").catch(() => {});
    return;
  }
  
    const isAnswer = content.startsWith("sg_");
    const isOpen = content === "sg!open" || content.startsWith("sg!open ");
    if (!isAnswer && !isOpen) return;
  
    const game = games.get(message.channel.id);
    if (!game) {
      await message.reply(
        "進行中のクイズはありません。`/quiz` で開始できます。"
      );
      return;
    }

  // 出題者は sg_ / sg!open 禁止
  if (message.author.id === game.hostId) {
    await replyTemp(
      message,
      "出題者は `sg_` と `sg!open` を使用できません。",
      5000
    );
    return;
  }

  // 直前にopenした人は、他の人がopenするか2分経過するまで回答・open不可
  const remain = game.lockRemaining(message.author.id);
  if (remain > 0) {
    const m = Math.floor(remain / 60);
    const s = String(remain % 60).padStart(2, "0");
    await replyTemp(
      message,
      `あなたは直前にopenしたため、他の人がopenするか約 ${m}分${s}秒 経つまで回答・openできません。`
    );
    return;
  }

  // --- sg!open n ---
  if (isOpen) {
    const arg = content.slice("sg!open".length).trim();
    if (!/^\d+$/.test(arg)) {
      await message.reply("使い方: `sg!open 3`");
      return;
    }
    const n = parseInt(arg, 10);
    if (n < 1 || n > game.labels.size) {
      await message.reply(`1〜${game.labels.size} の番号を指定してください。`);
      return;
    }
    if (game.opened.has(n)) {
      await message.reply(`${circled(n)} はすでにオープン済みです。`);
      return;
    }

    // 状態の更新は await の前に同期的に行う（同時投稿による二重処理を防ぐ）
    game.opened.add(n);
    game.setLock(message.author.id); // 他の人がopenすると上書きされて解除される

    if (game.opened.size === game.labels.size) {
      games.delete(message.channel.id);
      await deleteGame(message.channel.id);

      const hostPts = game.hostPoints(); // 出題者の得点（開いた文字数 + 不正解数）
      await addScore(message.guild.id, game.hostId, hostPts);

      await message.channel.send(
        `全ての文字が開きました。正解は: **${game.answer}**（正解者なし）\n` +
          `出題ポイント: <@${game.hostId}> **+${hostPts}pt**（${game.hostPointsDetail()}）`
      );
      return;
    }

    await saveGame(message.channel.id, game);
    await message.reply(
      `open: ${circled(n)}（${message.author} は2分間 or 他の人がopenするまで回答・open不可）\n` +
        `## ${game.render()}\n` +
        `現在の正解得点: **${game.points()}pt**（${game.pointsDetail()}）`
    );
    return;
  }

  // --- sg_答え ---
  const guess = content.slice("sg_".length).trim();
  if (!guess) return;

  if (normText(guess) === normText(game.answer)) {
    const pts = game.points();
    const detail = game.pointsDetail();
    const hostPts = game.hostPoints(); // 出題者の得点（開いた文字数 + 不正解数）
    games.delete(message.channel.id); // 先に消して、同時に正解した別の人の二重加点を防ぐ
    await deleteGame(message.channel.id);
    await addScore(message.guild.id, message.author.id, pts);
    if (hostPts > 0) {
      await addScore(message.guild.id, game.hostId, hostPts);
    }
    await message.react("<:pigeon_af:1565513151636836362>").catch(() => {});
    await message.reply(
      `Correct! ${message.author}\n` +
        `獲得ポイント: **+${pts}pt**（${detail}）` +
        (hostPts > 0
          ? `\n出題ポイント: <@${game.hostId}> **+${hostPts}pt**（${game.hostPointsDetail()}）`
          : "")
    );
  } else {
    game.wrongCount++;
    // 同時に正解が出てクイズが終わっていたら、保存し直さない
    if (games.get(message.channel.id) === game) {
      await saveGame(message.channel.id, game);
    }
    await message.react("<:uyuyu:1565513010422751302>").catch(() => {});
  }
}

// ---------- イベント ----------
client.once("clientReady", () => {
  console.log(
    `ログインしました。username=${client.user.username}, globalName=${client.user.globalName}, displayName=${client.user.displayName}`
  );
});

client.on("interactionCreate", async interaction => {
  if (!interaction.isChatInputCommand()) {
    return;
  }
  
  if (interaction.commandName === "help") {
    const embed = new EmbedBuilder()
      .setColor(0x00aaff)
      .setTitle("ヘルプ")
      .addFields(
        {
          name: "コマンド一覧",
          value: "\`/ping\` botの応答速度を計測します。\n" +
            "\`/help\` コマンド一覧を表示します。\n" + 
            "`/quiz songname` クイズを開始（出題者用）\n" +
            "`sg_答え` 答えを回答する\n" +
            "`sg!open n` n番の文字をオープンする\n" +
            "`sg!leaderboard` ランキングを表示",
          inline: false
        }
      );

    await interaction.reply({
      embeds: [embed]
    });
  } else if (interaction.commandName === "ping") {
    const websocketPing = client.ws.ping;

    await interaction.reply({
      content: `Pong!(${websocketPing}ms)`
    });
  } else if (interaction.commandName === "quiz") {
    await startQuiz(interaction);
  } else {
    return;
  }
});

client.on("messageCreate", async message => {
  if (message.author.bot) return;
  if (!message.guild) return;

  await handleQuizMessage(message);
});

process.on("unhandledRejection", error => {
  console.error("unhandledRejection:", error);
});
client.on("error", error => console.error("client error:", error));

registerCommands()
  .then(() => initDb())
  .then(() => loadGames())
  .then(() => client.login(TOKEN))
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
