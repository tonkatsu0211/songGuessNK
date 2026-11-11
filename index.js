const { Pool } = require("pg");
const { randomUUID } = require("crypto");
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

const OPEN_LOCK_MS = 1 * 60 * 1000; // open後の制限時間（1分）
const BONUS_MULTIPLIER = { 4: 3, 3: 4, 2: 6, 1: 10 }; // 曲名の文字数 -> 得点倍率
const FORCE_END_PENALTY = 10; // 強制終了のペナルティ（出題者の得点から引くポイント。0未満にはならない）
const MAX_QUEUE_PER_CHANNEL = 5; // 1チャンネルあたりの、順番待ちの最大数
const QUEUE_INTERVAL_MS = 10 * 1000; // 前のクイズが終わってから、順番待ちの次の問題が始まるまでの間隔（10秒）

console.log("songGuessNK v1.2.3");

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

const quiz = new SlashCommandBuilder()
  .setName("quiz")
  .setDescription("曲名クイズを開始します")
  .addStringOption(option =>
    option
      .setName("songname")
      .setDescription("出題する曲名")
      .setRequired(true)
      .setMaxLength(100)
  )
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setContexts(InteractionContextType.Guild);

// 出題者専用の強制終了コマンド（ペナルティあり）
const quizend = new SlashCommandBuilder()
  .setName("quizend")
  .setDescription("出題中のクイズを強制終了します（出題者専用・ペナルティあり）")
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setContexts(InteractionContextType.Guild);

// 自分が出題した問題（出題中・順番待ち）を確認するコマンド
const quizcheck = new SlashCommandBuilder()
  .setName("quizcheck")
  .setDescription("自分が出題した問題（出題中・順番待ち）を確認します")
  .setIntegrationTypes(ApplicationIntegrationType.GuildInstall)
  .setContexts(InteractionContextType.Guild);

const rest = new REST({ version: "10" }).setToken(TOKEN);

