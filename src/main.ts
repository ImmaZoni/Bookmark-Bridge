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
	syncInProgress: false
};

export default class BookmarkBridgePlugin extends Plugin {
	settings: BookmarkBridgeSettings;
	twitterService: TwitterService;
	bookmarkProcessor: BookmarkProcessor;
	bookmarkStorage: BookmarkStorage;
	syncTimer: NodeJS.Timeout | null = null;

	async onload() {
		await this.loadSettings();

		// Set up log file path if not already set
		if (!this.settings.logFile) {
			// Get vault path for log file
			const basePath = (this.app.vault.adapter as any).basePath || '';
			this.settings.logFile = `${basePath}/.obsidian/plugins/bookmark-bridge/bookmark-bridge-log.txt`;
			console.log(`[Bookmark Bridge] Setting log file path to: ${this.settings.logFile}`);
			await this.saveSettings();
		}

		// Initialize services
		this.twitterService = new TwitterService(this.settings);
		this.bookmarkStorage = new BookmarkStorage(this.app);
		this.bookmarkProcessor = new BookmarkProcessor(this.app, this.settings, this.bookmarkStorage);

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

		// Add settings tab
		this.addSettingTab(new BookmarkBridgeSettingTab(this.app, this));
		
		console.log(`[Bookmark Bridge] Plugin loaded. Storage method: ${this.settings.storageMethod}, Single file: ${this.settings.singleFileName}`);
		
		// Start automatic sync if enabled
		if (this.settings.autoSync) {
			this.startAutoSync();
		}
	}

