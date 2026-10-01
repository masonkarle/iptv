#!/usr/bin/env node
// Builds a custom channels.xml for the iptv-org/epg grabber from an M3U playlist.
// Every tvg-id in the playlist is mapped to guide sources, best first:
//   1. Pluto TV streams (jmp2.uk/plu-<id>) -> pluto.tv, using the id from the stream URL
//   2. An exact tvg-id match in epg/sites/**/*.channels.xml
//   3. The SD/HD twin of the same channel (same schedule, different quality)
//   4. US local stations (tvg-id like ABC.us@KERO) -> tvpassport.com, matched by call sign
//
// Usage: node build-channels.mjs <playlist.m3u> [--rank N] [--only ids.txt] [--out file.xml]
//   --rank N   use each channel's Nth-best source instead of the best (for retry passes)
//   --only F   limit output to the tvg-ids listed in file F (one per line)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const SITES_DIR = path.join(ROOT, 'epg', 'sites')

// Sites tried first, in this order; anything not listed comes after, alphabetically.
const SITE_PRIORITY = [
  'pluto.tv',
  'plex.tv',
  'xumo.tv',
  'tvpassport.com',
  'directv.com',
  'tvguide.com',
  'ontvtonight.com',
  'sky.com',
  'freeview.co.uk',
  'mytelly.co.uk',
  'distro.tv',
  'i.mjh.nz'
]

const args = process.argv.slice(2)
const flag = name => {
  const i = args.indexOf(name)
  return i === -1 ? undefined : args.splice(i, 2)[1]
}
const rank = Number(flag('--rank') ?? 0)
const onlyFile = flag('--only')
const outFile = flag('--out') ?? path.join(ROOT, 'custom.channels.xml')
const playlist = args[0]
if (!playlist) {
  console.error('Usage: node build-channels.mjs <playlist.m3u> [--rank N] [--only ids.txt] [--out file.xml]')
  process.exit(1)
}

const unescapeXml = s =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
const escapeXml = s =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function parsePlaylist(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const channels = new Map() // tvg-id -> { name, urls }
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXTINF')) continue
    const id = lines[i].match(/tvg-id="([^"]*)"/)?.[1]
    if (!id) continue
    const name = lines[i].slice(lines[i].lastIndexOf(',') + 1).trim()
    let j = i + 1
    while (j < lines.length && (lines[j].startsWith('#') || !lines[j].trim())) j++
    if (!channels.has(id)) channels.set(id, { name, urls: [] })
    if (lines[j]) channels.get(id).urls.push(lines[j].trim())
  }
  return channels
}

const normalize = s => s.toLowerCase().replace(/[^a-z0-9]/g, '')

function loadSiteChannels() {
  const byId = new Map() // xmltv_id -> [{ site, site_id, lang }]
  const stations = new Map() // call sign -> [{ network, site_id, hd }] (primary channels on tvpassport.com)
  for (const site of fs.readdirSync(SITES_DIR)) {
    const dir = path.join(SITES_DIR, site)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.channels.xml')) continue
      const xml = fs.readFileSync(path.join(dir, file), 'utf8')
      for (const m of xml.matchAll(/<channel ([^>]*)>([^<]*)</g)) {
        const attr = Object.fromEntries(
          [...m[1].matchAll(/(\w+)="([^"]*)"/g)].map(a => [a[1], unescapeXml(a[2])])
        )
        if (!attr.site || !attr.site_id) continue
        // "ABC (KERO) Bakersfield, CA HD" is a station's primary channel; subchannels look like "(KERO-TV5)".
        const station = site === 'tvpassport.com' && unescapeXml(m[2]).match(STATION_NAME)
        if (station && !/Canada/.test(station[3])) {
          if (!stations.has(station[2])) stations.set(station[2], [])
          stations.get(station[2]).push({ network: station[1], site_id: attr.site_id, hd: /\bHD$/.test(station[3]) })
        }
        if (!attr.xmltv_id) continue
        if (!byId.has(attr.xmltv_id)) byId.set(attr.xmltv_id, [])
        byId.get(attr.xmltv_id).push({ site: attr.site, site_id: attr.site_id, lang: attr.lang || 'en' })
      }
    }
  }
  return { byId, stations }
}

const STATION_NAME = /^(.+?) \(([KW][A-Z]{2,3})(?:-(?:TV|DT|LD|CD|LP))?\) (.*)$/
const NETWORK_ALIASES = { univision: ['uni'], mynetworktv: ['mnt'], thecw: ['cw'] }
const STATION_FEED = /^([KW][A-Z]{2,3}?)(?:TV|DT|LD|CD|LP)?$/

