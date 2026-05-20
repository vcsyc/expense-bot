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
  { label: '🍔 საკვები',       data: 'cat_food'        },
  { label: '🚗 ტრანსპორტი',   data: 'cat_transport'   },
  { label: '⛽️ საწვავი',      data: 'cat_fuel'        },
  { label: '🏢 ოფისი',        data: 'cat_office'      },
  { label: '🛠 შეკეთება',     data: 'cat_maintenance' },
  { label: '💡 შუქი',         data: 'cat_light'       },
  { label: '📦 ყუთები',       data: 'cat_boxes'       },
  { label: '💰 ხელფასი',      data: 'cat_salary'      },
  { label: '🔹 სხვა',         data: 'cat_other'       },
];

const SITES = [
  { label: '🌿 ტყაია', data: 'site_tqaia' },
  { label: '🌿 ზანა',  data: 'site_zana'  },
];

const categoryKeyboard = () => ({
  inline_keyboard: [
    CATEGORIES.slice(0, 2).map(c => ({ text: c.label, callback_data: c.data })),
    CATEGORIES.slice(2, 4).map(c => ({ text: c.label, callback_data: c.data })),
    CATEGORIES.slice(4, 6).map(c => ({ text: c.label, callback_data: c.data })),
    CATEGORIES.slice(6, 8).map(c => ({ text: c.label, callback_data: c.data })),
    CATEGORIES.slice(8, 9).map(c => ({ text: c.label, callback_data: c.data })),
  ]
});

