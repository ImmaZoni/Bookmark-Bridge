# 🔖 Bookmark Bridge - Obsidian Plugin

<div align="center">

**Seamlessly import your Twitter/X bookmarks into Obsidian, preserving valuable content in your knowledge base.**

</div>

## ✨ Features

- 📱 Import bookmarks from Twitter/X directly into your Obsidian vault
- 🔐 Authenticate securely with X API using OAuth 2.0
- 📝 Store bookmarks as individual notes or in a single combined file
- 🎨 Customize bookmark formatting with powerful templating
- ⏱️ Handle Twitter API rate limits automatically (1 request per 15 minutes)
- 🔄 Resume interrupted syncs with pagination support
- 🧠 Preserve valuable knowledge from your social media activity
- 🚨 Comprehensive error handling and logging

## 📥 Installation

1. Download the latest release from the [Releases page](https://github.com/ImmaZoni/Bookmark-Bridge/releases)
2. Extract the zip file into your Obsidian plugins folder (`YOUR_VAULT/.obsidian/plugins/`)
3. Enable the plugin in Obsidian settings under Community Plugins

## 🔧 Setup

1. Create a Twitter Developer account and a project/app at [developer.x.com](https://developer.x.com)
2. Configure your app with OAuth 2.0 and the required scopes (`tweet.read`, `users.read`, `bookmark.read`)
3. Enter your app's client ID in the plugin settings
4. Follow the authorization steps in the plugin settings

<<<<<<< Updated upstream
## Security Warning

Please be aware that the `clientID` and `clientSecrets` are stored in `data.json` within the plugin folder. This poses an inherent security risk, as your API keys may be exposed. It is recommended to take appropriate measures to secure this file and avoid sharing it publicly.

Detailed setup instructions are available in the plugin settings.
=======
For detailed setup instructions, see our [X API Setup Guide](docs/twitter-api-setup-guide.md).
>>>>>>> Stashed changes

## 📋 Template Variables

Bookmark Bridge supports a wide range of template variables for customizing how your bookmarks are formatted:

```
# Tweet by @{{authorUsername}}

{{text}}

{{#hasMedia}}
## Media
{{#mediaUrls}}
![]({{.}})
{{/mediaUrls}}
{{/hasMedia}}

[View on Twitter]({{tweetUrl}})
```

For the complete list of available variables and API parameters, see our [X API Parameters Documentation](docs/x-api-parameters.md).

## 💾 Storage Methods

Choose how your bookmarks are saved:

- **Separate Notes**: Each bookmark stored as an individual note
- **Single File**: All bookmarks combined into one master note

## ⏰ Rate Limits & Sync

The X API limits bookmark requests to 1 per 15 minutes. Bookmark Bridge handles this intelligently by:

- Implementing pagination for large bookmark collections
- Saving sync progress between sessions
- Supporting automatic syncing on a schedule
- Providing clear status indicators

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

<<<<<<< Updated upstream
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
=======
## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgements

- [Obsidian](https://obsidian.md) for the amazing knowledge management platform
- [Twitter/X API](https://developer.x.com) for providing access to bookmark data
>>>>>>> Stashed changes
