# BookOrbit Chomikuj.pl plugin

An indexer plugin for BookOrbit that searches Chomikuj.pl and downloads ebook files with your Chomikuj account's transfer.

## What it is

This plugin connects BookOrbit to Chomikuj.pl. It searches Chomikuj's Documents collection, returns matching ebook releases, and resolves a download URL for the release you pick. Downloads use the transfer attached to your own Chomikuj account. The plugin does not scrape the website HTML and does not download anonymously.

## Status

- The offline suite is verified: unit tests, the plugin contract check, and the bundled build all pass.
- The live Chomikuj API gate is owner-run; the latest recorded run passed (`UA_GATE=PASS`, `LIVE_QA=PASS`). It needs a real Chomikuj account and is not part of CI.
- v0.1.0 has no auto-update channel.

## Install

BookOrbit installs a plugin from a single `.mjs` file.

Download `index.mjs` from the [latest release](https://github.com/anarion80/bookorbit-chomikuj-plugin/releases/latest/download/index.mjs), then install it:

1. In BookOrbit, open **Settings**, then **Server**, then **Requests**, then **Sources**.
2. Choose **Install plugin** and select the downloaded `index.mjs`.

Alternatively, copy the file into BookOrbit's data directory:

```
<APP_DATA_PATH>/plugins/indexers/chomikuj/index.mjs
```

Create the `chomikuj` directory if it does not exist. The plugin is a single file and must stay under 512 KiB; the build fails if the bundle reaches that size. Restart or reload BookOrbit if the new source does not appear immediately.

For development, build the bundle locally with `npm run build` (see [Development](#development)); that produces `dist/index.mjs`, which can be installed the same way.

## Credentials

Chomikuj needs both a username and a password, but BookOrbit only stores one secret per source.

- Put your **Chomikuj username** in the plugin's `username` setting.
- Put your **Chomikuj password** in BookOrbit's credential field.

BookOrbit labels that credential field **"API key"**. BookOrbit has no password credential kind, so it reuses the API key field for this plugin. The plugin sends the value as the Chomikuj password during login. Do not paste a Chomikuj API key or some other token there; the password is what Chomikuj expects.

The plugin never logs or persists the password or the session key. A successful login returns a short-lived Chomikuj session key that the plugin keeps in memory.

## Settings

| Setting | Type | Default | What it does |
| --- | --- | --- | --- |
| `username` | string | none | Your Chomikuj.pl account name. |
| `formats` | list | `epub,mobi,pdf` | Ebook formats to accept. Options: `epub`, `kepub`, `mobi`, `azw3`, `azw`, `fb2`, `pdf`, `djvu`. At least one format is required. |
| `allowTransferSpend` | boolean | on (`true`) | Whether the plugin may resolve paid downloads that spend your transfer. |

How `formats` behaves:

- Exactly one format narrows the Chomikuj search on the server with an `Extension` hint.
- Several formats are filtered locally after the results come back.
- Archive formats are never accepted, even if typed into the setting.

How `allowTransferSpend` behaves:

- It defaults to **on**, so paid files may be offered and downloaded.
- When it is **off**, the plugin refuses paid files before it calls the download API. Files the owner marks as free for you, and accounts with unlimited transfer, are still allowed.
- The setting only blocks spending. It does not grant free downloads.

There is also a base URL setting in the manifest, defaulting to `https://mobile.chomikuj.pl`. You normally should not change it.

## How search works

- The plugin searches Chomikuj's **Documents** media type only (`MediaType=Documents`). It does not look in other media categories.
- Results are ordered newest first using `FileId` as a recency proxy. Chomikuj does not expose a reliable publication date, so the plugin never invents one and never sets a publication date on a release.
- The order decides which rows survive the requested result limit. BookOrbit may re-rank merged results by score afterwards, so the final display order is not guaranteed to match `FileId` order.
- Results are deduplicated by `FileId`, and each download is resolved with a single `files/download` call.
- Only files with an importable format are returned. Archive formats are dropped.

## Free vs paid

Chomikuj's transfer rules apply to the download, not to the search:

- **Unregistered users** are limited to 1 MB per file.
- **Registered free accounts** get roughly 50 MB of transfer per week.
- **Files you own** are free to download for you.
- **Paid or unlimited transfer** removes most limits. The plugin detects an unlimited account from the account payload.
- **Code 605 ("not enough transfer")** is a permanent quota error. It is not a rate limit and the plugin does not retry it. Free up transfer or use an account that has enough.

The plugin runs an advisory quota check before requesting a download URL, but Chomikuj's 605 response is the authoritative answer.

## Preview can spend transfer

> **Warning: previewing or inspecting a paid file can spend your Chomikuj transfer.** BookOrbit calls `resolveFile` when it previews or inspects a release, and Chomikuj charges transfer when the download URL is issued, even if BookOrbit never downloads the file. The issued URL is cached for about 60 seconds; a later grab after that window can charge again. Turn `allowTransferSpend` off to block paid files before the download API is called. Free files and unlimited accounts are unaffected.

## Troubleshooting

- **401 or 403 (unauthorized):** the username or password is wrong, or the Chomikuj session expired. Re-enter both values. The plugin clears a cached session after an authorization failure so the next attempt logs in again.
- **429 (rate limited):** Chomikuj is throttling requests. The plugin retries account and search calls once on 429 or 5xx, honoring `Retry-After` up to two seconds. Login and download calls are never retried. Wait and try again.
- **Cloudflare challenge:** a page or response looks like a Cloudflare challenge. The plugin treats this as unreachable and does not retry it. Change network or wait, then try again. The plugin has no challenge solver.
- **605 (not enough transfer):** your account lacks the transfer for this file. This is permanent for the current balance. See [Free vs paid](#free-vs-paid).
- **Empty results:** check that the title, author, or ISBN is correct, that your chosen `formats` match the file, and that the book is a Chomikuj Documents item. A single format also narrows the server search, so try a broader format list.
- **Base URL problems:** the default is `https://mobile.chomikuj.pl`, and the plugin appends `/api/v3` when it is missing. Reset the base URL if you changed it.
- **Live gate still pending:** the offline suite does not prove the live Chomikuj API works end to end. That check is owner-run with a real account.

## No archives

Archive formats are never offered, returned, or extracted. The plugin drops:

`zip`, `rar`, `7z`, `tar`, `gz`, `bz2`, `xz`, `cbz`, `cbr`, `cb7`, `cbt`

Comic archives such as `cbz`, `cbr`, `cb7`, and `cbt` are included in this rule. The plugin does not unpack anything.

## No auto-update

v0.1.0 has no signed update channel and does not check for or install updates. To upgrade, build or obtain a new `dist/index.mjs` and install it again, replacing the existing file.

## Uninstall

1. Remove the plugin file at `<APP_DATA_PATH>/plugins/indexers/chomikuj/index.mjs`, or delete the `chomikuj` directory.
2. Remove the configured source in BookOrbit under **Settings**, then **Server**, then **Requests**, then **Sources**.
3. Restart or reload BookOrbit if the source remains visible.

## Development

Requirements: Node.js 24 or newer.

```
npm ci
npm run build
npm run check
npm test
```

- `npm run build` bundles `src/index.mjs` into `dist/index.mjs` and fails if the output is at or above 512 KiB.
- `npm run check` validates the plugin shape and safety rules.
- `npm test` runs the offline verification suite.

The live Chomikuj feasibility gate is owner-run. Run it only with your own account and never paste credentials into chat, issues, or commits:

```
CHOMIKUJ_USERNAME=... CHOMIKUJ_PASSWORD=... node scripts/live-spike.mjs
```

The script logs in, reads the account, resolves a free PDF, and checks that the returned file URL downloads with BookOrbit's fixed headers. Exit code 0 means the gate passed, 1 means it failed, and 2 means credentials were missing and no network calls were made.

### Live QA

The end-to-end live QA is owner-run as well. Build first, then run it with your own account:

```
npm run build
CHOMIKUJ_USERNAME=... CHOMIKUJ_PASSWORD=... node scripts/live-qa.mjs
```

It calls the built plugin's `test`, searches for `CHOMIKUJ_QUERY` (default `test`), resolves a free file, fetches the returned URL with BookOrbit's fixed `User-Agent: BookOrbit` and `Accept: */*` headers and no `Range`, then confirms `allowTransferSpend=false` refuses a paid file without calling `files/download`. Use a free or test account, never a production one, for the paid-spend check. Evidence is written to `.omo/evidence/bookorbit-chomikuj-plugin/live-qa.txt`.

Set `CHOMIKUJ_QUERY` to a query whose results include both a free and a paid ebook. Exit code 0 means `LIVE_QA=PASS`, 1 means a step failed, and 2 means credentials were missing and no network calls were made. Never paste your Chomikuj password or a session key into chat, issues, or commits; the script redacts credentials from its output and evidence file.

## License

MIT. See [LICENSE](LICENSE).
