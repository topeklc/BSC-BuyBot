import { formatTokenAmount, formatDollarAmount } from './numberFormatting';
import { NewPoolMessageData, BuyMessageData, PoolDetail } from '../../../types';
import { trendingNumbersMap } from './trending';
// TODO move interfaces
export interface TokenData {
    address: string;
    name: string;
    symbol: string;
    amount: number;
    priceUSD: number;
    pricePairToken: number;
    totalSupply?: number;
}


export interface Socials {
    website: string | null;
    telegram: string | null;
    x: string | null;
}

export interface SubscriberData {
    emoji: string;
    socials: Socials;
}

export const getFakeBuyMessage = (gotToken: TokenData, pairAddress: string): BuyMessageData => {
    return {
        gotToken,
        spentToken: {
            address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
            name: 'Wrapped BNB',
            symbol: 'WBNB',
            amount: 1,
            priceUSD: 500,
            pricePairToken: 0.0001,

        },
        pairAddress: pairAddress,
        spentDollars: 1000,
        holderIncrease: 'New Holder!',
        holderWallet: '5dcn7-ic2md-acdb6-6a4j6-jmw4m-zb75p-5emge-bngjv-x5znn-wfhbl-5ae', //blockchain pill address
        marketcap: 100000000000,
        dex: 'PancakeSwap',
        bondingStatus: 10 * 10**18,
    }
}

/**
 * Generates a formatted string of social media links
 * @param socials Object containing social media links
 * @returns Formatted string of social links or empty string if no links are present
 */
function generateSocialLinksString(socials: Socials): string {
    const socialLinks = [];
    
    // Define the order and display text for each social type
    const socialTypes: Array<{key: keyof Socials; label: string}> = [
        { key: 'website', label: 'Website' },
        { key: 'telegram', label: 'Telegram' },
        { key: 'x', label: 'X' },
    ];

    // Add each social link if it exists
    for (const { key, label } of socialTypes) {
        if (socials[key]) {
            socialLinks.push(`[${label}](${socials[key]})`);
        }
    }

    // Return formatted string if there are any links, otherwise empty string
    return socialLinks.length > 0 ? `**👥${socialLinks.join(' | ')}**\n` : '';
}
// const getHolderIncreaseText = (increase: string) => {
//     if (!increase) return '';
//     if (increase.startsWith('New')) return `**👥 ${increase}**\n`;
//     if (increase.startsWith('+')) return `**⏫ Position Increase: ${increase}**\n`;
//     return '';
// };
const getHolderIncreaseText = (increase: string) => {
    if (!increase) return '';
    if (increase.startsWith('New')) return `: New!`;
    if (increase.startsWith('+')) return `: ${increase}`;
    return '';
};
export function formatBuyMessage(data: BuyMessageData, subscriberData: SubscriberData, rank: number | undefined=undefined): string {
    let chartLinks = '';
    if (data.pairAddress && data.pairAddress !== '0x0000000000000000000000000000000000000000') {
        
    const dexscreenerLink = `https://dexscreener.com/bsc/${data.gotToken.address}`;
    const dextoolsLink = `https://www.dextools.io/app/en/bsc/pair-explorer/${data.pairAddress}`;
    chartLinks = `**📈[DexScreener](${dexscreenerLink}) | [DexTools](${dextoolsLink})**\n`;

    } else {
        const springboardLink = `https://four.meme/token/${data.gotToken.address}?code=T4E34ZQNM2RH`;
        chartLinks = `**📈[Four Meme](${springboardLink})**\n`;
    }
    const bondingStatus = data.bondingStatus ? `**🔗 Bonding Status ${(data.bondingStatus / 10**18).toFixed(2)} BNB / 24.00 BNB** \n\n${generateProgressBar(data.bondingStatus)}**\n\n` : '';
    const txDetailsLink = `**🔍[Details](https://bscscan.com/tx/${data.txHash})**\n`;
    const tokenName = subscriberData.socials.telegram ? `[${data.gotToken.name}](${subscriberData.socials.telegram})` : data.gotToken.name;
    const emojiDenominator = 20
    const emojis = subscriberData.emoji.repeat(Math.min(Math.floor(data.spentDollars) / emojiDenominator | 1, 250));
    const socials = generateSocialLinksString(subscriberData.socials)
    
    const holderIncrease = getHolderIncreaseText(data.holderIncrease) || '';
    let trending = '';
    if (rank) {
        trending = `\n🚀[BSCTrending ${trendingNumbersMap[rank - 1]}](https://t.me/icp_trending)`;
    }
    const holderWallet = data.holderWallet ? `**💸[Holder${holderIncrease}](https://bscscan.com/address/${data.holderWallet})**\n` : ''
    return [
        `**__🚨 ${tokenName} New Buy!🚨__**\n\n`,
        `${emojis}\n\n`,
        `**💰Spent: ${formatTokenAmount(data.spentToken.amount)} ${data.spentToken.symbol} \\[$${formatDollarAmount(data.spentDollars)}\]**\n`,
        `**🧳Bought: ${formatTokenAmount(data.gotToken.amount)} $${data.gotToken.symbol}**\n`,
        `**💵Price: $${formatTokenAmount(data.gotToken.priceUSD)}**\n`,
        `**📊Marketcap: $${formatDollarAmount(data.marketcap, false)}**\n\n`,
        txDetailsLink,
        holderWallet,
        chartLinks,
        bondingStatus,
        socials,

    ].join('');
}

function generateProgressBar(currentAmount: number): string {
    const maxAmount = 24 * 10**18;
    const progressPercentage = (currentAmount / maxAmount) * 100;
    const maxSquares = 10;
    const filledSquares = Math.min(Math.floor(progressPercentage / 10), maxSquares);
    const unfilledSquares = maxSquares - filledSquares;

    const filledPart = '🟩'.repeat(filledSquares);
    const unfilledPart = '🟥'.repeat(unfilledSquares);

    return `${filledPart}${unfilledPart}`;
}

/**
 * Formats a message for a new pool created event
 * @param tokenName The name of the token
 * @param poolDetail The details of the pool
 * @returns Formatted message for the new pool notification
 */
export function formatNewPoolMessage(tokenName: string, poolDetail: PoolDetail): string {
    return `**🚨 Bonding reached! New pool for token ${tokenName} has been created! 🚨**\n\n` +
           `**Pool Address:** [${poolDetail.address}](https://bscscan.com/address/${poolDetail.address})\n`
}

export function getHelpMessage(): string {
    return `
📢 Buy Bot - Setup Guide 📢

🚀 Get real-time buy notifications in your group! Follow these steps to set up:

1️⃣ Start the Bot
🔹 Click Start or send /start (Only works in DMs to the bot).

2️⃣ Register a Token
🔹 Tap Register Token to begin setup.

3️⃣ Choose a Group
🔹 Click Choose Group (at the bottom of the chat).
🔹 Select the Telegram group where you want buy notifications.

4️⃣ Enter Token Address
🔹 The bot will ask for the token address.
🔹 After sending a valid address, the configuration menu will appear.

5️⃣ Configure Settings (Optional)
⚙ Set Media – Add a GIF or image for buy notifications.
💰 Min Amount – Set a minimum $ amount for notifications.
🌊 Pools – Select which liquidity pools to track.
🔗 Socials – Add links to Telegram, X (Twitter), and website.
🛠 Test – Preview your New Buy message.

✅ Done! Buy Bot will now post notifications based on your setup! 🚀🔥
    `;
}