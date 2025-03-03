import TelegramBot from 'node-telegram-bot-api';
import { sendUserConfigsMenu, sendConfigMenu, sendBuyMessage, getRandomInt} from '../libs/utils';
import { fetchTokenInfo } from '../../../utils/utils';
import { getCurrentGroupId, saveUser, updateUserCol, upsertGroup, insertDefaultGroupConfig, updateGroupConfig, upsertToken, getGroupConfig, getPoolsForToken, updateGroupConfigPools, upsertGroupUser } from '../../../DB/queries';
import { logError, logInfo, logDebug } from '../libs/logger';
import { getFakeBuyMessage, formatBuyMessage, SubscriberData } from '../libs/messages';
import { handleUserInput } from '../libs/messageUtils';
import { validateSocialUrl } from '../libs/validation';
import {GroupConfig, Socials} from '../../../types';
import {toChecksumAddress} from 'web3-utils';
import { commonWeb3 } from '../../../utils/utils';
const registrationHandler = (bot: TelegramBot, chatId: number) => {
    try {
        logInfo('RegistrationHandler', 'Starting registration', { chatId });
        var text = "Chose group";
        if (chatId) {
            const opts = {
                reply_markup: {
                    keyboard: [
                        [
                            {
                                text: text,
                                request_chat: {
                                    request_id: getRandomInt(),
                                    chat_is_channel: false,
                                    user_administrator_rights: {
                                        can_manage_chat: true,
                                    },
                                    bot_is_member: true
                                },
                            }
                        ]
                    ]
                }
            };
            // @ts-ignore
            bot.sendMessage(chatId, text, opts);
        }
    } catch (error) {
        logError('RegistrationHandler', error as Error);
        bot.sendMessage(chatId, "An error occurred during registration. Please try again later.");
    }
}

const configCommandHandler = async (bot: TelegramBot, msg: TelegramBot.Message) => {
    try {
        const chatId = msg.chat.id;
        const currentGroupId = await getCurrentGroupId(chatId);
        
        if (!currentGroupId) {
            await bot.sendMessage(chatId, 'Please register your token first using /start');
            return;
        }

        const config = await getGroupConfig(currentGroupId);
        if (!config) {
            await bot.sendMessage(chatId, 'Group configuration not found. Please register your token first using /start');
            return;
        }

        const tokenInfo = await fetchTokenInfo(config.address);
        if (!tokenInfo) {
            await bot.sendMessage(chatId, 'Could not fetch token information. Please try again later.');
            return;
        }
        await sendConfigMenu(bot, currentGroupId, chatId, tokenInfo);
    } catch (error) {
        logError('configCommandHandler', error as Error);
        await bot.sendMessage(msg.chat.id, 'An error occurred while fetching the configuration menu. Please try again later.');
    }
};

const shareChatHandler = async (bot: TelegramBot, msg: any) => {
    try {
        const userId = msg.from.id;
        const sharedChat = BigInt(msg.chat_shared.chat_id);
        const chat = await bot.getChat(Number(sharedChat))
        console.log(msg.chat_shared)
        logInfo('ShareChatHandler', 'Processing shared chat', { userId, sharedChat });
        const chatName = chat.title || chat.username || 'Private'
        await saveUser(userId, msg.from.username);
        await updateUserCol(userId, "currently_setting", sharedChat);
        await upsertGroup(sharedChat, chatName, msg.chat_shared.link);
        await upsertGroupUser(sharedChat, userId);
        // Check if config already exists
        const existingConfig = await getGroupConfig(sharedChat);
        if (existingConfig) {
            const tokenInfo = await fetchTokenInfo(existingConfig.address);
            if (tokenInfo) {
                await sendConfigMenu(bot, sharedChat, userId, tokenInfo);
                return;
            }
        }

        await bot.sendMessage(userId, `Group ${msg.chat_shared.title || ''} registered successfully`);
        
        await handleUserInput(
            bot,
            userId,
            userId,
            'Please send me token address ',
            async (message) => {
                const tokenAddress = toChecksumAddress(String(message.text)) || '';
                logInfo('ShareChatHandler', 'Registering address', { userId, tokenAddress });
                
                const tokenInfo = await fetchTokenInfo(tokenAddress);
                
                if (tokenInfo) {
                    await upsertToken(tokenInfo);
                } else {
                    throw new Error('Token information is undefined');
                }

                await insertDefaultGroupConfig(sharedChat, tokenAddress);
                await sendConfigMenu(bot, sharedChat, userId, tokenInfo);
                await commonWeb3.updatePools(tokenAddress);
                return "Token configuration completed successfully";
            },
            {
                keepSuccessMessage: true,
                successMessageTimeout: 5000
            }
        );
    } catch (error) {
        logError('ShareChatHandler', error as Error);
        if (msg.from?.id) {
            bot.sendMessage(msg.from.id, "An error occurred while processing the shared chat. Please try again later.");
        }
    }
}

