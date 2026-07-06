const { Client, GatewayIntentBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, Partials } = require('discord.js');
const { createClient } = require('@supabase/supabase-js');

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Channel],
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const DEAL_CHANNEL_ID       = process.env.DEAL_CHANNEL_ID;
const DAILY_LB_CHANNEL_ID   = process.env.DAILY_LB_CHANNEL_ID;
const WEEKLY_LB_CHANNEL_ID  = process.env.WEEKLY_LB_CHANNEL_ID;
const MONTHLY_LB_CHANNEL_ID = process.env.MONTHLY_LB_CHANNEL_ID;

let lbMessageIds = { daily: null, weekly: null, monthly: null };
let lbOffsets    = { daily: 0,    weekly: 0,    monthly: 0 };

// ============================================================
// DEAL SIGNALS
// ============================================================
const DEAL_SIGNALS = [
  'americo','ethos','aetna','transamerica','chubb','lincoln',
  'mutual of omaha','foresters','sbli','corebridge','kemper',
  'gerber','nationwide','prudential','john hancock','pacific life',
  'paclife','aig','royal neighbors','security benefit','five star',
  'amam','siwl','giwl','sgiwl','gsiwl','freakos','freakohoes',
  'frankos','moo','iul','rtd',' lp ',' ap ','term ','whole life',
  'max fund','select ','uw','uwed','immediate','imm ','approved',
  'submitted','issued','placed','inforce','graded','preferred',
  ' bob ',' ta ','trans ','tranz',
  '🐮','🦅','💜','💚','🏳️‍⚧️','🦠','🐣','🐥',
];

function hasDollarSign(content) {
  return /[\$#]\s*\d/.test(content) || /\d\s*\$/.test(content);
}

function hasDealSignal(content) {
  const lower = ' ' + content.toLowerCase() + ' ';
  return DEAL_SIGNALS.some(s => lower.includes(s));
}

// "1500 test", "2500 john smith" — message starts with an amount and has
// anything after it. A bare number alone ("1500" / "2026") does NOT count.
function startsWithAmount(content) {
  const m = content.match(/^\s*(\d[\d,]*(?:\.\d{1,2})?)\s+\S/);
  if (!m) return false;
  return valid(parseFloat(m[1].replace(/,/g, '')));
}

function looksLikeADeal(content, amounts) {
  if (amounts.length === 0) return false;
  if (hasDollarSign(content)) return true;
  if (startsWithAmount(content)) return true;
  return hasDealSignal(content);
}

function parseAllAmounts(content) {
  const found = new Set();
  if (!content) return [];

  // $2026 / #2026 — always valid, years included
  const reBefore = /[\$#]\s*(\d[\d,]*(?:\.\d{1,2})?)/g;
  let m;
  while ((m = reBefore.exec(content)) !== null) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (valid(n)) found.add(n);
  }

  // 2026$ — always valid
  const reAfter = /(\d[\d,]*(?:\.\d{1,2})?)\s*\$/g;
  while ((m = reAfter.exec(content)) !== null) {
    const n = parseFloat(m[1].replace(/,/g, ''));
    if (valid(n)) found.add(n);
  }

  // Standalone numbers — when the message has a deal signal OR starts with an amount.
  // "2026 americo" logs. A year inside a written date (7/6/2026) is skipped.
  if (found.size === 0 && (hasDealSignal(content) || startsWithAmount(content))) {
    const reStandalone = /(?<![.\d])(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d{3,}(?:\.\d{1,2})?)(?![.\d])/g;
    while ((m = reStandalone.exec(content)) !== null) {
      const n = parseFloat(m[1].replace(/,/g, ''));
      if (!valid(n)) continue;
      if (isDatePart(content, m.index, m[0].length, n)) continue;
      found.add(n);
    }
  }

  return [...found];
}

function valid(n) {
  return !isNaN(n) && n >= 100 && n <= 50000;
}

// Skip year-like numbers only when they're glued to a date: 7/6/2026 or 2026-07-06
function isDatePart(content, index, length, n) {
  if (!(Number.isInteger(n) && n >= 2020 && n <= 2035)) return false;
  const before = content[index - 1];
  const after = content[index + length];
  return before === '/' || before === '-' || after === '/' || after === '-';
}

// ============================================================
// DATE RANGE
// ============================================================
function getDateRange(period, offset = 0) {
  const now = new Date();

  if (period === 'daily') {
    const start = new Date(now);
    start.setDate(start.getDate() + offset);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    const isLive = offset === 0;
    const dateStr = start.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
    });
    const label = isLive ? `Today — ${dateStr}` : dateStr;
    return { start, end, label, isLive };
  }

  if (period === 'weekly') {
    const ref = new Date(now);
    ref.setDate(ref.getDate() + offset * 7);
    const start = new Date(ref);
    start.setDate(start.getDate() - start.getDay());
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    const isLive = offset === 0;
    const startStr = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const endStr = end.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    return { start, end, label: `Week of ${startStr} – ${endStr}`, isLive };
  }

  if (period === 'monthly') {
    const ref = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const start = new Date(ref.getFullYear(), ref.getMonth(), 1);
    const end = new Date(ref.getFullYear(), ref.getMonth() + 1, 0, 23, 59, 59, 999);
    const isLive = offset === 0;
    const label = start.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    return { start, end, label, isLive };
  }
}

