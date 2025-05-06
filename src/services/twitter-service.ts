import { TwitterApi } from 'twitter-api-v2';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as url from 'url';

interface BookmarkBridgeSettings {
    // OAuth 2.0 credentials
    clientId: string;
    clientSecret: string;
    oauth2AccessToken: string;
    oauth2RefreshToken: string;
    codeVerifier: string;
    
    // Storage settings
    storageMethod: 'separate' | 'single'; // Store bookmarks as separate files or in a single file
    targetFolder: string;
    singleFileName: string; // Filename for single file storage
    
    // Sync state
    lastSyncTimestamp: number;
    logFile: string;
    
    // Template settings
    template: string; // Template for all bookmark formats
    useCustomTemplate: boolean; // Whether to use custom templates
    
    // Pagination tracking
    nextPaginationToken: string; // Token for the next page of bookmarks
    initialSyncComplete: boolean; // Whether we've completed the initial full sync
    lastSyncPage: number; // Last page of bookmarks we've synced
    lastSyncTime: number; // Timestamp of the last sync attempt (for rate limit tracking)
}

interface TwitterUser {
    id: string;
    name: string;
    username: string;
}

interface TwitterMedia {
    media_key: string;
    url?: string;
    preview_image_url?: string;
}

export interface TwitterBookmark {
    id: string;
    text: string;
    createdAt: Date;
    authorId: string;
    authorUsername: string;
    authorName: string;
    mediaUrls: string[];
    tweetUrl: string;
}

export class TwitterService {
    private settings: BookmarkBridgeSettings;
    private client: TwitterApi | null = null;
    private logFilePath: string | null = null;

    constructor(settings: BookmarkBridgeSettings) {
        this.settings = settings;
        this.initializeClient();
        this.setupLogging();
    }

    private setupLogging() {
        // Try to set up logging if a log file path is provided in settings
        if (this.settings.logFile) {
            this.logFilePath = this.settings.logFile;
        } else {
            // Default to a log file in the plugin directory
            try {
                // Get the directory where the plugin is installed
                const pluginDir = path.dirname((window as any).require.main.filename);
                this.logFilePath = path.join(pluginDir, 'bookmark-bridge-debug.log');
                this.log(`Set up logging to: ${this.logFilePath}`);
            } catch (error) {
                console.error('Failed to set up logging in plugin directory:', error);
                
                // Fallback to user's documents folder
                try {
                    // Try to create a log file in a commonly accessible location
                    const homeDir = (process.env.HOME || process.env.USERPROFILE || '.'); // Home or User Profile or current directory
                    const documentsDir = path.join(homeDir, 'Documents');
                    this.logFilePath = path.join(documentsDir, 'bookmark-bridge-debug.log');
                    this.log(`Using fallback log location: ${this.logFilePath}`);
                    
                    // Test if we can write to this location
                    fs.appendFileSync(this.logFilePath, '[TEST] Initializing log file\n');
                } catch (fallbackError) {
                    console.error('Failed to set up fallback logging:', fallbackError);
                    this.logFilePath = null;
                }
            }
        }
    }