async function registerCommands() {
  const body = [help.toJSON(), ping.toJSON(), quiz.toJSON(), quizend.toJSON(), quizcheck.toJSON()];

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
    CREATE TABLE IF NOT EXISTS used_songs (
      guild_id   TEXT NOT NULL,
      song_key   TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (guild_id, song_key)
    );
    CREATE TABLE IF NOT EXISTS quiz_queue (
      id         TEXT PRIMARY KEY,
      guild_id   TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      host_id    TEXT NOT NULL,
      answer     TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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

// 出題済みの曲名を登録する。すでに登録されていれば false（重複）を返す。
// 判定と登録を1回のクエリで行うので、同時に同じ曲名が出題されても、片方だけが通る。
async function claimSong(guildId, songKey) {
  const { rowCount } = await pool.query(
    `INSERT INTO used_songs (guild_id, song_key) VALUES ($1, $2)
     ON CONFLICT DO NOTHING`,
    [guildId, songKey]
  );
  return rowCount === 1;
}

// 出題済みの登録を消す（強制終了・投稿失敗のとき）。失敗してもbotは止めない。
async function releaseSong(guildId, songKey) {
  try {
    await pool.query(
      "DELETE FROM used_songs WHERE guild_id = $1 AND song_key = $2",
      [guildId, songKey]
    );
  } catch (e) {
    console.error("releaseSong failed:", e);
  }
}

// 得点を引く（0未満にはならない）
async function subtractScore(guildId, userId, points) {
  await pool.query(
    `INSERT INTO scores (guild_id, user_id, points) VALUES ($1, $2, 0)
     ON CONFLICT (guild_id, user_id)
     DO UPDATE SET points = GREATEST(scores.points - $3::int, 0)`,
    [guildId, userId, points]
  );
}

// 順番待ちのクイズの保存（再起動しても残るように）。失敗してもbotは止めない。
async function addQueuedDb(item) {
  try {
    await pool.query(
      `INSERT INTO quiz_queue (id, guild_id, channel_id, host_id, answer)
       VALUES ($1, $2, $3, $4, $5)`,
      [item.id, item.guildId, item.channelId, item.hostId, item.answer]
    );
  } catch (e) {
    console.error("addQueuedDb failed:", e);
  }
}

async function removeQueuedDb(id) {
  try {
    await pool.query("DELETE FROM quiz_queue WHERE id = $1", [id]);
  } catch (e) {
    console.error("removeQueuedDb failed:", e);
  }
}

async function loadGames() {
  const { rows } = await pool.query("SELECT channel_id, data FROM games");
  for (const r of rows) {
    games.set(r.channel_id, Game.fromJSON(r.data));
  }
  console.log(`進行中のクイズを ${rows.length} 件復元しました。`);

  const queued = await pool.query(
    `SELECT id, guild_id, channel_id, host_id, answer
     FROM quiz_queue ORDER BY created_at, id`
  );
  for (const r of queued.rows) {
    if (!queues.has(r.channel_id)) {
      queues.set(r.channel_id, []);
    }
    queues.get(r.channel_id).push({
      id: r.id,
      guildId: r.guild_id,
      channelId: r.channel_id,
      hostId: r.host_id,
      answer: r.answer
    });
  }
  console.log(`順番待ちのクイズを ${queued.rows.length} 件復元しました。`);
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

  /** 重複出題の判定に使うキー（大文字小文字・全角半角・スペースの違いをなくしたもの） */
  songKey() {
    return normText(this.answer);
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

  // --- ロック（openした人は、他の人がopenするか1分経過するまで回答/open不可） ---
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

/** channelId -> 順番待ちのクイズ（出題する順）。{ id, guildId, channelId, hostId, answer } */
const queues = new Map();

/** channelId -> 次の問題の開始を待っている状態。{ timer, startAt(ms) } */
const pendingStarts = new Map();

async function replyTemp(message, text, ms = 8000) {
  const m = await message.reply(text);
  setTimeout(() => m.delete().catch(() => {}), ms);
}

// ---------- 問題の投稿・順番待ち ----------
/** 問題の埋め込みを作る */
function buildQuizEmbed(game, fromQueue = false) {
  const bonus =
    game.multiplier() > 1 ? ` × ボーナス **${game.multiplier()}倍**` : "";
  const embed = new EmbedBuilder()
      .setColor("#673bb7")
      .setDescription(
        `# ${game.render()}\n` +
          "`sg_答え` で回答 / `sg!open n` で n番の文字をオープン\n" +
          `・正解時の得点 = 開いていない文字種の数（現在 **${game.hiddenCount()}** 種類）${bonus}\n` +
          "・openした人は、他の人がopenするか1分経過するまで回答・openできません\n\n" +
          "・正解が出ると出題者にも開いた文字種の数+不正解数の点数が、全文字が開くとその1.5倍(切り捨て)の点数が入ります\n" +
          `出題者: <@${game.hostId}>`
      );

  if (fromQueue) {
    embed.setTitle("▶ 順番待ちのクイズ");
  }

  return embed;
}

// 順番待ちの先頭のクイズを開始する。進行中のクイズがあれば何もしない。
// クイズが終わったとき（正解・全文字オープン・強制終了）に呼ぶ。
async function startNextFromQueue(ch) {
  const queue = queues.get(ch.id);

  while (queue && queue.length > 0 && !games.has(ch.id)) {
    // 取り出しと開始の登録は、await の前に同期的に行う
    const item = queue.shift();
    const game = new Game(item.hostId, item.answer);
    games.set(ch.id, game);

    await removeQueuedDb(item.id);

    try {
      await ch.send({ embeds: [buildQuizEmbed(game, true)] });
    } catch (error) {
      // 投稿できなかった問題は取り消して、次の問題を試す
      games.delete(ch.id);
      await releaseSong(item.guildId, game.songKey());
      console.error("queued quiz send failed:", error);
      continue;
    }

    await saveGame(ch.id, game);
    break;
  }

  if (queue && queue.length === 0) {
    queues.delete(ch.id);
  }
}

// 順番待ちの次の問題を、インターバルを置いてから開始する。
// 進行中のクイズがある・すでに待機中・順番待ちが空のときは、何もしない。
function scheduleNextFromQueue(ch) {
  const queue = queues.get(ch.id);

  if (!queue || queue.length === 0) return;
  if (games.has(ch.id) || pendingStarts.has(ch.id)) return;

  const startAt = Date.now() + QUEUE_INTERVAL_MS;
  const timer = setTimeout(async () => {
    pendingStarts.delete(ch.id);

    try {
      await startNextFromQueue(ch);
    } catch (error) {
      console.error("startNextFromQueue failed:", error);
    }
  }, QUEUE_INTERVAL_MS);
  pendingStarts.set(ch.id, { timer, startAt });

  const seconds = Math.round(QUEUE_INTERVAL_MS / 1000);
  ch.send({
    content:
      `⏳ 次のクイズ（出題者: <@${queue[0].hostId}>）は ${seconds}秒後に始まります。（順番待ち ${queue.length} 件）`,
    allowedMentions: { parse: [] }
  }).catch(() => {});
}

// ---------- /quiz ----------
async function startQuiz(interaction) {
  const ch = interaction.channel;

  // DBへの問い合わせで3秒を超えても失敗しないよう、先に「処理中」にしてから editReply で返信する。
  // 出題者にだけ見える形にして、曲名が他の人に見えないようにする。
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  if (!interaction.inGuild() || !ch) {
    await interaction.editReply({
      content: "このコマンドはbotが参加しているサーバーのチャンネルで使用してください。"
    });
    return;
  }

  const songname = interaction.options.getString("songname").trim();
  if (!songname) {
    await interaction.editReply({ content: "曲名を入力してください。" });
    return;
  }

  const game = new Game(interaction.user.id, songname);
  const guildId = interaction.guildId;

  // 同じ曲名がすでに出題されていたら弾く（判定と登録を同時に行う）。
  // 順番待ちに入れる曲名も、ここで登録するので、同じ曲名は順番待ちにも入れられない。
  let claimed;
  try {
    claimed = await claimSong(guildId, game.songKey());
  } catch (error) {
    console.error("claimSong failed:", error);
    await interaction.editReply({
      content: "データベースの処理に失敗しました。しばらくしてから、もう一度お試しください。"
    });
    return;
  }

  if (!claimed) {
    await interaction.editReply({
      content:
        "この曲名は、このサーバーですでに出題されています。別の曲名で出題してください。"
    });
    return;
  }

  // 進行中のクイズがあるとき（または順番待ちが残っているとき）は、順番待ちに追加する
  const queue = queues.get(ch.id) ?? [];
  if (games.has(ch.id) || queue.length > 0) {
    if (queue.length >= MAX_QUEUE_PER_CHANNEL) {
      await releaseSong(guildId, game.songKey());
      await interaction.editReply({
        content:
          `順番待ちがいっぱいです（最大${MAX_QUEUE_PER_CHANNEL}件）。クイズが進んでから、もう一度お試しください。`
      });
      return;
    }

    const item = {
      id: randomUUID(),
      guildId,
      channelId: ch.id,
      hostId: interaction.user.id,
      answer: songname
    };
    queue.push(item); // 順番は、await の前に同期的に確定させる
    queues.set(ch.id, queue);
    const position = queue.length;

    await addQueuedDb(item);

    await interaction
      .editReply({
        content:
          `進行中のクイズがあるため、順番待ちに追加しました（${position}番目）。\n` +
          `答え: **${game.answer}**\n` +
          `前のクイズが終わって約 ${Math.round(QUEUE_INTERVAL_MS / 1000)} 秒後に、自動で出題が始まります。`
      })
      .catch(() => {});
    await ch
      .send({
        content: `📥 ${interaction.user} がクイズを順番待ちに追加しました（現在 ${position} 件待ち）`,
        allowedMentions: { parse: [] }
      })
      .catch(() => {});

    // 進行中のクイズがなければ、順番待ちの先頭から始める（再起動などで順番待ちだけが残っていた場合）
    scheduleNextFromQueue(ch);
    return;
  }

  games.set(ch.id, game); // 先に登録して、同時に2回出題されるのを防ぐ

  try {
    await ch.send({ embeds: [buildQuizEmbed(game)] });
  } catch (error) {
    games.delete(ch.id); // 投稿できなかった場合は、出題を取り消す
    await releaseSong(guildId, game.songKey()); // 出題していないので、曲名の登録も消す
    console.error("quiz send failed:", error);
    await interaction
      .editReply({
        content:
          "問題の投稿に失敗しました。botに、このチャンネルでの「メッセージを送信」と「埋め込みリンク」の権限があるか確認してください。"
      })
      .catch(() => {});
    return;
  }

  await interaction
    .editReply({
      content:
        `出題を受け付けました。答え: **${game.answer}**\n` +
        "（出題者は `sg_` と `sg!open` を使えません）\n" +
        `（強制終了は \`/quizend\`。出題者の得点から ${FORCE_END_PENALTY}pt 引かれます）`
    })
    .catch(() => {});

  await saveGame(ch.id, game);
}

// ---------- /quizend（出題者専用・ペナルティあり） ----------
async function endQuiz(interaction) {
  const ch = interaction.channel;

  if (!interaction.inGuild() || !ch) {
    await interaction.reply({
      content: "このコマンドはbotが参加しているサーバーのチャンネルで使用してください。",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  const game = games.get(ch.id);
  if (!game) {
    await interaction.reply({
      content: "このチャンネルで進行中のクイズはありません。",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  if (interaction.user.id !== game.hostId) {
    await interaction.reply({
      content: "クイズを強制終了できるのは、出題者だけです。",
      flags: MessageFlags.Ephemeral
    });
    return;
  }

  // 先に消して、同時に届いた回答・open・正解の処理と、二重にならないようにする
  games.delete(ch.id);

  await interaction.deferReply();

  try {
    await deleteGame(ch.id);
    // 強制終了した問題は、再び出題できるように、出題済みの登録を消す
    await releaseSong(interaction.guildId, game.songKey());
    await subtractScore(interaction.guildId, game.hostId, FORCE_END_PENALTY);
  } catch (error) {
    console.error("endQuiz failed:", error);
  }

  await interaction.editReply(
    `⚠️ 出題者の ${interaction.user} がクイズを強制終了しました。\n` +
      `正解は **${game.answer}** でした。\n` +
      `ペナルティ: 出題者の得点から **-${FORCE_END_PENALTY}pt**（0未満にはなりません）`
  );

  scheduleNextFromQueue(ch);
}

// ---------- /quizcheck（自分が出題した問題の確認） ----------
// 答えが他の人に見えないよう、本人にだけ見える形で返信する。
async function checkQuiz(interaction) {
  const ch = interaction.channel;
 
  if (!interaction.inGuild() || !ch) {
    await interaction.reply({
      content: "このコマンドはbotが参加しているサーバーのチャンネルで使用してください。",
      flags: MessageFlags.Ephemeral
    });
    return;
  }
 
  const userId = interaction.user.id;
  const sections = [];
 
  // 出題中の問題（自分が出題者のときだけ）
  const game = games.get(ch.id);
  if (game && game.hostId === userId) {
    sections.push(
      "**出題中**\n" +
        `答え: **${game.answer}**\n` +
        `表示: ${game.render()}\n` +
        `開いた文字: ${game.openedCount()}/${game.labels.size} 種類 / 不正解: ${game.wrongCount} 回\n` +
        `現在の正解得点: ${game.points()}pt`
    );
  }
 
  // 順番待ちの問題（自分が出題したもの。順番つき）
  const queue = queues.get(ch.id) ?? [];
  const mine = queue
    .map((item, index) => ({ item, position: index + 1 }))
    .filter(({ item }) => item.hostId === userId);
 
  if (mine.length > 0) {
    sections.push(
      "**順番待ち**\n" +
        mine.map(({ item, position }) => `${position}番目: **${item.answer}**`).join("\n") +
        `\n（このチャンネルの順番待ち: 全 ${queue.length} 件）`
    );
  }
 
  await interaction.reply({
    content:
      sections.length > 0
        ? sections.join("\n\n")
        : "このチャンネルで、あなたが出題した問題（出題中・順番待ち）はありません。",
    flags: MessageFlags.Ephemeral
  });
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

  if (content === "sg!fuck") {
    await message.react("<:crying_uyuyu:1565519672864932021>").catch(() => {});
    return;
  }

  const isAnswer = content.startsWith("sg_");
  const isOpen = content === "sg!open" || content.startsWith("sg!open ");
  if (!isAnswer && !isOpen) return;

  const game = games.get(message.channel.id);
  if (!game) {
    const pending = pendingStarts.get(message.channel.id);
    if (pending) {
      const seconds = Math.max(1, Math.ceil((pending.startAt - Date.now()) / 1000));
      await replyTemp(message, `次のクイズは、約 ${seconds} 秒後に始まります。`, 5000);
      return;
    }

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

  // 直前にopenした人は、他の人がopenするか1分経過するまで回答・open不可
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

      const hostPts = Math.floor(game.hostPoints() * 1.5); // 出題者の得点（開いた文字数 + 不正解数）
      await addScore(message.guild.id, game.hostId, hostPts);

      await message.channel.send(
        `全ての文字が開きました。正解は: **${game.answer}**（正解者なし）\n` +
          `出題ポイント: <@${game.hostId}> **+${hostPts}pt**（${game.hostPointsDetail()}）`
      );
      scheduleNextFromQueue(message.channel);
      return;
    }

    await saveGame(message.channel.id, game);
    await message.reply(
      `open: ${circled(n)}（${message.author} は1分間 or 他の人がopenするまで回答・open不可）\n` +
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
    scheduleNextFromQueue(message.channel);
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
client.once("clientReady", async () => {
  console.log(
    `ログインしました。username=${client.user.username}, globalName=${client.user.globalName}, displayName=${client.user.displayName}`
  );

  // 再起動の前に順番待ちが残っていて、進行中のクイズがないチャンネルは、次の問題を開始する
  for (const channelId of [...queues.keys()]) {
    if (games.has(channelId)) continue;

    const ch = await client.channels.fetch(channelId).catch(() => null);

    if (ch) {
      scheduleNextFromQueue(ch);
      continue;
    }

    // チャンネルが削除されているなど、投稿できない場合は、順番待ちを破棄する
    for (const item of queues.get(channelId) ?? []) {
      await removeQueuedDb(item.id);
      await releaseSong(item.guildId, normText(item.answer));
    }
    queues.delete(channelId);
  }
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
            "`/quiz songname` クイズを開始（出題者用。進行中なら順番待ちに追加）\n" +
            "`/quizend` クイズを強制終了（出題者用・ペナルティあり）\n" +
            "`/quizcheck` 自分が出題した問題を確認\n" +
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
  } else if (interaction.commandName === "quizend") {
    await endQuiz(interaction);
  } else if (interaction.commandName === "quizcheck") {
    await checkQuiz(interaction);
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
