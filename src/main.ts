import { App, Plugin, PluginSettingTab, Setting, Notice, DropdownComponent, ButtonComponent, TextComponent, TextAreaComponent, ToggleComponent } from 'obsidian';
import { TwitterService } from './services/twitter-service';
import { BookmarkProcessor } from './core/bookmark-processor';
import { BookmarkStorage } from './core/bookmark-storage';

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
	
	// Automatic sync settings
	autoSync: boolean; // Whether to automatically sync bookmarks
	syncInProgress: boolean; // Whether a sync is currently in progress
	
	// Debug settings
	bypassRateLimit: boolean; // DEBUG ONLY: Bypass the built-in rate limit check
}

const DEFAULT_SETTINGS: BookmarkBridgeSettings = {
	// OAuth 2.0 defaults
	clientId: '',
	clientSecret: '',
	oauth2AccessToken: '',
	oauth2RefreshToken: '',
	codeVerifier: '',
	
	// Storage defaults
	storageMethod: 'separate', // Default to separate files
	targetFolder: 'Twitter Bookmarks',
	singleFileName: 'twitter-bookmarks.md', // Default filename for single file storage
	
	// Sync state
	lastSyncTimestamp: 0,
	logFile: '', // Will be set on plugin load
	
	// Template defaults
	useCustomTemplate: false,
	template: `---
tweet_id: "{{id}}"
author: "@{{authorUsername}} ({{authorName}})"
date: "{{date}} {{time}}"
---

# Tweet by @{{authorUsername}}

{{text}}

{{#hasMedia}}
## Media

{{#mediaUrls}}
![]({{.}})

{{/mediaUrls}}
{{/hasMedia}}

[View on Twitter]({{tweetUrl}})`,

	// Pagination defaults
	nextPaginationToken: '',
	initialSyncComplete: false,
	lastSyncPage: 0,
	lastSyncTime: 0,
	
	// Automatic sync defaults
	autoSync: true,
	syncInProgress: false,
	
	// Debug defaults
	bypassRateLimit: false
};

export default class BookmarkBridgePlugin extends Plugin {
	settings: BookmarkBridgeSettings;
	twitterService: TwitterService;
	bookmarkProcessor: BookmarkProcessor;
	bookmarkStorage: BookmarkStorage;
	syncTimer: NodeJS.Timeout | null = null;
	private authState: string | null = null;
	private currentCodeVerifier: string | null = null; // Store code verifier for the current auth attempt
	private isSyncCooldown: boolean = false; // Global sync cooldown flag
	private nextAllowedSyncTime: number = 0; // Timestamp for next allowed sync

	async onload() {
		await this.loadSettings();

		// Initialize services FIRST, so logging is available
		this.twitterService = new TwitterService(this.settings, this.saveSettings.bind(this));
		this.bookmarkStorage = new BookmarkStorage(this.app);
		this.bookmarkProcessor = new BookmarkProcessor(this.app, this.settings, this.bookmarkStorage);

		if (!this.settings.logFile) {
			const basePath = (this.app.vault.adapter as any).basePath || '';
			this.settings.logFile = `${basePath}/.obsidian/plugins/bookmark-bridge/bookmark-bridge-log.txt`;
			// Log only after twitterService is initialized if using its log method here
			await this.saveSettings(); // Save settings first
			this.twitterService.log(`Setting log file path to: ${this.settings.logFile}`, 'info');
		}

		// Log important setup information that can help users troubleshoot
		this.logOAuthSetupInstructions();
		
		// Register protocol handlers for Twitter OAuth callback
		this.registerProtocolHandlers();

		// Add the plugin icon to the left ribbon.
		const ribbonIconEl = this.addRibbonIcon('bookmark', 'Bookmark Bridge', async () => {
			await this.syncBookmarks();
		});
		ribbonIconEl.addClass('bookmark-bridge-ribbon-icon');

		// Add command to sync bookmarks
		this.addCommand({
			id: 'sync-twitter-bookmarks',
			name: 'Sync Twitter Bookmarks',
			callback: async () => {
				await this.syncBookmarks();
			}
		});

		// Add test command to check if protocol handler works
		this.addCommand({
			id: 'test-protocol-handler',
			name: 'Test Protocol Handler (Debug)',
			callback: () => {
				// Generate test data similar to what Twitter would send
				const testState = this.authState || this.twitterService.generateRandomString(32);
				if (!this.authState) this.authState = testState;
				
				const testCode = this.twitterService.generateRandomString(20);
				
				// Create a test URL using the EXACT format Twitter would use
				const testUrl = `obsidian://bookmark-bridge/callback?code=${testCode}&state=${testState}`;
				this.twitterService.log(`TEST: Opening test URL to check protocol handler: ${testUrl}`, 'info');
				
				// Try to open the URL, which should trigger our protocol handler
				window.open(testUrl);
				
				new Notice("Opened test protocol URL. Check logs to see if handler was triggered.");
			}
		});

		// Add settings tab
		this.addSettingTab(new BookmarkBridgeSettingTab(this.app, this));
		
		this.twitterService.log(`Plugin loaded. Storage method: ${this.settings.storageMethod}, Single file: ${this.settings.singleFileName}`, 'info');
		
		if (this.settings.autoSync) {
			this.startAutoSync();
		}
	}

	startAutoSync() {
		this.twitterService.log('Starting automatic sync system', 'info');
		
		// Prevent starting sync if we're in cooldown or a sync is already in progress
		if (this.isSyncCooldown || this.settings.syncInProgress) {
			const reason = this.isSyncCooldown ? 'sync cooldown active' : 'sync already in progress';
			this.twitterService.log(`Not starting auto-sync: ${reason}`, 'info');
			return;
		}
		
		// Clear any existing timer
		if (this.syncTimer) {
			clearTimeout(this.syncTimer);
			this.syncTimer = null;
		}
		
		// Check if we should start an immediate sync
		this.checkAndScheduleSync();
	}
	
