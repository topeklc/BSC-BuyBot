import WebSocket from 'ws';
import TelegramBot from 'node-telegram-bot-api';
import { getGroupConfigByField, getTrending, getAllActiveTokens } from '../../../DB/queries';
import { sendBuyMessage } from '../libs/utils';
import { formatBuyMessage } from '../libs/messages';
import { logError, logInfo } from '../libs/logger';
import { WBNB } from '../../../CommonWeb3/common';


export class WebSocketClient {
    private ws: WebSocket | null = null;
    private bot: TelegramBot;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private pingInterval: NodeJS.Timeout | null = null;
    private reconnectCount: number = 0;
    private maxReconnectAttempts: number = 100; // Higher limit for long-running apps
    private readonly reconnectInterval: number = 5000; // 5 seconds base
    private isConnecting: boolean = false;
    private lastMessageTime: number = Date.now();
    private connectionCheckInterval: NodeJS.Timeout | null = null;
    
    // Add a message cache to prevent duplicate processing
    private recentMessages: Map<string, number> = new Map();
    private readonly MESSAGE_CACHE_TIMEOUT = 60000; // 60 seconds
    // Add a set to track processed transaction hashes
    private processedTxHashes: Set<string> = new Set();

    constructor(bot: TelegramBot) {
        this.bot = bot;
        logInfo('WebSocket', 'Initializing WebSocket client');
        this.connect();
        this.startConnectionMonitoring();
    }

    private connect(): WebSocket | null {
        if (this.isConnecting) {
            logInfo('WebSocket', 'Connection attempt already in progress');
            return this.ws;
        }

        if (this.reconnectCount >= this.maxReconnectAttempts) {
            logError('WebSocket', `Exceeded maximum reconnection attempts (${this.maxReconnectAttempts})`);
            return null;
        }

        this.isConnecting = true;
        const wsUrl = `ws://${process.env.FETCHER_HOST || 'localhost'}:${process.env.FETCHER_PORT || 3000}`;
        logInfo('WebSocket', `Connecting to ${wsUrl} (attempt ${this.reconnectCount + 1})`);
        
        // Add connection timeout
        const connectionTimeout = setTimeout(() => {
            if (this.isConnecting) {
                logError('WebSocket', 'Connection attempt timed out');
                this.isConnecting = false;
                this.scheduleReconnect();
            }
        }, 10000); // 10 second timeout
        
        try {
            const ws = new WebSocket(wsUrl, {
                handshakeTimeout: 5000,
                maxPayload: 100 * 1024 * 1024, // 100MB max payload
            });

            ws.on('open', () => {
                clearTimeout(connectionTimeout);
                logInfo('WebSocket', 'Connected to Fetcher');
                this.isConnecting = false;
                this.reconnectCount = 0; // Reset count on successful connection
                this.lastMessageTime = Date.now();
                
                if (this.reconnectTimeout) {
                    clearTimeout(this.reconnectTimeout);
                    this.reconnectTimeout = null;
                }
                
                // Send a handshake message to confirm connection
                ws.send(JSON.stringify({ 
                    type: 'ClientHandshake', 
                    client: 'BuyBot',
                    version: '1.0.0',
                    timestamp: new Date().toISOString()
                }));
                
                // Start periodic pings to keep connection alive
                this.startPingInterval(ws);
            });

            ws.on('ping', () => {
                logInfo('WebSocket', 'Received ping from server');
                try {
                    ws.pong();
                } catch (error) {
                    logError('WebSocket', 'Error sending pong response');
                }
            });
            
            ws.on('pong', () => {
                logInfo('WebSocket', 'Received pong from server');
                this.lastMessageTime = Date.now();
            });

            ws.on('message', async (data) => {
                try {
                    this.lastMessageTime = Date.now(); // Update last activity time
                    const rawMessage = data.toString();
                    const parsedMessage = JSON.parse(rawMessage);
                    
                    // Handle heartbeat messages
                    if (parsedMessage.type === 'Heartbeat' || parsedMessage.type === 'Pong') {
                        logInfo('WebSocket', `Received ${parsedMessage.type} from server`);
                        return;
                    }
                    
                    logInfo('WebSocket', `Received message type: ${parsedMessage.type}`);
                    
                    if (parsedMessage.type === 'NewBuy') {
                        await this.handleBuyMessage(parsedMessage);
                    }
                    
                    // Handle other message types as needed
                } catch (error) {
                    logError('Error processing message', error as Error);
                }
            });

            ws.on('close', (code, reason) => {
                logInfo('WebSocket', `Connection closed. Code: ${code}, Reason: ${reason.toString()}`);
                this.cleanup();
                this.scheduleReconnect();
            });

            ws.on('error', (error) => {
                logError('WebSocket error', error);
                this.cleanup();
                this.scheduleReconnect();
            });

            this.ws = ws;
            return ws;
        } catch (error) {
            clearTimeout(connectionTimeout);
            logError('WebSocket', `Connection error: ${error}`);
            this.isConnecting = false;
            this.scheduleReconnect();
            return null;
        }
    }
    
