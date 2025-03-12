import { BuyMessageData } from '../types/types';
import { CommonWeb3, WBNB } from '../CommonWeb3/common';
import { getPrice } from '../DB/queries';
import { getHolderIncrease } from './utils';

/**
 * Processes meme token buy events and converts them to BuyMessageData
 */
export class MemeSwapHandler {
    private commonWeb3: CommonWeb3;

    constructor() {
        this.commonWeb3 = new CommonWeb3();
    }
    
    /**
     * Process a buy event and convert it to BuyMessageData format
     * @param decodedLog The decoded log data from the buy event
     * @param txHash The transaction hash
     */
    public async processBuyEvent(decodedLog: any, txHash: string): Promise<BuyMessageData> {
        // handle Springboard buys.
        const tokenInfo = await this.commonWeb3.getTokenInfo(String(decodedLog.token));

        // Get holder balance
        let holderIncrease = '0';
        const holderBalance = await this.commonWeb3.getBalanceOf(tokenInfo.address, String(decodedLog.account));
        if (holderBalance) {
            holderIncrease = getHolderIncrease(holderBalance, Number(decodedLog.amount));
        }
        
        const WBNBPrice = (await getPrice()).price_usd // get price of WBNB in usd
        const spentAmount = Number(decodedLog.cost) / 10**18
        const spentDollars = spentAmount * WBNBPrice
        const price = spentDollars / (Number(decodedLog.amount) / 10**18)
        const marketcap = (Number(tokenInfo.totalSupply) / 10**18) * price // get marketcap TODO check burned tokens
        const dex = 'Springboard' 
        
        const buy: BuyMessageData = {
            spentToken: {
                address: WBNB, 
                name: 'Wrapped BNB', 
                symbol: 'WBNB', 
                amount: spentAmount, 
                priceUSD: WBNBPrice, 
                pricePairToken: Number(decodedLog.price) / 10**18
            },
            gotToken: {
                amount: Number(decodedLog.amount) / 10**18, 
                address: tokenInfo.address, 
                name: tokenInfo.name, 
                symbol: tokenInfo.symbol, 
                priceUSD: price, 
                pricePairToken: Number(decodedLog.price) / 10**18
            },
            holderWallet: String(decodedLog.account),
            pairAddress: tokenInfo.poolAddresses ? tokenInfo.poolAddresses[0] : '',
            spentDollars: spentDollars,
            holderIncrease: holderIncrease,
            marketcap: marketcap,
            dex: dex,
            txHash: txHash,
            bondingStatus: Number(decodedLog.funds)
        }
        
        return buy;
    }
}