	/**
	 * Check if we're in a rate-limit cooldown period
	 * @returns True if we're in cooldown, false if it's okay to sync
	 */
	private isInCooldown(): boolean {
		const now = Date.now();
		const cooldown = now < this.nextAllowedSyncTime;
		
		if (cooldown) {
			const waitSeconds = Math.ceil((this.nextAllowedSyncTime - now) / 1000);
			this.twitterService.log(`In cooldown period. Need to wait ${waitSeconds} seconds before next sync.`, 'debug');
		}
		
		return cooldown;
	}
	
	/**
	 * Set a cooldown period before the next sync can be attempted
	 * @param durationMs The cooldown duration in milliseconds
	 */
	private setCooldown(durationMs: number): void {
		this.isSyncCooldown = true;
		this.nextAllowedSyncTime = Date.now() + durationMs;
		const cooldownMinutes = Math.ceil(durationMs / 1000 / 60);
		
		this.twitterService.log(`Setting sync cooldown for ${cooldownMinutes} minutes`, 'info');
		
		// Set up the cooldown expiry timer
		setTimeout(() => {
			this.twitterService.log('Sync cooldown period expired', 'info');
			this.isSyncCooldown = false;
		}, durationMs);
	}
	
	async checkAndScheduleSync() {
		// Don't proceed if no valid credentials
		if (!this.validateSettings(false)) {
			this.twitterService.log('Cannot start auto-sync: missing required settings', 'error');
			return;
		}
		
		// Don't schedule a new sync if one is already in progress or we're in cooldown
		// Skip cooldown check if bypass is enabled
		if (this.settings.syncInProgress || (!this.settings.bypassRateLimit && this.isInCooldown())) {
			const reason = this.settings.syncInProgress ? 'sync in progress' : 'in cooldown period';
			this.twitterService.log(`Not scheduling sync: ${reason}`, 'info');
			return;
		}
		
		// If rate limit bypass is enabled, log it
		if (this.settings.bypassRateLimit) {
			this.twitterService.log(`⚠️ DEBUG: Bypassing rate limit window for scheduling due to debug setting`, 'info');
		}
		
		// Calculate time since last sync attempt
		const now = Date.now();
		const timeElapsed = now - this.settings.lastSyncTime;
		const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes in milliseconds
		
		// Check if we need to start an initial sync or continue pagination
		if (!this.settings.initialSyncComplete) {
			// We need to continue with pagination or start the initial sync
			
			// Either bypass rate limit check or check elapsed time
			if (this.settings.bypassRateLimit || this.settings.lastSyncTime === 0 || timeElapsed >= RATE_LIMIT_WINDOW) {
				// We can sync now - either first sync ever or rate limit window passed or bypass enabled
				this.twitterService.log(`Auto-starting sync ${this.settings.lastSyncPage > 0 ? 'continuation' : 'initial'}`, 'info');
				await this.syncBookmarks(true);
			} else {
				// We need to wait for the rate limit window
				const timeToWait = RATE_LIMIT_WINDOW - timeElapsed;
				const minutesToWait = Math.ceil(timeToWait/1000/60);
				this.twitterService.log(`Rate limit not reset yet, scheduling next auto-sync in ${minutesToWait} minutes`, 'info');
				
				// Make sure we're not in "sync in progress" state
				this.settings.syncInProgress = false;
				await this.saveSettings();
				
				// Set cooldown to prevent other sync attempts
				this.setCooldown(timeToWait); 
				
				// Schedule the next sync
				if (this.syncTimer) {
					clearTimeout(this.syncTimer);
				}
				
				this.syncTimer = setTimeout(() => {
					this.twitterService.log('Auto-sync timer triggered after rate limit window', 'info');
					// We're not awaiting this to prevent blocking
					this.syncBookmarks(true);
				}, timeToWait);
			}
		} else if (this.settings.autoSync) {
			// Initial sync complete, but we'll check again in 1 hour for new bookmarks
			// Use a shorter interval if bypass is enabled
			const CHECK_INTERVAL = this.settings.bypassRateLimit ? 
				1 * 60 * 1000 : // 1 minute if bypassing
				60 * 60 * 1000; // 1 hour normally
				
			const timeDesc = this.settings.bypassRateLimit ? '1 minute (debug mode)' : '1 hour';
			this.twitterService.log(`Initial sync complete, scheduling routine check in ${timeDesc}`, 'info');
			
			// Set a short cooldown to prevent immediate re-triggering
			// Skip if bypass is enabled
			if (!this.settings.bypassRateLimit) {
				this.setCooldown(30 * 1000); // 30 second cooldown
			}
			
			if (this.syncTimer) {
				clearTimeout(this.syncTimer);
			}
			
			this.syncTimer = setTimeout(() => {
				this.twitterService.log('Routine sync check triggered', 'info');
				// We're not awaiting this to prevent blocking
				this.syncBookmarks(true);
			}, CHECK_INTERVAL);
		}
	}

