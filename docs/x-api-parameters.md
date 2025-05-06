# X API Bookmark Parameters Documentation

This document outlines all the parameters and fields available from the X API (formerly Twitter) bookmarks endpoint that can be accessed through the Bookmark Bridge plugin.

## Endpoint Information

The plugin uses the `/2/users/{id}/bookmarks` endpoint from the X API v2 to fetch your bookmarked tweets.

## Available Template Variables

When creating custom templates for your bookmarks, you can use the following variables:

### Basic Tweet Fields

| Variable | Description |
|----------|-------------|
| `{{id}}` | The unique identifier of the tweet |
| `{{text}}` | The full text content of the tweet |
| `{{created_at}}` | The timestamp when the tweet was created |
| `{{date}}` | The formatted date of the tweet |
| `{{time}}` | The formatted time of the tweet |
| `{{tweetUrl}}` | The direct URL to the tweet |
| `{{lang}}` | The language of the tweet |
| `{{source}}` | The source of the tweet (e.g., "Twitter Web App") |

### Author Fields

| Variable | Description |
|----------|-------------|
| `{{authorId}}` | The unique identifier of the tweet author |
| `{{authorUsername}}` | The username/handle of the tweet author |
| `{{authorName}}` | The display name of the tweet author |
| `{{authorDescription}}` | The biography/description of the tweet author |
| `{{authorVerified}}` | Whether the author is verified |
| `{{authorProfileImageUrl}}` | URL to the author's profile image |

### Media Fields 

| Variable | Description |
|----------|-------------|
| `{{#hasMedia}}...{{/hasMedia}}` | Conditional block that only appears if media is attached |
| `{{#mediaUrls}}{{.}}{{/mediaUrls}}` | Loop through all media URLs |

### Metrics Fields

| Variable | Description |
|----------|-------------|
| `{{retweet_count}}` | Number of retweets |
| `{{reply_count}}` | Number of replies |
| `{{like_count}}` | Number of likes |
| `{{quote_count}}` | Number of quote tweets |
| `{{#hasMetrics}}...{{/hasMetrics}}` | Conditional block for engagement metrics |

### Available API Parameters

When fetching bookmarks, the plugin can request various optional fields from the X API. Below are the available query parameters:

#### Tweet Fields

The following fields can be requested via the `tweet.fields` parameter:

- `article`
- `attachments`
- `author_id`
- `card_uri`
- `community_id`
- `context_annotations`
- `conversation_id`
- `created_at`
- `display_text_range`
- `edit_controls`
- `edit_history_tweet_ids`
- `entities`
- `geo`
- `id`
- `in_reply_to_user_id`
- `lang`
- `media_metadata`
- `non_public_metrics`
- `note_tweet`
- `organic_metrics`
- `possibly_sensitive`
- `promoted_metrics`
- `public_metrics`
- `referenced_tweets`
- `reply_settings`
- `scopes`
- `source`
- `text`
- `withheld`

#### Expansions

The following expansions can be requested via the `expansions` parameter:

- `article.cover_media`
- `article.media_entities`
- `attachments.media_keys`
- `attachments.media_source_tweet`
- `attachments.poll_ids`
- `author_id`
- `edit_history_tweet_ids`
- `entities.mentions.username`
- `geo.place_id`
- `in_reply_to_user_id`
- `entities.note.mentions.username`
- `referenced_tweets.id`
- `referenced_tweets.id.attachments.media_keys`
- `referenced_tweets.id.author_id`

#### Media Fields

The following media fields can be requested via the `media.fields` parameter:

- `alt_text`
- `duration_ms`
- `height`
- `media_key`
- `preview_image_url`
- `public_metrics`
- `type`
- `url`
- `variants`
- `width`

#### User Fields

The following user fields can be requested via the `user.fields` parameter:

- `created_at`
- `description`
- `entities`
- `id`
- `location`
- `name`
- `pinned_tweet_id`
- `profile_image_url`
- `protected`
- `public_metrics`
- `url`
- `username`
- `verified`
- `verified_type`
- `withheld`

## Pagination Information

The X API limits bookmarks requests to 1 per 15 minutes. The plugin implements pagination to handle this limitation, allowing you to fetch more bookmarks across multiple sync sessions.

## Response Format Example

Below is an example of the data structure returned by the X API bookmarks endpoint:

```json
{
  "data": [
    {
      "author_id": "2244994945",
      "created_at": "Wed Jan 06 18:40:40 +0000 2021",
      "id": "1346889436626259968",
      "text": "Learn how to use the user Tweet timeline and user mention timeline endpoints in the X API v2 to explore Tweet...",
      "username": "XDevelopers"
    }
  ],
  "includes": {
    "users": [
      {
        "created_at": "2013-12-14T04:35:55Z",
        "id": "2244994945",
        "name": "X Dev",
        "protected": false,
        "username": "TwitterDev"
      }
    ],
    "media": [
      {
        "height": 1080,
        "media_key": "13_1346889435453620225",
        "type": "photo",
        "width": 1920
      }
    ]
  },
  "meta": {
    "next_token": "...",
    "result_count": 5
  }
}
```

## Using Template Variables

You can use the template variables in both Mustache-style conditionals and loops:

### Conditional Example

```
{{#hasMedia}}
## Media
{{#mediaUrls}}
![]({{.}})
{{/mediaUrls}}
{{/hasMedia}}
```

This will only show the Media section if the tweet has media attached.

### Loop Example

```
{{#hashtags}}
#{{.}} 
{{/hashtags}}
```

This will output all hashtags from the tweet.

## Rate Limit Information

Please note that the X API enforces rate limits on the bookmarks endpoint. The plugin handles these limits by implementing pagination and saving progress between sync sessions.

- Bookmarks requests: 1 request per 15 minutes
- Maximum results per request: 100 bookmarks 

## Learn More

You can read more about the bookmarks API Endpoint on [X/Twitters official API Documentation Page](https://docs.x.com/x-api/bookmarks/bookmarks-by-user )