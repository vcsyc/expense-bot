require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const axios = require('axios');
const fs = require('fs');

// ─── Init Bot ─────────────────────────────────────────────────────────────────
const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

// ─── Google Sheets Auth ───────────────────────────────────────────────────────
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS),
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive',
  ],
});
const sheets = google.sheets({ version: 'v4', auth });
const drive  = google.drive({ version: 'v3', auth });

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;

// ─── Session storage (in-memory) ──────────────────────────────────────────────
// sessions[chatId] = { step, name, description, category, amount, currency, photoLink }
const sessions = {};

// ─── Categories ───────────────────────────────────────────────────────────────
const CATEGORIES = [
  { label: '🍔 Food',         data: 'cat_food'        },
  { label: '🚗 Transport',    data: 'cat_transport'   },
  { label: '🏢 Office',       data: 'cat_office'      },
  { label: '🛠 Maintenance',  data: 'cat_maintenance' },
  { label: '🎉 Events',       data: 'cat_events'      },
  { label: '📦 Other',        data: 'cat_other'       },
];

const CURRENCIES = [
  [{ text: 'GEL', callback_data: 'cur_GEL' }, { text: 'USD', callback_data: 'cur_USD' }, { text: 'EUR', callback_data: 'cur_EUR' }]
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function categoryKeyboard() {
  return {
    inline_keyboard: [
      CATEGORIES.slice(0, 2).map(c => ({ text: c.label, callback_data: c.data })),
      CATEGORIES.slice(2, 4).map(c => ({ text: c.label, callback_data: c.data })),
      CATEGORIES.slice(4, 6).map(c => ({ text: c.label, callback_data: c.data })),
    ]
  };
}

function currencyKeyboard() {
  return { inline_keyboard: CURRENCIES };
}

function skipKeyboard() {
  return { inline_keyboard: [[{ text: '⏭ Skip', callback_data: 'skip_photo' }]] };
}

function getLabelFromData(data) {
  const cat = CATEGORIES.find(c => c.data === data);
  return cat ? cat.label : data;
}

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const name = msg.from.first_name || 'there';
  bot.sendMessage(msg.chat.id,
    `👋 Hi ${name}! Welcome to the *Expense Tracker*.\n\nUse /expense to log a new expense.\nUse /cancel at any time to cancel.`,
    { parse_mode: 'Markdown' }
  );
});

// ─── /expense ─────────────────────────────────────────────────────────────────
bot.onText(/\/expense/, (msg) => {
  const chatId = msg.chat.id;
  sessions[chatId] = { step: 'description' };
  bot.sendMessage(chatId, '🛒 *What did you buy?*\n\nType a short description (e.g. "Printer paper")', {
    parse_mode: 'Markdown',
    reply_markup: { remove_keyboard: true }
  });
});

// ─── /cancel ──────────────────────────────────────────────────────────────────
bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  delete sessions[chatId];
  bot.sendMessage(chatId, '❌ Cancelled. Use /expense to start again.', {
    reply_markup: { remove_keyboard: true }
  });
});

// ─── Text messages ────────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];

  // Ignore if no session or if it's a command
  if (!session) return;
  if (msg.text && msg.text.startsWith('/')) return;

  // ── Step: description ──
  if (session.step === 'description') {
    if (!msg.text || msg.text.trim() === '') {
      bot.sendMessage(chatId, '⚠️ Please type a description.');
      return;
    }
    session.description = msg.text.trim();
    session.step = 'category';
    bot.sendMessage(chatId, '📂 *Choose a category:*', {
      parse_mode: 'Markdown',
      reply_markup: categoryKeyboard()
    });

  // ── Step: amount ──
  } else if (session.step === 'amount') {
    const amount = parseFloat(msg.text.trim().replace(',', '.'));
    if (isNaN(amount) || amount <= 0) {
      bot.sendMessage(chatId, '⚠️ Please enter a valid amount, e.g. *45.50*', { parse_mode: 'Markdown' });
      return;
    }
    session.amount = amount;
    session.step = 'currency';
    bot.sendMessage(chatId, '💱 *Choose currency:*', {
      parse_mode: 'Markdown',
      reply_markup: currencyKeyboard()
    });

  // ── Step: photo ──
  } else if (session.step === 'photo') {
    if (msg.photo) {
      await handlePhoto(chatId, msg, session);
    } else {
      bot.sendMessage(chatId, '⚠️ Please send a *photo* or tap *Skip*.', {
        parse_mode: 'Markdown',
        reply_markup: skipKeyboard()
      });
    }
  }
});

