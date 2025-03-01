import TelegramBot from 'node-telegram-bot-api';
import { getTrending } from '../../../DB/queries';

export const trendingNumbersMap: { [key: number]: string } = {
    0: '🥇',
    1: '🥈',
    2: '🥉',
    3: '4️⃣',
    4: '5️⃣',
}

export const updateTrending = async (bot: TelegramBot) => {
    try {
        const trendingMetrics = await getTrending();
        if (trendingMetrics.length === 0) {
            console.error('No trending metrics found');
            return;
        }
        console.log('trending', trendingMetrics);
        let trendingMessage = '🚀ICP Trending🚀\nShows 1 day change, refreshes every few minutes\n\n';
        for (let i = 0; i < 5; i++) {
            const token = trendingMetrics[i];
            const name =  token.socials.telegram ? `[${token.name}](${token.socials.telegram})` : token.name
            const change = Number(token.price_usd_change);
            const changeEmoji = change > 0 ? '🟩' : '🟥';
            trendingMessage += `${trendingNumbersMap[i]} ${name}  ${change.toFixed(2)}% ${changeEmoji}\n`;
        }
        bot.editMessageCaption(trendingMessage, { chat_id: process.env.TRENDING_CHANNEL_ID, message_id: Number(process.env.TRENDING_MESSAGE_ID) || 0, parse_mode: 'Markdown' });

    } catch (error) {
        console.error('Error updating trending', error);
    }
};
