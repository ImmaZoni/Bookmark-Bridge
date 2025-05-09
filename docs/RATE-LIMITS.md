# Understanding Twitter/X API Rate Limits

## Overview of X API Rate Limits

Twitter/X's API implements strict rate limits that vary based on your subscription tier:

| Feature | Free Tier | Basic Tier ($100/mo) | Enterprise Tier |
|---------|-----------|----------------------|-----------------|
| Bookmarks API | 1 request / 15 minutes | 15 requests / 15 minutes | 50+ requests / 15 minutes |
| User lookup | 25 / 15 minutes | 100 / 15 minutes | 300+ / 15 minutes |
| Tweet lookup | 25 / 15 minutes | 300 / 15 minutes | 1,000+ / 15 minutes |
| Request limit | 1,500 / month | 10,000 / month | Unlimited |

## How This Affects Bookmark Bridge

With the free tier, our plugin can only:
- Fetch your bookmarks once every 15 minutes
- Process a maximum of ~100 bookmarks per request
- Make limited API calls per month

This means that for users with many bookmarks, the initial sync may take several days to complete, as we can only process approximately 100 bookmarks per 15 minutes.

## Error Code 429

If you're seeing error code 429 ("Too Many Requests"), it means one of two things:
1. The plugin has made a request before the 15-minute window has elapsed
2. We've exceeded our monthly API call limit

The plugin implements client-side rate limiting to prevent the first scenario, but we cannot prevent the second unless we upgrade our API access.

## Our Solution

We've implemented several features to work within these constraints:

1. **Smart pagination**: We save progress between sessions so syncing can continue across multiple 15-minute windows
2. **Incremental syncing**: After the initial sync, we only fetch new bookmarks
3. **Debug mode**: For developers, a bypass option for the client-side rate limit (note: this doesn't bypass Twitter's limits)

## How You Can Help

We're currently on the Free Tier, which severely limits our ability to serve users effectively. With your support, we aim to upgrade to the Basic Tier ($100/month), which would:

- Increase our sync speed by 15x
- Allow for more frequent updates
- Enable additional features
- Support more users simultaneously

Please consider [supporting our project](SUPPORTERS.md) if you find Bookmark Bridge valuable. 