// tvg-ids like "ABC.us@KEROTV" name a network and a local station's call sign.
function stationSources(id, name, stations) {
  const [channel, feed] = id.split('@')
  const call = feed?.match(STATION_FEED)?.[1]
  // "KITV" is itself a call sign, while "WMURTV" is WMUR plus a suffix: try the whole feed first.
  const found = stations.get(feed) ?? stations.get(call) ?? []
  const network = normalize(channel.split('.')[0])
  const names = [network, ...(NETWORK_ALIASES[network] ?? [])]
  // tvpassport abbreviates or prefixes some networks: "UNI (KMEX)", "NJ PBS (WNJT)".
  const matches = found.filter(s =>
    s.network.split(/\s+/).some(word => names.includes(normalize(word))) ||
    names.includes(normalize(s.network)) ||
    normalize(name).startsWith(normalize(s.network))
  )
  return matches
    .sort((a, b) => Number(b.hd) - Number(a.hd))
    .map(s => ({ site: 'tvpassport.com', site_id: s.site_id, lang: 'en' }))
}

// Sites the upstream repo currently marks as broken (🔴 in SITES.md) are only used as a last resort.
const brokenSites = new Set(
  [...fs.readFileSync(path.join(ROOT, 'epg', 'SITES.md'), 'utf8').matchAll(/<a href="sites\/([^"]+)">.*?🔴/g)].map(
    m => m[1]
  )
)

const sitePriority = site => {
  const i = SITE_PRIORITY.indexOf(site)
  return i === -1 ? SITE_PRIORITY.length : i
}

function rankSources(sources) {
  const seen = new Set()
  return sources
    .slice()
    .sort(
      (a, b) =>
        (brokenSites.has(a.site) ? 1 : 0) - (brokenSites.has(b.site) ? 1 : 0) ||
        (a.lang === 'en' ? 0 : 1) - (b.lang === 'en' ? 0 : 1) ||
        sitePriority(a.site) - sitePriority(b.site) ||
        a.site.localeCompare(b.site)
    )
    .filter(s => !seen.has(s.site) && seen.add(s.site)) // one source per site
}

function twinId(id) {
  const [channel, feed] = id.split('@')
  if (feed === 'SD') return `${channel}@HD`
  if (feed === 'HD') return `${channel}@SD`
  return null
}

const playlistChannels = parsePlaylist(playlist)
const { byId: siteChannels, stations } = loadSiteChannels()
const only = onlyFile
  ? new Set(fs.readFileSync(onlyFile, 'utf8').split(/\r?\n/).filter(Boolean))
  : null

const stats = { total: 0, pluto: 0, exact: 0, twin: 0, station: 0, unmatched: 0 }
const out = []
const unmatched = []

for (const [id, { name, urls }] of playlistChannels) {
  stats.total++
  const candidates = []
  const plutoId = urls.map(u => u.match(/jmp2\.uk\/plu-([0-9a-f]{24})/)?.[1]).find(Boolean)
  if (plutoId) candidates.push({ site: 'pluto.tv', site_id: plutoId, lang: 'en', how: 'pluto' })
  for (const s of rankSources(siteChannels.get(id) ?? [])) {
    if (!candidates.some(c => c.site === s.site)) candidates.push({ ...s, how: 'exact' })
  }
  if (!candidates.length) {
    const twin = twinId(id)
    for (const s of rankSources((twin && siteChannels.get(twin)) || [])) candidates.push({ ...s, how: 'twin' })
  }
  if (!candidates.length) {
    for (const s of stationSources(id, name, stations)) candidates.push({ ...s, how: 'station' })
  }

  if (!candidates.length) {
    stats.unmatched++
    unmatched.push(`${id}\t${name}`)
    continue
  }
  stats[candidates[0].how]++
  if (only && !only.has(id)) continue
  const pick = candidates[rank]
  if (!pick) continue
  out.push(
    `  <channel site="${escapeXml(pick.site)}" lang="${escapeXml(pick.lang)}" xmltv_id="${escapeXml(id)}" site_id="${escapeXml(pick.site_id)}">${escapeXml(name)}</channel>`
  )
}

fs.writeFileSync(outFile, `<?xml version="1.0" encoding="UTF-8"?>\n<channels>\n${out.join('\n')}\n</channels>\n`)
if (rank === 0 && !only) fs.writeFileSync(path.join(ROOT, 'unmatched.txt'), unmatched.join('\n') + '\n')

console.error(
  `${stats.total} channel ids: ${stats.pluto} via Pluto stream id, ${stats.exact} exact, ${stats.twin} SD/HD twin, ${stats.station} local stations by call sign, ${stats.unmatched} with no guide source`
)
console.error(`Wrote ${out.length} channels to ${outFile}`)