	startAutoSync() {
		console.log('[Bookmark Bridge] Starting automatic sync system');
		
		// Check if we're already syncing
		if (this.settings.syncInProgress) {
			console.log('[Bookmark Bridge] Sync already in progress, not starting a new one');
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
	
	async checkAndScheduleSync() {
		// Don't proceed if no valid credentials
		if (!this.validateSettings(false)) {
			console.log('[Bookmark Bridge] Cannot start auto-sync: missing required settings');
			return;
		}
		
		// Calculate time since last sync attempt
		const now = Date.now();
		const timeElapsed = now - this.settings.lastSyncTime;
		const RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes in milliseconds
		
		// Check if we need to start an initial sync or continue pagination
		if (!this.settings.initialSyncComplete) {
			// We need to continue with pagination or start the initial sync
			
			if (this.settings.lastSyncTime === 0 || timeElapsed >= RATE_LIMIT_WINDOW) {
				// We can sync now - either first sync ever or rate limit window passed
				console.log(`[Bookmark Bridge] Auto-starting sync ${this.settings.lastSyncPage > 0 ? 'continuation' : 'initial'}`);
				this.syncBookmarks(true);
			} else {
				// We need to wait for the rate limit window
				const timeToWait = RATE_LIMIT_WINDOW - timeElapsed;
				console.log(`[Bookmark Bridge] Rate limit not reset yet, scheduling next auto-sync in ${Math.ceil(timeToWait/1000)} seconds`);
				
				// Schedule the next sync
				this.syncTimer = setTimeout(() => {
					console.log('[Bookmark Bridge] Auto-sync timer triggered');
					this.syncBookmarks(true);
				}, timeToWait);
			}
		} else if (this.settings.autoSync) {
			// Initial sync complete, but we'll check again in 1 hour for new bookmarks
			const CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour in milliseconds
			console.log(`[Bookmark Bridge] Initial sync complete, scheduling routine check in 1 hour`);
			
			this.syncTimer = setTimeout(() => {
				console.log('[Bookmark Bridge] Routine sync check triggered');
				this.syncBookmarks(true);
			}, CHECK_INTERVAL);
		}
	}

	async syncBookmarks(isAutoSync: boolean = false) {
		if (!this.validateSettings(!isAutoSync)) {
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
			
			console.log(`[Bookmark Bridge] Starting bookmark sync. Storage method: ${this.settings.storageMethod}, Auto: ${isAutoSync}`);
			if (this.settings.storageMethod === 'single') {
				console.log(`[Bookmark Bridge] Using single file mode with file: ${this.settings.singleFileName}`);
			}
			
			// Get bookmarks from Twitter API
			const bookmarks = await this.twitterService.fetchBookmarks(this.settings.lastSyncTimestamp);
			
			if (bookmarks.length === 0) {
				console.log(`[Bookmark Bridge] No new bookmarks found`);
				if (notice) {
					notice.setMessage('No new bookmarks found.');
					setTimeout(() => notice?.hide(), 3000);
				}
				
				// If this was an auto-sync, schedule the next check
				if (isAutoSync) {
					this.settings.syncInProgress = false;
					await this.saveSettings();
					this.checkAndScheduleSync();
				}
				return;
			}

			console.log(`[Bookmark Bridge] Retrieved ${bookmarks.length} bookmarks, processing...`);
			
			// Process and save bookmarks
			try {
				await this.bookmarkProcessor.processBookmarks(bookmarks);
				console.log(`[Bookmark Bridge] Successfully processed ${bookmarks.length} bookmarks`);
			} catch (processingError) {
				console.error(`[Bookmark Bridge] Error processing bookmarks:`, processingError);
				throw new Error(`Error processing bookmarks: ${(processingError as Error).message}`);
			}

			// Only update the lastSyncTimestamp if we've completed the initial sync
			if (this.settings.initialSyncComplete) {
				this.settings.lastSyncTimestamp = Date.now();
				console.log(`[Bookmark Bridge] Updated last sync timestamp to ${new Date(this.settings.lastSyncTimestamp).toISOString()}`);
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
			
			// If this was an auto-sync, schedule the next check
			if (isAutoSync) {
				this.checkAndScheduleSync();
			}
		} catch (error) {
			console.error(`[Bookmark Bridge] Error syncing bookmarks:`, error);
			this.settings.syncInProgress = false;
			await this.saveSettings();
			
			if (!isAutoSync) {
				new Notice(`Error syncing bookmarks: ${(error as Error).message}`, 5000);
			}
			
			// Schedule next auto-sync attempt even if there was an error
			if (isAutoSync) {
				const RETRY_DELAY = 5 * 60 * 1000; // 5 minutes retry for errors
				this.syncTimer = setTimeout(() => {
					console.log('[Bookmark Bridge] Retrying auto-sync after error');
					this.syncBookmarks(true);
				}, RETRY_DELAY);
			}
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
}

class BookmarkBridgeSettingTab extends PluginSettingTab {
	plugin: BookmarkBridgePlugin;

	constructor(app: App, plugin: BookmarkBridgePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// Add some CSS for the authorization elements
		containerEl.createEl('style', {
			text: `
				.auth-example {
					font-family: monospace;
					background-color: var(--background-secondary);
					padding: 8px;
					border-radius: 4px;
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
				.auth-code-input {
					width: 100%;
					font-family: monospace;
				}
				.auth-help-text {
					margin-top: 8px;
					font-size: 0.8rem;
					color: var(--text-muted);
				}
				.auth-help-text.success {
					color: var(--text-success);
				}
				.error-text {
					color: var(--text-error);
				}
				.auth-code-container {
					margin-top: 16px;
					display: none;
				}
				.auth-code-container.visible {
					display: block;
				}
				.bookmark-bridge-storage-method {
					margin-top: 16px;
				}
				.bookmark-bridge-sync-button {
					margin-top: 16px;
				}
			`
		});

		containerEl.createEl('h2', { text: 'Bookmark Bridge Settings' });

		new Setting(containerEl)
			.setName('X API Documentation')
			.setDesc('Learn how to get your X API credentials')
			.addButton((button: ButtonComponent) => button
				.setButtonText('View Guide')
				.onClick(() => {
					window.open('https://github.com/yourrepo/bookmark-bridge/wiki/Twitter-API-Setup-Guide', '_blank');
				}));

		containerEl.createEl('h3', { text: 'X API Credentials' });
		
		// Connection Status Banner - Moved right below the X API Credentials header
		const statusDiv = containerEl.createDiv();
		const statusText = this.plugin.twitterService.hasOAuth2Credentials() ? 
			'✓ Connected to X API' : '✗ Not connected to X API';
		const statusClass = this.plugin.twitterService.hasOAuth2Credentials() ? 
			'oauth2-status connected' : 'oauth2-status disconnected';
		
		const authStatus = document.createElement('div');
		authStatus.className = statusClass;
		authStatus.textContent = statusText;
		statusDiv.appendChild(authStatus);
		
		// OAuth 2.0 credentials
		new Setting(containerEl)
			.setName('Client ID')
			.setDesc('Your X API Client ID from the Developer Portal')
			.addText((text: TextComponent) => text
				.setPlaceholder('Enter your Client ID')
				.setValue(this.plugin.settings.clientId)
				.onChange(async (value: string) => {
					this.plugin.settings.clientId = value;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Client Secret (Optional)')
			.setDesc('Your X API Client Secret from the Developer Portal. Required for confidential clients.')
			.addText((text: TextComponent) => text
				.setPlaceholder('Enter your Client Secret')
				.setValue(this.plugin.settings.clientSecret)
				.onChange(async (value: string) => {
					this.plugin.settings.clientSecret = value;
					await this.plugin.saveSettings();
				}));
		
		if (this.plugin.twitterService.hasOAuth2Credentials()) {
								// Test Connection and Sync buttons
			new Setting(containerEl)
			.setName('Test API Connection')
			.setDesc('Verify your X API credentials')
			.addButton((button) => button
				.setButtonText('Test Connection')
				.onClick(async () => {
					try {
						const isValid = await this.plugin.twitterService.testConnection();
						if (isValid) {
							new Notice('Connection successful! Your API credentials work.');
						} else {
							new Notice('Connection failed. Please check your API credentials.');
						}
					} catch (error) {
						console.error('Connection test error:', error);
						new Notice(`Connection test failed: ${(error as Error).message}`);
					}
				}));


			new Setting(containerEl)
				.setName('Revoke Access')
				.setDesc('Disconnect from X API')
				.addButton((button: ButtonComponent) => button
					.setButtonText('Disconnect')
					.onClick(async () => {
						try {
							await this.plugin.twitterService.revokeToken();
							await this.plugin.saveSettings();
							new Notice('Successfully disconnected from X API');
							this.display(); // Refresh to update status
						} catch (error) {
							console.error('Error revoking token:', error);
							new Notice(`Error disconnecting: ${(error as Error).message}`);
						}
					}));
		} else {
			// Authorization Step 1: Generate URL and open browser
			new Setting(containerEl)
				.setName('Step 1: Start Authorization')
				.setDesc('Connect to X API to access your bookmarks')
				.addButton(button => button
					.setButtonText('Generate Authorization URL')
					.onClick(async () => {
						try {
							if (!this.plugin.settings.clientId) {
								new Notice('Please enter your Client ID first');
								return;
							}
							
							// Generate auth URL
							const authInfo = await this.plugin.twitterService.generateAuthUrl();
							
							// Save settings to persist code verifier
							await this.plugin.saveSettings();
							
							// Open browser window with auth URL
							window.open(authInfo.url, '_blank');
							
							new Notice('Authorization page opened. After authorizing, copy the code from the URL and paste it below.');
						} catch (error) {
							console.error('Error generating auth URL:', error);
							new Notice(`Error: ${(error as Error).message}`);
						}
					}));
			
			// Show example URL
			containerEl.createEl('div', {
				text: 'Example URL: http://127.0.0.1/callback?code=ABCDEF...',
				cls: 'auth-example'
			});
			
			// Authorization Step 2: Enter the code
			let authCode = '';
			new Setting(containerEl)
				.setName('Step 2: Enter Authorization Code')
				.setDesc('After authorizing, paste the URL or code from your browser')
				.addText(text => text
					.setPlaceholder('Paste URL or code here')
					.onChange(value => {
						// If this looks like a URL, try to extract the code
						if (value.includes('http') && value.includes('callback')) {
							const extractedCode = this.plugin.twitterService.extractAuthorizationCode(value);
							if (extractedCode) {
								// Update the text field with just the extracted code
								text.setValue(extractedCode);
								authCode = extractedCode;
								new Notice('Code extracted successfully!');
								return;
							}
						}
						authCode = value;
					}));
			
			// Authorization Step 3: Submit code
			new Setting(containerEl)
				.setName('Step 3: Complete Authorization')
				.setDesc('Submit the authorization code to finish connecting')
				.addButton(button => button
					.setButtonText('Submit Code')
					.onClick(async () => {
						if (!authCode) {
							new Notice('Please enter the authorization code first');
							return;
						}
						
						try {
							await this.plugin.twitterService.exchangeAuthCodeForToken(authCode);
							await this.plugin.saveSettings();
							new Notice('Successfully connected to X API!');
							
							// Start auto-sync if enabled
							if (this.plugin.settings.autoSync) {
								this.plugin.startAutoSync();
							}
							
							this.display(); // Refresh to update status
						} catch (error) {
							console.error('Error exchanging auth code:', error);
							new Notice(`Authorization failed: ${(error as Error).message}`);
						}
					}));
		}

		containerEl.createEl('h3', { text: 'Storage Settings' });

		// Storage Method - Single radio choice instead of separate settings
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
					this.plugin.settings.targetFolder = value;
					await this.plugin.saveSettings();
				}));

		// Show single file name input if 'single' storage method is selected
		if (this.plugin.settings.storageMethod === 'single') {
			new Setting(containerEl)
				.setName('File Name')
				.setDesc('Name of the file for combined bookmarks')
				.addText((text) => text
					.setPlaceholder('e.g., twitter-bookmarks.md')
					.setValue(this.plugin.settings.singleFileName)
					.onChange(async (value: string) => {
						// Ensure the filename ends with .md
						if (!value.endsWith('.md')) {
							value += '.md';
						}
						this.plugin.settings.singleFileName = value;
						await this.plugin.saveSettings();
					}));
		}

		// Custom Templates section
		containerEl.createEl('h3', { text: 'Template Settings' });
		
		// Use custom templates toggle
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
		
		// Only show template settings if custom templates are enabled
		if (this.plugin.settings.useCustomTemplate) {
			// Template Help - Documentation link instead of listing variables
			new Setting(containerEl)
				.setName('Template Variables Documentation')
				.setDesc('View the complete list of available template variables and API parameters')
				.addButton((button: ButtonComponent) => button
					.setButtonText('View Documentation')
					.onClick(() => {
						// This will open the docs in the default app
						// For published plugins, use an absolute URL to the GitHub documentation
						const basePath = (this.plugin.app.vault.adapter as any).basePath || '';
						const docPath = `${basePath}/docs/x-api-parameters.md`;
						
						// Try to use the system's default program to open the markdown file
						try {
							require('electron').shell.openPath(docPath);
						} catch (e) {
							// Fallback for web version or if electron fails
							new Notice('Documentation file available at: docs/x-api-parameters.md');
							console.log('Documentation path:', docPath);
						}
					}));
			
			// Template
			new Setting(containerEl)
				.setName('Template')
				.setDesc('Template for all bookmark formats')
				.addTextArea((textArea: TextAreaComponent) => {
					textArea.setValue(this.plugin.settings.template);
					textArea.inputEl.rows = 10;
					textArea.inputEl.cols = 60;
					textArea.onChange(async (value: string) => {
						this.plugin.settings.template = value;
						await this.plugin.saveSettings();
					});
					return textArea;
				});
			
			// Reset to defaults button
			new Setting(containerEl)
				.setName('Reset Template')
				.setDesc('Reset template to default value')
				.addButton((button) => {
					button.setButtonText('Reset to Defaults');
					button.onClick(async () => {
						this.plugin.settings.template = DEFAULT_SETTINGS.template;
						await this.plugin.saveSettings();
						this.display(); // Refresh UI
						new Notice('Template reset to defaults');
					});
					return button;
				});
		}

		// Automatic sync options
		containerEl.createEl('h3', { text: 'Sync Settings' });
		
		// Auto sync toggle
		new Setting(containerEl)
			.setName('Automatic Syncing')
			.setDesc('Automatically sync bookmarks without manual intervention')
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.autoSync);
				toggle.onChange(async (value) => {
					this.plugin.settings.autoSync = value;
					await this.plugin.saveSettings();
					
					if (value) {
						// Start the auto sync if it was just enabled
						this.plugin.startAutoSync();
						new Notice('Automatic syncing enabled and started');
					} else {
						// Clear the timer if auto sync was disabled
						if (this.plugin.syncTimer) {
							clearTimeout(this.plugin.syncTimer);
							this.plugin.syncTimer = null;
						}
						new Notice('Automatic syncing disabled');
					}
				});
			});
		
		// Sync button
		new Setting(containerEl)
			.setName('Manual Sync')
			.setDesc('Manually sync your X bookmarks to Obsidian')
			.addButton((button) => button
				.setButtonText('Sync Now')
				.onClick(async () => {
					await this.plugin.syncBookmarks();
				}));

		containerEl.createEl('div', { text: `Last sync: ${this.formatLastSync()}`, cls: 'bookmark-bridge-last-sync' });
		
		// Add sync status info
		containerEl.createEl('div', { text: `Sync status: ${this.formatSyncStatus()}`, cls: 'bookmark-bridge-sync-status' });
		
		// Rate limit note moved to the bottom
		containerEl.createEl('div', {
			text: 'Note: X API limits bookmarks requests to 1 per 15 minutes for free Developer accounts. Pagination is handled automatically over multiple sync sessions.',
			cls: 'setting-item-description'
		});
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