    private startConnectionMonitoring(): void {
        // Clear any existing interval
        if (this.connectionCheckInterval) {
            clearInterval(this.connectionCheckInterval);
        }
        
        // Check connection health every minute
        this.connectionCheckInterval = setInterval(() => {
            const now = Date.now();
            const timeSinceLastMessage = now - this.lastMessageTime;
            
            // If no message for 2 minutes, consider connection dead
            if (timeSinceLastMessage > 120000) { // 2 minutes
                logError('WebSocket', `No messages received for ${Math.round(timeSinceLastMessage/1000)} seconds, reconnecting`);
                this.cleanup();
                this.connect();
            } else {
                // Send ping to keep connection alive
                this.sendPing();
            }
        }, 60000); // Check every minute
    }
    
    private startPingInterval(ws: WebSocket): void {
        // Clear existing interval if any
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
        }
        
        // Send ping every 30 seconds
        this.pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                try {
                    ws.send(JSON.stringify({
                        type: 'Ping',
                        timestamp: new Date().toISOString()
                    }));
                    logInfo('WebSocket', 'Sent ping to server');
                } catch (error) {
                    logError('WebSocket', `Error sending ping: ${error}`);
                    this.cleanup();
                    this.connect();
                }
            } else {
                logError('WebSocket', `Cannot ping: socket state is ${ws.readyState}`);
                this.cleanup();
                this.connect();
            }
        }, 30000);
    }
    
    private sendPing(): void {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                this.ws.send(JSON.stringify({
                    type: 'Ping',
                    timestamp: new Date().toISOString()
                }));
                logInfo('WebSocket', 'Sent ping to server');
            } catch (error) {
                logError('WebSocket', `Error sending ping: ${error}`);
            }
        }
    }
    
    private cleanup(): void {
        // Clear intervals
        if (this.pingInterval) {
            clearInterval(this.pingInterval);
            this.pingInterval = null;
        }
        
        // Close websocket if it exists
        if (this.ws) {
            try {
                // Only close if not already closed
                if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
                    this.ws.close();
                }
            } catch (error) {
                logError('WebSocket', `Error closing WebSocket: ${error}`);
            }
            this.ws = null;
        }
        
        this.isConnecting = false;
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimeout || this.isConnecting) {
            return;
        }
        
        // Exponential backoff with jitter
        const baseDelay = this.reconnectInterval;
        const maxDelay = 60000; // Max 1 minute
        
        // Calculate delay with exponential backoff
        let delay = Math.min(baseDelay * Math.pow(1.5, this.reconnectCount), maxDelay);
        
        // Add jitter (±20%)
        delay = delay * (0.8 + Math.random() * 0.4);
        
        logInfo('WebSocket', `Scheduling reconnect in ${Math.round(delay/1000)} seconds`);
        
        this.reconnectTimeout = setTimeout(() => {
            this.reconnectCount++;
            this.reconnectTimeout = null;
            this.connect();
        }, delay);
    }

    public close(): void {
        logInfo('WebSocket', 'Closing WebSocket client');
        
        // Clear all caches and timeouts
        if (this.reconnectTimeout) {
            clearTimeout(this.reconnectTimeout);
            this.reconnectTimeout = null;
        }
        
        if (this.connectionCheckInterval) {
            clearInterval(this.connectionCheckInterval);
            this.connectionCheckInterval = null;
        }
        
        this.recentMessages.clear();
        this.processedTxHashes.clear();
        this.cleanup();
    }
    
    /**
     * Check if a buy message is a duplicate with stronger checks
     */
    private isDuplicateBuyMessage(message: any): boolean {
        if (!message || !message.gotToken) return false;
        
        // Use txHash for strongest deduplication if available
        if (message.txHash) {
            if (this.processedTxHashes.has(message.txHash)) {
                logInfo('WebSocket', `Detected duplicate transaction: ${message.txHash}`);
                return true;
            }
            
            // Add to our processed tx hashes
            this.processedTxHashes.add(message.txHash);
            
            // Clean up tx hash set if it gets too large
            if (this.processedTxHashes.size > 1000) {
                // Just clear all for simplicity - in production you'd want to be more selective
                logInfo('WebSocket', 'Clearing transaction hash cache (reached 1000 entries)');
                this.processedTxHashes.clear();
            }
        }
        
        // Create multiple keys for the message
        const messageKeys = [
            // Standard key with all values
            `${message.holderWallet}-${message.gotToken.address}-${message.gotToken.amount}-${message.spentToken.amount}`,
            
            // Key with just token and amounts
            `${message.gotToken.address}-${message.gotToken.amount}-${message.spentToken.amount}`,
            
            // Time-based key for rapid buys
            `${message.holderWallet}-${message.gotToken.address}-${Math.floor(Date.now()/1000/10)}` 
        ];
        
        const now = Date.now();
        
        // Clean up old entries in the message cache
        for (const [key, timestamp] of this.recentMessages.entries()) {
            if (now - timestamp > this.MESSAGE_CACHE_TIMEOUT) {
                this.recentMessages.delete(key);
            }
        }
        
        // Check if any key exists in our cache
        for (const key of messageKeys) {
            if (this.recentMessages.has(key)) {
                logInfo('WebSocket', `Detected duplicate buy message with key: ${key}`);
                return true;
            }
        }
        
        // Store all keys in the cache
        for (const key of messageKeys) {
            this.recentMessages.set(key, now);
        }
        
        // Log that this is a new message
        logInfo('WebSocket', 'New message detected, not a duplicate');
        return false;
    }

    private async handleBuyMessage(parsedMessage: any): Promise<void> {
        // Parse the message content if it's a string
        const buyMessage = typeof parsedMessage.message === 'string' 
            ? JSON.parse(parsedMessage.message) 
            : parsedMessage.message;
        
        console.log('Buy message:', buyMessage);
        console.log('Buy message gotToken:', buyMessage?.gotToken?.address);
        console.log('Buy message txHash:', buyMessage?.txHash || 'none');
        
        if (!buyMessage || !buyMessage.gotToken || !buyMessage.gotToken.address) {
            logError('Buy Message', 'Invalid buy message format');
            return;
        }
        
        // Check for duplicate with enhanced detection
        if (this.isDuplicateBuyMessage(buyMessage)) {
            logInfo('Buy Message', 'Ignoring duplicate buy message');
            return;
        }
        
        // Get all group configurations that have this token
        const groupsToSend = await getGroupConfigByField('address', buyMessage.gotToken.address);
        
        // Send to trending first
        const spentAmountDollars = buyMessage.spentToken.amount * buyMessage.spentToken.priceUSD;
        logInfo('Buy Message', 'Processing buy message', { 
            token: buyMessage.gotToken.name, 
            groups: groupsToSend.length,
            amount: buyMessage.spentToken.amount,
            spentAmountDollars: spentAmountDollars
        });
        
        const trending = await getTrending();
        const trendingToken = trending.slice(0, 5).find(token => token.address === buyMessage.gotToken.address);
        
        if (trendingToken && spentAmountDollars > 10) {
            try {
                var rank = trendingToken.place;
                const message = formatBuyMessage(buyMessage, {emoji: '🚀', socials: {website: null, x: null, telegram: null}}, rank);
                await sendBuyMessage(this.bot, Number(process.env.TRENDING_CHANNEL_ID), message, `https://app.icpswap.com/swap/pro?input=${buyMessage.spentToken.address}&output=${buyMessage.gotToken.address}`);
            } catch (error) {
                logError('Failed to send buy message to trending', error as Error);
            }
        }
        
        // Check if the bought token is one we want to track
        const activeTokens = await getAllActiveTokens();
        if (buyMessage.gotToken.address === WBNB || !activeTokens.includes(buyMessage.gotToken.address)) {
            console.log(`Skipping: Token ${buyMessage.gotToken.address} not in active tracking ${activeTokens} list or it's bnb`);
            return;
        }
        
        // Send message to each configured group
        for (const config of groupsToSend) {
            try {
                console.log('Group config:', config.group_id, buyMessage.gotToken.address, config.pools, buyMessage.pairAddress);
                // Skip if notifications are disabled or amount is below minimum
                if (!config.active || (config.min_amount > 0 && config.min_amount > spentAmountDollars)) {
                    logInfo('Buy Message', 'Skipping group', { 
                        groupId: config.group_id, 
                        reason: !config.active ? 'inactive' : 'below minimum amount',
                        minAmount: config.min_amount,
                        actualAmount: buyMessage.spentToken.amount
                    });
                    continue;
                }

                // Updated condition to handle both pairAddress and poolAddress
                const isSpringboardPurchase = buyMessage.dex === 'Springboard';
                
                // Check if any address matches the configured pools or token address for Springboard
                const isPairAddressMatching = config.pools.includes(buyMessage.pairAddress);
                
                if (!isPairAddressMatching  && !isSpringboardPurchase) {
                    logInfo('Buy Message', 'Skipping group due to pool address mismatch', { 
                        groupId: config.group_id, 
                        poolAddress: buyMessage.pairAddress,
                        tokenAddress: buyMessage.gotToken.address,
                        configuredPools: config.pools,
                        isSpringboard: buyMessage.dex === 'Springboard'
                    });
                    continue;
                }
                
                let message = formatBuyMessage(buyMessage, {emoji: config.emoji, socials: config.socials}, rank);
                logInfo('Buy Message', 'Sending buy message', { message });
                
                let buyUrl = `https://pancakeswap.finance/?outputCurrency=${buyMessage.gotToken.address}`;
                if (parsedMessage.dex === "springboard") {
                    buyUrl = `https://springboard.pancakeswap.finance/bsc/token/${buyMessage.gotToken.address}`;
                }
                
                await sendBuyMessage(this.bot, config.group_id, message, buyUrl, config.media);
            } catch (error) {
                logError('Failed to send buy message to group', error as Error);
            }
        }
    }
}