async function handleConfigUpdate(
    bot: TelegramBot,
    currentGroupId: bigint,
    chatId: number,
    messageId: number,
    configKey: string,
    value: any,
    successMessage: string
): Promise<string> {
    await updateGroupConfig(currentGroupId, configKey, value);
    
    const config = await getGroupConfig(currentGroupId);
    if (!config) {
        throw new Error('Could not find group configuration');
    }

    const tokenInfo = await fetchTokenInfo(config.address);
    await sendConfigMenu(bot, currentGroupId, chatId, tokenInfo, messageId);
    
    return successMessage;
}

async function handlePoolsConfig(bot: TelegramBot, chatId: number, messageId: number | undefined, config: GroupConfig) {
    try {
        console.log("Starting handlePoolsConfig with config:", config);
        const pools = await getPoolsForToken(config.address);
        console.log(`Found ${pools.length} pools for token ${config.address}`);
        
        if (pools.length === 0) {
            const message = 'No pools found for this token.';
            if (messageId) {
                await bot.editMessageText(message, {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '⬅️ Back to Config', callback_data: 'config_back_to_config' }]
                        ]
                    }
                });
            } else {
                await bot.sendMessage(chatId, message, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '⬅️ Back to Config', callback_data: 'config_back_to_config' }]
                        ]
                    }
                });
            }
            return;
        }
        
        // Normalize selected pools for better comparison
        const selectedPools = Array.isArray(config.pools) ? config.pools : [];
        console.log("Raw selected pools:", selectedPools);
        
        // Improved parsing to handle various formats
        const selectedPoolAddresses = selectedPools.map((pool: any) => {
            if (typeof pool === 'string') {
                try {
                    // Try to parse as JSON string first
                    const parsed = JSON.parse(pool);
                    return parsed.address || parsed.tokenAddress || pool;
                } catch {
                    // If it's not JSON, use as is
                    return pool;
                }
            }
            return pool;
        });
        
        console.log("Normalized selected pool addresses:", selectedPoolAddresses);

        const isAllSelected = pools.length === selectedPoolAddresses.length && 
            pools.every(pool => selectedPoolAddresses.includes(pool.address));

        console.log(`isAllSelected=${isAllSelected}, selected=${selectedPoolAddresses.length}, total=${pools.length}`);

        const keyboard: TelegramBot.InlineKeyboardButton[][] = [
            [{ text: `${isAllSelected ? '❌ Deselect All' : '✅ Select All'}`, callback_data: 'config_pools_select_all' }],
            ...pools.map(pool => ({
                text: `${selectedPoolAddresses.includes(pool.address) ? '✅' : '❌'} ${pool.pairName || pool.address.substring(0, 8)}`,
                callback_data: `config_pool_toggle:${pool.address}`
            })).reduce((acc, curr, i) => {
                if (i % 2 === 0) acc.push([curr]);
                else acc[acc.length - 1].push(curr);
                return acc;
            }, [] as TelegramBot.InlineKeyboardButton[][]),
            [{ text: '⬅️ Back to Config', callback_data: 'config_back_to_config' }]
        ];

        const message = 'Select pools to monitor:\n\n' +
            `Selected: ${selectedPoolAddresses.length}/${pools.length}`;

        if (messageId) {
            await bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: { inline_keyboard: keyboard }
            });
        } else {
            await bot.sendMessage(chatId, message, {
                reply_markup: { inline_keyboard: keyboard }
            });
        }
    } catch (error) {
        console.error("Error in handlePoolsConfig:", error);
        const errorMessage = "Failed to load pools. Please try again.";
        
        try {
            if (messageId) {
                await bot.editMessageText(errorMessage, {
                    chat_id: chatId,
                    message_id: messageId,
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '⬅️ Back to Config', callback_data: 'config_back_to_config' }]
                        ]
                    }
                });
            } else {
                await bot.sendMessage(chatId, errorMessage, {
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: '⬅️ Back to Config', callback_data: 'config_back_to_config' }]
                        ]
                    }
                });
            }
        } catch (err) {
            console.error("Failed to send error message:", err);
        }
    }
}