    private log(message: string, type: 'info' | 'error' | 'debug' = 'info') {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] [${type.toUpperCase()}] ${message}\n`;
        
        // Always log to console
        if (type === 'error') {
            console.error(logMessage);
        } else if (type === 'debug') {
            console.debug(logMessage);
        } else {
            console.log(logMessage);
        }
        
        // Try to log to file if possible
        if (this.logFilePath) {
            try {
                fs.appendFileSync(this.logFilePath, logMessage);
            } catch (error) {
                console.error('Failed to write to log file:', error);
                // Try to recreate the log file in case it was deleted
                try {
                    // Get directory path
                    const dirPath = path.dirname(this.logFilePath);
                    // Check if directory exists, create if not
                    if (!fs.existsSync(dirPath)) {
                        fs.mkdirSync(dirPath, { recursive: true });
                    }
                    fs.writeFileSync(this.logFilePath, `[${timestamp}] [INFO] Log file recreated\n${logMessage}`);
                } catch (recreateError) {
                    console.error('Failed to recreate log file:', recreateError);
                }
            }
        }
    }

    private initializeClient() {
        // Initialize with OAuth 2.0
        if (this.settings.oauth2AccessToken) {
            this.log('Initializing Twitter client with OAuth 2.0 access token');
            this.client = new TwitterApi(this.settings.oauth2AccessToken);
        } else {
            this.log('Missing OAuth 2.0 access token', 'error');
            this.client = null;
        }
    }

    /**
     * Generate a random string to use as state or code verifier
     */
    private generateRandomString(length: number = 43): string {
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
        let text = '';
        for (let i = 0; i < length; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }

    /**
     * Generate a code challenge from a code verifier using S256 method
     */
    private async generateCodeChallenge(codeVerifier: string): Promise<string> {
        try {
            this.log(`Generating code challenge from verifier (length: ${codeVerifier.length})`, 'debug');
            
            // Convert the code verifier to a Uint8Array
            const encoder = new TextEncoder();
            const data = encoder.encode(codeVerifier);
            this.log(`Encoded verifier to ${data.length} bytes`, 'debug');
            
            // Hash the code verifier using SHA-256
            this.log('Applying SHA-256 hash...', 'debug');
            const hash = await crypto.subtle.digest('SHA-256', data);
            this.log(`Hash generated, byte length: ${hash.byteLength}`, 'debug');
            
            // Convert the hash to base64url encoding
            const base64Hash = this.arrayBufferToBase64(hash);
            this.log(`Base64 encoded hash: ${base64Hash}`, 'debug');
            
            // Make it base64url by replacing + with -, / with _, and removing =
            const base64urlHash = base64Hash
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=/g, '');
                
            this.log(`Final base64url code challenge: ${base64urlHash}`, 'debug');
            
            return base64urlHash;
        } catch (error) {
            this.log(`Error generating code challenge: ${error}`, 'error');
            this.log('Your environment may not support the required cryptographic APIs.', 'error');
            
            // Let's try a more detailed error analysis
            if (typeof crypto === 'undefined' || typeof crypto.subtle === 'undefined') {
                this.log('Web Crypto API is not available in this environment', 'error');
            } else if (typeof TextEncoder === 'undefined') {
                this.log('TextEncoder is not available in this environment', 'error');
            }
            
            throw new Error('Failed to generate code challenge. Your environment may not support the required cryptographic APIs.');
        }
    }

    /**
     * Convert an ArrayBuffer to a base64 string
     */
    private arrayBufferToBase64(buffer: ArrayBuffer): string {
        try {
            const bytes = new Uint8Array(buffer);
            let binary = '';
            for (let i = 0; i < bytes.byteLength; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            return btoa(binary);
        } catch (error) {
            this.log(`Error in arrayBufferToBase64: ${error}`, 'error');
            throw error;
        }
    }

    /**
     * Generate the authorization URL for OAuth 2.0
     */
    public async generateAuthUrl(callbackUrl: string = 'http://127.0.0.1/callback'): Promise<{ url: string, codeVerifier: string, state: string }> {
        if (!this.settings.clientId) {
            this.log('Client ID is required for OAuth 2.0 authorization', 'error');
            throw new Error('Client ID is required for OAuth 2.0 authorization');
        }

        // Generate a random state and code verifier
        const state = this.generateRandomString();
        const codeVerifier = this.generateRandomString();
        
        this.log(`Generated state: ${state}`, 'debug');
        this.log(`Generated code verifier: ${codeVerifier}`, 'debug');
        
        // Generate the code challenge using S256 method
        const codeChallenge = await this.generateCodeChallenge(codeVerifier);
        this.log(`Generated code challenge: ${codeChallenge}`, 'debug');
        
        // Store the code verifier for later use
        this.settings.codeVerifier = codeVerifier;

        // Create the authorization URL
        const url = new URL('https://x.com/i/oauth2/authorize');
        
        // Add required parameters
        url.searchParams.append('response_type', 'code');
        url.searchParams.append('client_id', this.settings.clientId);
        url.searchParams.append('redirect_uri', callbackUrl);
        url.searchParams.append('scope', 'tweet.read users.read bookmark.read');
        url.searchParams.append('state', state);
        url.searchParams.append('code_challenge', codeChallenge);
        url.searchParams.append('code_challenge_method', 'S256');

        this.log(`Generated authorization URL: ${url.toString()}`);
        
        return {
            url: url.toString(),
            codeVerifier: codeVerifier,
            state: state
        };
    }

    /**
     * Extract authorization code from a URL
     * @param url The redirect URL containing the code
     * @returns The authorization code or null if not found
     */
    public extractAuthorizationCode(url: string): string | null {
        this.log(`Attempting to extract authorization code from: ${url}`, 'debug');
        
        try {
            const urlObj = new URL(url);
            
            // Check for error parameters in the URL
            if (urlObj.searchParams.has('error')) {
                const error = urlObj.searchParams.get('error');
                const errorDescription = urlObj.searchParams.get('error_description');
                this.log(`Authorization error: ${error} - ${errorDescription}`, 'error');
                return null;
            }
            
            const code = urlObj.searchParams.get('code');
            if (code) {
                this.log(`Successfully extracted authorization code: ${code.substring(0, 10)}...`, 'debug');
                return code;
            } else {
                this.log('No authorization code found in URL parameters', 'error');
                return null;
            }
        } catch (e) {
            // If it's not a valid URL, try to extract code using regex
            this.log(`Failed to parse URL, attempting regex extraction: ${e}`, 'debug');
            const codeMatch = url.match(/[?&]code=([^&]+)/);
            if (codeMatch && codeMatch[1]) {
                this.log(`Found authorization code via regex: ${codeMatch[1].substring(0, 10)}...`, 'debug');
                return codeMatch[1];
            }
            
            // Check for error via regex
            const errorMatch = url.match(/[?&]error=([^&]+)/);
            if (errorMatch && errorMatch[1]) {
                this.log(`Authorization error detected via regex: ${errorMatch[1]}`, 'error');
                
                // Try to extract error description
                const errorDescMatch = url.match(/[?&]error_description=([^&]+)/);
                const errorDesc = errorDescMatch && errorDescMatch[1] ? decodeURIComponent(errorDescMatch[1]) : 'No description';
                this.log(`Error description: ${errorDesc}`, 'error');
                
                return null;
            }
            
            this.log('No authorization code found in string using regex', 'error');
            return null;
        }
    }

    /**
     * Safe base64 encoding for credentials that works in all environments
     */
    private safeBase64Encode(str: string): string {
        // First convert the string to UTF-8
        const bytes = new TextEncoder().encode(str);
        
        // Convert bytes to a binary string
        let binaryStr = '';
        for (let i = 0; i < bytes.length; i++) {
            binaryStr += String.fromCharCode(bytes[i]);
        }
        
        // Use built-in btoa function to convert to base64
        const base64 = btoa(binaryStr);
        
        return base64;
    }

    /**
     * Perform an HTTP request using Node.js https module instead of fetch to avoid CORS issues
     * @param urlString The URL to request
     * @param options Request options
     * @param postData Optional data to send for POST requests
     */
    private async nodeHttpRequest(urlString: string, options: any, postData?: string): Promise<{ statusCode: number, headers: any, body: string }> {
        return new Promise((resolve, reject) => {
            this.log(`Making Node.js HTTPS request to: ${urlString}`, 'debug');
            
            // Parse the URL to get hostname, path, etc.
            const parsedUrl = new URL(urlString);
            
            // Set up the request options
            const requestOptions = {
                hostname: parsedUrl.hostname,
                path: parsedUrl.pathname + parsedUrl.search,
                port: parsedUrl.port || 443,
                method: options.method || 'GET',
                headers: options.headers || {},
                timeout: 10000 // 10 second timeout
            };
            
            this.log(`Request options: ${JSON.stringify(requestOptions)}`, 'debug');
            
            const req = https.request(requestOptions, (res) => {
                let data = '';
                
                res.on('data', (chunk) => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    this.log(`Response status code: ${res.statusCode}`, 'debug');
                    resolve({
                        statusCode: res.statusCode || 0,
                        headers: res.headers,
                        body: data
                    });
                });
            });
            
            req.on('error', (error) => {
                this.log(`HTTPS request error: ${error.message}`, 'error');
                
                // Provide more detailed diagnostics based on error type
                // Use type assertion for Node.js errors which have a code property
                const nodeError = error as NodeJS.ErrnoException;
                if (nodeError.code === 'ENOTFOUND' || nodeError.code === 'ECONNREFUSED') {
                    this.log('Connection issue: Cannot connect to the server. Check network and DNS.', 'error');
                } else if (nodeError.code === 'ETIMEDOUT') {
                    this.log('Connection timed out: Server took too long to respond.', 'error');
                } else if (nodeError.code === 'ECONNRESET') {
                    this.log('Connection reset: The connection was forcibly closed by the remote server.', 'error');
                } else if (nodeError.code === 'CERT_HAS_EXPIRED') {
                    this.log('SSL error: The server certificate has expired or is invalid.', 'error');
                }
                
                reject(error);
            });
            
            // Timeout handler
            req.on('timeout', () => {
                this.log('Request timed out after 10 seconds', 'error');
                req.destroy();
                reject(new Error('Request timed out'));
            });
            
            if (postData) {
                req.write(postData);
            }
            
            req.end();
        });
    }

    public async exchangeAuthCodeForToken(code: string, callbackUrl: string = 'http://127.0.0.1/callback'): Promise<boolean> {
        if (!this.settings.clientId || !this.settings.codeVerifier) {
            this.log('Client ID and code verifier are required', 'error');
            throw new Error('Client ID and code verifier are required');
        }

        try {
            this.log('Exchanging auth code for token...');
            this.log(`Code: ${code}`, 'debug');
            this.log(`Code verifier: ${this.settings.codeVerifier}`, 'debug');
            this.log(`Callback URL: ${callbackUrl}`, 'debug');
            
            // Prepare the request body
            const body = new URLSearchParams();
            body.append('code', code);
            body.append('grant_type', 'authorization_code');
            body.append('client_id', this.settings.clientId);
            body.append('redirect_uri', callbackUrl);
            body.append('code_verifier', this.settings.codeVerifier);
            
            // Convert body to string
            const postData = body.toString();

            // Create Authorization header for confidential clients
            let headers: Record<string, string> = {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData).toString()
            };
            
            if (this.settings.clientSecret) {
                const credentials = this.safeBase64Encode(`${this.settings.clientId}:${this.settings.clientSecret}`);
                headers['Authorization'] = `Basic ${credentials}`;
                this.log('Using client authentication with Basic auth', 'debug');
            } else {
                this.log('No client secret provided, using client ID in body only', 'debug');
            }

            this.log(`Request URL: https://api.twitter.com/2/oauth2/token`);
            this.log(`Request headers: ${JSON.stringify(headers)}`, 'debug');
            this.log(`Request body: ${postData}`, 'debug');

