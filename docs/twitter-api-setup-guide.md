# X API Setup Guide for Bookmark Bridge

This guide will walk you through setting up the X API (formerly Twitter API) for use with the Bookmark Bridge Obsidian plugin.

## Overview

Bookmark Bridge uses the X API v2 with OAuth 2.0 authentication to access your bookmarks. This authentication method is required by X for accessing personal bookmarks, and it ensures that your credentials remain secure.

## Step 1: Create a Developer Account

1. Go to [X Developer Portal](https://developer.x.com)
2. Sign in with your X account
3. If this is your first time, you'll need to apply for a developer account by following the on-screen instructions

## Step 2: Create a New Project and App

1. From the Developer Portal dashboard, click "Projects & Apps"
2. Click "Create Project" and follow the prompts to create a new project
3. Give your project a name (e.g., "Bookmark Bridge")
4. Select "Web App, Automated App or Bot" as the use case
5. In the project, click "Add App" to create a new app within the project
6. Give your app a name (e.g., "Bookmark Bridge App")

## Step 3: Set Up OAuth 2.0

1. In your app's settings, navigate to the "Authentication" tab
2. Make sure "OAuth 2.0" is enabled
3. Set "Type of App" to "Web App" or "Native App"
4. Under "Redirect URL," add `http://127.0.0.1/callback`
5. Under "Website URL," you can use `https://obsidian.md` or your own website if you have one

## Step 4: Configure App Permissions

1. In your app's settings, navigate to the "App permissions" tab
2. Select "Read" access
3. Make sure the following scopes are enabled:
   - `tweet.read`
   - `users.read`
   - `bookmark.read`
4. Save your changes

## Step 5: Get Your API Credentials

1. In your app's settings, navigate to the "Keys and tokens" tab
2. Copy your "Client ID" (you'll need this for the plugin)
3. If you want added security, also copy the "Client Secret" (optional for the plugin)

## Step 6: Configure Bookmark Bridge

1. Open Obsidian and go to Settings > Community Plugins > Bookmark Bridge
2. Select "OAuth 2.0 (X API v2)" as the authentication method
3. Enter your Client ID from Step 5
4. (Optional) Enter your Client Secret from Step 5
5. Click "Authorize" to connect to X

## Step 7: Authorization Flow

When you click "Authorize," the following will happen:

1. A browser window will open with X's authorization page
2. Sign in to X if needed
3. Review the permissions and click "Authorize app"
4. You'll be redirected to a page that might show an error (this is normal)
5. Copy the entire URL from your browser's address bar
6. Return to Obsidian, where a popup should be waiting
7. Paste the copied URL into the field and click "Submit"
8. If successful, you'll see a "Connected to X API" message

## Troubleshooting

### Authorization Popup Not Appearing
- Try restarting Obsidian
- Make sure no popup blockers are preventing the authorization window from opening

### Authorization Fails
- Double-check that you've correctly copied your Client ID
- Make sure you've added `http://127.0.0.1/callback` as a Redirect URL in your app settings
- Verify that you've enabled the required scopes (`tweet.read`, `users.read`, `bookmark.read`)

### "Invalid Redirect URL" Error
- Make sure the Redirect URL in your app settings exactly matches `http://127.0.0.1/callback`
- Note that URLs are case-sensitive and must include the protocol (http://)

### Token Refresh Issues
- If you encounter authentication errors after some time, try reconnecting through the plugin settings

## API Limitations

Please be aware that X may have rate limits on API requests. The plugin is designed to work within these limits, but if you sync very frequently, you might hit these limits.

## Privacy and Security

- The plugin only stores your OAuth tokens on your local device
- Your X password is never stored or transmitted through the plugin
- You can revoke access to the app at any time from your X account settings

## X API Documentation

For more information about the X API, you can refer to the [official documentation](https://developer.x.com/en/docs/twitter-api/getting-started/about-twitter-api). 