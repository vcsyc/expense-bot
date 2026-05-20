require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { google } = require('googleapis');
const axios = require('axios');

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

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
const sessions = {};

const CATEGORIES = [
  { label: '🍔 Food',        data: 'cat_food'        },
  { label: '🚗 Transport',   data: 'cat_transport'   },
  { label: '🏢 Office',      data: 'cat_office'      },
  { label: '🛠 Maintenance', data: 'cat_maintenance' },
  { label: '🎉 Events',      data: 'cat_events'      },
  { label: '📦 Other',       data: 'cat_other'       },
];

const categoryKeyboard = () => ({
  inline_keyboard: [
    CATEGORIES.slice(0, 2).map(c => ({ text: c.label, callback_data: c.data })),
    CATEGORIES.slice(2, 4).map(c => ({ text: c.label, callback_data: c.data })),
    CATEGORIES.slice(4, 6).map(c => ({ text: c.label, callback_data: c.data })),
  ]
});

const currencyKeyboard = () => ({
  inline_keyboard: [[
    { text: 'GEL', callback_data: 'cur_GEL' },
    { text: 'USD', callback_data: 'cur_USD' },
    { text: 'EUR', callback_data: 'cur_EUR' },
  ]]
});

const skipKeyboard = (action) => ({
  inline_keyboard: [[{ text: '⏭ Skip', callback_data: 'skip_' + action }]]
});

const getCategoryLabel = (data) => {
  const cat = CATEGORIES.find(c => c.data === data);
  return cat ? cat.label : data;
};

