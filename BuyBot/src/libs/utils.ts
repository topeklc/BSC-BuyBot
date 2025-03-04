import TelegramBot from 'node-telegram-bot-api';
import { getGroupData, getGroupConfig, getConfigsForUserView} from '../../../DB/queries';
import { logError, logDebug } from './logger';
import { InputMediaPhoto } from 'node-telegram-bot-api';
import fs from 'fs';
import path from 'path';
/**
 * Checks if a user is an administrator of a specified Telegram group
 * @param bot The Telegram bot instance
 * @param userId The ID of the user to check
 * @param groupId The ID of the group to check
 * @returns Promise<boolean> True if the user is an admin, false otherwise
 */
export async function isGroupAdmin(bot: TelegramBot, userId: number, groupId: number): Promise<boolean> {
    try {
        const chatMember = await bot.getChatMember(groupId, userId);
        return ['creator', 'administrator'].includes(chatMember.status);
    } catch (error) {
        console.error('Error checking admin status:', error);
        return false;
    }
}

/**
 * Generates an inline keyboard markup for group configuration
 * @param groupId The ID of the group to generate configuration menu for
 * @returns Promise<TelegramBot.InlineKeyboardMarkup> Configuration menu buttons
 */
export async function generateConfigMenu(groupId: bigint): Promise<TelegramBot.InlineKeyboardMarkup> {
    const config = await getGroupConfig(groupId);
    
    const configFields = [
        { 
            text: `Token Address: ${config?.address}`, 
            callback_data: 'config_address' 
        },
        { 
            text: 'Set Media 🖼 ', // Not showing media content as it's in bytes
            callback_data: 'config_media'
        },
        { 
            text: `Emoji: ${config?.emoji}`, 
            callback_data: 'config_emoji' 
        },
        { 
            text: `Min Amount: $${config?.min_amount}`, 
            callback_data: 'config_min_amount' 
        },
        { 
            text: `Pools: ${config?.pools?.length || 0}`, 
            callback_data: 'config_pools' 
        },
        { 
            text: `Socials`,
            callback_data: 'config_socials' 
        },
        {
            text: `${config?.active ? '🟢' : '🔴'} Notifications`,
            callback_data: 'config_toggle_active'
        },
        { 
            text: `Test`,
            callback_data: 'config_test'
        }
    ];

    const keyboard = configFields.map(field => [
        { text: field.text, callback_data: field.callback_data }
    ]);

    return {
        inline_keyboard: keyboard
    };
}

const generateUserConfigsMenu = async (groupId: bigint): Promise<TelegramBot.InlineKeyboardMarkup> => {
    const keyboard = []
    const userConfigs = await getConfigsForUserView(groupId);
    for (const config of userConfigs) {
        console.log(config)
        console.log(config.configGroupId)
        keyboard.push([
            { text: `${config.groupName} | ${config.tokenName}`, callback_data: `config_user_menu_${config.configGroupId}` }
        ]);
    }
    return {inline_keyboard: keyboard};
}

