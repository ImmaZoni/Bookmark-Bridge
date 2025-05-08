import { App } from 'obsidian';

/**
 * Interface for storing processed bookmarks
 * Maps bookmark ID to timestamp when it was processed
 */
interface ProcessedBookmarks {
    [key: string]: number;
}

/**
 * Interface for storing detailed bookmark records
 */
export interface BookmarkRecord {
    tweetId: string;
    filePath: string;
    importDate: Date;
}

/**
 * Handles storage and retrieval of bookmark processing status
 * Provides persistence for tracking which bookmarks have already been imported
 */
export class BookmarkStorage {
    private app: App;
    private processedBookmarks: ProcessedBookmarks = {};
    private bookmarkRecords: Record<string, BookmarkRecord> = {};
    private STORAGE_KEY = 'bookmark-bridge-processed';
    private RECORDS_KEY = 'bookmark-bridge-records';
    private dataLoaded = false;

    /**
     * Creates a new BookmarkStorage instance
     * @param app The Obsidian App instance
     */
    constructor(app: App) {
        this.app = app;
        this.loadData();
    }

    /**
     * Load previously processed bookmarks and records from plugin data
     * Uses localStorage for persistence across plugin reloads
     */
    private async loadData(): Promise<void> {
        if (this.dataLoaded) return;
        
        try {
            // Use localStorage as our data store
            const processedBookmarksJson = localStorage.getItem(this.STORAGE_KEY);
            const bookmarkRecordsJson = localStorage.getItem(this.RECORDS_KEY);
            
            if (processedBookmarksJson) {
                this.processedBookmarks = JSON.parse(processedBookmarksJson);
            }
            
            if (bookmarkRecordsJson) {
                const recordsData = JSON.parse(bookmarkRecordsJson);
                
                // Convert date strings back to Date objects
                this.bookmarkRecords = {};
                for (const id in recordsData) {
                    const record = recordsData[id];
                    this.bookmarkRecords[id] = {
                        ...record,
                        importDate: new Date(record.importDate)
                    };
                }
            }
            
            this.dataLoaded = true;
        } catch (error) {
            console.error('Failed to load bookmark data:', error);
            this.processedBookmarks = {};
            this.bookmarkRecords = {};
        }
    }

    /**
     * Save the current processed bookmarks and records to localStorage
     * Ensures persistence across plugin reloads
     */
    private async saveData(): Promise<void> {
        try {
            // Save to localStorage
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.processedBookmarks));
            localStorage.setItem(this.RECORDS_KEY, JSON.stringify(this.bookmarkRecords));
        } catch (error) {
            console.error('Failed to save bookmark data:', error);
        }
    }

    /**
     * Check if a bookmark has already been processed
     * @param bookmarkId The ID of the bookmark to check
     * @returns True if the bookmark has been processed, false otherwise
     */
    public async isBookmarkProcessed(bookmarkId: string): Promise<boolean> {
        await this.loadData(); // Ensure data is loaded
        return !!this.processedBookmarks[bookmarkId];
    }

    /**
     * Mark a bookmark as processed
     * @param bookmarkId The ID of the bookmark to mark as processed
     */
    public async markBookmarkAsProcessed(bookmarkId: string): Promise<void> {
        this.processedBookmarks[bookmarkId] = Date.now();
        await this.saveData();
    }

    /**
     * Get all processed bookmark IDs
     * @returns An array of processed bookmark IDs
     */
    public async getProcessedBookmarkIds(): Promise<string[]> {
        await this.loadData(); // Ensure data is loaded
        return Object.keys(this.processedBookmarks);
    }

    /**
     * Clear all processed bookmarks
     * Useful for forcing a full re-sync
     */
    public async clearProcessedBookmarks(): Promise<void> {
        this.processedBookmarks = {};
        await this.saveData();
    }
    
    /**
     * Get a bookmark record by its tweet ID
     * @param tweetId The ID of the tweet
     * @returns The bookmark record or null if not found
     */
    public async getBookmarkById(tweetId: string): Promise<BookmarkRecord | null> {
        await this.loadData(); // Ensure data is loaded
        return this.bookmarkRecords[tweetId] || null;
    }
    
    /**
     * Save a bookmark record
     * @param record The bookmark record to save
     */
    public async saveBookmark(record: BookmarkRecord): Promise<void> {
        this.bookmarkRecords[record.tweetId] = record;
        // Also mark as processed for backward compatibility
        this.processedBookmarks[record.tweetId] = record.importDate.getTime();
        await this.saveData();
    }
    
    /**
     * Get all bookmark records
     * @returns An array of all bookmark records
     */
    public async getAllBookmarks(): Promise<BookmarkRecord[]> {
        await this.loadData(); // Ensure data is loaded
        return Object.values(this.bookmarkRecords);
    }
} 