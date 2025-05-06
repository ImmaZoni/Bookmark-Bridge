import { App, normalizePath, TFile, Vault } from 'obsidian';
import { TwitterBookmark } from '../services/twitter-service';
import { BookmarkStorage } from './bookmark-storage';

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

export class BookmarkProcessor {
    private app: App;
    private settings: BookmarkBridgeSettings;
    private bookmarkStorage: BookmarkStorage;

    constructor(app: App, settings: BookmarkBridgeSettings, bookmarkStorage: BookmarkStorage) {
        this.app = app;
        this.settings = settings;
        this.bookmarkStorage = bookmarkStorage;
    }

    public async processBookmarks(bookmarks: TwitterBookmark[]): Promise<void> {
        if (!bookmarks || bookmarks.length === 0) {
            return;
        }

        // Make sure the target folder exists
        await this.ensureTargetFolderExists();

        if (this.settings.storageMethod === 'single') {
            // Process all bookmarks into a single file
            await this.processSingleFileBookmarks(bookmarks);
        } else {
            // Process each bookmark into its own file
            await this.processSeparateFileBookmarks(bookmarks);
        }
    }

    /**
     * Process bookmarks into individual files (original method)
     */
    private async processSeparateFileBookmarks(bookmarks: TwitterBookmark[]): Promise<void> {
        for (const bookmark of bookmarks) {
            // Skip if already processed
            if (await this.bookmarkStorage.isBookmarkProcessed(bookmark.id)) {
                continue;
            }

            // Generate the file content
            const fileContent = this.generateMarkdownContent(bookmark);
            
            // Save to file
            const fileName = this.generateFileName(bookmark);
            await this.saveToFile(fileName, fileContent);
            
            // Mark as processed
            await this.bookmarkStorage.markBookmarkAsProcessed(bookmark.id);
        }
    }

    /**
     * Process bookmarks into a single file
     */
    private async processSingleFileBookmarks(bookmarks: TwitterBookmark[]): Promise<void> {
        try {
            // Normalize file name and make sure it has .md extension
            const fileName = this.settings.singleFileName || 'twitter-bookmarks.md';
            const normalizedFileName = fileName.endsWith('.md') ? fileName : `${fileName}.md`;
            
            // Make sure the target folder exists
            await this.ensureTargetFolderExists();
            
            // Build the full path using Obsidian's path normalization to handle OS differences
            const folderPath = normalizePath(this.settings.targetFolder);
            const filePath = normalizePath(`${folderPath}/${normalizedFileName}`);
            
            console.log(`[Bookmark Bridge] Processing bookmarks into single file: ${filePath}`);
            
            // Get existing content if file exists
            let existingContent = '';
            const fileExists = await this.fileExists(filePath);
            
            if (fileExists) {
                console.log(`[Bookmark Bridge] Single file exists, reading existing content`);
                existingContent = await this.readFile(filePath);
                console.log(`[Bookmark Bridge] Read ${existingContent.length} characters from existing file`);
            } else {
                console.log(`[Bookmark Bridge] Single file does not exist, creating new file with header`);
                // Create a header for the file if it's new
                existingContent = `# Twitter Bookmarks\n\nA collection of your bookmarked tweets from Twitter/X.\n\n`;
            }
            
            // Process each new bookmark
            let newBookmarksAdded = false;
            let processedCount = 0;
            
            console.log(`[Bookmark Bridge] Processing ${bookmarks.length} bookmarks for single file storage`);
            
            for (const bookmark of bookmarks) {
                try {
                    // Skip if already processed
                    if (await this.bookmarkStorage.isBookmarkProcessed(bookmark.id)) {
                        console.log(`[Bookmark Bridge] Skipping already processed bookmark: ${bookmark.id}`);
                        continue;
                    }
                    
                    // Generate the markdown for this bookmark
                    console.log(`[Bookmark Bridge] Generating content for bookmark: ${bookmark.id}`);
                    const bookmarkContent = this.generateSingleFileBookmarkContent(bookmark);
                    
                    // Add to existing content with a separator
                    existingContent = `${existingContent}\n---\n\n${bookmarkContent}`;
                    
                    // Mark as processed
                    await this.bookmarkStorage.markBookmarkAsProcessed(bookmark.id);
                    newBookmarksAdded = true;
                    processedCount++;
                } catch (bookmarkError) {
                    console.error(`[Bookmark Bridge] Error processing bookmark ${bookmark.id}:`, bookmarkError);
                }
            }
            
            // Only save if we added new bookmarks
            if (newBookmarksAdded) {
                console.log(`[Bookmark Bridge] Saving ${processedCount} new bookmarks to single file`);
                try {
                    const savedFile = await this.saveToFile(filePath, existingContent);
                    console.log(`[Bookmark Bridge] Successfully saved to file: ${savedFile.path}`);
                } catch (saveError) {
                    console.error(`[Bookmark Bridge] Error saving single file:`, saveError);
                    throw saveError;
                }
            } else {
                console.log(`[Bookmark Bridge] No new bookmarks to add to single file`);
            }
        } catch (error) {
            console.error(`[Bookmark Bridge] Error in processSingleFileBookmarks:`, error);
            throw error;
        }
    }

