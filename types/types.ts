import { KeyboardButtonRequestUser, KeyboardButtonPollType, WebAppInfo } from 'node-telegram-bot-api';


export interface Group {
    id: bigint;
    name: string;
    link: string;
    created_at: Date;
    updated_at: Date;
}

export interface GroupConfig {
    address: string
    minBuyAmount: number;
    buyMessageTemplate: string;
    pools: string[];
    socials: Socials;
}

export interface Socials {
    telegram?: string;
    x?: string;
    website?: string;
}

interface KeyboardButtonRequestChat {
    request_id: number;
    chat_is_channel: boolean;
    chat_is_forum?: boolean | undefined;
    chat_has_username?: boolean | undefined;
    chat_is_created?: boolean | undefined;
    user_administrator_rights?: {can_manage_chat: boolean} | undefined;
    bot_administrator_rights?: boolean | undefined;
    bot_is_member?: boolean | undefined;
}

interface KeyboardButton {
    text: string;
    request_user?: KeyboardButtonRequestUser | undefined;
    request_chat?: KeyboardButtonRequestChat | undefined;
    request_contact?: boolean | undefined;
    request_location?: boolean | undefined;
    request_poll?: KeyboardButtonPollType;
    web_app?: WebAppInfo;
}

export interface CustomKeyboardButton extends KeyboardButton {
    request_chat?: {
        request_id: number;
        chat_is_channel: boolean;
        user_administrator_rights?: {
            can_manage_chat: boolean
        };
        bot_is_member: boolean;
    };
}

export interface BuyMessageData {
    spentToken: {
        address: string;
        name: string;
        symbol: string;
        amount: number;
        priceUSD: number;
        pricePairToken: number;
    };
    gotToken: {
        address: string;
        name: string;
        symbol: string;
        amount: number;
        priceUSD: number;
        pricePairToken: number;
    };
    pairAddress: string;
    spentDollars: number;
    holderIncrease: string;
    holderWallet: string;
    marketcap: number;
    txHash: string;
    dex: string;
    bondingStatus: number;
}


export interface NewPoolMessageData {
    canisterId: string;
    token0: TokenData;
    token1: TokenData;
    dex: string;
    type: string;
}

export interface TokenData {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: string;
  owner: string;
  poolAddresses: string[];
}

export interface TokenInfo {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    totalSupply: string;
    owner: string;
    poolAddresses?: string[] | undefined;
    holders?: number;
    timestamp?: string;
  }

export interface PoolDetail {
    fee: number;
    tickSpacing: number;
    address: string;
    token0_address: string;
    token1_address: string;
    version: number;
  }