	async syncBookmarks(isAutoSync: boolean = false) {
		// Don't sync if we don't have required settings
		if (!this.validateSettings(!isAutoSync)) {
			return;
		}
		
		// Check if we're in cooldown or a sync is already in progress
		// Skip cooldown check if bypass is enabled
		if (!this.settings.bypassRateLimit && this.isInCooldown()) {
			const waitTimeMs = this.nextAllowedSyncTime - Date.now();
			const waitMinutes = Math.ceil(waitTimeMs / 1000 / 60);
			const message = `Rate limit cooldown active. Please wait approximately ${waitMinutes} more minutes before syncing.`;
			
			this.twitterService.log(message, 'info');
			if (!isAutoSync) {
				new Notice(message, 5000);
			}
			return;
		}
		
		// If bypass enabled, log it
		if (this.settings.bypassRateLimit) {
			this.twitterService.log(`⚠️ DEBUG: Bypassing rate limit cooldown check due to debug setting`, 'info');
		}
		
		// Also check Twitter service's rate limit status directly
		// Skip this check if bypass is enabled
		if (!this.settings.bypassRateLimit) {
			try {
				// This will throw an error if rate limited
				const isLimited = await this.twitterService.checkRateLimitStatus();
				if (isLimited) {
					this.twitterService.log('Rate limited according to Twitter service, aborting sync', 'info');
					if (!isAutoSync) {
						new Notice('Twitter API rate limit in effect. Please try again later.', 5000);
					}
					return;
				}
			} catch (error) {
				const errorMessage = (error as Error).message;
				this.twitterService.log(`Rate limit check error: ${errorMessage}`, 'error');
				if (!isAutoSync) {
					new Notice(`Cannot sync: ${errorMessage}`, 5000);
				}
				return;
			}
		}
		
		// Check if a sync is already in progress
		if (this.settings.syncInProgress) {
			this.twitterService.log('Sync already in progress, not starting a new one', 'info');
			if (!isAutoSync) {
				new Notice('A sync is already in progress. Please wait for it to complete.');
			}
			return;
		}
		
		// Set the sync in progress flag
		this.settings.syncInProgress = true;
		await this.saveSettings();
		
		try {
			// Show status notification if this is a manual sync
			let notice: Notice | null = null;
			if (!isAutoSync) {
				notice = new Notice('Syncing Twitter bookmarks...', 0);
			}
			
			this.twitterService.log(`Starting bookmark sync. Storage method: ${this.settings.storageMethod}, Auto: ${isAutoSync}`, 'info');
			if (this.settings.storageMethod === 'single') {
				this.twitterService.log(`Using single file mode with file: ${this.settings.singleFileName}`, 'info');
			}
			
			// Get bookmarks from Twitter API
			try {
				const bookmarks = await this.twitterService.fetchBookmarks(this.settings.lastSyncTimestamp);
				
				if (bookmarks.length === 0) {
					this.twitterService.log(`No new bookmarks found`, 'info');
					if (notice) {
						notice.setMessage('No new bookmarks found.');
						setTimeout(() => notice?.hide(), 3000);
					}
					
					// Set a cooldown to prevent retrying too soon
					this.setCooldown(60 * 1000); // 1 minute cooldown after successful empty response
					
					// If this was an auto-sync, schedule the next check
					if (isAutoSync) {
						this.settings.syncInProgress = false;
						await this.saveSettings();
						// Use setTimeout to avoid recursive call
						setTimeout(() => this.checkAndScheduleSync(), 1000);
					}
					return;
				}
	
				this.twitterService.log(`Retrieved ${bookmarks.length} bookmarks, processing...`, 'info');
				
				// Process and save bookmarks
				try {
					await this.bookmarkProcessor.processBookmarks(bookmarks);
					this.twitterService.log(`Successfully processed ${bookmarks.length} bookmarks`, 'info');
				} catch (processingError) {
					this.twitterService.log(`Error processing bookmarks: ${(processingError as Error).message}`, 'error');
					throw new Error(`Error processing bookmarks: ${(processingError as Error).message}`);
				}
	
				// Only update the lastSyncTimestamp if we've completed the initial sync
				if (this.settings.initialSyncComplete) {
					this.settings.lastSyncTimestamp = Date.now();
					this.twitterService.log(`Updated last sync timestamp to ${new Date(this.settings.lastSyncTimestamp).toISOString()}`, 'info');
				}
				
				// Save settings to persist pagination state
				this.settings.syncInProgress = false;
				await this.saveSettings();
	
				// Update notice if this was a manual sync
				if (notice) {
					if (this.settings.initialSyncComplete) {
						notice.setMessage(`Successfully synced ${bookmarks.length} bookmark(s).`);
					} else {
						notice.setMessage(`Synced ${bookmarks.length} bookmark(s). More bookmarks available - continuing automatic sync.`);
					}
					setTimeout(() => notice?.hide(), 5000);
				}
				
				// Set standard cooldown after successful sync
				const cooldownTime = 15 * 60 * 1000; // 15 minutes standard cooldown
				this.setCooldown(cooldownTime);
				
				// If this was an auto-sync, schedule the next check after a delay
				if (isAutoSync) {
					// Use setTimeout to avoid recursive call
					setTimeout(() => this.checkAndScheduleSync(), 2000);
				}
			} catch (fetchError) {
				// Handle rate limiting errors in a user-friendly way
				let errorMessage = (fetchError as Error).message;
				this.twitterService.log(`Error fetching bookmarks: ${errorMessage}`, 'error');
				
				// Special handling for token refresh success
				if (errorMessage.includes('Authentication refreshed')) {
					// Token was refreshed, but we need to wait before trying again
					this.twitterService.log('Access token refreshed successfully, scheduling retry with cooldown', 'info');
					
					// Set a moderate cooldown before retrying after token refresh
					const cooldownTime = 30 * 1000; // 30 seconds
					this.setCooldown(cooldownTime);
					
					if (notice) {
						notice.setMessage('Authentication renewed. Will retry shortly.');
						setTimeout(() => notice?.hide(), 5000);
					}
					
					// If auto-sync, schedule a retry
					if (isAutoSync) {
						setTimeout(() => {
							this.twitterService.log('Retrying sync after token refresh...', 'info');
							this.syncBookmarks(true);
						}, cooldownTime + 1000);
					}
					
					return;
				}
				
				if (notice) {
					if (errorMessage.includes('rate limit') || errorMessage.includes('Please wait')) {
						notice.setMessage(`Rate limit reached. ${errorMessage}`);
					} else {
						notice.setMessage(`Error syncing bookmarks: ${errorMessage}`);
					}
					setTimeout(() => notice?.hide(), 10000);
				}
				
				// Set appropriate cooldown after error
				let cooldownTime = 5 * 60 * 1000; // Default: 5 minutes cooldown
				
				// If rate limited, extract the waiting time from the error message
				if (errorMessage.includes('wait approximately')) {
					const minutesMatch = errorMessage.match(/wait approximately (\d+) more minutes/);
					if (minutesMatch && minutesMatch[1]) {
						const waitMinutes = parseInt(minutesMatch[1], 10);
						// Add a small buffer (1 minute) to ensure the rate limit has expired
						cooldownTime = (waitMinutes + 1) * 60 * 1000;
					}
				}
				
				this.setCooldown(cooldownTime);
				
				// If this was an auto-sync, schedule the next attempt appropriately
				if (isAutoSync) {
					// Schedule the retry with a delay
					if (this.syncTimer) {
						clearTimeout(this.syncTimer);
					}
					
					this.syncTimer = setTimeout(() => {
						this.twitterService.log(`Retrying sync after error cooldown of ${Math.round(cooldownTime / 60000)} minutes`, 'info');
						// Note: we're not awaiting this to prevent blocking
						this.syncBookmarks(true);
					}, cooldownTime + 1000); // Add 1 second to ensure cooldown has expired
				}
			}
		} finally {
			// Always clear the sync in progress flag
			this.settings.syncInProgress = false;
			await this.saveSettings();
		}
	}

