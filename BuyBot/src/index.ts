import TelegramBot from 'node-telegram-bot-api';
import dotenv from 'dotenv';
import { registrationHandler, shareChatHandler, configCallbackHandler } from './handlers/registrationHandlers';
import { sendUserConfigsMenu} from './libs/utils';   
import { logError, logInfo, logDebug } from './libs/logger';
import { WebSocketClient } from './services/websocket';
import { saveUser } from '../../DB/queries';
import { callbackify } from 'util';
import {groupTypeChangeHandler} from './handlers/utilsHandlers'
import { updateTrending } from './libs/trending';


dotenv.config();

const token: string = process.env.TELEGRAM_BOT_TOKEN || "";
const bot = new TelegramBot(token, { polling: true });

// Initialize WebSocket client
const wsClient = new WebSocketClient(bot);

setInterval(() => updateTrending(bot), 60000);

// Global error handler
process.on('uncaughtException', (error) => {
    logError('UncaughtException', error);
    // Keep the process running
});

process.on('unhandledRejection', (reason, promise) => {
    logError('UnhandledRejection', reason as Error, { promise });
    // Keep the process running
});

bot.on('polling_error', (error) => {
    logError('PollingError', error);
    // Bot will automatically continue polling
});

// Command handlers
bot.onText(/\/start/, async (msg: any) => {
    try {
        if (msg.chat.type !== 'private') return;
        const chatId = msg.chat.id;
        await saveUser(chatId, msg.from.username);
        logInfo('StartCommand', 'User started the bot', { chatId });
        const opts = {
            reply_markup: {
                inline_keyboard: [
                    [
                        {
                            text: '✍️Register Token',
                            callback_data: 'register'
                        },
                        {
                            text: '⚙️Configs',
                            callback_data: 'config_user_configs'
                        }
                    ]
                ]
            }
        };
        bot.sendMessage(chatId, "Welcome to Benny BuyBot", opts);
    } catch (error) {
        logError('StartCommand', error as Error);
        bot.sendMessage(msg.chat.id, "An error occurred. Please try again later.");
    }
});

bot.onText(/\/config/, async (msg) => {
    if (msg.chat.type !== 'private') return;
    await sendUserConfigsMenu(bot, BigInt(msg.chat.id));
});

bot.on('callback_query', async function onCallbackQuery(callbackQuery) {
    try {
        const action = callbackQuery.data;
        const msg = callbackQuery.message;
        logDebug('CallbackQuery', `Received callback query`, { action });
        console.debug(`action: ${action}, msg:`);
        console.debug(msg)
        const chatId = msg?.chat.id;
        if (action === 'register' && chatId) {
            registrationHandler(bot, chatId);
        } else if (action?.startsWith('config_')) {
            await configCallbackHandler(bot, callbackQuery);
        }
    } catch (error) {
        logError('CallbackQuery', error as Error);
        if (callbackQuery.message) {
            bot.sendMessage(callbackQuery.message.chat.id, "An error occurred. Please try again later.");
        }
    }
});

bot.on('message', async (msg: any) => {
    // handle chose group button
    console.debug(msg)
    try {
        if (msg.chat_shared) {
            await shareChatHandler(bot, msg)
        }
        // TODO needs to be testes
        // if (msg.migrate_from_chat_id) {
        //     await groupTypeChangeHandler(msg)
        // }
    } catch (error) {
        logError('MessageHandler', error as Error);
    }
});