// ============================================================
// ELITE CAPITAL SALES BOT
// Discord deal tracker + daily/weekly/monthly leaderboards
// Same architecture as foundation-agency bot (Railway + Supabase)
// ============================================================

const { Client, GatewayIntentBits, EmbedBuilder, Partials } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');
const cron = require('node-cron');

// ---------- ENV ----------
const {
  DISCORD_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  DEAL_CHANNEL_ID,
  DAILY_LB_CHANNEL_ID,
  WEEKLY_LB_CHANNEL_ID,
  MONTHLY_LB_CHANNEL_ID,
} = process.env;

// TZ=America/New_York must be set in Railway env vars so all
// Date math below resolves to Eastern Time.

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel],
});

// ---------- DEAL PARSING ----------
// Accepts: "$1,500" | "1500" | "AP: $1,234.56" | "sold 2500 whole life"
// Takes the FIRST dollar amount found. Adjust MIN/MAX to filter noise.
const MIN_DEAL = 50;
const MAX_DEAL = 100000;

function parseAmount(content) {
  if (!content) return null;
  const match = content.match(/\$?\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/);
  if (!match) return null;
  const whole = match[1].replace(/,/g, '');
  const amount = parseFloat(whole + (match[2] ? '.' + match[2] : ''));
  if (isNaN(amount) || amount < MIN_DEAL || amount > MAX_DEAL) return null;
  return amount;
}

function displayNameOf(message) {
  // member.nickname first (guild display name), fall back to global
  return (
    message.member?.nickname ||
    message.member?.displayName ||
    message.author.globalName ||
    message.author.username
  );
}

// ---------- SAVE ----------
async function saveDeal(message) {
  const amount = parseAmount(message.content);
  if (amount === null) return false;

  const row = {
    message_id: message.id,
    user_id: message.author.id,
    display_name: displayNameOf(message),
    amount,
    posted_at: new Date(message.createdTimestamp).toISOString(),
    raw_content: message.content.slice(0, 500),
  };

  // unique message_id constraint = duplicate-safe
  const { error } = await supabase
    .from('deals')
    .upsert(row, { onConflict: 'message_id', ignoreDuplicates: true });

  if (error) {
    console.error('saveDeal error:', error.message);
    return false;
  }

  // keep users table fresh
  await supabase.from('users').upsert(
    { user_id: row.user_id, display_name: row.display_name, updated_at: new Date().toISOString() },
    { onConflict: 'user_id' }
  );

  return true;
}

// ---------- BACKFILL ----------
// Runs on every restart. Walks the deal channel backwards,
// upserts everything, skips duplicates via message_id constraint.
const BACKFILL_MAX_MESSAGES = 5000;

async function backfill() {
  try {
    const channel = await client.channels.fetch(DEAL_CHANNEL_ID);
    let before = undefined;
    let scanned = 0;
    let saved = 0;

    while (scanned < BACKFILL_MAX_MESSAGES) {
      const batch = await channel.messages.fetch({ limit: 100, before });
      if (batch.size === 0) break;

      for (const msg of batch.values()) {
        if (msg.author.bot) continue;
        if (await saveDeal(msg)) saved++;
      }

      scanned += batch.size;
      before = batch.last().id;
    }
    console.log(`Backfill complete: scanned ${scanned}, saved/updated ${saved}`);
  } catch (e) {
    console.error('Backfill failed:', e.message);
  }
}

// ---------- PERIOD MATH (Eastern Time via TZ env) ----------
function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function startOfWeek() {
  // Week starts Monday
  const d = startOfToday();
  const day = d.getDay(); // 0=Sun
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d;
}
function startOfMonth() {
  const d = startOfToday();
  d.setDate(1);
  return d;
}

// ---------- LEADERBOARD ----------
async function fetchDealsSince(startISO) {
  // paginate past Supabase's 1000-row limit
  let all = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('deals')
      .select('user_id, display_name, amount')
      .gte('posted_at', startISO)
      .range(from, from + PAGE - 1);
    if (error) {
      console.error('fetchDeals error:', error.message);
      break;
    }
    all = all.concat(data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

function aggregate(deals) {
  const map = new Map();
  for (const deal of deals) {
    const cur = map.get(deal.user_id) || { name: deal.display_name, total: 0, count: 0 };
    cur.total += Number(deal.amount);
    cur.count += 1;
    cur.name = deal.display_name || cur.name;
    map.set(deal.user_id, cur);
  }
  return [...map.values()].sort((a, b) => b.total - a.total);
}

const fmtUSD = (n) =>
  '$' + Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

function buildEmbed(title, rows) {
  const medals = ['👑', '🥈', '🥉'];
  const lines = rows.slice(0, 10).map((row, i) => {
    const badge = medals[i] || `**${i + 1}.**`;
    return `${badge} ${row.name} — **${fmtUSD(row.total)}** (${row.count} deal${row.count === 1 ? '' : 's'})`;
  });

  const totalAP = rows.reduce((s, r) => s + r.total, 0);
  const totalDeals = rows.reduce((s, r) => s + r.count, 0);

  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(lines.length ? lines.join('\n') : '_No deals yet._')
    .setColor(0xc0c0c0) // Elite Capital silver
    .setFooter({ text: `Team total: ${fmtUSD(totalAP)} • ${totalDeals} deals` })
    .setTimestamp();
}

async function postLeaderboard(channelId, title, start) {
  try {
    const deals = await fetchDealsSince(start.toISOString());
    const rows = aggregate(deals);
    const channel = await client.channels.fetch(channelId);
    await channel.send({ embeds: [buildEmbed(title, rows)] });
    console.log(`Posted: ${title}`);
  } catch (e) {
    console.error(`postLeaderboard failed (${title}):`, e.message);
  }
}

// ---------- LIVE DEAL HANDLER ----------
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== DEAL_CHANNEL_ID) return;

  const ok = await saveDeal(message);
  if (ok) {
    try {
      await message.react('✅');
    } catch {}
  }
});

// keep names synced if someone edits their deal post
client.on('messageUpdate', async (_old, message) => {
  if (message.partial) {
    try { message = await message.fetch(); } catch { return; }
  }
  if (message.author?.bot) return;
  if (message.channelId !== DEAL_CHANNEL_ID) return;
  await saveDeal(message);
});

// ---------- SCHEDULES (Eastern via TZ env) ----------
// Daily LB  — every day 9:00 PM ET
cron.schedule('0 21 * * *', () =>
  postLeaderboard(DAILY_LB_CHANNEL_ID, "🏆 Elite Capital — Today's Leaderboard", startOfToday())
);
// Weekly LB — Sunday 9:00 PM ET (covers Mon–Sun)
cron.schedule('0 21 * * 0', () =>
  postLeaderboard(WEEKLY_LB_CHANNEL_ID, '🏆 Elite Capital — Weekly Leaderboard', startOfWeek())
);
// Monthly LB — last calendar day handled by posting on the 1st at 12:05 AM for prior month?
// Simpler + matches Blueprint behavior: post current-month standings daily at 9 PM on the 1st-of-month channel cadence.
// Default: 9:00 PM on the last day of each month via daily check:
cron.schedule('5 21 * * *', () => {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (tomorrow.getDate() === 1) {
    postLeaderboard(MONTHLY_LB_CHANNEL_ID, '🏆 Elite Capital — Monthly Leaderboard', startOfMonth());
  }
});

// ---------- BOOT ----------
client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await backfill();
});

client.login(DISCORD_TOKEN);