    /**
     * Generate markdown content for a bookmark in the single file format
     */
    private generateSingleFileBookmarkContent(bookmark: TwitterBookmark): string {
        if (this.settings.useCustomTemplate) {
            return this.renderTemplate(this.settings.template, bookmark);
        }
        
        // Default template if custom templates are not enabled
        const date = bookmark.createdAt.toLocaleDateString();
        const time = bookmark.createdAt.toLocaleTimeString();
        
        let content = `## Tweet by @${bookmark.authorUsername} - ${date} ${time}\n\n`;
        content += `${bookmark.text}\n\n`;
        
        if (bookmark.mediaUrls.length > 0) {
            content += `### Media\n\n`;
            for (const mediaUrl of bookmark.mediaUrls) {
                content += `![](${mediaUrl})\n\n`;
            }
        }
        
        content += `[View on Twitter](${bookmark.tweetUrl})`;
        
        return content;
    }

    /**
     * Render a template with bookmark data
     */
    private renderTemplate(template: string, bookmark: TwitterBookmark): string {
        // Get date and time for formatting
        const date = bookmark.createdAt.toLocaleDateString();
        const time = bookmark.createdAt.toLocaleTimeString();
        
        // Basic replacements
        let content = template
            .replace(/{{id}}/g, bookmark.id)
            .replace(/{{text}}/g, bookmark.text)
            .replace(/{{authorUsername}}/g, bookmark.authorUsername)
            .replace(/{{authorName}}/g, bookmark.authorName)
            .replace(/{{authorId}}/g, bookmark.authorId)
            .replace(/{{date}}/g, date)
            .replace(/{{time}}/g, time)
            .replace(/{{tweetUrl}}/g, bookmark.tweetUrl);
        
        // Handle conditional block for media
        const hasMedia = bookmark.mediaUrls.length > 0;
        
        // Handle {{#hasMedia}}...{{/hasMedia}} blocks
        content = this.processConditionalBlock(content, 'hasMedia', hasMedia);
        
        // Handle media URL list {{#mediaUrls}}{{.}}{{/mediaUrls}}
        content = this.processArrayBlock(content, 'mediaUrls', bookmark.mediaUrls);
        
        return content;
    }
    
    /**
     * Process conditional blocks in templates
     */
    private processConditionalBlock(content: string, blockName: string, condition: boolean): string {
        const blockRegex = new RegExp(`{{#${blockName}}}([\\s\\S]*?){{/${blockName}}}`, 'g');
        
        if (condition) {
            // If condition is true, keep the content but remove the tags
            return content.replace(blockRegex, (match, blockContent) => blockContent);
        } else {
            // If condition is false, remove the entire block
            return content.replace(blockRegex, '');
        }
    }
    
    /**
     * Process array blocks in templates
     */
    private processArrayBlock(content: string, blockName: string, array: string[]): string {
        const blockRegex = new RegExp(`{{#${blockName}}}([\\s\\S]*?){{/${blockName}}}`, 'g');
        
        return content.replace(blockRegex, (match, blockContent) => {
            if (array.length === 0) return '';
            
            // Replace {{.}} with each item in the array
            return array.map(item => blockContent.replace(/{{\.}}/g, item)).join('');
        });
    }

    private async ensureTargetFolderExists(): Promise<void> {
        const folderPath = normalizePath(this.settings.targetFolder);
        
        // Check if folder exists
        if (!(await this.app.vault.adapter.exists(folderPath))) {
            // Create folder including any necessary parent folders
            await this.app.vault.createFolder(folderPath);
        }
    }

