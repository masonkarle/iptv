# iptv

An IPTV playlist and a matching XMLTV guide, for Jellyfin Live TV.

| | URL |
|---|---|
| Playlist (M3U tuner) | `https://raw.githubusercontent.com/masonkarle/iptv/main/playlist.m3u` |
| Guide (XMLTV) | `https://raw.githubusercontent.com/masonkarle/iptv/guide/guide.xml` |
| Guide, gzipped | `https://raw.githubusercontent.com/masonkarle/iptv/guide/guide.xml.gz` |

## How the guide stays current

The "Update guide" workflow runs twice a day (and whenever `playlist.m3u` changes). It
runs the [iptv-org/epg](https://github.com/iptv-org/epg) grabber and overwrites the
`guide` branch with the result. That branch only ever holds the latest guide.

To change the channel list, replace `playlist.m3u` on `main`; the guide follows.

## How channels are matched

`build-channels.mjs` maps every `tvg-id` in the playlist to guide sources, best first:

1. Pluto TV streams (`jmp2.uk/plu-<id>`) go straight to Pluto's API using the id in the stream URL.
2. An exact `tvg-id` match in the grabber's site lists. Sites marked broken upstream are tried last.
3. The SD/HD twin of the same channel.
4. US local stations (`ABC.us@KERO`) are matched to tvpassport.com by call sign.

`update.mjs` grabs each site in its own process, retries channels that came back empty
against their next-best source, and merges everything into `guide.xml`. The channel ids
in the guide are the playlist's `tvg-id`s, so Jellyfin maps them automatically.

The `guide` branch also carries `unmatched.txt` (channels with no guide source anywhere)
and `no-programmes.txt` (channels whose source returned nothing on the last run).

## Running it locally

```sh
git clone --depth 1 https://github.com/iptv-org/epg.git epg && (cd epg && npm install)
node update.mjs
```
