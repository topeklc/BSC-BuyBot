FROM node:20-slim

WORKDIR /app

# Create app directory and set permissions
RUN mkdir -p /app && chown -R node:node /app

# Switch to non-root user
USER node

# Copy package files first to leverage Docker caching
COPY --chown=node:node package*.json ./

# Install dependencies
RUN npm install

# Copy source files
COPY --chown=node:node . .

# Compile TypeScript files
RUN npx tsc

EXPOSE 3000

# Run the compiled JavaScript files
CMD ["node", "dist/index.js"]
