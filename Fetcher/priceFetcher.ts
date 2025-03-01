import { CommonWeb3, WBNB } from '../CommonWeb3/common';
import { saveTokenPrice } from '../DB/queries';

// Use simple console.log for now since logger might not be set up
const logInfo = (context: string, message: string, data?: any) => {
  console.log(`[${context}] ${message}`, data || '');
};

const logError = (context: string, error: Error | string) => {
  console.error(`[${context}] ${typeof error === 'string' ? error : error.message}`);
  if (error instanceof Error) console.error(error.stack);
};

// Export the class directly instead of using default export
export class PriceFetcher {
    private commonWeb3: CommonWeb3;
    private fetchInterval: NodeJS.Timeout | null = null;
    private readonly intervalTime: number; // in milliseconds

    /**
     * Creates a new PriceFetcher instance
     * @param intervalMinutes How often to fetch prices in minutes
     */
    constructor(intervalMinutes: number = 5) {
        this.commonWeb3 = new CommonWeb3();
        this.intervalTime = intervalMinutes * 60 * 1000; // Convert minutes to milliseconds
        logInfo('PriceFetcher', `Initialized with ${intervalMinutes} minute interval`);
    }

    /**
     * Start the price fetcher service
     */
    public start(): void {
        if (this.fetchInterval) {
            logInfo('PriceFetcher', 'Price fetcher already running');
            return;
        }

        logInfo('PriceFetcher', 'Starting price fetcher service');
        
        // Fetch immediately on start
        this.fetchAndSavePrice().catch(err => 
            logError('Error in initial price fetch', err instanceof Error ? err : new Error(String(err)))
        );
        
        // Then set up the interval
        this.fetchInterval = setInterval(async () => {
            try {
                await this.fetchAndSavePrice();
            } catch (error) {
                logError('Error in scheduled price fetch', error instanceof Error ? error : new Error(String(error)));
            }
        }, this.intervalTime);
    }

    /**
     * Stop the price fetcher service
     */
    public stop(): void {
        if (this.fetchInterval) {
            clearInterval(this.fetchInterval);
            this.fetchInterval = null;
            logInfo('PriceFetcher', 'Price fetcher service stopped');
        }
    }

    /**
     * Fetch the current WBNB price and save it to the database
     */
    private async fetchAndSavePrice(): Promise<void> {
        logInfo('PriceFetcher', 'Fetching WBNB price');
        
        try {
            // Get WBNB price in USDC
            const price = await this.commonWeb3.getMainPrice();
            
            if (price <= 0) {
                throw new Error('Invalid price returned');
            }
            
            logInfo('PriceFetcher', `WBNB price: $${price}`);
            
            // Save to database
            await saveTokenPrice(WBNB, price);
            
            logInfo('PriceFetcher', 'WBNB price saved to database');
        } catch (error) {
            logError('PriceFetcher', error instanceof Error ? error : new Error(String(error)));
            throw error;
        }
    }
}
