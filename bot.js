const { Telegraf } = require('telegraf');
const { Connection, PublicKey } = require('@solana/web3.js');
const { Pool } = require('pg');

// Hardcoded values (from you)
const bot = new Telegraf('7647246493:AAF5MRU_X23hNg9AxZlEA00F9uvhoR7_eGU'); // Your Telegram bot API token
const ownerChatId = '5469051084'; // Your chat ID
const paymentAddress = new PublicKey('278e7zbxnkFfdPmdppeiUxm2RxMHW6GtwC9eCNCuRM5H'); // Your Solana payment address
const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Set up database tables and initial wallet list
(async () => {
    await pool.query('CREATE TABLE IF NOT EXISTS users (chat_id BIGINT PRIMARY KEY, solana_address TEXT, access_expiration BIGINT)');
    await pool.query('CREATE TABLE IF NOT EXISTS trader_wallets (id INT PRIMARY KEY, wallets TEXT[])');
    const initialWallets = [
        '99i9uVA7Q56bY22ajKKUfTZTgTeP5yCtVGmrG9J4pDYQ',
        '9yYya3F5EJoLnBNKW6z4bZvyQytMXzDcpU5D6yYr4jqL',
        'DfMxre4cKmvogbLrPigxmibVTTQDuzjdXojWzjCXXhzj',
        '4BdKaxN8G6ka4GYtQQWk4G4dZRUTX2vQH9GcXdBREFUk',
        'GJA1HEbxGnqBhBifH9uQauzXSB53to5rhDrzmKxhSU65',
        '2kv8X2a9bxnBM8NKLc6BBTX2z13GFNRL4oRotMUJRva9',
        'JDd3hy3gQn2V982mi1zqhNqUw1GfV2UL6g76STojCJPN',
        'F72vY99ihQsYwqEDCfz7igKXA5me6vN2zqVsVUTpw6qL',
        'BCnqsPEtA1TkgednYEebRpkmwFRJDCjMQcKZMMtEdArc',
        'F2SuErm4MviWJ2HzKXk2nuzBC6xe883CFWUDCPz6cyWm'
    ];
    await pool.query('INSERT INTO trader_wallets (id, wallets) VALUES (1, $1) ON CONFLICT (id) DO NOTHING', [initialWallets]);
})();

// Load trader wallets from database
let traderWallets = [];
(async () => {
    const res = await pool.query('SELECT wallets FROM trader_wallets WHERE id = 1');
    traderWallets = res.rows[0].wallets;
})();

// Bot commands
bot.start((ctx) => {
    ctx.reply('Welcome! Use /setaddress YOUR_ADDRESS to set your Solana address, then /getaccess to subscribe.');
});

bot.command('setaddress', async (ctx) => {
    const chatId = ctx.chat.id;
    const address = ctx.message.text.split(' ')[1];
    if (!address) return ctx.reply('Please provide your Solana address, e.g., /setaddress YOUR_ADDRESS');
    try {
        new PublicKey(address);
        await pool.query('INSERT INTO users (chat_id, solana_address) VALUES ($1, $2) ON CONFLICT (chat_id) DO UPDATE SET solana_address = $2', [chatId, address]);
        ctx.reply('Address set! Use /getaccess to proceed.');
    } catch (error) {
        ctx.reply('Invalid Solana address. Try again.');
    }
});

bot.command('getaccess', async (ctx) => {
    const chatId = ctx.chat.id;
    const user = (await pool.query('SELECT solana_address FROM users WHERE chat_id = $1', [chatId])).rows[0];
    if (!user || !user.solana_address) return ctx.reply('Set your address first with /setaddress YOUR_ADDRESS');
    ctx.reply(`Send 0.50 SOL from ${user.solana_address} to ${paymentAddress.toBase58()}. Then use /paid to confirm.`);
});

bot.command('paid', async (ctx) => {
    const chatId = ctx.chat.id;
    const user = (await pool.query('SELECT solana_address FROM users WHERE chat_id = $1', [chatId])).rows[0];
    if (!user || !user.solana_address) return ctx.reply('Set your address first with /setaddress YOUR_ADDRESS');
    const userAddress = new PublicKey(user.solana_address);
    const signatures = await connection.getSignaturesForAddress(paymentAddress, { limit: 10 });
    let paymentFound = false;
    for (const sig of signatures) {
        const tx = await connection.getTransaction(sig.signature, { commitment: 'confirmed' });
        if (tx && tx.meta && !tx.meta.err) {
            const transfer = tx.transaction.message.instructions.find(ix => ix.programId.toBase58() === '11111111111111111111111111111111');
            if (transfer && transfer.parsed && transfer.parsed.type === 'transfer' &&
                transfer.parsed.info.source === userAddress.toBase58() &&
                transfer.parsed.info.destination === paymentAddress.toBase58() &&
                transfer.parsed.info.lamports === 500000000) { // 0.50 SOL
                paymentFound = true;
                break;
            }
        }
    }
    if (paymentFound) {
        const expiration = Date.now() + 14 * 24 * 60 * 60 * 1000; // 14 days
        await pool.query('UPDATE users SET access_expiration = $1 WHERE chat_id = $2', [expiration, chatId]);
        ctx.reply('Payment confirmed! Access granted for 2 weeks. Use /showwallets to view trader wallets.');
    } else {
        ctx.reply('Payment not found. Send exactly 0.50 SOL from your set address.');
    }
});

bot.command('showwallets', async (ctx) => {
    const chatId = ctx.chat.id;
    const user = (await pool.query('SELECT access_expiration FROM users WHERE chat_id = $1', [chatId])).rows[0];
    if (!user || !user.access_expiration || Date.now() > user.access_expiration) {
        return ctx.reply('No access. Use /getaccess to subscribe.');
    }
    let message = 'Successful trader wallets:\n\n';
    traderWallets.forEach((wallet, index) => {
        message += `${index + 1}. ${wallet} - [View](https://explorer.solana.com/address/${wallet})\n`;
    });
    ctx.reply(message, { parse_mode: 'Markdown' });
});

// Command to update wallets (only you can use this)
bot.command('updatewallets', async (ctx) => {
    if (ctx.chat.id.toString() !== ownerChatId) {
        return ctx.reply('Unauthorized.');
    }
    const newWallets = ctx.message.text.split(' ').slice(1);
    if (newWallets.length !== 10) {
        return ctx.reply('Provide exactly 10 wallets.');
    }
    const validWallets = [];
    for (const wallet of newWallets) {
        try {
            const pubKey = new PublicKey(wallet);
            if (PublicKey.isOnCurve(pubKey.toBuffer())) {
                validWallets.push(wallet);
            } else {
                return ctx.reply(`Invalid wallet: ${wallet}`);
            }
        } catch (error) {
            return ctx.reply(`Invalid wallet: ${wallet}`);
        }
    }
    await pool.query('UPDATE trader_wallets SET wallets = $1 WHERE id = 1', [validWallets]);
    traderWallets = validWallets;
    ctx.reply('Wallets updated successfully.');
});

// Launch bot with webhook
const port = process.env.PORT || 3000;
bot.launch({
    webhook: {
        domain: 'YOUR_RENDER_URL', // Replace with your Render URL after deployment
        port: port,
        hookPath: '/' + bot.token
    }
});
