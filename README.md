# Bookmark Bridge - Obsidian Plugin

Bookmark Bridge seamlessly imports your Twitter/X bookmarks into Obsidian, preserving valuable content in your knowledge base.

## Features

- Import bookmarks from Twitter/X into your Obsidian vault
- Authenticate securely with X API using OAuth 2.0
- Store bookmarks as individual notes or in a single combined file
- Customize bookmark formatting with templates
- Automatic pagination for X API rate limits (1 request per 15 minutes)
- Comprehensive error handling and logging

## Installation

1. Download the latest release from the Releases page
2. Extract the zip file into your Obsidian plugins folder
3. Enable the plugin in Obsidian settings

## Setup

1. Create a Twitter Developer account and a project/app
2. Configure your app with OAuth 2.0 and the required scopes
3. Enter your app's client ID in the plugin settings
4. Follow the authorization steps in the plugin settings

## Security Warning

Please be aware that the `clientID` and `clientSecrets` are stored in `data.json` within the plugin folder. This poses an inherent security risk, as your API keys may be exposed. It is recommended to take appropriate measures to secure this file and avoid sharing it publicly.

Detailed setup instructions are available in the plugin settings.

## Template Variables

The plugin supports a wide range of template variables for customizing how your bookmarks are formatted. For the complete list of available variables and API parameters, see [X API Parameters Documentation](docs/x-api-parameters.md).

## Storage Methods

Bookmark Bridge offers two ways to store your bookmarks:

1. **Separate Notes**: Each bookmark is saved as a separate note
2. **Single File**: All bookmarks are combined into a single note

## Rate Limits

The X API limits bookmark requests to 1 per 15 minutes. Bookmark Bridge handles this by implementing pagination and saving progress between sync sessions.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.