            try {
                // Exchange code for token using Node.js https instead of fetch
                const response = await this.nodeHttpRequest('https://api.twitter.com/2/oauth2/token', {
                    method: 'POST',
                    headers: headers
                }, postData);

                this.log(`Response status: ${response.statusCode}`);
                
                // Log response headers for debugging
                this.log(`Response headers: ${JSON.stringify(response.headers)}`, 'debug');
                
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    try {
                        const errorData = JSON.parse(response.body);
                        this.log(`Error exchanging code for token: ${JSON.stringify(errorData)}`, 'error');
                        throw new Error(`Token exchange failed: ${errorData?.error_description || errorData?.error || 'HTTP Error'}`);
                    } catch (jsonError) {
                        // If we can't parse JSON, use the text content
                        this.log(`Error response (text): ${response.body}`, 'error');
                        throw new Error(`Token exchange failed: HTTP ${response.statusCode}. Response: ${response.body}`);
                    }
                }

                const data = JSON.parse(response.body);
                this.log('Token exchange successful!');
                this.log(`Received access token: ${data.access_token.substring(0, 10)}...`, 'debug');
                if (data.refresh_token) {
                    this.log('Received refresh token', 'debug');
                }
                
                // Save the tokens
                this.settings.oauth2AccessToken = data.access_token;
                if (data.refresh_token) {
                    this.settings.oauth2RefreshToken = data.refresh_token;
                }
                