const configCallbackHandler = async (bot: TelegramBot, callbackQuery: TelegramBot.CallbackQuery) => {
    try {
        
        const userId = callbackQuery.message?.chat.id;
        const messageId = callbackQuery.message?.message_id;
        const action = callbackQuery.data;
        //validation

        if (callbackQuery.message?.chat.type !== 'private' || !action || !userId || !messageId) return;

        
        const currentGroupId = await getCurrentGroupId(userId);

        if (!currentGroupId) {
            await bot.sendMessage(userId, 'Please register your token first using /start');
            return;
        }
        const config = await getGroupConfig(currentGroupId);
        if (!config) {
            await bot.sendMessage(userId, 'Please register your token first using /start');
            return;
        }
        if (action.startsWith('config_user_menu')) {
            try {
                console.log(action)
                const configGroupId = BigInt(action.split('_')[3]);
                await updateUserCol(BigInt(userId), "currently_setting", configGroupId);
                const tokenAddress = (await getGroupConfig(configGroupId))?.address;
                const tokenInfo = await fetchTokenInfo(tokenAddress)
                console.log(tokenInfo)
                await sendConfigMenu(bot, configGroupId, userId,tokenInfo, messageId);
            } catch (error) {
                logError('ConfigCallbackHandler', error as Error);
            }
        }
        
        if (action === 'config_user_configs') {
            try {
                await sendUserConfigsMenu(bot, BigInt(userId), messageId);
            } catch (error) {
                logError('ConfigCallbackHandler', error as Error);
            }
        }
        if (action === 'config_pools_all') {
            try {
                await updateGroupConfigPools(currentGroupId, 'all');
                const tokenInfo = await getGroupConfig(currentGroupId);
                await bot.answerCallbackQuery(callbackQuery.id, { text: 'Successfully updated to track all pools!' });
                await sendConfigMenu(bot, currentGroupId, userId, tokenInfo, messageId);
            } catch (error) {
                logError('Error updating pools to all', error as Error);
                await bot.answerCallbackQuery(callbackQuery.id, { text: 'Failed to update pools configuration' });
            }
            return;
        }

        



        if (action.startsWith('config_pool_toggle:')) {
            await bot.answerCallbackQuery(callbackQuery.id);
            const toggledPool = action.split(':')[1];
            
            try {
                console.log(`Toggling pool: ${toggledPool}`);
                const poolConfig = await getGroupConfig(currentGroupId);
                if (!poolConfig) {
                    await bot.sendMessage(userId, 'Error: Could not find group configuration');
                    return;
                }

                // Normalize pools array for consistent handling
                const currentPools = Array.isArray(poolConfig.pools) ? poolConfig.pools : [];
                console.log("Current pools before toggle:", currentPools);
                
                // Check if pool is already selected - improved detection
                const isSelected = currentPools.some(p => {
                    if (p === toggledPool) return true;
                    
                    try {
                        const parsed = JSON.parse(p);
                        return parsed.address === toggledPool || parsed.tokenAddress === toggledPool;
                    } catch {
                        return false;
                    }
                });
                
                console.log(`Pool ${toggledPool} is currently ${isSelected ? 'selected' : 'not selected'}`);
                
                let updatedPools;
                if (isSelected) {
                    // Remove pool by filtering
                    updatedPools = currentPools.filter(p => {
                        if (p === toggledPool) return false;
                        
                        try {
                            const parsed = JSON.parse(p);
                            return parsed.address !== toggledPool && parsed.tokenAddress !== toggledPool;
                        } catch {
                            return true;
                        }
                    });
                } else {
                    // Always store just the address for simplicity
                    updatedPools = [...currentPools, toggledPool];
                }
                
                console.log(`Updating pools: ${currentPools.length} -> ${updatedPools.length}`);
                
                // Update database
                await updateGroupConfig(currentGroupId, 'pools', updatedPools);
                
                // Get fresh config
                const updatedConfig = await getGroupConfig(currentGroupId);
                console.log("Updated config:", updatedConfig);
                
                // Refresh UI
                await handlePoolsConfig(bot, userId, messageId, updatedConfig);
                
            } catch (err) {
                logError('ConfigCallbackHandler', err as Error, { context: 'pool_toggle' });
                await bot.sendMessage(userId, 'Error updating pools configuration');
            }
            return;
        }

        if (action === 'config_pools') {
            await handlePoolsConfig(bot, userId, messageId, config);
            return;
        }

        if (action === 'config_pools_select_all') {
            try {
                const pools = await getPoolsForToken(config.address);
                const selectedPools = Array.isArray(config.pools) ? config.pools : [];
                
                // Parse selected pools to get tokenAddresss
                const selectedtokenAddresss = selectedPools.map((pool: any) => {
                    try {
                        return JSON.parse(pool).tokenAddress;
                    } catch {
                        return pool;
                    }
                });
                
                // Check if all pools are currently selected
                const isAllSelected = pools.length === selectedtokenAddresss.length && 
                    pools.every(pool => selectedtokenAddresss.includes(pool.address));
                
                // Toggle between all selected and none selected
                const newPools = isAllSelected ? [] : pools.map(p => JSON.stringify(p));
                
                await updateGroupConfig(currentGroupId, 'pools', newPools);
                
                await bot.answerCallbackQuery(callbackQuery.id, {
                    text: isAllSelected ? 'All pools deselected ❌' : 'All pools selected ✅'
                });
                
                const updatedConfig = await getGroupConfig(currentGroupId);
                await handlePoolsConfig(bot, userId, messageId, updatedConfig);
            } catch (error) {
                console.error('Error in pools_select_all:', error);
                await bot.answerCallbackQuery(callbackQuery.id, {
                    text: 'Error updating pools configuration'
                });
            }
            return;
        }

        if (action === 'config_back_to_config') {
            const tokenInfo = await fetchTokenInfo(config.address);
            await sendConfigMenu(bot, currentGroupId, userId, tokenInfo, messageId);
            return;
        }

        switch (action) {
            case 'config_media':
                await bot.answerCallbackQuery(callbackQuery.id);
                
                await handleUserInput(
                    bot,
                    userId,
                    callbackQuery.from.id,
                    'Please send me a media file (photo, GIF or video) to use for buy notifications',
                    async (msg) => {
                        const mediaData = msg.photo || msg.animation || msg.video;
                        if (!mediaData) {
                            throw new Error('Please send a valid media file (photo, GIF or video)');
                        }
                        
                        return handleConfigUpdate(
                            bot,
                            currentGroupId,
                            userId,
                            callbackQuery.message?.message_id || 0,
                            'media',
                            Buffer.from(JSON.stringify(mediaData)),
                            'Media updated successfully'
                        );
                    },
                    {},
                    ['photo', 'animation', 'video']
                );
                break;

            case 'config_emoji':
                await bot.answerCallbackQuery(callbackQuery.id);
                
                await handleUserInput(
                    bot,
                    userId,
                    callbackQuery.from.id,
                    'Please send me a emoji to use',
                    async (message) => {
                        const text = message.text;
                        if (!text) {
                            throw new Error('Please send an emoji');
                        }

                        if (text.length < 6) {
                            return handleConfigUpdate(
                                bot,
                                currentGroupId,
                                userId,
                                callbackQuery.message?.message_id || 0,
                                'emoji',
                                text,
                                'Emoji updated successfully'
                            );
                        } else {
                            throw new Error('Please send less emojis');
                        }
                    }
                );
                break;

            case 'config_min_amount':
                await bot.answerCallbackQuery(callbackQuery.id);
                
                await handleUserInput(
                    bot,
                    userId,
                    callbackQuery.from.id,
                    'Please send me the minimum amount in USD for buy notifications',
                    async (message) => {
                        const text = message.text;
                        if (!text) {
                            throw new Error('Please send a number');
                        }

                        const amount = parseInt(text);
                        if (!isNaN(amount) && amount >= 0) {
                            return handleConfigUpdate(
                                bot,
                                currentGroupId,
                                userId,
                                callbackQuery.message?.message_id || 0,
                                'min_amount',
                                amount,
                                'Minimum amount updated successfully'
                            );
                        } else {
                            throw new Error('Please send a valid number greater than or equal to 0');
                        }
                    }
                );
                break;

            case 'config_back':
                await bot.answerCallbackQuery(callbackQuery.id);
                try {
                    const tokenInfo = await fetchTokenInfo(config.address);
                    await sendConfigMenu(bot, currentGroupId, userId, tokenInfo, callbackQuery.message.message_id);
                } catch (err) {
                    logError('ConfigCallbackHandler', err as Error, { context: 'config_back' });
                    await bot.sendMessage(userId, 'Error: Could not show configuration menu');
                }
                break;
            case 'config_test':
                await bot.answerCallbackQuery(callbackQuery.id);
                try {
                    const tokenInfo = await fetchTokenInfo(config.address);
                    if (!tokenInfo) {
                        throw new Error('Could not fetch token info');
                    }
                    let testPool = config.pools[0];
                    if (!testPool) {
                        testPool = { tokenAddress: ""}
                    }
                    const subscriberData : SubscriberData = {
                        emoji: config.emoji,
                        socials: config.socials || {
                            telegram: null,
                            x: null,
                            website: null
                        }
                    };
                    const messageToSend = formatBuyMessage(getFakeBuyMessage({address: config.address, symbol: tokenInfo.symbol, name: tokenInfo.name, amount: 100000, priceUSD: 10, pricePairToken: 0.1}, testPool.tokenAddress), subscriberData)
                    const buyUrl = `https://springboard.pancakeswap.finance/bsc/token/${config.address}`;
                    await sendBuyMessage(bot, userId, messageToSend, buyUrl, config.media);
                } catch (err) {
                    logError('ConfigCallbackHandler', err as Error, { context: 'config_back' });
                    await bot.sendMessage(userId, 'Something went wrong');
                }
                break;
            case 'config_toggle_active':
                const newActiveStatus = !config.active;
                await updateGroupConfig(currentGroupId, 'active', newActiveStatus);
                await bot.answerCallbackQuery(callbackQuery.id, { 
                    text: newActiveStatus ? 'Notifications enabled 🟢' : 'Notifications disabled 🔴'
                });

                const tokenInfo = await fetchTokenInfo(config.address);
                await sendConfigMenu(bot, currentGroupId, userId, tokenInfo, messageId);
                return;
            case 'config_address':
                await bot.answerCallbackQuery(callbackQuery.id);
                
                await handleUserInput(
                    bot,
                    userId,
                    callbackQuery.from.id,
                    'Please send me the Contract Address of the token',
                    async (message) => {
                        const tokenAddress = toChecksumAddress(String(message.text));
                        if (!tokenAddress) {
                            throw new Error('Please send a valid Contract Address');
                        }

                        const tokenInfo = await fetchTokenInfo(tokenAddress);
                        if (!tokenInfo) {
                            throw new Error('Could not fetch token information. Please check the Contract Address.');
                        }
                        await commonWeb3.updatePools(tokenAddress);
                        await updateGroupConfig(currentGroupId, 'address', tokenAddress);
                        
                        await sendConfigMenu(bot, currentGroupId, userId, tokenInfo, callbackQuery.message?.message_id || 0,);
                        
                        return `Token updated to ${tokenInfo.name} (${tokenInfo.symbol})`;
                    }
                );
                break;
            case 'config_socials':
                await bot.answerCallbackQuery(callbackQuery.id);
                
                if (!config) {
                    await bot.sendMessage(userId, 'Error: Could not find group configuration');
                    return;
                }
                const socials = config.socials = config.socials || {};
                const socialsButtons = [
                    [{
                        text: `Website: ${socials.website || 'Not set'}`,
                        callback_data: 'config_social_website'
                    }],
                    [{
                        text: `Telegram: ${socials.telegram || 'Not set'}`,
                        callback_data: 'config_social_telegram'
                    }],
                    [{
                        text: `X: ${socials.x || 'Not set'}`,
                        callback_data: 'config_social_x'
                    }],
                    [{
                        text: 'Back to Config ⬅️',
                        callback_data: 'config_back'
                    }]
                ];

                await bot.editMessageText(
                    'Configure social media links:\n\n' +
                    'Click on a button to set or update a link.\n' +
                    'Type "del" or "unset" to remove a link.',
                    {
                        chat_id: userId,
                        message_id: callbackQuery.message.message_id,
                        reply_markup: {
                            inline_keyboard: socialsButtons
                        },
                        parse_mode: 'HTML'
                    }
                );
                break;
            case 'config_social_website':
            case 'config_social_telegram':
            case 'config_social_x':
                await bot.answerCallbackQuery(callbackQuery.id);
                const socialType = action.replace('config_social_', '');

                await handleUserInput(
                    bot,
                    userId,
                    callbackQuery.from.id,
                    `Please enter the ${socialType} link (or type "unset" to remove):`,
                    async (message) => {
                        const currentConfig = await getGroupConfig(currentGroupId);
                        if (!currentConfig) {
                            throw new Error('Could not find group config');
                        }
                        const inputText = message.text;
                        if (!inputText) {
                            throw new Error('Please provide a valid URL or type "unset" to remove');
                        }

                        const validation = validateSocialUrl(socialType as keyof Socials, inputText);
                        if (!validation.isValid) {
                            throw new Error(validation.error || 'Invalid URL format');
                        }

                        const socials = currentConfig.socials || {};
                        socials[socialType] = validation.normalizedUrl;

                        await updateGroupConfig(currentGroupId, 'socials', socials);

                        const socialsButtons = [
                            [{
                                text: `Website: ${socials.website || 'Not set'}`,
                                callback_data: 'config_social_website'
                            }],
                            [{
                                text: `Telegram: ${socials.telegram || 'Not set'}`,
                                callback_data: 'config_social_telegram'
                            }],
                            [{
                                text: `X: ${socials.x || 'Not set'}`,
                                callback_data: 'config_social_x'
                            }],
                            [{
                                text: 'Back to Config ⬅️',
                                callback_data: 'config_back'
                            }]
                        ];

                        try {
                            await bot.editMessageText(
                                'Configure social media links:\n\n' +
                                'Click on a button to set or update a link.\n' +
                                'Type "del" or "unset" to remove a link.',
                                {
                                    chat_id: userId,
                                    message_id: callbackQuery.message?.message_id,
                                    reply_markup: {
                                        inline_keyboard: socialsButtons
                                    },
                                    parse_mode: 'HTML'
                                }
                            );
                        } catch (editErr: any) {
                            if (!(editErr.message && editErr.message.includes('message is not modified'))) {
                                throw editErr;
                            }
                        }

                        return validation.normalizedUrl === null 
                            ? `${socialType} link has been removed`
                            : `${socialType} link has been updated to ${validation.normalizedUrl}`;
                    }
                );
                break;
        } 
    } catch (error) {
        logError('ConfigCallbackHandler', error as Error);
        if (callbackQuery.message) {
            bot.sendMessage(callbackQuery.message.chat.id, "An error occurred while processing your request. Please try again later.");
        }
    }
};

export {
    registrationHandler,
    shareChatHandler,
    configCallbackHandler,
    configCommandHandler,
    handleConfigUpdate
};
