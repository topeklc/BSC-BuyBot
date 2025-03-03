import dotenv from 'dotenv';
dotenv.config();

import eventFetcher from './eventFetcher';
import {PriceFetcher} from './priceFetcher';

const fetchEvents = async () => {
    new PriceFetcher().start();

    
    // Create event fetcher and pass websocket server for event broadcasting
    const fetcher = new eventFetcher();
    
    // Start fetching events
    await fetcher.start();
    
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