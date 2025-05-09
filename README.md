# Bookmark Bridge - Obsidian Plugin

Bookmark Bridge seamlessly imports your Twitter/X bookmarks into Obsidian, preserving valuable content in your knowledge base.

## 🚨 Call for Testers & Supporters 🚨

**We need your help!** Due to X API limitations, we've reached our monthly usage limit for bookmark API calls. We're looking for:

1. **Testers** to help validate functionality across different environments and use cases
2. **Supporters** willing to contribute to upgrading our Twitter API access tier

### How You Can Help:

- **Test the plugin**: Install it, provide feedback, and report any issues you encounter
- **Support development**: 
  - [Buy Me a Coffee](https://www.buymeacoffee.com/immazoni)

Your contributions will help us upgrade to a paid Twitter API plan ($100/month) that allows for higher request limits and more features. All supporters will be acknowledged in the plugin documentation.

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

Detailed setup instructions are available in the plugin settings.

## Template Variables

The plugin supports a wide range of template variables for customizing how your bookmarks are formatted. For the complete list of available variables and API parameters, see [X API Parameters Documentation](docs/x-api-parameters.md).

## Storage Methods

Bookmark Bridge offers two ways to store your bookmarks:

1. **Separate Notes**: Each bookmark is saved as a separate note
2. **Single File**: All bookmarks are combined into a single note

## Rate Limits

The X API limits bookmark requests to 1 per 15 minutes for the free tier. Bookmark Bridge handles this by implementing pagination and saving progress between sync sessions.

**Note:** We're currently on the free Twitter API tier, which has significant rate limits. With enough support, we plan to upgrade to a paid tier ($100/month) to improve sync capabilities and add more features.

## Future Vision

Bookmark Bridge is designed to be more than just a Twitter/X bookmarks importer. Our long-term vision includes:

### Multi-Platform Support
- **Reddit**: Import saved posts and comments
- **Hacker News**: Import upboted posts
- **Bluesky**: Import saved posts
- **LinkedIn**: Capture saved articles and posts
- **Other Platforms**: Extend to additional services based on community needs

### AI-Powered Organization
- **Intelligent Categorization**: Leverage LLM capabilities to automatically sort bookmarks by topic
- **Smart Tagging**: Generate relevant tags based on content analysis
- **Content Summarization**: Create concise summaries of longer content

### Enhanced Features
- **Thread Unrolling**: Capture entire Twitter threads, not just individual tweets
- **Advanced Media Handling**: Better support for various media types

Our goal is to create a comprehensive "bridge" between all your content discovery platforms and your Obsidian knowledge base, making Bookmark Bridge an essential part of your PKM workflow.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgements

Special thanks to all our [supporters and contributors](docs/SUPPORTERS.md) who make this project possible.