	validateSettings(showNotices: boolean = true): boolean {
		// Validate OAuth 2.0 credentials
		if (!this.settings.clientId) {
			if (showNotices) new Notice('Please configure your X API Client ID in the settings.', 5000);
			return false;
		}
		
		if (!this.settings.oauth2AccessToken) {
			if (showNotices) new Notice('Please authorize with X to generate an access token.', 5000);
			return false;
		}

		// Validate storage settings
		if (!this.settings.targetFolder) {
			if (showNotices) new Notice('Please specify a target folder in the settings.', 5000);
			return false;
		}
		
		// For single file storage, validate filename
		if (this.settings.storageMethod === 'single' && !this.settings.singleFileName) {
			if (showNotices) new Notice('Please specify a filename for single file storage.', 5000);
			return false;
		}

		return true;
	}

	onunload() {
		// Clear any running timers
		if (this.syncTimer) {
			clearTimeout(this.syncTimer);
			this.syncTimer = null;
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		
		// Make sure singleFileName is set if missing (for migration from older versions)
		if (!this.settings.singleFileName) {
			this.settings.singleFileName = DEFAULT_SETTINGS.singleFileName;
			await this.saveSettings();
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// Method to initiate authentication from settings tab
	async initiateTwitterAuth() {
		this.twitterService.log("initiateTwitterAuth: Called", 'debug');
		if (!this.settings.clientId) {
			new Notice("Please enter your Twitter Client ID in the settings.");
			this.twitterService.log("initiateTwitterAuth: Client ID missing", 'error');
			return;
		}
		try {
			this.authState = this.twitterService.generateRandomString(32);
			this.twitterService.log(`initiateTwitterAuth: Generated state: ${this.authState}`, 'debug');
			
			const { url: authUrl, codeVerifier } = await this.twitterService.generateAuthUrl(this.authState);
			this.twitterService.log(`initiateTwitterAuth: Generated auth URL: ${authUrl}`, 'debug');
			this.currentCodeVerifier = codeVerifier; // Store in class member
			this.twitterService.log(`initiateTwitterAuth: Stored currentCodeVerifier: ${this.currentCodeVerifier ? this.currentCodeVerifier.substring(0, 10) + '...' : 'null'}`, 'debug');

			// No longer saving codeVerifier to this.settings here
			this.twitterService.log("AUTHENTICATION FLOW START: Opening browser for Twitter OAuth. After authorizing, you should be redirected back to Obsidian.", 'info');
			this.twitterService.log("If you're seeing a 'Something went wrong' error from Twitter, check that your callback URL in Twitter Developer Portal EXACTLY matches: obsidian://bookmark-bridge/callback", 'info');

			new Notice("Redirecting to Twitter for authentication... Please complete the process in your browser.");
			window.open(authUrl);
		} catch (error) {
			this.twitterService.log(`initiateTwitterAuth: Error initiating Twitter auth: ${(error as Error).message}`, 'error');
			new Notice("Error initiating Twitter authentication. Check console/log file.");
			this.authState = null;
			this.currentCodeVerifier = null; // Clear class member
		}
	}

	async handleAuthCallback(params: Record<string, string>) {
		this.twitterService.log(`handleAuthCallback: Called with params: ${JSON.stringify(params)}`, 'debug');

		// Guard: Prevent duplicate/looping calls if state is already cleared
		if (!this.authState || !this.currentCodeVerifier) {
			this.twitterService.log('handleAuthCallback: Ignoring callback because authState or currentCodeVerifier is null (already processed or invalid state).', 'error');
			return;
		}
		
		// Try to extract code and state from the parameters
		let code = params.code;
		let state = params.state;
		
		// Log the parameters we're working with
		this.twitterService.log(`Parameters received: ${JSON.stringify(params)}`, 'info');
		
		// Check if the code/state might be embedded in a path segment
		if (!code && params.callback && typeof params.callback === 'string') {
			// If the callback path segment contains the code and state
			this.twitterService.log("Attempting to extract code/state from callback path segment", 'debug');
			try {
				// First try parsing as a URL query string
				if (params.callback.includes('?')) {
					const callbackUrl = "https://dummy.com/" + params.callback;
					const urlObj = new URL(callbackUrl);
					code = urlObj.searchParams.get('code') || code;
					state = urlObj.searchParams.get('state') || state;
					this.twitterService.log(`Extracted from URL: code=${code?.substring(0,10)}..., state=${state}`, 'debug');
				} 
				// If no question mark, try parsing as a standalone query string
				else if (params.callback.includes('code=') || params.callback.includes('state=')) {
					const queryParams = new URLSearchParams(params.callback);
					code = queryParams.get('code') || code;
					state = queryParams.get('state') || state;
					this.twitterService.log(`Extracted from query string: code=${code?.substring(0,10)}..., state=${state}`, 'debug');
				}
			} catch (e) {
				this.twitterService.log(`Failed to parse callback: ${e}`, 'error');
			}
		}
		
		const currentNotice = new Notice("Processing Twitter authentication callback...", 0);
		this.twitterService.log(`Final extracted code: ${code ? code.substring(0, 10) + '...' : 'null'}`, 'debug');
		this.twitterService.log(`Final extracted state: ${state}`, 'debug');
		this.twitterService.log(`Expected state (this.authState): ${this.authState}`, 'debug');

		// Validate state parameter to prevent CSRF
		if (!state || state !== this.authState) {
			this.twitterService.log("handleAuthCallback: Invalid state parameter.", 'error');
			this.twitterService.log(`Received state: "${state}", Expected state: "${this.authState}"`, 'error');
			currentNotice.setMessage("Authentication failed: Invalid state. Please try again.");
			setTimeout(() => currentNotice.hide(), 5000);
			this.authState = null;
			this.currentCodeVerifier = null;
			return;
		}
		
		this.authState = null; // Clear state after use
		this.twitterService.log("State validated and cleared.", 'debug');

		// Validate code parameter
		if (!code) {
			this.twitterService.log("No authorization code received.", 'error');
			currentNotice.setMessage("Authentication failed: No authorization code received.");
			setTimeout(() => currentNotice.hide(), 5000);
			this.currentCodeVerifier = null;
			return;
		}

		// Validate code verifier
		if (!this.currentCodeVerifier) {
			this.twitterService.log("Critical error - currentCodeVerifier is null before token exchange.", 'error');
			currentNotice.setMessage("Authentication error: Missing internal verifier. Please try again.");
			setTimeout(() => currentNotice.hide(), 5000);
			return;
		}
		
		// Temporarily set codeVerifier in settings for TwitterService to use, then clear it
		this.settings.codeVerifier = this.currentCodeVerifier;
		this.currentCodeVerifier = null; // Clear immediately after assigning to settings for the service call
		this.twitterService.log(`Assigned currentCodeVerifier to settings.codeVerifier for service call: ${this.settings.codeVerifier ? this.settings.codeVerifier.substring(0, 10) + '...' : 'null'}`, 'debug');

		try {
			// Use same callbackUrl as in generateAuthUrl - this must match EXACTLY what was used in the auth request
			const callbackUrl = 'obsidian://bookmark-bridge/callback';
			this.twitterService.log("Attempting to exchange auth code for token...", 'debug');
			const success = await this.twitterService.exchangeAuthCodeForToken(code, callbackUrl);

			if (success) {
				this.twitterService.log("Token exchange successful.", 'info');
				currentNotice.setMessage("Successfully authenticated with Twitter!");
				setTimeout(() => currentNotice.hide(), 5000);
				
				// Force refresh the settings tab UI
				this.refreshSettingsUI();
			} else {
				this.twitterService.log("Token exchange failed.", 'error');
				currentNotice.setMessage("Failed to obtain access token from Twitter. Check log file.");
				setTimeout(() => currentNotice.hide(), 5000);
			}
		} catch (error) {
			this.twitterService.log(`Error exchanging auth code for token: ${(error as Error).message}`, 'error');
			currentNotice.setMessage("Error during Twitter authentication. Check log file.");
			setTimeout(() => currentNotice.hide(), 5000);
		} finally {
			this.twitterService.log("Entering finally block.", 'debug');
			// Always clear state after any attempt
			this.authState = null;
			this.currentCodeVerifier = null;
			// Ensure codeVerifier is cleared from settings (it should have been by exchangeAuthCodeForToken on success)
			if (this.settings.codeVerifier !== '') {
				this.twitterService.log("Clearing settings.codeVerifier in finally block.", 'debug');
				this.settings.codeVerifier = '';
				await this.saveSettings();
			}
		}
	}

	/**
	 * Attempt to refresh the settings UI after changes
	 */
	private refreshSettingsUI(): void {
		this.twitterService.log("Attempting to refresh settings tab UI...", 'debug');
		
		try {
			// Method 1: Try using the setting instance from app
			const settingsInstance = (this.app as any).setting;
			if (settingsInstance && settingsInstance.settingTabs) {
				const settingTab = settingsInstance.settingTabs.find((tab: PluginSettingTab) => tab instanceof BookmarkBridgeSettingTab);
				if (settingTab) {
					this.twitterService.log("Found settings tab instance, refreshing UI", 'debug');
					// Force a complete UI refresh by clearing the container first
					(settingTab as BookmarkBridgeSettingTab).containerEl.empty();
					(settingTab as BookmarkBridgeSettingTab).display();
				} else {
					this.twitterService.log("Settings tab not found in settingTabs", 'debug');
				}
			}
			
			// Method 2: Try to open the settings tab which should trigger a refresh
			this.twitterService.log("Trying to open plugin settings tab to force refresh", 'debug');
			(this.app as any).setting.open('bookmark-bridge');
			
		} catch (uiError) {
			this.twitterService.log(`Error refreshing settings UI: ${uiError}`, 'error');
		}
	}

	// Add detailed instructions for setting up OAuth correctly in Twitter Developer Portal
	private logOAuthSetupInstructions() {
		this.twitterService.log("=== TWITTER OAUTH SETUP INSTRUCTIONS ===", 'info');
		this.twitterService.log("To set up Twitter OAuth correctly for this plugin:", 'info');
		this.twitterService.log("1. Go to https://developer.x.com and log in", 'info');
		this.twitterService.log("2. Navigate to your App's settings in the developer portal", 'info');
		this.twitterService.log("3. Under 'User authentication settings', ensure OAuth 2.0 is enabled", 'info');
		this.twitterService.log("4. Set App type to 'Native App' (or 'Web App' if running on a server)", 'info');
		this.twitterService.log("5. Add EXACTLY this URL to the 'Callback URLs / Redirect URLs' section:", 'info');
		this.twitterService.log("   obsidian://bookmark-bridge/callback", 'info');
		this.twitterService.log("6. Make sure the URL is saved in your app settings", 'info');
		this.twitterService.log("7. IMPORTANT: The URL format with '/callback' is correctly registered", 'info');
		this.twitterService.log("   in the plugin's protocol handlers", 'info');
		this.twitterService.log("===================================", 'info');
	}

	/**
	 * Register all protocol handlers for the OAuth redirect flow
	 */
	private registerProtocolHandlers(): void {
		// Option 1: Register handler for full "bookmark-bridge/callback" as an action
		this.twitterService.log("Registering protocol handler for 'bookmark-bridge/callback'", "debug");
		this.registerObsidianProtocolHandler("bookmark-bridge/callback", (params: Record<string, string>) => {
			this.twitterService.log("CALLBACK TRIGGERED: Protocol handler for 'bookmark-bridge/callback' with params: " + JSON.stringify(params), "info");
			this.handleAuthCallback(params);
		});
		
		// Option 2: Register handler for "bookmark-bridge" which might receive the "callback" as a parameter
		this.twitterService.log("Registering protocol handler for 'bookmark-bridge'", "debug");
		this.registerObsidianProtocolHandler("bookmark-bridge", (params: Record<string, string>) => {
			this.twitterService.log("CALLBACK TRIGGERED: Protocol handler for 'bookmark-bridge' with params: " + JSON.stringify(params), "info");
			this.handleAuthCallback(params);
		});
	}
}

class BookmarkBridgeSettingTab extends PluginSettingTab {
	plugin: BookmarkBridgePlugin;

	constructor(app: App, plugin: BookmarkBridgePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		(containerEl as any).innerHTML = ''; // Clear previous content

		// Optional: Add some CSS (can be moved to styles.css)
		containerEl.createEl('style', {
			text: `
				.auth-status-container {
					margin-top: 10px;
					margin-bottom: 20px;
				}
				.oauth2-status {
					margin-top: 8px;
					padding: 8px;
					border-radius: 4px;
				}
				.oauth2-status.connected {
					background-color: var(--background-modifier-success);
				}
				.oauth2-status.disconnected {
					background-color: var(--background-modifier-error);
				}
			`
		});

		containerEl.createEl('h2', { text: 'Bookmark Bridge Settings' });

		// --- X API Documentation Link ---
		new Setting(containerEl)
			.setName('X API Setup Guide')
			.setDesc('Learn how to get your X API credentials for the OAuth 2.0 PKCE flow. This is required to use the plugin.')
			.addButton((button: ButtonComponent) => button
				.setButtonText('View Setup Guide')
				.onClick(() => {
					// Replace with your actual guide URL if you have one
					window.open('https://developer.x.com/en/docs/authentication/oauth-2-0/authorization-code', '_blank'); 
				}));

		// --- X API Credentials & Authentication Status Section ---
		containerEl.createEl('h3', { text: 'X API Configuration (OAuth 2.0)' });
		
		// This div will be populated by renderAuthStatus with appropriate buttons/info
		const authStatusEl = containerEl.createDiv({ cls: 'auth-status-container' });
		this.renderAuthStatus(authStatusEl);

		new Setting(containerEl)
			.setName('Client ID')
			.setDesc('Your X App\'s Client ID (from Twitter Developer Portal -> Project -> App -> Keys & Tokens).')
			.addText((text: TextComponent) => text
				.setPlaceholder('Enter your Client ID')
				.setValue(this.plugin.settings.clientId)
				.onChange(async (value: string) => {
					this.plugin.settings.clientId = value.trim();
					await this.plugin.saveSettings();
					this.display(); // Refresh to update UI based on new Client ID (e.g., auth button state)
				}));

		// Client Secret is generally not used for PKCE public clients token exchange but might be needed for revocation if app is confidential.
		new Setting(containerEl)
			.setName('Client Secret (Optional)')
			.setDesc('Your X App\'s Client Secret. Needed if your app is \'Confidential\' and client authentication is required for token revocation.')
			.addText((text: TextComponent) => text
				.setPlaceholder('Enter your Client Secret if applicable')
				.setValue(this.plugin.settings.clientSecret)
				.onChange(async (value: string) => {
					this.plugin.settings.clientSecret = value.trim();
					await this.plugin.saveSettings();
				}));

		// --- Storage Settings ---
		containerEl.createEl('h3', { text: 'Storage Settings' });

		new Setting(containerEl)
			.setName('Storage Method')
			.setDesc('Choose how to store your Twitter bookmarks')
			.addDropdown((dropdown) => dropdown
				.addOption('separate', 'Separate note for each bookmark')
				.addOption('single', 'Combine all bookmarks into a single note')
				.setValue(this.plugin.settings.storageMethod)
				.onChange(async (value: 'separate' | 'single') => {
					this.plugin.settings.storageMethod = value;
					await this.plugin.saveSettings();
					this.display(); // Refresh to show/hide the single filename field
				}));

		new Setting(containerEl)
			.setName('Target Folder')
			.setDesc('Folder where your Twitter bookmarks will be saved')
			.addText((text) => text
				.setPlaceholder('e.g., Twitter/Bookmarks')
				.setValue(this.plugin.settings.targetFolder)
				.onChange(async (value: string) => {
					this.plugin.settings.targetFolder = value.trim();
					await this.plugin.saveSettings();
				}));

		if (this.plugin.settings.storageMethod === 'single') {
			new Setting(containerEl)
				.setName('File Name for Single Note')
				.setDesc('Name of the .md file if using single note storage.')
				.addText((text) => text
					.setPlaceholder('e.g., twitter-bookmarks.md')
					.setValue(this.plugin.settings.singleFileName)
					.onChange(async (value: string) => {
						let fileName = value.trim();
						if (!fileName.endsWith('.md')) {
							fileName += '.md';
						}
						this.plugin.settings.singleFileName = fileName;
						await this.plugin.saveSettings();
					}));
		}

		// --- Template Settings ---
		containerEl.createEl('h3', { text: 'Template Settings' });
		// ... (template settings remain the same, ensure they are below this point)
		new Setting(containerEl)
			.setName('Use Custom Templates')
			.setDesc('Enable custom templates for formatting bookmarks')
			.addToggle((toggle: ToggleComponent) => {
				toggle.setValue(this.plugin.settings.useCustomTemplate);
				toggle.onChange(async (value: boolean) => {
					this.plugin.settings.useCustomTemplate = value;
					await this.plugin.saveSettings();
					this.display(); // Refresh UI to show/hide template fields
				});
				return toggle;
			});
		
		if (this.plugin.settings.useCustomTemplate) {
			new Setting(containerEl)
				.setName('Template Variables Documentation')
				.setDesc('View the list of available template variables.') // Simplified description
				.addButton((button: ButtonComponent) => button
					.setButtonText('View Documentation')
					.onClick(() => {
						// Link to your plugin's documentation for template variables
						window.open('https://github.com/your-repo/bookmark-bridge/wiki/Template-Variables', '_blank');
					}));
			
			new Setting(containerEl)
				.setName('Bookmark Note Template')
				.setDesc('Define the template for how bookmarks are formatted as notes.')
				.addTextArea((textArea: TextAreaComponent) => {
					textArea.setValue(this.plugin.settings.template);
					textArea.inputEl.rows = 10;
					textArea.inputEl.cols = 60; // Ensure this doesn't break layout, adjust if needed
					textArea.onChange(async (value: string) => {
						this.plugin.settings.template = value;
						await this.plugin.saveSettings();
					});
					return textArea;
				});
			
			new Setting(containerEl)
				.setName('Reset Template')
				.setDesc('Reset template to the default value.')
				.addButton((button) => {
					button.setButtonText('Reset to Default');
					button.onClick(async () => {
						this.plugin.settings.template = DEFAULT_SETTINGS.template;
						await this.plugin.saveSettings();
						this.display(); // Refresh UI
						new Notice('Template reset to default');
					});
					return button;
				});
		}

		// --- Sync Settings ---
		containerEl.createEl('h3', { text: 'Sync Settings' });
		
		new Setting(containerEl)
			.setName('Automatic Syncing')
			.setDesc('Automatically sync bookmarks periodically in the background.')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.autoSync);
				toggle.onChange(async (value) => {
					this.plugin.settings.autoSync = value;
					await this.plugin.saveSettings();
					
					if (value) {
						this.plugin.startAutoSync();
						new Notice('Automatic syncing enabled and started.');
					} else {
						if (this.plugin.syncTimer) {
							clearTimeout(this.plugin.syncTimer);
							this.plugin.syncTimer = null;
						}
						new Notice('Automatic syncing disabled.');
					}
				});
			});
		
		new Setting(containerEl)
			.setName('Manual Sync')
			.setDesc('Manually trigger a sync of your X bookmarks to Obsidian.')
			.addButton((button) => button
				.setButtonText('Sync Now')
				.onClick(async () => {
					await this.plugin.syncBookmarks();
				}));

		containerEl.createEl('div', { text: `Last sync: ${this.formatLastSync()}`, cls: 'bookmark-bridge-last-sync setting-item-description' });
		containerEl.createEl('div', { text: `Sync status: ${this.formatSyncStatus()}`, cls: 'bookmark-bridge-sync-status setting-item-description' });
		
		containerEl.createEl('div', {
			text: 'Note: X API limits bookmarks requests to 1 per 15 minutes for free Developer accounts. Pagination is handled automatically over multiple sync sessions if needed.',
			cls: 'setting-item-description'
		});

		// --- Debug Settings ---
		containerEl.createEl('h3', { text: 'Debug Settings' });
		containerEl.createEl('div', { 
			text: '⚠️ WARNING: These settings are for debugging only and may cause unexpected behavior or API errors.',
			cls: 'setting-item-description bookmark-bridge-warning'
		});

		new Setting(containerEl)
			.setName('Bypass Rate Limit Checks')
			.setDesc('DEBUG ONLY: Disable the built-in rate limit check. May result in API errors (429) if you exceed X API limits.')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.bypassRateLimit);
				toggle.onChange(async (value) => {
					this.plugin.settings.bypassRateLimit = value;
					await this.plugin.saveSettings();
					
					if (value) {
						new Notice('⚠️ Rate limit checks bypassed. Use with caution!', 5000);
						this.plugin.twitterService.log('DEBUG: Rate limit bypass has been ENABLED', 'info');
					} else {
						new Notice('Rate limit checks enabled', 3000);
						this.plugin.twitterService.log('DEBUG: Rate limit bypass has been DISABLED', 'info');
					}
				});
			});

		// Add some visible styling to the debug section
		containerEl.createEl('style', {
			text: `
				.bookmark-bridge-warning {
					color: var(--text-error);
					margin-bottom: 12px;
					font-weight: bold;
				}
			`
		});

		// --- API Status Notice ---
		containerEl.createEl('h3', { text: 'API Status Notice' });
		const apiStatusEl = containerEl.createEl('div', {
			cls: 'bookmark-bridge-api-status-notice'
		});

		// Add API status notice and styling
		apiStatusEl.createEl('p', {
			text: '⚠️ IMPORTANT: We have reached our monthly Twitter API request limit on the Free Tier.',
			cls: 'bookmark-bridge-api-warning'
		});

		apiStatusEl.createEl('p', {
			text: 'New users may experience 429 errors when trying to sync bookmarks. We need community support to upgrade to the paid API tier.'
		});

		apiStatusEl.createEl('p', {
			text: 'Please see our README for information on how you can help us improve the plugin for everyone.'
		});

		// Styling for the API Status notice
		containerEl.createEl('style', {
			text: `
				.bookmark-bridge-api-status-notice {
					padding: 12px;
					background-color: var(--background-modifier-error-hover);
					border-left: 4px solid var(--text-error);
					margin-bottom: 20px;
					border-radius: 4px;
				}
				.bookmark-bridge-api-warning {
					font-weight: bold;
					margin-bottom: 8px;
				}
			`
		});
	}

	private renderAuthStatus(containerEl: HTMLElement) {
		(containerEl as any).innerHTML = ''; // Clear previous content

		// Display current connection status
		const isConnected = this.plugin.twitterService.hasOAuth2Credentials();
		const statusText = isConnected 
			? '✓ Connected to X API' 
			: '✗ Not connected to X API. Please provide your Client ID and click Authenticate.';
		const statusClass = isConnected 
			? 'oauth2-status connected' 
			: 'oauth2-status disconnected';
		containerEl.createEl('div', { text: statusText, cls: statusClass });

		if (isConnected) {
			// User is authenticated - show Re-authenticate and Log Out options
			new Setting(containerEl)
				.setName('Account Actions')
				.setDesc('Manage your X API connection.')
				.addButton(button => button
					.setButtonText('Re-authenticate')
					.setTooltip('If you encounter issues, try authenticating with Twitter again.')
					.onClick(async () => {
						if (!this.plugin.settings.clientId) {
							new Notice('Client ID is missing. Please enter it above.');
							return;
						}
						await this.plugin.initiateTwitterAuth();
					}))
				.addButton(button => button
					.setButtonText('Log Out / Revoke Token')
					.setWarning()
					.setTooltip('Disconnect the plugin from your Twitter account and revoke its access.')
					.onClick(async () => {
						new Notice('Attempting to log out from Twitter...');
						const success = await this.plugin.twitterService.revokeToken();
						if (success) {
							new Notice('Logged out from Twitter and local tokens cleared.');
						} else {
							// Even if revoke fails (e.g. token already invalid), settings are cleared locally in revokeToken.
							new Notice('Logout attempt finished. Local tokens cleared.');
						}
						this.display(); // Refresh the settings tab to show updated status
					}));
		} else {
			// User is not authenticated - show Authenticate button
			new Setting(containerEl)
				.setName('Connect to Twitter')
				.setDesc('Authorize the plugin to access your Twitter bookmarks. Ensure your Client ID is entered above.')
				.addButton(button => button
					.setButtonText('Authenticate with Twitter')
					.setCta() // Call to action style
					.setDisabled(!this.plugin.settings.clientId) // Disable if no Client ID
					.onClick(async () => {
						if (!this.plugin.settings.clientId) {
							new Notice('Please enter your Client ID in the setting above before authenticating.');
							return;
						}
						await this.plugin.initiateTwitterAuth();
					}));
		}

		// Test Connection Button - always show but disable if not authenticated
		new Setting(containerEl)
		.setName('Test API Connection')
		.setDesc('Verify if the plugin can communicate with the Twitter API using current credentials.')
		.addButton(button => button
			.setButtonText('Test Connection')
			.setDisabled(!isConnected) 
			.onClick(async () => {
				if (!isConnected) {
					new Notice('Not authenticated. Please authenticate with Twitter first.');
					return;
				}
				new Notice('Testing Twitter connection...');
				const success = await this.plugin.twitterService.testConnection();
				if (success) {
					new Notice('Twitter connection successful!');
				} else {
					new Notice('Twitter connection failed. Please check your credentials or try re-authenticating.');
				}
			}));
	}

	formatLastSync(): string {
		const timestamp = this.plugin.settings.lastSyncTimestamp;
		if (!timestamp) {
			return 'Never';
		}
		return new Date(timestamp).toLocaleString();
	}

	formatSyncStatus(): string {
		if (this.plugin.settings.syncInProgress) {
			return `Sync in progress`;
		} else if (!this.plugin.settings.initialSyncComplete && this.plugin.settings.lastSyncPage > 0) {
			return `Initial sync in progress: Page ${this.plugin.settings.lastSyncPage} completed`;
		} else if (this.plugin.settings.initialSyncComplete) {
			return `Initial sync complete - syncing new bookmarks only`;
		} else {
			return `Initial sync not started`;
		}
	}
} 