bot.onText(/\/start/, (msg) => {
  const name = msg.from.first_name || 'there';
  bot.sendMessage(msg.chat.id,
    '👋 Hi *' + name + '*! Welcome to the Expense Tracker.\n\nTap /expense to log a new expense.\nTap /cancel at any time to cancel.',
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/expense/, (msg) => {
  const chatId = msg.chat.id;
  sessions[chatId] = {
    step: 'description',
    staffName: msg.from.first_name || 'Unknown',
  };
  bot.sendMessage(chatId,
    '🛒 *Step 1 of 6* — What did you buy?\n\nType a short description:',
    { parse_mode: 'Markdown', reply_markup: { remove_keyboard: true } }
  );
});

bot.onText(/\/cancel/, (msg) => {
  delete sessions[msg.chat.id];
  bot.sendMessage(msg.chat.id, '❌ Cancelled. Use /expense to start again.');
});

bot.on('message', async (msg) => {
  const chatId  = msg.chat.id;
  const session = sessions[chatId];
  if (!session) return;
  if (msg.text && msg.text.startsWith('/')) return;

  if (session.step === 'description') {
    if (!msg.text || !msg.text.trim()) {
      bot.sendMessage(chatId, '⚠️ Please type a description.');
      return;
    }
    session.description = msg.text.trim();
    session.step = 'category';
    bot.sendMessage(chatId,
      '📂 *Step 2 of 6* — Choose a category:',
      { parse_mode: 'Markdown', reply_markup: categoryKeyboard() }
    );

  } else if (session.step === 'amount') {
    const amount = parseFloat(msg.text.trim().replace(',', '.'));
    if (isNaN(amount) || amount <= 0) {
      bot.sendMessage(chatId, '⚠️ Please enter a valid number, e.g. *45.50*', { parse_mode: 'Markdown' });
      return;
    }
    session.amount = amount;
    session.step = 'currency';
    bot.sendMessage(chatId,
      '💱 *Step 4 of 6* — Choose currency:',
      { parse_mode: 'Markdown', reply_markup: currencyKeyboard() }
    );

  } else if (session.step === 'comment') {
    session.comment = msg.text.trim();
    session.step = 'photo';
    bot.sendMessage(chatId,
      '📷 *Step 6 of 6* — Upload a receipt photo\n\nSend a photo or tap Skip.',
      { parse_mode: 'Markdown', reply_markup: skipKeyboard('photo') }
    );

  } else if (session.step === 'photo') {
    if (msg.photo) {
      await handlePhoto(chatId, msg, session);
    } else {
      bot.sendMessage(chatId,
        '⚠️ Please send a *photo* or tap *Skip*.',
        { parse_mode: 'Markdown', reply_markup: skipKeyboard('photo') }
      );
    }
  }
});

bot.on('callback_query', async (query) => {
  const chatId  = query.message.chat.id;
  const data    = query.data;
  const session = sessions[chatId];

  bot.answerCallbackQuery(query.id);

  if (!session) {
    bot.sendMessage(chatId, '⚠️ Session expired. Use /expense to start again.');
    return;
  }

  if (data.startsWith('cat_') && session.step === 'category') {
    session.category = getCategoryLabel(data);
    session.step = 'amount';
    bot.editMessageText(
      '📂 Category: *' + session.category + '*',
      { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
    );
    bot.sendMessage(chatId,
      '💵 *Step 3 of 6* — How much did it cost?\n\nEnter the amount (e.g. 45.50):',
      { parse_mode: 'Markdown' }
    );

  } else if (data.startsWith('cur_') && session.step === 'currency') {
    session.currency = data.replace('cur_', '');
    session.step = 'comment';
    bot.editMessageText(
      '💱 Currency: *' + session.currency + '*',
      { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
    );
    bot.sendMessage(chatId,
      '💬 *Step 5 of 6* — Add a comment (optional)\n\nType a note or tap Skip.',
      { parse_mode: 'Markdown', reply_markup: skipKeyboard('comment') }
    );

  } else if (data === 'skip_comment' && session.step === 'comment') {
    session.comment = '';
    session.step = 'photo';
    bot.editMessageText(
      '💬 No comment.',
      { chat_id: chatId, message_id: query.message.message_id }
    );
    bot.sendMessage(chatId,
      '📷 *Step 6 of 6* — Upload a receipt photo\n\nSend a photo or tap Skip.',
      { parse_mode: 'Markdown', reply_markup: skipKeyboard('photo') }
    );

  } else if (data === 'skip_photo' && session.step === 'photo') {
    session.photoLink = '';
    bot.editMessageText(
      '📷 No photo.',
      { chat_id: chatId, message_id: query.message.message_id }
    );
    await saveExpense(chatId, session);
  }
});

async function handlePhoto(chatId, msg, session) {
  try {
    bot.sendMessage(chatId, '⏳ Uploading photo...');
    const fileId  = msg.photo[msg.photo.length - 1].file_id;
    const fileUrl = await bot.getFileLink(fileId);
    const response = await axios.get(fileUrl, { responseType: 'stream' });

    const driveRes = await drive.files.create({
      requestBody: { name: 'receipt_' + Date.now() + '.jpg', mimeType: 'image/jpeg' },
      media: { mimeType: 'image/jpeg', body: response.data },
    });
    await drive.permissions.create({
      fileId: driveRes.data.id,
      requestBody: { role: 'reader', type: 'anyone' },
    });
    session.photoLink = 'https://drive.google.com/file/d/' + driveRes.data.id + '/view';
  } catch (err) {
    console.error('Photo error:', err);
    session.photoLink = '';
    bot.sendMessage(chatId, '⚠️ Photo upload failed, saving without photo.');
  }
  await saveExpense(chatId, session);
}

async function saveExpense(chatId, session) {
  const date = new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Tbilisi',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const row = [
    date,
    session.staffName,
    session.description,
    session.category,
    session.amount,
    session.currency,
    session.comment || '',
    session.photoLink || '',
  ];

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: 'Sheet1!A:H',
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [row] },
    });

    bot.sendMessage(chatId,
      '✅ *Expense saved!*\n\n' +
      '🛒 ' + session.description + '\n' +
      '📂 ' + session.category + '\n' +
      '💵 ' + session.amount + ' ' + session.currency + '\n' +
      '💬 ' + (session.comment || 'No comment') + '\n' +
      '📷 ' + (session.photoLink ? '[View Receipt](' + session.photoLink + ')' : 'No photo') + '\n\n' +
      'Use /expense to log another.',
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
  } catch (err) {
    console.error('Sheets error:', err);
    bot.sendMessage(chatId, '❌ Failed to save. Please try again with /expense.');
  }

  delete sessions[chatId];
}

console.log('🤖 Expense bot is running...');


// Keep Render web service alive
const http = require('http');
http.createServer((req, res) => res.end('Bot is running!')).listen(process.env.PORT || 3000);
