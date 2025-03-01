import TelegramBot from 'node-telegram-bot-api';
import { logError } from './logger';

interface CleanupConfig {
    successMessageTimeout?: number;
    keepSuccessMessage?: boolean;
    keepUserInput?: boolean;
    keepPrompt?: boolean;
}

type MessageHandler = (msg: TelegramBot.Message) => Promise<string>;

/**
 * Utility function to handle user input with automatic message cleanup
 * @param bot Telegram bot instance
 * @param chatId Chat ID where the interaction is happening
 * @param userId User ID to handle messages from
 * @param promptText Text to show in the prompt message
 * @param handler Function to handle the user's input
 * @param cleanup Configuration for message cleanup behavior
 * @param mediaTypes Optional array of media types to accept ('photo', 'video', 'animation', etc.)
 * @returns Promise that resolves when the handler is set up
 */
export async function handleUserInput(
    bot: TelegramBot,
    chatId: number,
    userId: number,
    promptText: string,
    handler: MessageHandler,
    cleanup: CleanupConfig = {},
    mediaTypes?: string[]
): Promise<void> {
    const {
        successMessageTimeout = 10000,
        keepSuccessMessage = false,
        keepUserInput = false,
        keepPrompt = false
    } = cleanup;

    // Send prompt and store its message ID
    const promptMessage = await bot.sendMessage(chatId, promptText);

    const messageHandler = async (msg: TelegramBot.Message) => {
        if (msg.from?.id !== userId) return;

        // Check if we're expecting media and if this message contains it
        if (mediaTypes && mediaTypes.length > 0) {
            const hasExpectedMedia = mediaTypes.some(type => msg[type as keyof TelegramBot.Message]);
            if (!hasExpectedMedia) return;
        } else if (!msg.text) {
            return;
        }

        try {
            // Remove the message handler
            bot.removeListener('message', messageHandler);

            // Call the handler with the message
            const successText = await handler(msg);

            // Show success message
            const successMessage = await bot.sendMessage(chatId, successText);

            // Clean up messages
            try {
                if (!keepPrompt) {
                    await bot.deleteMessage(chatId, promptMessage.message_id);
                }
                if (!keepUserInput) {
                    await bot.deleteMessage(chatId, msg.message_id);
                }
                if (!keepSuccessMessage) {
                    // Delete success message after timeout
                    setTimeout(async () => {
                        try {
                            await bot.deleteMessage(chatId, successMessage.message_id);
                        } catch (deleteErr) {
                            // Ignore delete errors for the success message
                        }
                    }, successMessageTimeout);
                }
            } catch (deleteErr) {
                // Log but don't throw error for message cleanup failures
                logError('MessageUtils', deleteErr as Error, { context: 'message_cleanup' });
            }
        } catch (err) {
            logError('MessageUtils', err as Error, { context: 'input_handler' });
            const errorMsg = await bot.sendMessage(chatId, (err as Error).message || 'An error occurred while processing your input.');
            
            // Clean up messages in error case
            try {
                if (!keepPrompt) {
                    await bot.deleteMessage(chatId, promptMessage.message_id);
                }
                if (!keepUserInput) {
                    await bot.deleteMessage(chatId, msg.message_id);
                }
            } catch (deleteErr) {
                // Log but don't throw error for message cleanup failures
                logError('MessageUtils', deleteErr as Error, { context: 'message_cleanup_error' });
            }

            // Clean up error message after timeout
            setTimeout(async () => {
                try {
                    await bot.deleteMessage(chatId, errorMsg.message_id);
                } catch (deleteErr) {
                    // Ignore delete errors
                }
            }, successMessageTimeout);
        }
    };

    bot.on('message', messageHandler);
}
