import dotenv from 'dotenv';
dotenv.config();

import eventFetcher from './eventFetcher';
import {PriceFetcher} from './priceFetcher';
import {BlockPoller} from './blockPoller';

// Global error handlers
process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
    // Optionally, you can restart the process or perform other recovery actions
    // process.exit(1); // Uncomment to exit the process
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Optionally, you can restart the process or perform other recovery actions
    // process.exit(1); // Uncomment to exit the process
});

const fetchEvents = async () => {
    new PriceFetcher().start();

    // // Create event fetcher and pass websocket server for event broadcasting
    // const fetcher = new eventFetcher();
    
    // // Start fetching events
    // await fetcher.start();
    new BlockPoller().start();
    // Handle process shutdown
    const shutdown = () => {
        console.log('Shutting down...');
        process.exit(0);
    };
    
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
};

fetchEvents().catch(console.error);
// Keep process running
setInterval(() => {}, 60000);