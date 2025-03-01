import { formatTokenAmount, formatDollarAmount } from './numberFormatting';
import { NewPoolMessageData } from '../../../types';
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

export interface BuyMessageData {
    spentToken: TokenData;
    gotToken: TokenData;
    pairAddress: string;
    spentDollars: number;
    holderIncrease: string;
    holderWallet: string;
    marketcap: number;
    dex: string;
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
        dex: 'PancakeSwap'
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
const getHolderIncreaseText = (increase: string) => {
    if (!increase) return '';
    if (increase.startsWith('New')) return `**👥 ${increase}**\n`;
    if (increase.startsWith('+')) return `**⏫ Position Increase: ${increase}**\n`;
    return '';
};

export function formatBuyMessage(data: BuyMessageData, subscriberData: SubscriberData, rank: number | undefined=undefined): string {
    let chartLinks = '';
    if (data.pairAddress && data.pairAddress !== '0x0000000000000000000000000000000000000000') {
        
    const dexscreenerLink = `https://dexscreener.com/bsc/${data.gotToken.address}`;
    const dextoolsLink = `https://www.dextools.io/app/en/bsc/pair-explorer/${data.pairAddress}`;
    chartLinks = `**📈[DexScreener](${dexscreenerLink}) | [DexTools](${dextoolsLink})**\n`;

    } else {
        const springboardLink = `https://springboard.pancakeswap.finance/bsc/token/${data.gotToken.address}`;
        chartLinks = `**📈[Springboard](${springboardLink})**\n`;

    }
    const tokenDetailsLink = `**🔍[Details](https://bscscan.com/address/${data.gotToken.address})**\n`;
    const tokenName = subscriberData.socials.telegram ? `[${data.gotToken.name}](${subscriberData.socials.telegram})` : data.gotToken.name;
    const emojiDenominator = 20
    const emojis = subscriberData.emoji.repeat(Math.min(Math.floor(data.spentDollars) / emojiDenominator | 1, 250));
    const socials = generateSocialLinksString(subscriberData.socials)
    
    const holderIncrease = getHolderIncreaseText(data.holderIncrease);
    let trending = '';
    if (rank) {
        trending = `\n🚀[BSCTrending ${trendingNumbersMap[rank - 1]}](https://t.me/icp_trending)`;
    }
    const holderWallet = data.holderWallet ? `**💸[Holder wallet](https://bscscan.com/address/${data.holderWallet})**\n` : ''
    return [
        `**__🚨 ${tokenName} New Buy!🚨__**\n\n`,
        `${emojis}\n\n`,
        `**💰Spent: ${formatTokenAmount(data.spentToken.amount)} ${data.spentToken.symbol} \\[$${formatDollarAmount(data.spentDollars)}\]**\n`,
        `**🧳Bought: ${formatTokenAmount(data.gotToken.amount)} $${data.gotToken.symbol}**\n`,
        `**💵Price: $${formatTokenAmount(data.gotToken.priceUSD)}**\n`,
        holderIncrease,
        `**📊Marketcap: $${formatDollarAmount(data.marketcap, false)}**\n\n`,
        tokenDetailsLink,
        holderWallet,
        chartLinks,
        socials,
        trending

    ].join('');
}

