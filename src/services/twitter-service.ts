import { TwitterApi } from 'twitter-api-v2';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as url from 'url';
import * as http from 'http';

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
    
    // Debug settings
    bypassRateLimit: boolean; // DEBUG ONLY: Bypass the built-in rate limit check
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
    private saveSettingsCallback: () => Promise<void>; // Callback to save settings
    private lastApiCallTime: number = 0;
    private apiRateLimitWindow: number = 15 * 60 * 1000; // 15 minutes in milliseconds
    private apiCallsInProgress: boolean = false;

    constructor(settings: BookmarkBridgeSettings, saveSettingsCallback: () => Promise<void>) {
        this.settings = settings;
        this.saveSettingsCallback = saveSettingsCallback; // Store the callback
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

    public log(message: string, type: 'info' | 'error' | 'debug' = 'info') {
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
        if (!this.settings.oauth2AccessToken) {
            this.log('Cannot initialize client: No access token available', 'error');
            return;
        }

        try {
            this.log('Initializing Twitter API client with access token', 'info');
            this.client = new TwitterApi(this.settings.oauth2AccessToken);
            this.log('Twitter API client initialized successfully', 'info');
        } catch (error) {
            this.log(`Failed to initialize Twitter API client: ${error}`, 'error');
            this.client = null;
        }
    }

    /**
     * Generate a random string to use as state or code verifier
     */
    public generateRandomString(length: number = 43): string {
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
     * Generate the authorization URL for OAuth 2.0 PKCE flow.
     * The codeVerifier generated here must be stored by the caller and provided
     * back to settings (e.g. this.settings.codeVerifier) before calling exchangeAuthCodeForToken.
     */
    public async generateAuthUrl(state: string): Promise<{ url: string, codeVerifier: string }> {
        if (!this.settings.clientId) {
            this.log('Client ID is required for OAuth 2.0 authorization', 'error');
            throw new Error('Client ID is required for OAuth 2.0 authorization');
        }

        const codeVerifier = this.generateRandomString();
        this.log(`Generated code verifier for PKCE: ${codeVerifier}`, 'debug');
        
        const codeChallenge = await this.generateCodeChallenge(codeVerifier);
        this.log(`Generated code challenge: ${codeChallenge}`, 'debug');
        
        // Twitter has exact match validation for redirect URIs
        // Make sure this EXACTLY matches what's registered in your Twitter Developer Portal
        const callbackUrl = 'obsidian://bookmark-bridge/callback';
        this.log(`Using redirect_uri: ${callbackUrl}`, 'info');
        this.log(`IMPORTANT: This must exactly match your registered Callback URL in Twitter Developer Portal`, 'info');

        const authUrl = new URL('https://x.com/i/oauth2/authorize');
        
        // Required OAuth 2.0 parameters
        authUrl.searchParams.append('response_type', 'code');
        authUrl.searchParams.append('client_id', this.settings.clientId);
        authUrl.searchParams.append('redirect_uri', callbackUrl);
        // Now that basic auth works, restore the full scopes needed for bookmarks
        authUrl.searchParams.append('scope', 'bookmark.read tweet.read users.read offline.access'); 
        authUrl.searchParams.append('state', state);
        authUrl.searchParams.append('code_challenge', codeChallenge);
        authUrl.searchParams.append('code_challenge_method', 'S256');

        // Output the complete URL for debugging
        const urlString = authUrl.toString();
        this.log(`Generated Auth URL: ${urlString}`, 'debug');
        
        return { url: urlString, codeVerifier };
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
     * Make a HTTP request with detailed logging
     */
    private async nodeHttpRequest(
        requestUrl: string | URL, 
        options: https.RequestOptions = {}, 
        postData?: string
    ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
        // Log the API call before making the request
        const method = options.method || 'GET';
        const urlStr = requestUrl.toString();
        this.log(`API REQUEST: ${method} ${urlStr}`, 'info');
        
        if (options.headers) {
            this.log(`Request headers: ${JSON.stringify(options.headers, (k, v) => 
                k === 'Authorization' ? 'Bearer [REDACTED]' : v)}`, 'debug');
        }
        
        if (postData) {
            // Log post data with sensitive info redacted
            const redactedData = postData.replace(/(client_secret|code|token|refresh_token)=([^&]+)/g, '$1=[REDACTED]');
            this.log(`Request body: ${redactedData}`, 'debug');
        }
        
        // Update the rate limit timestamp for any API call
        await this.updateRateLimitTimestamp();
        
        return new Promise((resolve, reject) => {
            this.log(`Making Node.js HTTPS request to: ${urlStr}`, 'debug');
            
            // Parse the URL to get hostname, path, etc.
            const parsedUrl = new URL(urlStr);
            
            // Set up the request options
            const requestOptions = {
                hostname: parsedUrl.hostname,
                path: parsedUrl.pathname + parsedUrl.search,
                port: parsedUrl.port || 443,
                method: options.method || 'GET',
                headers: options.headers || {},
                timeout: 10000 // 10 second timeout
            };
            
            this.log(`Request options: ${JSON.stringify(requestOptions, (k, v) => 
                k === 'headers' && v.Authorization ? {...v, Authorization: 'Bearer [REDACTED]'} : v)}`, 'debug');
            
            const req = https.request(requestOptions, (res) => {
                let data = '';
                
                res.on('data', (chunk) => {
                    data += chunk;
                });
                
                res.on('end', () => {
                    // Log response data
                    this.log(`Response status code: ${res.statusCode}`, 'debug');
                    
                    // Log response headers with special handling for rate limit headers
                    const rateLimitHeaders = Object.entries(res.headers)
                        .filter(([key]) => key.toLowerCase().includes('ratelimit') || key.toLowerCase().includes('x-rate-limit'))
                        .reduce((obj, [k, v]) => ({ ...obj, [k]: v }), {});
                    
                    if (Object.keys(rateLimitHeaders).length > 0) {
                        this.log(`Rate limit headers: ${JSON.stringify(rateLimitHeaders)}`, 'info');
                    }
                    
                    // Redact sensitive data in response for logging
                    let logData = data;
                    try {
                        const jsonData = JSON.parse(data);
                        // Redact tokens in response
                        if (jsonData.access_token) jsonData.access_token = '[REDACTED]';
                        if (jsonData.refresh_token) jsonData.refresh_token = '[REDACTED]';
                        logData = JSON.stringify(jsonData);
                    } catch (e) {
                        // Not JSON, just use as is
                    }
                    
                    if (res.statusCode === 429) {
                        this.log(`RATE LIMIT EXCEEDED - Response body: ${logData}`, 'error');
                        
                        // Extract retry-after header if present
                        const retryAfter = res.headers['retry-after'];
                        if (retryAfter) {
                            this.log(`X API says to retry after: ${retryAfter} seconds`, 'info');
                        }
                        
                        // Log debug info about the bypass setting
                        if (this.settings.bypassRateLimit) {
                            this.log(`NOTICE: You have rate limit bypass enabled, but the X API is still enforcing its own rate limits. You're hitting the actual API rate limit.`, 'error');
                            this.log(`The client-side bypass only removes our rate limit handling, not X's server-side limits.`, 'info');
                        } else {
                            this.log(`TIP: For debugging, you can temporarily bypass the client-side rate limit in Settings > Debug Settings.`, 'info');
                        }
                    } else if (res.statusCode && res.statusCode >= 400) {
                        this.log(`ERROR RESPONSE - Status ${res.statusCode}, body: ${logData}`, 'error');
                    } else {
                        this.log(`Response body: ${logData.length > 500 ? logData.substring(0, 500) + '...' : logData}`, 'debug');
                    }
                    
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

    /**
     * Exchange authorization code for access token (OAuth 2.0 PKCE)
     */
    public async exchangeAuthCodeForToken(code: string, callbackUrl: string): Promise<boolean> {
        this.log(`exchangeAuthCodeForToken: Starting with code: ${code.substring(0, 10)}... and callback URL: ${callbackUrl}`, 'debug');
        if (!this.settings.clientId) {
            this.log('Client ID is missing for token exchange', 'error');
            throw new Error('Client ID is required to exchange authorization code for token.');
        }
        // PKCE requires the code_verifier that was used to generate the code_challenge
        if (!this.settings.codeVerifier) {
            this.log('Code verifier is missing for token exchange (PKCE)', 'error');
            throw new Error('Code verifier is required for PKCE flow.');
        }

        try {
            const tokenUrl = 'https://api.x.com/2/oauth2/token';
            
            // Prepare body params as URLSearchParams
            const bodyParams = new URLSearchParams({
                'code': code,
                'grant_type': 'authorization_code',
                'client_id': this.settings.clientId,
                'redirect_uri': callbackUrl,
                'code_verifier': this.settings.codeVerifier
            });

            const options = {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            };
            
            this.log('Sending token exchange request using nodeHttpRequest', 'debug');
            const response = await this.nodeHttpRequest(tokenUrl, options, bodyParams.toString());

            // Check if request was successful
            if (response.statusCode >= 200 && response.statusCode < 300) {
                try {
                    const data = JSON.parse(response.body);
                    this.log('Received token exchange response: successful', 'debug');
                    
                    // Store the tokens
                    this.settings.oauth2AccessToken = data.access_token;
                    this.settings.oauth2RefreshToken = data.refresh_token || '';
                    
                    // Clear the code_verifier as it's no longer needed
                    this.settings.codeVerifier = '';
                    
                    // Save settings
                    await this.saveSettingsCallback();
                    
                    // Initialize client with the new token
                    this.initializeClient();
                    
                    return true;
                } catch (parseError) {
                    this.log(`Error parsing token response: ${parseError}`, 'error');
                    return false;
                }
            } else {
                this.log(`Token exchange failed with status ${response.statusCode}: ${response.body}`, 'error');
                return false;
            }
        } catch (error) {
            this.log(`Error during token exchange: ${error}`, 'error');
            return false;
        }
    }

    /**
     * Refresh the access token using the refresh token
     * Implements exponential backoff for rate-limited requests
     */
    public async refreshAccessToken(retryCount: number = 0, maxRetries: number = 1): Promise<boolean> {
        if (!this.settings.oauth2RefreshToken) {
            this.log('No refresh token available to refresh access token.', 'info');
            return false;
        }
        if (!this.settings.clientId) {
            this.log('Client ID is missing for token refresh', 'error');
            return false;
        }
        
        // Don't retry if we've reached max retries
        if (retryCount > maxRetries) {
            this.log(`Maximum retries (${maxRetries}) reached for token refresh`, 'error');
            return false;
        }

        // Add exponential backoff if this is a retry
        if (retryCount > 0) {
            const backoffMs = Math.pow(2, retryCount) * 1000;
            this.log(`Applying backoff delay of ${backoffMs}ms before retry #${retryCount}`, 'info');
            await new Promise(resolve => setTimeout(resolve, backoffMs));
        }

        this.log('Attempting to refresh access token...', 'debug');

        const tokenUrl = 'https://api.x.com/2/oauth2/token';
        const bodyParams = new URLSearchParams({
            'refresh_token': this.settings.oauth2RefreshToken,
            'grant_type': 'refresh_token',
            'client_id': this.settings.clientId
        });

        // Include client_secret only if provided
        if (this.settings.clientSecret) {
            bodyParams.append('client_secret', this.settings.clientSecret);
        }

        const options = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        };

        try {
            this.log('Sending token refresh request using nodeHttpRequest', 'debug');
            const response = await this.nodeHttpRequest(tokenUrl, options, bodyParams.toString());

            // Handle rate limiting
            if (response.statusCode === 429) {
                this.log('Token refresh rate limited', 'error');
                
                // Extract retry-after header or error message for wait time
                let waitTime = 15 * 60 * 1000; // Default: 15 minutes
                
                if (response.headers['retry-after']) {
                    const retryAfterSecs = parseInt(response.headers['retry-after'] as string, 10);
                    if (!isNaN(retryAfterSecs)) {
                        waitTime = retryAfterSecs * 1000;
                    }
                }
                
                // Parse the response to see if there's a more specific wait time
                try {
                    const errorData = JSON.parse(response.body);
                    this.log(`Token refresh response status: ${response.statusCode}`, 'debug');
                    this.log(`Token refresh response data: ${response.body}`, 'debug');
                    
                    // Try to extract wait time from error message if available
                    if (errorData.error_description && errorData.error_description.includes('wait')) {
                        const minutesMatch = errorData.error_description.match(/wait (\d+) minutes/i);
                        if (minutesMatch && minutesMatch[1]) {
                            const waitMinutes = parseInt(minutesMatch[1], 10);
                            if (!isNaN(waitMinutes)) {
                                waitTime = waitMinutes * 60 * 1000;
                            }
                        }
                    }
                } catch (e) {
                    // JSON parsing failed, use default wait time
                }
                
                this.log(`Rate limited. Need to wait ${Math.ceil(waitTime/1000/60)} minutes before retrying.`, 'error');
                
                // IMPORTANT: Do NOT recursively call the function again here.
                // Instead return false and let the caller handle the rate limiting
                return false;
            }

            // Check if request was successful
            if (response.statusCode >= 200 && response.statusCode < 300) {
                try {
                    const data = JSON.parse(response.body);
                    this.log('Received token refresh response: successful', 'debug');
                    
                    // Update the tokens
                    this.settings.oauth2AccessToken = data.access_token;
                    
                    // Only update refresh token if a new one was provided
                    if (data.refresh_token) {
                        this.settings.oauth2RefreshToken = data.refresh_token;
                    }
                    
                    // Save settings
                    await this.saveSettingsCallback();
                    
                    // Re-initialize client with the new token
                    this.initializeClient();
                    
                    return true;
                } catch (parseError) {
                    this.log(`Error parsing refresh token response: ${parseError}`, 'error');
                    return false;
                }
            } else {
                this.log(`Token refresh failed with status ${response.statusCode}: ${response.body}`, 'error');
                return false;
            }
        } catch (error) {
            this.log(`Error during token refresh: ${error}`, 'error');
            return false;
        }
    }

    /**
     * Revoke the current access token
     */
    public async revokeToken(): Promise<boolean> {
        if (!this.settings.oauth2AccessToken) {
            this.log('No access token to revoke.', 'info');
            return true; // Nothing to do
        }
        if (!this.settings.clientId) {
            this.log('Client ID is missing for token revocation.', 'error');
            // For public clients, client_secret might not be needed. For confidential, it is.
            // If confidential: add 'Authorization': 'Basic ' + btoa(`${this.settings.clientId}:${this.settings.clientSecret}`) to headers
            return false; 
        }

        this.log('Attempting to revoke access token...', 'debug');
        const revokeUrl = 'https://api.x.com/2/oauth2/revoke';
        
        const bodyParams = new URLSearchParams({
            'token': this.settings.oauth2AccessToken,
            'token_type_hint': 'access_token', // Or 'refresh_token' if revoking that
            'client_id': this.settings.clientId // Required for public clients
        });

        const options: any = {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        };

        // For confidential clients, Twitter requires authentication to revoke a token.
        // This usually means a Basic Auth header with Client ID and Client Secret.
        if (this.settings.clientSecret) {
            options.headers['Authorization'] = 'Basic ' + this.safeBase64Encode(`${this.settings.clientId}:${this.settings.clientSecret}`);
        }

        try {
            this.log('Sending token revocation request using nodeHttpRequest', 'debug');
            const response = await this.nodeHttpRequest(revokeUrl, options, bodyParams.toString());

            // Check if request was successful
            if (response.statusCode >= 200 && response.statusCode < 300) {
                this.log('Token successfully revoked.', 'info');
            } else {
                // An error here might not be critical if the token was already invalid
                this.log(`Error revoking token: ${response.statusCode} - ${response.body}`, 'info');
            }
        } catch (error) {
            this.log(`Network or other error during token revocation: ${error}`, 'error');
        } finally {
            // Always clear local tokens after attempting revocation
            this.settings.oauth2AccessToken = '';
            this.settings.oauth2RefreshToken = '';
            this.settings.codeVerifier = ''; // Clear any leftover verifier
            await this.saveSettingsCallback();
            this.client = null; // Clear the initialized client
            this.log('Local tokens cleared after revocation attempt.', 'info');
        }
        return true; // Return true to indicate logout process completed from plugin's perspective
    }

    /**
     * Check if we have valid OAuth 2.0 credentials
     */
    public hasOAuth2Credentials(): boolean {
        return !!this.settings.oauth2AccessToken;
    }

    /**
     * Test the connection to Twitter API
     * This counts against the rate limit, so use sparingly
     */
    public async testConnection(): Promise<boolean> {
        try {
            // First check if we're rate limited before making the call
            if (this.isRateLimited()) {
                const timeElapsed = Date.now() - Math.max(this.lastApiCallTime, this.settings.lastSyncTime);
                const timeToWait = Math.ceil((this.apiRateLimitWindow - timeElapsed) / 1000 / 60);
                this.log(`TEST CONNECTION: Cannot proceed - still in rate limit window. Please wait ${timeToWait} more minutes.`, 'error');
                return false;
            }
            
            if (!this.client) {
                this.log('No Twitter client available, initializing...', 'info');
                this.initializeClient();
                if (!this.client) {
                    this.log('Failed to initialize Twitter client', 'error');
                    return false;
                }
            }

            // Explicitly log this API call
            this.log('API CALL: GET /2/users/me (test connection)', 'info');
            
            // Update the rate limit timestamp before making the call
            await this.updateRateLimitTimestamp();
            
            // Attempt to verify credentials by fetching user info
            const currentUser = await this.client.v2.me();
            this.log(`Connection test response: ${JSON.stringify(currentUser)}`, 'info');
            
            return !!currentUser.data.id;
        } catch (error) {
            this.log(`Twitter API connection test failed: ${error}`, 'error');
            
            // Check if this is a rate limit error
            const errorObj = error as any;
            if (errorObj.code === 429 || (errorObj.errors && errorObj.errors[0]?.code === 88)) {
                this.log('TEST CONNECTION: Rate limit reached', 'error');
                // Still update rate limit timestamp on error
                await this.updateRateLimitTimestamp();
                return false;
            }
            
            // If we have a refresh token, try refreshing the access token
            if (this.settings.oauth2RefreshToken && !this.isRateLimited()) {
                try {
                    this.log('Trying to refresh the access token...', 'info');
                    await this.refreshAccessToken();
                    
                    // Try again with the new token but only if we're not rate limited
                    if (this.client && !this.isRateLimited()) {
                        this.log('API CALL: GET /2/users/me (retry after token refresh)', 'info');
                        // Update timestamp for this call too
                        await this.updateRateLimitTimestamp();
                        const currentUser = await this.client.v2.me();
                        return !!currentUser.data.id;
                    } else {
                        this.log('Not retrying after token refresh due to rate limit', 'info');
                    }
                } catch (refreshError) {
                    this.log(`Failed to refresh access token: ${refreshError}`, 'error');
                }
            }
            
            return false;
        }
    }

    /**
     * Check if we're currently rate limited and should avoid making API calls
     * @returns True if rate limited, false if okay to proceed
     */
    private isRateLimited(): boolean {
        // If rate limit bypass is enabled, always return false (not rate limited)
        if (this.settings.bypassRateLimit) {
            this.log(`⚠️ RATE LIMIT BYPASS: Rate limit check bypassed due to debug setting`, 'info');
            return false;
        }

        const now = Date.now();
        const lastCallTime = this.lastApiCallTime || 0;
        const lastSyncTime = this.settings.lastSyncTime || 0;
        const lastRelevantTime = Math.max(lastCallTime, lastSyncTime);
        
        // If no previous calls have been made, we're not rate limited
        if (lastRelevantTime === 0) {
            this.log('No previous API calls detected, not rate limited', 'debug');
            return false;
        }
        
        const timeElapsed = now - lastRelevantTime;
        const isLimited = timeElapsed < this.apiRateLimitWindow;
        
        if (isLimited) {
            const timeToWait = Math.ceil((this.apiRateLimitWindow - timeElapsed) / 1000 / 60);
            this.log(`⚠️ RATE LIMITED: Need to wait ${timeToWait} more minutes before API call.`, 'info');
            
            // Log more detailed debugging information
            this.log(`Rate limit details: 
               Current time: ${new Date(now).toISOString()}
               Last API call: ${new Date(lastCallTime).toISOString()} 
               Last sync time: ${new Date(lastSyncTime).toISOString()}
               Most recent event: ${new Date(lastRelevantTime).toISOString()}
               Time elapsed: ${timeElapsed}ms
               Rate limit window: ${this.apiRateLimitWindow}ms (${this.apiRateLimitWindow/1000/60} minutes)
               Time remaining: ${this.apiRateLimitWindow - timeElapsed}ms
               Will be free at: ${new Date(lastRelevantTime + this.apiRateLimitWindow).toISOString()}`, 'debug');
        } else {
            this.log(`Not rate limited. Last API call was ${Math.floor(timeElapsed/1000/60)} minutes ago.`, 'debug');
        }
        
        return isLimited;
    }
    
    /**
     * Update the rate limit timestamp after making an API call
     * Also saves to settings for persistence across restarts
     */
    private async updateRateLimitTimestamp(): Promise<void> {
        const now = Date.now();
        this.lastApiCallTime = now;
        this.log(`Updated API rate limit timestamp to ${new Date(this.lastApiCallTime).toISOString()}`, 'debug');
        
        // Also update the lastSyncTime in settings for persistence across restarts
        this.settings.lastSyncTime = now;
        
        // Save settings to ensure rate limit info persists
        try {
            await this.saveSettingsCallback();
            this.log('Saved rate limit info to settings file', 'debug');
        } catch (error) {
            this.log(`Error saving rate limit info: ${error}`, 'error');
        }
    }

    public async fetchBookmarks(lastSyncTimestamp: number): Promise<TwitterBookmark[]> {
        // Prevent concurrent API calls
        if (this.apiCallsInProgress) {
            this.log('API call already in progress, aborting', 'info');
            throw new Error('Another API call is already in progress. Please wait for it to complete.');
        }
        
        // Check if we're rate limited BEFORE making any calls
        if (this.isRateLimited()) {
            const timeElapsed = Date.now() - Math.max(this.lastApiCallTime, this.settings.lastSyncTime);
            const timeToWait = Math.ceil((this.apiRateLimitWindow - timeElapsed) / 1000 / 60);
            const nextAllowedTime = new Date(Math.max(this.lastApiCallTime, this.settings.lastSyncTime) + this.apiRateLimitWindow);
            
            this.log(`⛔ RATE LIMIT CHECK: Cannot proceed with API call - still in rate limit window.`, 'error');
            this.log(`Next allowed time: ${nextAllowedTime.toISOString()} (in ${timeToWait} minutes)`, 'info');
            
            throw new Error(`X API rate limit not reset yet. Please wait approximately ${timeToWait} more minutes before trying again.`);
        }
        
        // Set flag to prevent concurrent calls
        this.apiCallsInProgress = true;
        
        try {
            if (!this.client) {
                this.log('Twitter client not initialized, attempting to initialize now', 'info');
                this.initializeClient();
                if (!this.client) {
                    this.log('Failed to initialize Twitter client', 'error');
                    throw new Error('Twitter client not initialized. Check your API credentials or authorize with X.');
                }
            }

            // Log that we're making the "me" API call
            this.log(`STARTING BOOKMARKS SYNC: Retrieving user information first`, 'info');
            this.log('API CALL: GET /2/users/me (to get user ID)', 'info');
            
            // Update the rate limit timestamp for the me() API call
            await this.updateRateLimitTimestamp();
            this.log(`API timestamp updated to prevent rapid consecutive calls`, 'debug');
            
            let currentUser;
            try {
                currentUser = await this.client.v2.me();
                this.log(`API RESPONSE: User ID ${currentUser.data.id} retrieved successfully`, 'info');
            } catch (userError: any) {
                this.log(`Error getting current user: ${userError}`, 'error');
                
                if (userError.code === 429 || (userError.errors && userError.errors[0]?.code === 88)) {
                    this.log(`RATE LIMIT REACHED on GET /2/users/me call`, 'error');
                    // Get reset time if available
                    const resetTimeRaw = userError.rateLimit?.reset;
                    let waitTimeMsg = '15 minutes';
                    if (resetTimeRaw) {
                        const resetTime = new Date(resetTimeRaw * 1000);
                        const waitMinutes = Math.ceil((resetTime.getTime() - Date.now()) / (1000 * 60));
                        waitTimeMsg = `${waitMinutes} minutes (until ${resetTime.toISOString()})`;
                    }
                    
                    throw new Error(`X API rate limit exceeded on user info request. Please wait ${waitTimeMsg} before trying again.`);
                }
                
                throw userError; // re-throw if not a rate limit error
            }
            
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
            this.log(`⚠️ RATE LIMIT INFO: X API allows 1 request per 15 minutes per user.`, 'info');

            // Track if we've made a request in this session
            let madeRequest = false;
            
            while (requestCount < MAX_REQUESTS) {
                requestCount++;
                madeRequest = true;
                
                this.log(`API CALL: GET /2/users/${userId}/bookmarks (request ${requestCount}/${MAX_REQUESTS})`, 'info');
                
                // Log detailed parameters
                this.log(`API parameters: expansions=[author_id,attachments.media_keys], user.fields=[name,username], media.fields=[url,preview_image_url], tweet.fields=[created_at], max_results=100${paginationToken ? `, pagination_token=${paginationToken.substring(0, 10)}...` : ''}`, 'debug');
                
                // Update timestamp BEFORE making the API call
                await this.updateRateLimitTimestamp();
                
                try {
                    // Fetch bookmarks with parameters
                    const bookmarksResponse = await this.client.v2.bookmarks({
                        expansions: ['author_id', 'attachments.media_keys'],
                        'user.fields': ['name', 'username'],
                        'media.fields': ['url', 'preview_image_url'],
                        'tweet.fields': ['created_at'],
                        max_results: 100, // Maximum allowed
                        pagination_token: paginationToken
                    });
                    
                    this.log(`API RESPONSE: Received bookmarks response with status OK, found ${bookmarksResponse.data.data?.length || 0} bookmark(s)`, 'info');
                    
                    // Process the current page of bookmarks
                    const bookmarks = this.processBookmarksPage(bookmarksResponse, this.settings.initialSyncComplete ? lastSyncTimestamp : 0);
                    allBookmarks.push(...bookmarks);
                    
                    // Update the last sync page
                    this.settings.lastSyncPage++;
                    
                    // Check for rate limit headers
                    if (bookmarksResponse.rateLimit) {
                        this.log(`RATE LIMIT HEADERS: Remaining=${bookmarksResponse.rateLimit.remaining}/${bookmarksResponse.rateLimit.limit}, Reset=${new Date(bookmarksResponse.rateLimit.reset * 1000).toISOString()}`, 'info');
                    }
                    
                    // Check if there's another page
                    if (bookmarksResponse.meta && bookmarksResponse.meta.next_token) {
                        // Save the pagination token for the next run
                        this.settings.nextPaginationToken = bookmarksResponse.meta.next_token;
                        this.log(`PAGINATION: Found next pagination token: ${this.settings.nextPaginationToken.substring(0, 10)}...`, 'debug');
                        this.log(`⚠️ MORE DATA AVAILABLE: There are more bookmarks available. You'll need to sync again in 15 minutes to continue.`, 'info');
                        
                        // Not done with initial sync
                        this.settings.initialSyncComplete = false;
                        await this.saveSettingsCallback(); // Save after updating pagination info
                        break;
                    } else {
                        // No more pages, we've completed the initial sync
                        this.settings.nextPaginationToken = '';
                        this.settings.initialSyncComplete = true;
                        this.log('SYNC COMPLETE: No more pages available, reached the end of all bookmarks', 'info');
                        await this.saveSettingsCallback(); // Save after completing sync
                        break;
                    }
                } catch (bookmarkError: any) {
                    this.log(`Error fetching bookmarks: ${bookmarkError}`, 'error');
                    
                    // Enhanced rate limit error handling
                    if (bookmarkError.code === 429 || (bookmarkError.errors && bookmarkError.errors[0]?.code === 88)) {
                        this.log(`RATE LIMIT REACHED on GET /2/users/${userId}/bookmarks call`, 'error');
                        
                        // Extract any rate limit information
                        if (bookmarkError.rateLimit) {
                            const resetTime = new Date(bookmarkError.rateLimit.reset * 1000);
                            this.log(`Rate limit reset time: ${resetTime.toISOString()}`, 'info');
                        }
                        
                        // Still update rate limit timestamp
                        await this.updateRateLimitTimestamp();
                        
                        // Throw with better message
                        throw new Error(`X API rate limit exceeded. Please try again in 15 minutes.`);
                    }
                    
                    // Re-throw the error
                    throw bookmarkError;
                }
            }
            
            if (!madeRequest) {
                this.log('No bookmarks request made in this session due to rate limits', 'info');
            }

            this.log(`SYNC SUMMARY: Retrieved ${allBookmarks.length} bookmarks in this sync session`, 'info');
            return allBookmarks;
        } catch (error) {
            this.log(`ERROR FETCHING TWITTER BOOKMARKS: ${error}`, 'error');
            
            // Enhanced error logging
            const errorObj = error as any;
            if (errorObj.code || (errorObj.errors && errorObj.errors.length > 0)) {
                this.log(`API error details: ${JSON.stringify({
                    code: errorObj.code,
                    errors: errorObj.errors,
                    status: errorObj.status,
                    rateLimit: errorObj.rateLimit
                }, null, 2)}`, 'error');
            }
            
            // Check if this is a rate limit error
            if (errorObj.code === 429 || (errorObj.errors && errorObj.errors[0]?.code === 88)) {
                const resetTimeHeader = errorObj.rateLimit?.reset;
                let waitMessage = 'X API rate limit exceeded. Please try again in 15 minutes.';
                
                if (resetTimeHeader) {
                    const resetTime = new Date(resetTimeHeader * 1000);
                    const waitMinutes = Math.ceil((resetTime.getTime() - Date.now()) / (1000 * 60));
                    waitMessage = `X API rate limit exceeded. Please try again in ${waitMinutes} minutes.`;
                }
                
                await this.updateRateLimitTimestamp(); // Update timestamp on rate limit error
                
                // Add debug info about bypass setting
                if (!this.settings.bypassRateLimit) {
                    this.log(`TIP: For debugging, you can temporarily bypass the client-side rate limit in Settings > Debug Settings. This won't prevent X API 429 errors but will bypass the waiting period between requests.`, 'info');
                } else {
                    this.log(`NOTICE: You have rate limit bypass enabled, but received a 429 error from X API. This confirms you are hitting the actual API rate limit.`, 'error');
                }
                
                this.log(waitMessage, 'error');
                throw new Error(waitMessage);
            }
            
            // If the token is expired, try to refresh it just once
            if (this.settings.oauth2RefreshToken && 
                !this.isRateLimited() && // Only try if not rate limited
                (errorObj.code === 401 || 
                 (errorObj.errors && errorObj.errors[0]?.code === 32) || 
                 /unauthorized/i.test(String(error)))) {
                
                this.log('Token may have expired, attempting to refresh once...', 'info');
                
                try {
                    const refreshed = await this.refreshAccessToken();
                    if (refreshed) {
                        this.log('Successfully refreshed token, retrying bookmark fetch', 'info');
                        // Clear the in-progress flag before recursive call
                        this.apiCallsInProgress = false;
                        
                        // IMPORTANT: Don't make recursive calls, use a promise instead
                        throw new Error('Authentication refreshed. Please try syncing again.');
                    } else {
                        this.log('Failed to refresh token', 'error');
                    }
                } catch (refreshError) {
                    this.log(`Error refreshing token: ${refreshError}`, 'error');
                    throw new Error(`Authentication error: ${(refreshError as Error).message}`);
                }
            }
            
            throw new Error(`Failed to fetch bookmarks: ${(error as Error).message}`);
        } finally {
            // Always clear the in-progress flag when done
            this.apiCallsInProgress = false;
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

    /**
     * Check if we're currently rate limited - can be called by external code
     * @returns True if rate limited, false if not
     * @throws Error with descriptive message if rate limited
     */
    public async checkRateLimitStatus(): Promise<boolean> {
        // If rate limit bypass is enabled, always return false (not rate limited)
        if (this.settings.bypassRateLimit) {
            this.log(`⚠️ RATE LIMIT BYPASS: Rate limit check bypassed due to debug setting`, 'info');
            return false;
        }

        const now = Date.now();
        const lastCallTime = this.lastApiCallTime || 0;
        const lastSyncTime = this.settings.lastSyncTime || 0;
        const lastRelevantTime = Math.max(lastCallTime, lastSyncTime);
        
        // If no previous calls have been made, we're not rate limited
        if (lastRelevantTime === 0) {
            this.log('No previous API calls detected, not rate limited', 'debug');
            return false;
        }
        
        const timeElapsed = now - lastRelevantTime;
        const isLimited = timeElapsed < this.apiRateLimitWindow;
        
        if (isLimited) {
            const timeToWait = Math.ceil((this.apiRateLimitWindow - timeElapsed) / 1000 / 60);
            const nextAllowedTime = new Date(lastRelevantTime + this.apiRateLimitWindow);
            
            const errorMessage = `X API rate limit active. Please wait approximately ${timeToWait} more minutes (until ${nextAllowedTime.toLocaleTimeString()}).`;
            this.log(`RATE LIMIT CHECK: ${errorMessage}`, 'info');
            throw new Error(errorMessage);
        }
        
        this.log('Rate limit check passed - API is available', 'debug');
        return false;
    }
} 