                // Initialize client with the new access token
                this.client = new TwitterApi(data.access_token);
                
                return true;
            } catch (httpError) {
                this.log(`HTTP error during token exchange: ${httpError}`, 'error');
                throw httpError;
            }
        } catch (error) {
            this.log(`Error exchanging code for token: ${error}`, 'error');
            throw error;
        }
    }

    /**
     * Refresh the access token using the refresh token
     */
    public async refreshAccessToken(): Promise<boolean> {
        if (!this.settings.clientId || !this.settings.oauth2RefreshToken) {
            this.log('Client ID and refresh token are required for token refresh', 'error');
            throw new Error('Client ID and refresh token are required');
        }

        try {
            this.log('Attempting to refresh access token...');
            
            // Prepare the request body
            const body = new URLSearchParams();
            body.append('refresh_token', this.settings.oauth2RefreshToken);
            body.append('grant_type', 'refresh_token');
            body.append('client_id', this.settings.clientId);
            
            // Convert body to string
            const postData = body.toString();

            // Create Authorization header for confidential clients
            let headers: Record<string, string> = {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData).toString()
            };
            
            if (this.settings.clientSecret) {
                const credentials = this.safeBase64Encode(`${this.settings.clientId}:${this.settings.clientSecret}`);
                headers['Authorization'] = `Basic ${credentials}`;
                this.log('Using client authentication with Basic auth for token refresh', 'debug');
            } else {
                this.log('No client secret provided for token refresh', 'debug');
            }

            this.log(`Request URL: https://api.twitter.com/2/oauth2/token`);
            this.log(`Request headers: ${JSON.stringify(headers)}`, 'debug');
            this.log(`Request body: ${postData}`, 'debug');

            try {
                // Request new access token using Node.js https instead of fetch
                const response = await this.nodeHttpRequest('https://api.twitter.com/2/oauth2/token', {
                    method: 'POST',
                    headers: headers
                }, postData);

                this.log(`Token refresh response status: ${response.statusCode}`);

                if (response.statusCode < 200 || response.statusCode >= 300) {
                    try {
                        const errorData = JSON.parse(response.body);
                        this.log(`Error refreshing token: ${JSON.stringify(errorData)}`, 'error');
                        throw new Error(`Token refresh failed: ${errorData?.error_description || errorData?.error || 'HTTP Error'}`);
                    } catch (jsonError) {
                        // If we can't parse JSON, use the text content
                        this.log(`Error response (text): ${response.body}`, 'error');
                        throw new Error(`Token refresh failed: HTTP ${response.statusCode}. Response: ${response.body}`);
                    }
                }

                const data = JSON.parse(response.body);
                this.log('Token refresh successful!');
                
                // Save the new access token
                this.settings.oauth2AccessToken = data.access_token;
                if (data.refresh_token) {
                    this.log('Received new refresh token', 'debug');
                    this.settings.oauth2RefreshToken = data.refresh_token;
                }
                
                // Initialize client with the new access token
                this.client = new TwitterApi(data.access_token);
                
                return true;
            } catch (httpError) {
                this.log(`HTTP error during token refresh: ${httpError}`, 'error');
                throw httpError;
            }
        } catch (error) {
            this.log(`Error refreshing access token: ${error}`, 'error');
            throw error;
        }
    }

    /**
     * Revoke the current access token
     */
    public async revokeToken(): Promise<boolean> {
        if (!this.settings.clientId || !this.settings.oauth2AccessToken) {
            this.log('Client ID and access token are required', 'error');
            throw new Error('Client ID and access token are required');
        }

        try {
            this.log('Attempting to revoke access token...');
            
            // Prepare the request body
            const body = new URLSearchParams();
            body.append('token', this.settings.oauth2AccessToken);
            body.append('client_id', this.settings.clientId);
            
            // Convert body to string
            const postData = body.toString();

            // Create Authorization header for confidential clients
            let headers: Record<string, string> = {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData).toString()
            };
            
            if (this.settings.clientSecret) {
                const credentials = this.safeBase64Encode(`${this.settings.clientId}:${this.settings.clientSecret}`);
                headers['Authorization'] = `Basic ${credentials}`;
                this.log('Using client authentication with Basic auth for token revocation', 'debug');
            } else {
                this.log('No client secret provided for token revocation', 'debug');
            }

            this.log(`Request URL: https://api.twitter.com/2/oauth2/revoke`);
            this.log(`Request headers: ${JSON.stringify(headers)}`, 'debug');
            this.log(`Request body: ${postData}`, 'debug');

            try {
                // Revoke the token using Node.js https instead of fetch
                const response = await this.nodeHttpRequest('https://api.twitter.com/2/oauth2/revoke', {
                    method: 'POST',
                    headers: headers
                }, postData);

                this.log(`Token revocation response status: ${response.statusCode}`);
                
                if (response.statusCode < 200 || response.statusCode >= 300) {
                    try {
                        const errorData = JSON.parse(response.body);
                        this.log(`Error revoking token: ${JSON.stringify(errorData)}`, 'error');
                        throw new Error(`Token revocation failed: ${errorData?.error_description || errorData?.error || 'HTTP Error'}`);
                    } catch (jsonError) {
                        // If we can't parse JSON, use the text content
                        this.log(`Error response (text): ${response.body}`, 'error');
                        throw new Error(`Token revocation failed: HTTP ${response.statusCode}. Response: ${response.body}`);
                    }
                }
                
                // Clear the tokens
                this.settings.oauth2AccessToken = '';
                this.settings.oauth2RefreshToken = '';
                this.client = null;
                
                return true;
            } catch (httpError) {
                this.log(`HTTP error during token revocation: ${httpError}`, 'error');
                throw httpError;
            }
        } catch (error) {
            this.log(`Error revoking token: ${error}`, 'error');
            throw error;
        }
    }

    /**
     * Check if we have valid OAuth 2.0 credentials
     */
    public hasOAuth2Credentials(): boolean {
        return !!this.settings.oauth2AccessToken;
    }

    public async testConnection(): Promise<boolean> {
        try {
            if (!this.client) {
                this.log('No Twitter client available, initializing...');
                this.initializeClient();
                if (!this.client) {
                    this.log('Failed to initialize Twitter client', 'error');
                    return false;
                }
            }

            // Attempt to verify credentials by fetching user info
            this.log('Testing connection to Twitter API...');
            const currentUser = await this.client.v2.me();
            this.log(`Connection test response: ${JSON.stringify(currentUser)}`);
            return !!currentUser.data.id;
        } catch (error) {
            this.log(`Twitter API connection test failed: ${error}`, 'error');
            
            // If we have a refresh token, try refreshing the access token
            if (this.settings.oauth2RefreshToken) {
                try {
                    this.log('Trying to refresh the access token...');
                    await this.refreshAccessToken();
                    
                    // Try again with the new token
                    if (this.client) {
                        const currentUser = await this.client.v2.me();
                        return !!currentUser.data.id;
                    }
                } catch (refreshError) {
                    this.log(`Failed to refresh access token: ${refreshError}`, 'error');
                }
            }
            
            return false;
        }
    }

    public async fetchBookmarks(lastSyncTimestamp: number): Promise<TwitterBookmark[]> {
        if (!this.client) {
            this.initializeClient();
            if (!this.client) {
                throw new Error('Twitter client not initialized. Check your API credentials or authorize with X.');
            }
        }

        try {
            // Check if we're still in the rate limit waiting period (15 minutes)
            const now = Date.now();
            const timeElapsed = now - this.settings.lastSyncTime;
            const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes in milliseconds
            
            if (this.settings.lastSyncTime > 0 && timeElapsed < RATE_LIMIT_WINDOW) {
                const timeToWait = Math.ceil((RATE_LIMIT_WINDOW - timeElapsed) / 1000 / 60);
                throw new Error(`X API rate limit not reset yet. Please wait approximately ${timeToWait} more minutes before trying again.`);
            }
            
            // Get the user's ID first (required for bookmarks endpoint)
            const currentUser = await this.client.v2.me();
            const userId = currentUser.data.id;

            // Store all bookmarks here
            const allBookmarks: TwitterBookmark[] = [];
            const MAX_REQUESTS = 1; // X API limits to 1 request per 15 minutes
            let requestCount = 0;
            
            // Determine if we're continuing pagination or starting fresh
            let paginationToken: string | undefined = undefined;
            
            if (!this.settings.initialSyncComplete && this.settings.nextPaginationToken) {
                // If we're in the middle of the initial sync, use the saved token
                paginationToken = this.settings.nextPaginationToken;
                this.log(`Continuing bookmarks sync from page ${this.settings.lastSyncPage + 1} with saved pagination token`, 'info');
            } else if (this.settings.initialSyncComplete) {
                // If we've completed the initial sync, we're just looking for new bookmarks
                this.log(`Initial sync complete, checking for new bookmarks since ${new Date(lastSyncTimestamp).toISOString()}`, 'info');
            } else {
                // Starting a fresh sync
                this.log('Starting initial bookmark sync', 'info');
            }
            
            // Log the rate limit info
            this.log(`Rate limit: 1 request per 15 minutes per user.`, 'info');

            // Track if we've made a request in this session
            let madeRequest = false;
            
            while (requestCount < MAX_REQUESTS) {
                requestCount++;
                madeRequest = true;
                
                this.log(`Making bookmarks request ${requestCount}/${MAX_REQUESTS}${paginationToken ? ' with pagination token' : ''}`);
                
                // Update the last sync time
                this.settings.lastSyncTime = Date.now();
                
                // Fetch bookmarks with parameters
                const bookmarksResponse = await this.client.v2.bookmarks({
                    expansions: ['author_id', 'attachments.media_keys'],
                    'user.fields': ['name', 'username'],
                    'media.fields': ['url', 'preview_image_url'],
                    'tweet.fields': ['created_at'],
                    max_results: 100, // Maximum allowed
                    pagination_token: paginationToken
                });
                
                // Process the current page of bookmarks
                const bookmarks = this.processBookmarksPage(bookmarksResponse, this.settings.initialSyncComplete ? lastSyncTimestamp : 0);
                allBookmarks.push(...bookmarks);
                
                // Update the last sync page
                this.settings.lastSyncPage++;
                
                // Check for rate limit headers
                if (bookmarksResponse.rateLimit) {
                    this.log(`Rate limit remaining: ${bookmarksResponse.rateLimit.remaining}/${bookmarksResponse.rateLimit.limit}`, 'debug');
                    this.log(`Rate limit resets at: ${new Date(bookmarksResponse.rateLimit.reset * 1000).toISOString()}`, 'debug');
                }
                
                // Check if there's another page
                if (bookmarksResponse.meta && bookmarksResponse.meta.next_token) {
                    // Save the pagination token for the next run
                    this.settings.nextPaginationToken = bookmarksResponse.meta.next_token;
                    this.log(`Found next pagination token: ${this.settings.nextPaginationToken.substring(0, 10)}...`, 'debug');
                    this.log(`There are more bookmarks available. You'll need to sync again in 15 minutes to continue.`, 'info');
                    
                    // Not done with initial sync
                    this.settings.initialSyncComplete = false;
                    break;
                } else {
                    // No more pages, we've completed the initial sync
                    this.settings.nextPaginationToken = '';
                    this.settings.initialSyncComplete = true;
                    this.log('No more pages available, reached the end of all bookmarks', 'info');
                    break;
                }
            }
            
            if (!madeRequest) {
                this.log('No bookmarks request made in this session due to rate limits', 'info');
            }

            this.log(`Retrieved ${allBookmarks.length} bookmarks in this sync session`, 'info');
            return allBookmarks;
        } catch (error) {
            this.log(`Error fetching Twitter bookmarks: ${error}`, 'error');
            
            // Check if this is a rate limit error
            const errorObj = error as any;
            if (errorObj.code === 429 || (errorObj.errors && errorObj.errors[0]?.code === 88)) {
                const resetTimeHeader = errorObj.rateLimit?.reset;
                let waitMessage = 'X API rate limit exceeded. Please try again in 15 minutes.';
                
                if (resetTimeHeader) {
                    const resetTime = new Date(resetTimeHeader * 1000);
                    const waitMinutes = Math.ceil((resetTime.getTime() - Date.now()) / (1000 * 60));
                    waitMessage = `X API rate limit exceeded. Please try again in ${waitMinutes} minutes.`;
                }
                
                this.log(waitMessage, 'error');
                throw new Error(waitMessage);
            }
            
            // If the token is expired, try to refresh it
            if (this.settings.oauth2RefreshToken) {
                try {
                    await this.refreshAccessToken();
                    // Retry with new token
                    return this.fetchBookmarks(lastSyncTimestamp);
                } catch (refreshError) {
                    this.log(`Failed to refresh token when fetching bookmarks: ${refreshError}`, 'error');
                }
            }
            
            throw new Error(`Failed to fetch bookmarks: ${(error as Error).message}`);
        }
    }
    
    /**
     * Process a single page of bookmarks from the API response
     */
    private processBookmarksPage(bookmarksResponse: any, lastSyncTimestamp: number): TwitterBookmark[] {
        const bookmarks: TwitterBookmark[] = [];
        
        // Process each bookmark tweet
        for (const tweet of bookmarksResponse.data.data || []) {
            // Find author info
            const author = bookmarksResponse.data.includes?.users?.find(
                (user: TwitterUser) => user.id === tweet.author_id
            );
            
            // Find media attachments
            const mediaKeys = tweet.attachments?.media_keys || [];
            const mediaItems = bookmarksResponse.data.includes?.media || [];
            const mediaUrls = mediaKeys
                .map((key: string) => {
                    const media = mediaItems.find((item: TwitterMedia) => item.media_key === key);
                    return media?.url || media?.preview_image_url || null;
                })
                .filter((url: string | null) => url !== null) as string[];

            // Skip tweets created before the last sync (if we have a timestamp)
            const tweetCreatedAt = new Date(tweet.created_at as string);
            if (lastSyncTimestamp > 0 && tweetCreatedAt.getTime() <= lastSyncTimestamp) {
                continue;
            }

            // Create a bookmark object
            bookmarks.push({
                id: tweet.id,
                text: tweet.text,
                createdAt: tweetCreatedAt,
                authorId: tweet.author_id as string,
                authorUsername: author?.username || 'unknown',
                authorName: author?.name || 'Unknown User',
                mediaUrls,
                tweetUrl: `https://twitter.com/${author?.username}/status/${tweet.id}`
            });
        }

        return bookmarks;
    }
} 