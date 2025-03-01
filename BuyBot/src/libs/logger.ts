import winston from 'winston';

// Custom replacer for JSON.stringify to handle BigInt
const customReplacer = (key: string, value: any) => {
    if (typeof value === 'bigint') {
        return value.toString();
    }
    return value;
};

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        winston.format.printf(({ level, message, timestamp, ...rest }) => {
            const extras = Object.keys(rest).length ? `\n${JSON.stringify(rest, customReplacer, 2)}` : '';
            return `${timestamp} ${level}: ${typeof message === 'object' ? JSON.stringify(message, customReplacer, 2) : message}${extras}`;
        })
    ),
    transports: [
        new winston.transports.Console(),
    ]
});

if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.combine(
            winston.format.colorize(),
            winston.format.printf(({ level, message, timestamp, ...rest }) => {
                const extras = Object.keys(rest).length ? `\n${JSON.stringify(rest, customReplacer, 2)}` : '';
                return `${timestamp} ${level}: ${typeof message === 'object' ? JSON.stringify(message, customReplacer, 2) : message}${extras}`;
            })
        )
    }));
}

export const logError = (context: string, error: any, additionalInfo?: any) => {
    const errorObj = {
        context,
        error: error instanceof Error ? {
            message: error.message,
            name: error.name,
            stack: error.stack,
        } : JSON.stringify(error, customReplacer),
        ...(additionalInfo ? { additionalInfo } : {})
    };
    logger.error(errorObj);
};

export const logInfo = (context: string, message: string, additionalInfo?: any) => {
    logger.info({
        context,
        message,
        ...additionalInfo
    });
};

export const logDebug = (context: string, message: string, additionalInfo?: any) => {
    logger.debug({
        context,
        message,
        ...additionalInfo
    });
};

export default logger;