// ============================================================
// CHECK IF PREVIOUS PERIOD HAS DATA
// ============================================================
async function hasPreviousData(period, offset) {
  const { start, end } = getDateRange(period, offset - 1);
  const { count } = await supabase
    .from('deals')
    .select('id', { count: 'exact', head: true })
    .gte('posted_at', start.toISOString())
    .lte('posted_at', end.toISOString());
  return (count || 0) > 0;
}

// ============================================================
// BUILD LEADERBOARD TEXT
// ============================================================
async function buildLeaderboard(period, offset = 0) {
  const { start, end, label, isLive } = getDateRange(period, offset);

  let allDeals = [];
  let from = 0;
  const PAGE_SIZE = 1000;
  while (true) {
    const { data, error } = await supabase
      .from('deals')
      .select('discord_id, amount')
      .gte('posted_at', start.toISOString())
      .lte('posted_at', end.toISOString())
      .range(from, from + PAGE_SIZE - 1);
    if (error || !data || data.length === 0) break;
    allDeals = allDeals.concat(data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  if (allDeals.length === 0) {
    const periodTitle = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };
    return [
      `🏆 __**Elite Capital Top Producers**__ | ${periodTitle[period]}`,
      `📅 ${label}`,
      ``,
      `*No deals posted yet — let's get to work!* 💪`
    ].join('\n');
  }

  const map = {};
  allDeals.forEach(d => {
    if (!map[d.discord_id]) map[d.discord_id] = { total: 0, count: 0 };
    map[d.discord_id].total += parseFloat(d.amount);
    map[d.discord_id].count++;
  });

  const periodTitle = { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' };

  const ids = Object.keys(map);
  const { data: users } = await supabase
    .from('users')
    .select('discord_id, display_name')
    .in('discord_id', ids);

  const userMap = {};
  (users || []).forEach(u => userMap[u.discord_id] = u.display_name);

  const allAgents = Object.entries(map)
    .map(([id, stats]) => ({
      id, ...stats,
      name: userMap[id] || 'Unknown'
    }))
    .sort((a, b) => b.total - a.total);

  const sorted = allAgents.slice(0, 25);

  const agencyTotal = allAgents.reduce((s, u) => s + u.total, 0);
  const agencyDeals = allAgents.reduce((s, u) => s + u.count, 0);

  const rankIcon = (i) => ['👑','🥈','🥉'][i] || `${i + 1}.`;

  let lines = [];
  lines.push(`🏆 __**Elite Capital Top Producers**__ | ${periodTitle[period]}`);
  lines.push(`📅 ${label}`);
  lines.push(`**▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬**`);

  sorted.forEach((u, i) => {
    const name = u.name.length > 22 ? u.name.slice(0, 21) + '…' : u.name;
    const total = `$${Math.round(u.total).toLocaleString()}`;
    const deals = `${u.count} deal${u.count !== 1 ? 's' : ''}`;
    lines.push(`${rankIcon(i)} **${name}** — ${total} | ${deals}`);
  });

  lines.push(`**▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬**`);
  lines.push(`💰 **Total: $${Math.round(agencyTotal).toLocaleString()}** | ${agencyDeals} deals`);
  if (isLive) {
    lines.push(`*Updated ${new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}*`);
  }

  return lines.join('\n');
}

// ============================================================
// BUILD BUTTONS
// ============================================================
async function buildButtons(period, offset) {
  const isLive = offset === 0;
  const prevHasData = await hasPreviousData(period, offset);

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`lb_prev_${period}`)
      .setLabel('◀ Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!prevHasData),
    new ButtonBuilder()
      .setCustomId(`lb_next_${period}`)
      .setLabel('Next ▶')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isLive),
  );
}

