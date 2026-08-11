# Travel Spots Collector

A Chrome extension that turns YouTube travel videos into your personal city guide. When travel bloggers mention or display restaurants, cafés, brunch spots, and attractions in their videos, Travel Spots Collector captures them automatically — so you never have to pause, copy, and manually search again.

- Detect place names from video transcripts and on-screen text as you watch.
- Save spots instantly to a running list, organized by city or trip.
- Add personal notes and timestamps to remember exactly why you saved a place.
- Export your saved spots directly to Google Maps to build a custom travel map.
- Keep your data local — no accounts, no tracking, just your own API keys and Chrome storage.

## Why this exists

When you're watching a travel vlog about Tokyo or Paris, bloggers constantly name-drop the cafés they visited, the restaurants they loved, and the hidden spots worth finding. The old workflow is painful: pause the video, copy the name, switch to Google Maps, search it, save it, come back. Repeat twenty times per video.

Travel Spots Collector automates that entire loop. Watch the video. The extension detects the places. You review the list, drop the pins, and your trip map builds itself.

## How it works

1. Open a YouTube travel video.
2. Click the Travel Spots Collector icon to open the side panel.
3. The extension reads the video transcript and detects place names — restaurants, cafés, hotels, landmarks, and attractions.
4. Detected spots appear in your **Spots** list with a timestamp linking back to the moment in the video.
5. Review, edit, or add notes to each spot.
6. When you're ready, export your list to Google Maps to pin every place on a custom map.

## Install

This extension is installed locally from GitHub. It is not available through the Chrome Web Store.

1. Open [github.com/wendylzh6/Travel-Spots-Collector](https://github.com/wendylzh6/Travel-Spots-Collector).
2. Click **Code**, then **Download ZIP**, or clone the repo.
3. Unzip and place the folder somewhere permanent (e.g. `~/Documents/Travel-Spots-Collector`).
4. In Chrome, open `chrome://extensions`.
5. Enable **Developer mode**.
6. Click **Load unpacked** and select the project folder (the one containing `manifest.json`).
7. Pin Travel Spots Collector from Chrome's Extensions menu.

Because this is an unpacked extension, it does not auto-update. After pulling new changes, click **Reload** on the extension card at `chrome://extensions`, then refresh open YouTube tabs.

## Set up your API keys

Travel Spots Collector uses two external services under your own accounts:

1. A **Supadata API key** — to retrieve YouTube video transcripts.
2. A **DeepSeek API key** — to extract and identify place names from the transcript using AI.

### Get a Supadata API key

1. Go to [dash.supadata.ai/auth/sign-up](https://dash.supadata.ai/auth/sign-up) and create an account.
2. Your API key is generated during onboarding.
3. Find it anytime at [dash.supadata.ai](https://dash.supadata.ai).
4. Paste it into **Supadata API key** in the extension's Settings page.

### Get a DeepSeek API key

1. Go to [platform.deepseek.com/api_keys](https://platform.deepseek.com/api_keys) and sign in or create an account.
2. Click **Create new API key**, name it `Travel Spots Collector`, and copy it immediately.
3. Paste it into **DeepSeek API key** in the extension's Settings page.

Never paste an API key into a chat, source file, screenshot, or public message.

## Use Travel Spots Collector

1. Open a YouTube travel video.
2. Click the extension icon to open the side panel.
3. The **Spots** tab shows all detected places from the transcript, each with a timestamp.
4. Click a timestamp to jump to that moment in the video.
5. Click any spot to add a personal note — cuisine type, why you want to go, who recommended it.
6. Use the **Notes** tab to write freeform trip planning notes for the video.
7. When your list is ready, click **Open in Google Maps** to drop all spots as pins on a custom map.

## What it detects

Travel Spots Collector looks for:

- Restaurants and dining spots
- Cafés, bakeries, and brunch places
- Bars and nightlife venues
- Hotels and accommodations
- Landmarks, museums, and tourist attractions
- Neighborhoods and districts worth exploring

Detection quality depends on the transcript. Videos with clear captions and named places work best.

## What works today

- Google Chrome 116 or newer, using the Side Panel API.
- Standard `youtube.com/watch` video pages.
- Native subtitle tracks retrieved via Supadata.
- AI-powered place name extraction using DeepSeek.
- Timestamped spot list with personal notes.
- Google Maps export for pinning saved locations.
- Local storage only — no account system, no analytics.

Shorts, live streams, private videos, and videos without native captions may not work reliably. Firefox, Safari, and mobile browsers are not supported.

## Remix it

This is a personal project with no upstream pull requests accepted. Fork your own copy and customize freely. Ideas:

- Add filters by category (food, culture, nature, nightlife).
- Support trip folders to organize spots across multiple videos.
- Add star ratings or priority levels to spots.
- Sync saved spots with a Notion or Airtable travel planner.
- Add offline map export (e.g. GPX or KML for maps.me or OsmAnd).
- Surface opening hours and reviews by connecting to the Google Places API.

## Privacy and data flow

Travel Spots Collector makes all requests directly from the extension:

1. It sends the YouTube video URL to Supadata to fetch the native transcript.
2. It sends the transcript to DeepSeek to extract place names.
3. Extracted spots and notes are stored locally in Chrome storage on your device.

There is no Travel Spots Collector account system, advertising, analytics, or telemetry. Supadata and DeepSeek receive data under their own terms. See [PRIVACY.md](PRIVACY.md) for details.

## Troubleshooting

**The extension button is missing on a YouTube video**
- Reload the extension at `chrome://extensions`, then refresh the YouTube tab.
- Confirm you are on a standard `youtube.com/watch` page, not a Short or live stream.

**No spots are detected**
- Check that the video has native captions enabled.
- Confirm your Supadata key is valid and has remaining credits.
- Videos in languages other than English may have lower detection accuracy.

**Google Maps export doesn't open**
- Make sure your browser allows pop-ups from the extension.
- Check that spots have names — unnamed or vague entries may be skipped.

**AI requests fail**
- A `401` or `403` usually means an invalid DeepSeek key.
- A `429` means a rate or credit limit was hit — check your DeepSeek account balance.

## Checks for coding agents

```bash
npm test
npm run check
npm run package
```

After any change, reload the unpacked extension in Chrome and test on real travel videos.

## License

MIT. See [LICENSE](LICENSE).