const siteKeyboard = () => ({
  inline_keyboard: [
    SITES.map(s => ({ text: s.label, callback_data: s.data }))
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
  inline_keyboard: [[{ text: '⏭ გამოტოვება', callback_data: 'skip_' + action }]]
});

const getCategoryLabel = (data) => {
  const cat = CATEGORIES.find(c => c.data === data);
  return cat ? cat.label : data;
};

const getSiteLabel = (data) => {
  const site = SITES.find(s => s.data === data);
  return site ? site.label : data;
};

// /start
bot.onText(/\/start/, (msg) => {
  const name = msg.from.first_name || 'მომხმარებელო';
  bot.sendMessage(msg.chat.id,
    '👋 გამარჯობა *' + name + '*! მოგესალმებთ ხარჯების ტრეკერში.\n\nდააჭირეთ /expense ახალი ხარჯის დასამატებლად.\nდააჭირეთ /cancel გასაუქმებლად.',
    { parse_mode: 'Markdown' }
  );
});

// /expense
bot.onText(/\/expense/, (msg) => {
  const chatId = msg.chat.id;
  sessions[chatId] = {
    step: 'category',
    staffName: msg.from.first_name || 'უცნობი',
  };
  bot.sendMessage(chatId,
    '📂 *ნაბიჯი 1/6* — აირჩიეთ კატეგორია:',
    { parse_mode: 'Markdown', reply_markup: categoryKeyboard() }
  );
});

// /cancel
bot.onText(/\/cancel/, (msg) => {
  delete sessions[msg.chat.id];
  bot.sendMessage(msg.chat.id, '❌ გაუქმებულია. დააჭირეთ /expense თავიდან დასაწყებად.');
});

// Messages
bot.on('message', async (msg) => {
  const chatId  = msg.chat.id;
  const session = sessions[chatId];
  if (!session) return;
  if (msg.text && msg.text.startsWith('/')) return;

  // Step 3: Amount
  if (session.step === 'amount') {
    const amount = parseFloat(msg.text.trim().replace(',', '.'));
    if (isNaN(amount) || amount <= 0) {
      bot.sendMessage(chatId, '⚠️ გთხოვთ შეიყვანოთ სწორი რიცხვი, მაგ. *45.50*', { parse_mode: 'Markdown' });
      return;
    }
    session.amount = amount;
    session.step = 'currency';
    bot.sendMessage(chatId,
      '💱 *ნაბიჯი 4/6* — აირჩიეთ ვალუტა:',
      { parse_mode: 'Markdown', reply_markup: currencyKeyboard() }
    );

  // Step 5: Comment
  } else if (session.step === 'comment') {
    session.comment = msg.text.trim();
    session.step = 'photo';
    bot.sendMessage(chatId,
      '📷 *ნაბიჯი 6/6* — ატვირთეთ ქვითრის ფოტო\n\nგამოაგზავნეთ ფოტო ან დააჭირეთ გამოტოვება.',
      { parse_mode: 'Markdown', reply_markup: skipKeyboard('photo') }
    );

  // Step 6: Photo
  } else if (session.step === 'photo') {
    if (msg.photo) {
      await handlePhoto(chatId, msg, session);
    } else {
      bot.sendMessage(chatId,
        '⚠️ გთხოვთ გამოაგზავნოთ *ფოტო* ან დააჭიროთ *გამოტოვება*.',
        { parse_mode: 'Markdown', reply_markup: skipKeyboard('photo') }
      );
    }
  }
});

// Callbacks
bot.on('callback_query', async (query) => {
  const chatId  = query.message.chat.id;
  const data    = query.data;
  const session = sessions[chatId];

  bot.answerCallbackQuery(query.id);

  if (!session) {
    bot.sendMessage(chatId, '⚠️ სესია ამოიწურა. გამოიყენეთ /expense თავიდან.');
    return;
  }

  // Step 1: Category selected
  if (data.startsWith('cat_') && session.step === 'category') {
    session.category = getCategoryLabel(data);
    session.step = 'site';
    bot.editMessageText(
      '📂 კატეგორია: *' + session.category + '*',
      { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
    );
    bot.sendMessage(chatId,
      '🌿 *ნაბიჯი 2/6* — აირჩიეთ ფერმა:',
      { parse_mode: 'Markdown', reply_markup: siteKeyboard() }
    );

  // Step 2: Site selected
  } else if (data.startsWith('site_') && session.step === 'site') {
    session.site = getSiteLabel(data);
    session.step = 'amount';
    bot.editMessageText(
      '🌿 ფერმა: *' + session.site + '*',
      { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
    );
    bot.sendMessage(chatId,
      '💵 *ნაბიჯი 3/6* — რა ღირდა?\n\nშეიყვანეთ თანხა (მაგ. 45.50):',
      { parse_mode: 'Markdown' }
    );

  // Step 4: Currency selected
  } else if (data.startsWith('cur_') && session.step === 'currency') {
    session.currency = data.replace('cur_', '');
    session.step = 'comment';
    bot.editMessageText(
      '💱 ვალუტა: *' + session.currency + '*',
      { chat_id: chatId, message_id: query.message.message_id, parse_mode: 'Markdown' }
    );
    bot.sendMessage(chatId,
      '💬 *ნაბიჯი 5/6* — დაამატეთ კომენტარი (არასავალდებულო)\n\nდაწერეთ შენიშვნა ან დააჭირეთ გამოტოვება.',
      { parse_mode: 'Markdown', reply_markup: skipKeyboard('comment') }
    );

  // Skip comment
  } else if (data === 'skip_comment' && session.step === 'comment') {
    session.comment = '';
    session.step = 'photo';
    bot.editMessageText(
      '💬 კომენტარი: არ არის.',
      { chat_id: chatId, message_id: query.message.message_id }
    );
    bot.sendMessage(chatId,
      '📷 *ნაბიჯი 6/6* — ატვირთეთ ქვითრის ფოტო\n\nგამოაგზავნეთ ფოტო ან დააჭირეთ გამოტოვება.',
      { parse_mode: 'Markdown', reply_markup: skipKeyboard('photo') }
    );

  // Skip photo
  } else if (data === 'skip_photo' && session.step === 'photo') {
    session.photoLink = '';
    bot.editMessageText(
      '📷 ფოტო: არ არის.',
      { chat_id: chatId, message_id: query.message.message_id }
    );
    await saveExpense(chatId, session);
  }
});

// Photo upload
async function handlePhoto(chatId, msg, session) {
  try {
    bot.sendMessage(chatId, '⏳ ფოტო იტვირთება...');
    const fileId  = msg.photo[msg.photo.length - 1].file_id;
    const fileUrl = await bot.getFileLink(fileId);
    const response = await axios.get(fileUrl, { responseType: 'stream' });

    const driveRes = await drive.files.create({
      requestBody: {
        name: 'receipt_' + Date.now() + '.jpg',
        mimeType: 'image/jpeg',
        parents: ['16-wuG2NdTZtNPWEtgXZc4XTjpCpVCJ93'],
      },
      media: { mimeType: 'image/jpeg', body: response.data },
    });

    session.photoLink = 'https://drive.google.com/file/d/' + driveRes.data.id + '/view';
  } catch (err) {
    console.error('Photo error:', err);
    session.photoLink = '';
    bot.sendMessage(chatId, '⚠️ ფოტოს ატვირთვა ვერ მოხერხდა, ვინახავთ ფოტოს გარეშე.');
  }
  await saveExpense(chatId, session);
}

// Save to Sheets
async function saveExpense(chatId, session) {
  const date = new Date().toLocaleString('en-GB', {
    timeZone: 'Asia/Tbilisi',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const row = [
    date,
    session.staffName,
    session.site,
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
      '✅ *ხარჯი შენახულია!*\n\n' +
      '🌿 ' + session.site + '\n' +
      '📂 ' + session.category + '\n' +
      '💵 ' + session.amount + ' ' + session.currency + '\n' +
      '💬 ' + (session.comment || 'კომენტარი არ არის') + '\n' +
      '📷 ' + (session.photoLink ? '[ქვითრის ნახვა](' + session.photoLink + ')' : 'ფოტო არ არის') + '\n\n' +
      'დააჭირეთ /expense სხვა ხარჯის დასამატებლად.',
      { parse_mode: 'Markdown', disable_web_page_preview: true }
    );
  } catch (err) {
    console.error('Sheets error:', err);
    bot.sendMessage(chatId, '❌ შენახვა ვერ მოხერხდა. სცადეთ თავიდან /expense.');
  }

  delete sessions[chatId];
}

// Keep Render web service alive
const http = require('http');
http.createServer((req, res) => res.end('Bot is running!')).listen(process.env.PORT || 3000);

console.log('🤖 Expense bot is running...');