// ============================================================
// POST OR EDIT LEADERBOARD
// ============================================================
async function updateLeaderboard(period, offset = null) {
  const channelIds = {
    daily:   DAILY_LB_CHANNEL_ID,
    weekly:  WEEKLY_LB_CHANNEL_ID,
    monthly: MONTHLY_LB_CHANNEL_ID,
  };
  const channelId = channelIds[period];
  if (!channelId) return;

  if (offset === null) offset = lbOffsets[period];

  try {
    const channel = await discord.channels.fetch(channelId);
    const content = await buildLeaderboard(period, offset);
    if (!content) return;

    const components = [await buildButtons(period, offset)];
    const payload = { content, components };

    if (lbMessageIds[period]) {
      try {
        const msg = await channel.messages.fetch(lbMessageIds[period]);
        await msg.edit(payload);
        return;
      } catch(e) {
        lbMessageIds[period] = null;
      }
    }

    const recent = await channel.messages.fetch({ limit: 50 });
    const existing = recent.find(m => m.author.id === discord.user.id && m.components?.length > 0);
    if (existing) {
      await existing.edit(payload);
      lbMessageIds[period] = existing.id;
      return;
    }

    const sent = await channel.send(payload);
    lbMessageIds[period] = sent.id;
    try { await sent.pin(); } catch(e) {}
  } catch(e) {
    console.error(`LB error (${period}):`, e.message);
  }
}

async function updateAllLeaderboards() {
  await Promise.all([
    updateLeaderboard('daily'),
    updateLeaderboard('weekly'),
    updateLeaderboard('monthly'),
  ]);
}

// ============================================================
// BUTTON INTERACTIONS
// ============================================================
discord.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;
  const { customId } = interaction;
  if (!customId.startsWith('lb_')) return;

  const parts = customId.split('_');
  const action = parts[1];
  const period = parts[2];

  if (action === 'prev') lbOffsets[period] -= 1;
  if (action === 'next' && lbOffsets[period] < 0) lbOffsets[period] += 1;

  try {
    await interaction.deferUpdate();
  } catch(e) {
    console.log(`⚠️ Interaction expired for ${customId} — updating anyway`);
  }

  try {
    await updateLeaderboard(period, lbOffsets[period]);
  } catch(e) {
    console.error(`LB update error:`, e.message);
  }
});

// ============================================================
// DB HELPERS
// ============================================================
async function upsertUser(message) {
  try {
    let displayName = message.author.username;
    let avatar = message.author.displayAvatarURL();
    try {
      const member = message.member || await message.guild?.members.fetch(message.author.id);
      if (member) {
        displayName = member.nickname || member.displayName || message.author.username;
        avatar = member.displayAvatarURL() || message.author.displayAvatarURL();
      }
    } catch(e) {}

    await supabase.from('users').upsert({
      discord_id: message.author.id,
      username: message.author.username,
      display_name: displayName,
      avatar,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'discord_id' });
  } catch(e) { console.error('upsertUser:', e.message); }
}

async function logDeals(message, amounts) {
  let logged = 0;
  for (let i = 0; i < amounts.length; i++) {
    const { error } = await supabase.from('deals').insert({
      discord_id: message.author.id,
      amount: amounts[i],
      message_id: `${message.id}-${i}`,
      message_url: message.url,
      posted_at: message.createdAt.toISOString(),
    });
    if (!error) logged++;
  }
  return logged;
}

