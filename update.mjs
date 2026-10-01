#!/usr/bin/env node
// Regenerates guide.xml for the playlist using the iptv-org/epg grabber.
//
// Usage: node update.mjs [playlist.m3u] [--days N] [--pull]
//   playlist   defaults to ./playlist.m3u
//   --days N   days of guide to fetch from non-Pluto sites (default 3; Pluto always returns ~3)
//   --pull     update the epg repo (site scrapers break and get fixed often) before grabbing
//
// Each site is grabbed in its own process, so one site crashing or hanging cannot lose
// the others. Channels that come back empty from their best source are retried against
// their next-best sources, then everything is merged into guide.xml (+ guide.xml.gz).

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const EPG_DIR = path.join(ROOT, 'epg')
const WORK_DIR = path.join(ROOT, 'work')
const LOG_DIR = path.join(WORK_DIR, 'logs')
const MAX_RANK = 3 // how many fallback sources to try per channel
const PARALLEL_SITES = 4
const SITE_TIMEOUT_MS = 20 * 60 * 1000

const args = process.argv.slice(2)
const pull = args.includes('--pull')
const daysIdx = args.indexOf('--days')
const days = daysIdx === -1 ? 3 : Number(args[daysIdx + 1])
const playlist = path.resolve(
  args.find((a, i) => !a.startsWith('--') && (daysIdx === -1 || i !== daysIdx + 1)) ?? path.join(ROOT, 'playlist.m3u')
)

const log = msg => console.log(`[${new Date().toISOString()}] ${msg}`)
const attr = (line, name) => line.match(new RegExp(` ${name}="([^"]*)"`))[1].replace(/&amp;/g, '&')

if (pull) {
  log('Updating epg repo...')
  const ok = spawnSync('git', ['pull', '--ff-only'], { cwd: EPG_DIR, stdio: 'inherit' }).status === 0
  if (ok) spawnSync('npm', ['install'], { cwd: EPG_DIR, stdio: 'inherit' })
}

fs.rmSync(WORK_DIR, { recursive: true, force: true })
fs.mkdirSync(LOG_DIR, { recursive: true })

const channels = new Map() // id -> <channel> element
const programmes = new Map() // id -> [<programme> elements]

function collect(file) {
  if (!fs.existsSync(file)) return
  const xml = fs.readFileSync(file, 'utf8')
  for (const m of xml.matchAll(/<channel id="([^"]*)">[\s\S]*?<\/channel>/g)) {
    if (!channels.has(m[1])) channels.set(m[1], m[0])
  }
  for (const m of xml.matchAll(/<programme [^>]*?channel="([^"]*)"[^>]*?(?:\/>|>[\s\S]*?<\/programme>)/g)) {
    if (!m[0].includes('<title')) continue // some sites emit empty, untitled slots
    if (!programmes.has(m[1])) programmes.set(m[1], [])
    programmes.get(m[1]).push(m[0])
  }
}

// i.mjh.nz serves a few very large XML files that the grabber keeps in memory,
// so each of its files gets a process of its own.
function groupKey(line) {
  const site = attr(line, 'site')
  return site === 'i.mjh.nz' ? `${site}_${attr(line, 'site_id').split('#')[0].replace(/\W+/g, '-')}` : site
}

function grabGroup(name, lines) {
  const channelsFile = path.join(WORK_DIR, `${name}.channels.xml`)
  const outFile = path.join(WORK_DIR, `${name}.xml`)
  fs.writeFileSync(channelsFile, `<?xml version="1.0" encoding="UTF-8"?>\n<channels>\n${lines.join('\n')}\n</channels>\n`)
  // Pluto returns its whole schedule in one request, so it never needs more than one "day".
  const grabDays = name.endsWith('pluto.tv') ? 1 : days
  const maxConnections = name.includes('i.mjh.nz') ? 1 : 5
  return new Promise(resolve => {
    const logFile = fs.openSync(path.join(LOG_DIR, `${name}.log`), 'w')
    const child = spawn(
      'npm',
      ['run', 'grab', '---', `--channels=${channelsFile}`, `--output=${outFile}`, `--days=${grabDays}`, `--maxConnections=${maxConnections}`],
      {
        cwd: EPG_DIR,
        stdio: ['ignore', logFile, logFile],
        detached: true, // own process group, so a timeout can kill npm and the grabber together
        env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' }
      }
    )
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {}
    }, SITE_TIMEOUT_MS)
    child.on('close', code => {
      clearTimeout(timer)
      fs.closeSync(logFile)
      collect(outFile)
      const ids = lines.map(l => attr(l, 'xmltv_id'))
      const ok = ids.filter(id => programmes.get(id)?.length).length
      log(`  ${name.replace(/^rank\d+\./, '')}: ${ok}/${ids.length} channels with programmes${code === 0 ? '' : ` (exit ${code ?? 'killed'})`}`)
      resolve()
    })
  })
}