    private generateMarkdownContent(bookmark: TwitterBookmark): string {
        if (this.settings.useCustomTemplate) {
            return this.renderTemplate(this.settings.template, bookmark);
        }
        
        // Default template if custom templates are not enabled
        const date = bookmark.createdAt.toLocaleDateString();
        const time = bookmark.createdAt.toLocaleTimeString();
        
        let content = `---
tweet_id: "${bookmark.id}"
author: "@${bookmark.authorUsername} (${bookmark.authorName})"
date: "${date} ${time}"
---

# Tweet by @${bookmark.authorUsername}

${bookmark.text}

`;

        if (bookmark.mediaUrls.length > 0) {
            content += `## Media\n\n`;
            for (const mediaUrl of bookmark.mediaUrls) {
                content += `![](${mediaUrl})\n\n`;
            }
        }
        
        content += `[View on Twitter](${bookmark.tweetUrl})`;
        
        return content;
    }

    private generateFileName(bookmark: TwitterBookmark): string {
        // Create a filename based on ID to prevent duplication issues
        // Format: Tweet-{id}-{truncated-text}.md
        const sanitizedText = bookmark.text
            .replace(/[^\w\s]/gi, '') // Remove special characters
            .trim()
            .replace(/\s+/g, '-') // Replace spaces with hyphens
            .substring(0, 30); // Limit length
        
        return `${this.settings.targetFolder}/Tweet-${bookmark.id}-${sanitizedText}.md`;
    }

    /**
     * Save content to a file, ensuring the file path is properly normalized
     */
    private async saveToFile(filePath: string, content: string): Promise<TFile> {
        try {
            const normalizedPath = normalizePath(filePath);
            console.log(`[Bookmark Bridge] Saving to file: ${normalizedPath}`);
            
            // Check if file exists
            if (await this.app.vault.adapter.exists(normalizedPath)) {
                console.log(`[Bookmark Bridge] File exists, updating content`);
                // Update existing file
                const file = this.app.vault.getAbstractFileByPath(normalizedPath) as TFile;
                if (!file) {
                    console.error(`[Bookmark Bridge] File exists but couldn't be retrieved as TFile: ${normalizedPath}`);
                    throw new Error(`File exists but couldn't be retrieved: ${normalizedPath}`);
                }
                await this.app.vault.modify(file, content);
                return file;
            } else {
                console.log(`[Bookmark Bridge] File doesn't exist, creating new file`);
                // Create new file
                // Ensure parent folders exist
                const lastSlashIndex = normalizedPath.lastIndexOf('/');
                if (lastSlashIndex > 0) {
                    const dirPath = normalizedPath.substring(0, lastSlashIndex);
                    await this.ensureFolderExists(dirPath);
                }
                
                return await this.app.vault.create(normalizedPath, content);
            }
        } catch (error) {
            console.error(`[Bookmark Bridge] Error in saveToFile:`, error);
            throw error;
        }
    }

    /**
     * Ensure a folder exists, creating parent directories as needed
     */
    private async ensureFolderExists(folderPath: string): Promise<void> {
        const normalizedPath = normalizePath(folderPath);
        console.log(`[Bookmark Bridge] Ensuring folder exists: ${normalizedPath}`);
        
        // Check if folder exists
        if (!(await this.app.vault.adapter.exists(normalizedPath))) {
            console.log(`[Bookmark Bridge] Folder doesn't exist, creating: ${normalizedPath}`);
            // Create folder including any necessary parent folders
            await this.app.vault.createFolder(normalizedPath);
        } else {
            console.log(`[Bookmark Bridge] Folder already exists: ${normalizedPath}`);
        }
    }

    /**
     * Check if a file exists
     */
    private async fileExists(filePath: string): Promise<boolean> {
        const normalizedPath = normalizePath(filePath);
        const exists = await this.app.vault.adapter.exists(normalizedPath);
        console.log(`[Bookmark Bridge] Checking if file exists: ${normalizedPath} - ${exists ? 'Yes' : 'No'}`);
        return exists;
    }

    /**
     * Read a file's content
     */
    private async readFile(filePath: string): Promise<string> {
        const normalizedPath = normalizePath(filePath);
        console.log(`[Bookmark Bridge] Reading file: ${normalizedPath}`);
        
        if (await this.app.vault.adapter.exists(normalizedPath)) {
            try {
                const content = await this.app.vault.adapter.read(normalizedPath);
                console.log(`[Bookmark Bridge] Successfully read ${content.length} characters from file`);
                return content;
            } catch (error) {
                console.error(`[Bookmark Bridge] Error reading file: ${normalizedPath}`, error);
                throw error;
            }
        }
        console.log(`[Bookmark Bridge] File not found for reading: ${normalizedPath}`);
        return '';
    }
} 