// ─── Callback queries (button taps) ───────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data   = query.data;
  const session = sessions[chatId];

  // Always answer to remove spinner
  bot.answerCallbackQuery(query.id);

  if (!session) {
    bot.sendMessage(chatId, '⚠️ Session expired. Use /expense to start again.');
    return;
  }

  // ── Category selected ──
  if (data.startsWith('cat_') && session.step === 'category') {
    session.category = getLabelFromData(data);
    session.step = 'amount';
    bot.editMessageText(
      `📂 Category: *${session.category}*`,
      { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
    );
    bot.sendMessage(chatId, '💵 *How much did it cost?*\n\nEnter the amount (e.g. 45.50)', {
      parse_mode: 'Markdown'
    });

  // ── Currency selected ──
  } else if (data.startsWith('cur_') && session.step === 'currency') {
    session.currency = data.replace('cur_', '');
    session.step = 'photo';
    bot.editMessageText(
      `💱 Currency: *${session.currency}*`,
      { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
    );
    bot.sendMessage(chatId, '📷 *Upload a receipt photo*\n\nSend a photo or tap Skip.', {
      parse_mode: 'Markdown',
      reply_markup: skipKeyboard()
    });

  // ── Skip photo ──
  } else if (data === 'skip_photo' && session.step === 'photo') {
    session.photoLink = '';
    bot.editMessageText(
      '📷 No photo.',
      { chat_id: chatId, message_id: query.message.message_id }
    );
    await saveExpense(chatId, session);
  }
});

// ─── Handle photo upload ───────────────────────────────────────────────────────
async function handlePhoto(chatId, msg, session) {
  try {
    bot.sendMessage(chatId, '⏳ Uploading photo...');
    const fileId  = msg.photo[msg.photo.length - 1].file_id;
    const fileUrl = await bot.getFileLink(fileId);

    const response = await axios.get(fileUrl, { responseType: 'stream' });
    const fileName = `receipt_${Date.now()}.jpg`;

    const driveRes = await drive.files.create({
      requestBody: { name: fileName, mimeType: 'image/jpeg' },
      media: { mimeType: 'image/jpeg', body: response.data },
    });

    await drive.permissions.create({
      fileId: driveRes.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
    });

    session.photoLink = `https://drive.google.com/file/d/${driveRes.data.id}/view`;
  } catch (err) {
    console.error('Photo upload error:', err);
    session.photoLink = '';
    bot.sendMessage(chatId, '⚠️ Photo upload failed, saving without photo.');
  }

  await saveExpense(chatId, session);
}

// ─── Save to Google Sheets ────────────────────────────────────────────────────
async function saveExpense(chatId, session) {
  const date = new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Tbilisi',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });

  const staffName = session.staffName || 'Unknown';

  const row = [
    date,
    staffName,
    session.description,
    session.category,
    session.amount,
    session.currency,
    session.photoLink || '',
  ];

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sheet1!A:G',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });

    bot.sendMessage(chatId,
      `✅ *Expense saved!*\n\n` +
      `🛒 ${session.description}\n` +
      `📂 ${session.category}\n` +
      `💵 ${session.amount} ${session.currency}\n` +
      `📷 ${session.photoLink ? '[View Receipt](' + session.photoLink + ')' : 'No photo'}\n\n` +
      `Use /expense to log another.`,
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
  } catch (err) {
    console.error('Sheets error:', err);
    bot.sendMessage(chatId, '❌ Failed to save to Google Sheets. Please try again with /expense.');
  }

  delete sessions[chatId];
}

console.log('🤖 Expense bot is running...');
