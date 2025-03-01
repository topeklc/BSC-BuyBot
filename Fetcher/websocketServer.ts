import WebSocket, { Server } from 'ws';
import http from 'http';

// Export the class with a named export instead of default export
export class WebSocketServer {
  private server: Server;
  private clients: Set<WebSocket> = new Set();
  private httpServer: http.Server;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private reconnectAttemptInterval: NodeJS.Timeout | null = null;
  
  constructor() {

    
    this.initServer();
  }

  private initServer() {
    try {
      const port = process.env.FETCHER_PORT ? parseInt(process.env.FETCHER_PORT) : 2111;
      console.log(`Starting WebSocket server on port ${port}`);
      // Clean up any existing server
      this.cleanup();
      
      this.httpServer = http.createServer((req, res) => {
          // Simple health check endpoint
          if (req.url === '/health') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ 
                  status: 'healthy',
                  clients: this.clients.size,
                  uptime: process.uptime()
              }));
          } else {
              res.writeHead(404);
              res.end();
          }
      });

      this.server = new WebSocket.Server({ 
        server: this.httpServer,
        // Set ping timeout to 45 seconds
        clientTracking: true,
        perMessageDeflate: {
          zlibDeflateOptions: {
            chunkSize: 1024,
            memLevel: 7,
            level: 3
          },
          zlibInflateOptions: {
            chunkSize: 10 * 1024
          },
          clientNoContextTakeover: true,
          serverNoContextTakeover: true,
          serverMaxWindowBits: 10,
          concurrencyLimit: 10,
          threshold: 1024
        }
      });
      
      this.server.on('connection', (ws: WebSocket, req: http.IncomingMessage) => {
          console.log(`New client connected from ${req.socket.remoteAddress}`);
          this.handleConnection(ws, req);
      });
      
      this.server.on('error', (error: Error) => {
          console.error('WebSocket server error:', error);
          this.scheduleServerRestart();
      });
      
      this.server.on('close', () => {
        console.log('WebSocket server closed');
        this.scheduleServerRestart();
      });
      
      this.httpServer.on('error', (error: Error) => {
        console.error('HTTP server error:', error);
        this.scheduleServerRestart();
      });
      
      this.httpServer.listen(port, () => {
          console.log(`WebSocket server listening on port ${port}`);
      });
      
      // Setup heartbeat to keep connections alive and detect stale clients
      this.heartbeatInterval = setInterval(() => this.sendHeartbeats(), 30000);

      // Debug periodic logging of client count
      setInterval(() => {
          console.log(`Current WebSocket clients: ${this.clients.size}`);
          if (this.clients.size === 0) {
              console.log("Warning: No connected clients to receive broadcasts");
          }
          
          // Log some diagnostics
          const memory = process.memoryUsage();
          console.log(`Memory: ${Math.round(memory.rss / 1024 / 1024)}MB RSS, ${Math.round(memory.heapUsed / 1024 / 1024)}MB Heap Used`);
      }, 60000);
      
    } catch (error) {
      console.error('Error initializing WebSocket server:', error);
      this.scheduleServerRestart();
    }
  }
  
  private scheduleServerRestart() {
    if (this.reconnectAttemptInterval) {
      clearTimeout(this.reconnectAttemptInterval);
    }
    
    console.log('Scheduling server restart in 5 seconds...');
    this.reconnectAttemptInterval = setTimeout(() => {
      console.log('Attempting to restart WebSocket server...');
      this.initServer();  // Default port
    }, 5000);
  }
  
  private cleanup() {
    // Clear existing intervals
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    
    if (this.reconnectAttemptInterval) {
      clearTimeout(this.reconnectAttemptInterval);
      this.reconnectAttemptInterval = null;
    }
    
    // Close existing clients
    if (this.clients && this.clients.size > 0) {
      console.log(`Closing ${this.clients.size} existing client connections`);
      this.clients.forEach(client => {
        try {
          client.terminate();
        } catch (error) {
          console.error('Error terminating client:', error);
        }
      });
      this.clients.clear();
    }
    
    // Close existing server
    if (this.server) {
      try {
        this.server.close();
        console.log('Closed WebSocket server');
      } catch (error) {
        console.error('Error closing WebSocket server:', error);
      }
    }
    
    // Close existing HTTP server
    if (this.httpServer) {
      try {
        this.httpServer.close();
        console.log('Closed HTTP server');
      } catch (error) {
        console.error('Error closing HTTP server:', error);
      }
    }
  }
  
  /**
   * Send heartbeats to all clients to check if they're still alive
   */
  private sendHeartbeats(): void {
    console.log(`Sending heartbeat to ${this.clients.size} clients`);
    
    if (this.clients.size === 0) {
      // If no clients for a while, check if server is still healthy
      try {
        if (this.server && !this.server.listening) {
          console.log('WebSocket server not listening, restarting...');
          this.scheduleServerRestart();
          return;
        }
      } catch (error) {
        console.error('Error checking server health:', error);
        this.scheduleServerRestart();
        return;
      }
    }
    
    this.clients.forEach(client => {
      try {
        // @ts-ignore - isAlive property
        if (client.isAlive === false) {
          console.log('Terminating inactive client');
          client.terminate();
          this.clients.delete(client);
          return;
        }
        
        // @ts-ignore
        client.isAlive = false;
        client.ping();
        
        // Also send a heartbeat message
        try {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'Heartbeat', timestamp: new Date().toISOString() }));
          }
        } catch (sendError) {
          console.error('Error sending heartbeat message:', sendError);
        }
      } catch (error) {
        console.error('Error during heartbeat:', error);
        this.clients.delete(client);
      }
    });
  }

  /**
   * Broadcast a message to all connected clients
   * @param messageType Type of message (e.g., 'NewBuy', 'NewPool')
   * @param payload Object to be sent as JSON
   */
  public broadcast(messageType: string, payload: any): void {
    const message = {
        type: messageType,
        message: payload
    };
    
    const messageStr = JSON.stringify(message);
    
    // Log shorter version for very large payloads
    let logMessage = messageStr;
    if (logMessage.length > 200) {
        logMessage = `${logMessage.substring(0, 200)}...`;
    }
    
    console.log(`Broadcasting ${messageType} to ${this.clients.size} clients`);
    
    // Count how many successful sends
    let successCount = 0;
    let failCount = 0;
    
    this.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(messageStr);
                successCount++;
            } catch (error) {
                console.error('Error sending to client:', error);
                failCount++;
                this.clients.delete(client);
            }
        } else {
            console.log(`Client in state ${client.readyState}, removing from clients list`);
            this.clients.delete(client);
            failCount++;
        }
    });
    
    console.log(`Broadcast results: ${successCount} success, ${failCount} failed`);
    
    // If all clients failed, maybe server has an issue
    if (this.clients.size > 0 && successCount === 0) {
      console.log('All broadcasts failed, checking server health...');
      if (!this.server || !this.server.listening) {
        this.scheduleServerRestart();
      }
    }
  }

  /**
   * Handle new client connection
   * @param ws WebSocket connection
   */
  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    // Add client to set
    this.clients.add(ws);
    console.log(`Client connected. Total clients: ${this.clients.size}`);
    
    // Set up ping/pong for connection monitoring
    // @ts-ignore - isAlive is not in the type definitions
    ws.isAlive = true;
    
    ws.on('pong', () => {
      // @ts-ignore
      ws.isAlive = true;
      console.log('Client responded to ping');
    });
    
    ws.on('message', (message: string) => {
        console.log(`Received message: ${message}`);
        // Handle incoming messages here
        try {
          const parsedMessage = JSON.parse(message.toString());
          console.log('Parsed message:', parsedMessage);
          
          // Handle client handshakes
          if (parsedMessage.type === 'ClientHandshake') {
            console.log(`Client identified as: ${parsedMessage.client}`);
            // @ts-ignore
            ws.clientType = parsedMessage.client;
            
            // Send welcome response
            ws.send(JSON.stringify({
              type: 'ServerHandshake',
              message: {
                connected: true,
                serverTime: new Date().toISOString(),
                clientCount: this.clients.size
              }
            }));
          }
          
          // Handle ping requests with immediate pong
          if (parsedMessage.type === 'Ping') {
            ws.send(JSON.stringify({
              type: 'Pong',
              timestamp: new Date().toISOString(),
              echo: parsedMessage.timestamp
            }));
          }
        } catch (error) {
          console.error('Error parsing message:', error);
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`Client disconnected. Code: ${code}, Reason: ${reason || 'No reason provided'}`);
        this.clients.delete(ws);
        console.log(`Client disconnected. Remaining clients: ${this.clients.size}`);
    });

    ws.on('error', (error: Error) => {
        console.error('WebSocket client error:', error);
        this.clients.delete(ws);
        console.log(`Client errored. Remaining clients: ${this.clients.size}`);
    });
    
    // Send welcome message
    try {
      ws.send(JSON.stringify({
        type: 'ServerInfo',
        message: {
          status: 'connected',
          time: new Date().toISOString(),
          clientId: Math.random().toString(36).substring(2, 15),
          clientCount: this.clients.size,
          serverUptime: process.uptime()
        }
      }));
    } catch (error) {
      console.error('Error sending welcome message:', error);
    }
  }
  
  /**
   * Close the server and all connections
   */
  public close(): void {
    console.log('Closing WebSocket server');
    this.cleanup();
  }
}

// Add this line to support both default and named imports
export default WebSocketServer;