async function pool(tasks, size) {
  const queue = tasks.slice()
  await Promise.all(Array.from({ length: size }, async () => {
    while (queue.length) await queue.shift()()
  }))
}

let pending = null // ids still without programmes; null = all
for (let rank = 0; rank <= MAX_RANK; rank++) {
  const all = path.join(WORK_DIR, `rank${rank}.all.channels.xml`)
  const buildArgs = [path.join(ROOT, 'build-channels.mjs'), playlist, '--rank', String(rank), '--out', all]
  if (pending) {
    const only = path.join(WORK_DIR, 'pending.txt')
    fs.writeFileSync(only, [...pending].join('\n'))
    buildArgs.push('--only', only)
  }
  if (spawnSync('node', buildArgs, { stdio: 'inherit' }).status !== 0) process.exit(1)

  const lines = fs.readFileSync(all, 'utf8').split('\n').filter(l => l.includes('<channel '))
  if (!lines.length) break

  const groups = new Map()
  for (const line of lines) {
    const key = groupKey(line)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(line)
  }
  log(`Pass ${rank + 1}: grabbing ${lines.length} channels from ${groups.size} sources`)
  // Biggest groups first so the long ones overlap with everything else.
  const tasks = [...groups]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([key, groupLines]) => () => grabGroup(`rank${rank}.${key}`, groupLines))
  await pool(tasks, PARALLEL_SITES)

  const tried = lines.map(l => attr(l, 'xmltv_id'))
  pending = new Set([...(pending ?? tried)].filter(id => !programmes.get(id)?.length))
  log(`Pass ${rank + 1} done: ${pending.size} channels still without programmes`)
  if (!pending.size) break
}

// Sites fetched day by day repeat the programme that spans midnight, and a few list
// programmes that run into the next one. Drop the repeats and trim the overruns.
function tidy(list) {
  const times = el => el.match(/^<programme start="(\d{14}) ([+-]\d{4})" stop="(\d{14}) ([+-]\d{4})"/)
  const sorted = list
    .map(el => ({ el, t: times(el) }))
    .filter(p => p.t && p.t[2] === '+0000' && p.t[4] === '+0000')
  if (sorted.length !== list.length) return list // unexpected time format: leave untouched
  sorted.sort((a, b) => a.t[1].localeCompare(b.t[1]))
  const out = []
  for (const p of sorted) {
    const prev = out.at(-1)
    if (prev && p.t[1] === prev.t[1]) continue
    if (prev && p.t[1] < prev.t[3]) {
      prev.el = prev.el.replace(`stop="${prev.t[3]} `, `stop="${p.t[1]} `)
      prev.t[3] = p.t[1]
    }
    out.push(p)
  }
  return out.map(p => p.el)
}
for (const [id, list] of programmes) programmes.set(id, tidy(list))

const withGuide = [...channels.keys()].filter(id => programmes.get(id)?.length)
if (!withGuide.length) {
  console.error('No programmes were grabbed; leaving the existing guide.xml untouched.')
  process.exit(1)
}

const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const xml =
  `<?xml version="1.0" encoding="UTF-8" ?><tv date="${date}">\n` +
  withGuide.map(id => channels.get(id)).join('\n') +
  '\n' +
  withGuide.flatMap(id => programmes.get(id)).join('\n') +
  '\n</tv>\n'

const out = path.join(ROOT, 'guide.xml')
fs.writeFileSync(`${out}.tmp`, xml)
fs.renameSync(`${out}.tmp`, out)
fs.writeFileSync(`${out}.gz`, zlib.gzipSync(xml))
fs.writeFileSync(path.join(ROOT, 'no-programmes.txt'), [...(pending ?? [])].sort().join('\n') + '\n')

const total = withGuide.reduce((n, id) => n + programmes.get(id).length, 0)
log(`Wrote ${out}: ${withGuide.length} channels, ${total} programmes`)
if (pending?.size) log(`${pending.size} mapped channels returned no programmes (see no-programmes.txt)`)