// ============================================================
// BACKFILL
// ============================================================
async function backfill(channel) {
  console.log('🔄 Starting backfill...');
  let before = null;
  let totalDeals = 0;
  let msgCount = 0;

  while (true) {
    const opts = { limit: 100 };
    if (before) opts.before = before;
    let messages;
    try { messages = await channel.messages.fetch(opts); }
    catch(e) { console.error('fetch error:', e.message); break; }
    if (messages.size === 0) break;

    for (const msg of messages.values()) {
      if (msg.author.bot) continue;
      const amounts = parseAllAmounts(msg.content);
      if (!looksLikeADeal(msg.content, amounts)) continue;
      await upsertUser(msg);
      totalDeals += await logDeals(msg, amounts);
      msgCount++;
    }

    console.log(`📦 ${msgCount} deal msgs → ${totalDeals} deals logged...`);
    before = messages.last().id;
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`✅ Backfill complete! ${totalDeals} deals from ${msgCount} messages.`);
  await updateAllLeaderboards();
}

// ============================================================
// MESSAGE DELETE
// ============================================================
discord.on('messageDelete', async (message) => {
  if (message.channelId !== DEAL_CHANNEL_ID) return;

  const { error } = await supabase
    .from('deals')
    .delete()
    .like('message_id', `${message.id}%`);

  if (!error) {
    console.log(`🗑️ Removed deals for deleted message ${message.id}`);
    await Promise.all([
      lbOffsets.daily   === 0 ? updateLeaderboard('daily')   : null,
      lbOffsets.weekly  === 0 ? updateLeaderboard('weekly')  : null,
      lbOffsets.monthly === 0 ? updateLeaderboard('monthly') : null,
    ].filter(Boolean));
  }
});

// ============================================================
// MESSAGE EDIT
// ============================================================
discord.on('messageUpdate', async (oldMessage, newMessage) => {
  if (newMessage.partial) {
    try { newMessage = await newMessage.fetch(); } catch(e) { return; }
  }
  if (newMessage.channelId !== DEAL_CHANNEL_ID) return;
  if (newMessage.author?.bot) return;

  await supabase
    .from('deals')
    .delete()
    .like('message_id', `${newMessage.id}%`);

  const content = newMessage.content || '';
  const amounts = parseAllAmounts(content);

  if (looksLikeADeal(content, amounts)) {
    await upsertUser(newMessage);
    const logged = await logDeals(newMessage, amounts);
    if (logged > 0) {
      console.log(`✏️ Re-logged ${logged} deal(s) for edited message ${newMessage.id}`);
    }
  }

  await Promise.all([
    lbOffsets.daily   === 0 ? updateLeaderboard('daily')   : null,
    lbOffsets.weekly  === 0 ? updateLeaderboard('weekly')  : null,
    lbOffsets.monthly === 0 ? updateLeaderboard('monthly') : null,
  ].filter(Boolean));
});

// ============================================================
// MIDNIGHT RESET
// ============================================================
function scheduleMidnightReset() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setDate(midnight.getDate() + 1);
  midnight.setHours(0, 0, 0, 0);
  const ms = midnight - now;

  setTimeout(async () => {
    console.log('🌙 Midnight reset');
    lbOffsets = { daily: 0, weekly: 0, monthly: 0 };
    await updateAllLeaderboards();
    scheduleMidnightReset();
  }, ms);
}

// ============================================================
// BOT EVENTS
// ============================================================
discord.on('ready', async () => {
  console.log(`✅ Elite Capital Bot online as ${discord.user.tag}`);
  await updateAllLeaderboards();
  const channel = await discord.channels.fetch(DEAL_CHANNEL_ID);
  await backfill(channel);
  scheduleMidnightReset();
});

discord.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== DEAL_CHANNEL_ID) return;

  const amounts = parseAllAmounts(message.content);
  if (!looksLikeADeal(message.content, amounts)) return;

  await upsertUser(message);
  const logged = await logDeals(message, amounts);

  if (logged > 0) {
    try { await message.react('✅'); } catch(e) {}
    const total = amounts.reduce((s, n) => s + n, 0);
    console.log(`✅ ${message.author.username}: ${logged} deal(s) — $${total.toLocaleString()}`);
    await Promise.all([
      lbOffsets.daily   === 0 ? updateLeaderboard('daily')   : null,
      lbOffsets.weekly  === 0 ? updateLeaderboard('weekly')  : null,
      lbOffsets.monthly === 0 ? updateLeaderboard('monthly') : null,
    ].filter(Boolean));
  }
});

discord.login(process.env.DISCORD_TOKEN);