export const sendUserConfigsMenu = async (bot: TelegramBot, groupId: bigint, messageId?: number): Promise<void> => {
    const buttons = await generateUserConfigsMenu(groupId);
    const message = 'Select a configuration:';
    try {
        if (messageId) {

        await bot.editMessageText(message, {
            chat_id: groupId.toString(),
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: buttons
        });} else {
            await bot.sendMessage(groupId.toString(), message, {
                parse_mode: 'Markdown',
                reply_markup: buttons
            });
        }
    } catch (err) {
        logError('sendUserConfigsMenu', err as Error, { context: 'Failed to send message' });
    }
}
export const sendConfigMenu = async (bot: TelegramBot, configGroupId: bigint, chatId: bigint | number, tokenInfo: any, messageId?: number): Promise<void> => {
    const buttons = await generateConfigMenu(configGroupId);
    const groupData = await getGroupData(configGroupId);
    if (!groupData) {
        throw new Error('Could not find group configuration');
    }
    const formattedSupply = `<code>${Math.floor(Number(tokenInfo.totalSupply) / 10**Number(tokenInfo.decimals)).toString()}</code>`;
    let message = '<b>Configuration menu</b>\n';
    message += `Group: <code>${groupData.name || groupData.id}</code>\n`;
    message += `Token Info:\n`;
    message += `Name: <code>${tokenInfo.name}</code>\n`;
    message += `Symbol: <code>${tokenInfo.symbol}</code>\n`;
    message += `Decimals: <code>${tokenInfo.decimals}</code>\n`;
    message += `Total Supply: ${formattedSupply}\n`;

    if (messageId) {
        try {
            await bot.editMessageText(message, {
                chat_id: chatId.toString(),
                message_id: messageId,
                parse_mode: 'HTML',
                reply_markup: buttons
            });
        } catch {
            await bot.sendMessage(chatId.toString(), message, { 
                parse_mode: 'HTML',
                reply_markup: buttons 
            });
        }

    } else {
        await bot.sendMessage(chatId.toString(), message, { 
            parse_mode: 'HTML',
            reply_markup: buttons 
        });
    }
}


export const sendBuyMessage = async (bot: TelegramBot, chatId: number, message: string, buyUrl: string, media?: any) => {
    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{ 
                    text: 'Buy on Maestro', 
                    url: buyUrl
                }]
            ]
        },
        parse_mode: 'Markdown',
        disable_web_page_preview: true
    } as TelegramBot.SendMessageOptions & TelegramBot.SendPhotoOptions & TelegramBot.SendAnimationOptions;

    if (media) {
        try {
            const mediaData = JSON.parse(media.toString());
            opts.caption = message;
            console.log('mediaData', mediaData);
            if (mediaData.mime_type && mediaData.mime_type.startsWith('video/')) {
                try {
                    await bot.sendAnimation(chatId, mediaData.file_id, opts);
                    return;
                } catch (err) {
                    logError('sendBuyMessage', err as Error, { context: 'Failed to send animation' });
                    // Fall back to sending text message
                }
            } else if (mediaData.type && mediaData.type === 'photo' || mediaData[0] && mediaData[0].file_id) {
                try {
                    const fileId = mediaData.file_id || mediaData[0].file_id;
                    console.log(`fileId: ${fileId}`);
                    await bot.sendPhoto(chatId, fileId, opts);
                    return;
                } catch (err) {
                    logError('sendBuyMessage', err as Error, { context: 'Failed to send photo' });
                    // Fall back to sending text message
                }
            }
        } catch (err) {
            logError('sendBuyMessage', err as Error, { context: 'Failed to parse media data' });
            // Fall back to sending text message
        }
    }
    
    // If media sending fails or there's no media, send a text message
    try {
        await bot.sendMessage(chatId, message, opts);
    } catch (err) {
        logError('sendBuyMessage', err as Error, { context: 'Failed to send text message' });
        // If even text message fails, throw the error
        throw err;
    }
}

const ALERT_CHANNEL = '-1002326585867'
// TODO Change it to use file_id
const NEW_POOL_MEDIA = path.resolve(__dirname, '..', '..','src', 'media', 'Canister.jpeg');
export const sendNewPoolMessage = async (bot: TelegramBot, message: string, buyUrl: string) => {
    try {
    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{ 
                    text: 'Buy', 
                    url: buyUrl
                }]
            ]
        },
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        caption: message
    } as TelegramBot.SendPhotoOptions;
    await bot.sendPhoto(ALERT_CHANNEL, fs.createReadStream(NEW_POOL_MEDIA), opts);
} catch (err) {
    logError('sendNewPoolMessage', err as Error, { context: 'Failed to send new pool message' });
}
}

export const getRandomInt = (min: number=1, max: number=10000): number => {
    min = Math.ceil(min);
    max = Math.floor(max);
    return Math.floor(Math.random() * (max - min + 1)) + min;
};