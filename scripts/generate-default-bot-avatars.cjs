#!/usr/bin/env node
/**
 * Renders the default library (renderer `defaults.json` + the vendored shape
 * gallery) into the eight shipped PNGs through the real engine.
 *
 *   pnpm exec electron scripts/generate-default-bot-avatars.cjs
 *   pnpm exec electron scripts/generate-default-bot-avatars.cjs --check
 *
 * Static export only: `renderAvatarSvg(definition, { color, reducedMotion: true })`
 * is rasterized by Chromium in an offscreen BrowserWindow with its own throwaway
 * profile under `_artifacts/completion-next/default-avatars/`. No extra
 * dependency, no network, no member data is touched.
 *
 * --check verifies the written files against the recorded receipt and never
 * re-renders.
 */
const { app, BrowserWindow } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const fsSync = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const RENDERER = path.join(ROOT, 'apps/desktop/src/renderer/src')
const CATALOG = path.join(RENDERER, 'assets/open-bot-avatar')
const DEFAULTS_FILE = path.join(CATALOG, 'defaults.json')
const ARTIFACTS = path.join(ROOT, '_artifacts/completion-next/default-avatars')
const RECEIPT_FILE = path.join(ARTIFACTS, 'receipt.json')
const BEFORE_FILE = path.join(ARTIFACTS, 'before.json')
const BACKUP_DIR = path.join(ARTIFACTS, 'backup')
const PROFILE_DIR = path.join(ARTIFACTS, `electron-profile-${crypto.randomUUID()}`)
const ICON_EDGE = 192
const ROLES = ['luoke', 'muwa', 'mianzhi', 'qilu']

// One profile, created before the app is ready. It stays in the artifacts
// directory on purpose: an owned trail beats a silently deleted temp dir.
const SESSION_DIR = path.join(PROFILE_DIR, 'session')
fsSync.mkdirSync(SESSION_DIR, { recursive: true })
app.setPath('userData', PROFILE_DIR)
app.setPath('sessionData', SESSION_DIR)
app.disableHardwareAcceleration()
// Destroying the only window must not end the run before the receipt is written;
// this script owns its single exit path below.
app.on('window-all-closed', () => {})

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
const relative = (file) => path.relative(ROOT, file).split(path.sep).join('/')

function pngSize(bytes) {
  if (bytes.length < 24 || bytes.readUInt32BE(12) !== 0x49484452) {
    throw new Error('not a PNG with an IHDR chunk')
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

async function loadInputs() {
  const defaults = JSON.parse(await fs.readFile(DEFAULTS_FILE, 'utf8'))
  const { validateAvatar, renderAvatarSvg } = await import('open-bot-avatar')
  const targets = []
  for (const role of ROLES) {
    const entry = defaults[role]
    if (!entry) throw new Error(`defaults.json is missing role ${role}`)
    const raw = JSON.parse(
      await fs.readFile(path.join(CATALOG, `${entry.id}.json`), 'utf8')
    )
    const result = validateAvatar(raw)
    if (!result.ok) throw new Error(`invalid shape ${entry.id} for ${role}`)
    targets.push({
      role,
      id: entry.id,
      color: entry.color,
      definition: result.value,
      renderAvatarSvg,
      files: [
        {
          kind: 'icon',
          path: path.join(RENDERER, `assets/characters/${role}/icon-192.png`)
        },
        {
          kind: 'portrait',
          path: path.join(ROOT, `crates/rovai-core/resources/member-avatars/${role}.png`)
        }
      ]
    })
  }
  return { defaults, targets }
}

/**
 * The originals to preserve. Once `before.json` exists it is authoritative:
 * every recorded backup is re-verified against its own sha256 and PNG size, so
 * a truncated target from an earlier run can never be mistaken for an original.
 * Only a first run, with no record at all, reads the targets themselves.
 */
async function snapshotOriginals(targets) {
  let recorded = null
  try {
    recorded = JSON.parse(await fs.readFile(BEFORE_FILE, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (recorded) {
    if (!Array.isArray(recorded.files) || recorded.files.length !== 8) {
      throw new Error(`${relative(BEFORE_FILE)} does not describe 8 originals`)
    }
    for (const record of recorded.files) {
      const bytes = await fs.readFile(
        path.join(BACKUP_DIR, record.relativePath.replace(/[\\/]/g, '__'))
      )
      if (sha256(bytes) !== record.sha256) {
        throw new Error(`backup for ${record.relativePath} does not match its recorded sha256`)
      }
      const size = pngSize(bytes)
      if (size.width !== record.size.width || size.height !== record.size.height) {
        throw new Error(
          `backup for ${record.relativePath} is ${size.width}x${size.height}, recorded ${record.size.width}x${record.size.height}`
        )
      }
    }
    return recorded.files
  }
  const records = []
  for (const target of targets) {
    for (const file of target.files) {
      const bytes = await fs.readFile(file.path)
      records.push({
        role: target.role,
        kind: file.kind,
        relativePath: relative(file.path),
        sha256: sha256(bytes),
        size: pngSize(bytes)
      })
    }
  }
  return records
}

/** Same-directory temp file, then rename: no target is ever left truncated. */
async function writeAtomic(file) {
  await fs.mkdir(path.dirname(file.path), { recursive: true })
  const temporary = `${file.path}.tmp-${process.pid}`
  await fs.writeFile(temporary, file.bytes)
  await fs.rename(temporary, file.path)
}

/**
 * The first run records the originals. Later runs keep that record untouched:
 * `wx` never overwrites, and an existing `before.json` is authoritative.
 */
async function ensureBackup(originals) {
  await fs.mkdir(BACKUP_DIR, { recursive: true })
  try {
    const existing = JSON.parse(await fs.readFile(BEFORE_FILE, 'utf8'))
    if (!Array.isArray(existing.files) || existing.files.length !== originals.length) {
      throw new Error(`${relative(BEFORE_FILE)} is present but does not describe 8 originals`)
    }
    console.log(`keeping existing originals record (${existing.files.length} files)`)
    return existing
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  for (const record of originals) {
    const destination = path.join(BACKUP_DIR, record.relativePath.replace(/[\\/]/g, '__'))
    try {
      await fs.copyFile(path.join(ROOT, record.relativePath), destination, fs.constants.COPYFILE_EXCL)
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  const record = { recordedAt: new Date().toISOString(), files: originals }
  await fs.writeFile(BEFORE_FILE, `${JSON.stringify(record, null, 2)}\n`, { flag: 'wx' })
  console.log(`recorded ${originals.length} originals at ${relative(BEFORE_FILE)}`)
  return record
}

async function rasterize(window, { svg, width, height }) {
  const svgBase64 = Buffer.from(svg, 'utf8').toString('base64')
  const dataUrl = await window.webContents.executeJavaScript(`(async () => {
    const image = new Image();
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('svg load failed'));
      image.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(svgBase64)};
    });
    const canvas = document.createElement('canvas');
    canvas.width = ${width};
    canvas.height = ${height};
    const context = canvas.getContext('2d');
    const edge = Math.min(${width}, ${height});
    context.clearRect(0, 0, ${width}, ${height});
    context.drawImage(image, (${width} - edge) / 2, (${height} - edge) / 2, edge, edge);
    return canvas.toDataURL('image/png');
  })()`)
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
}

/**
 * Renders all eight PNGs into memory. Nothing is written until every file has
 * a non-zero size, so a failed run cannot leave a half-updated set.
 */
async function renderAll(targets, originals) {
  const sizes = new Map(originals.map(record => [`${record.role}/${record.kind}`, record.size]))
  await app.whenReady()
  const window = new BrowserWindow({
    show: false,
    width: 256,
    height: 256,
    webPreferences: { offscreen: true, backgroundThrottling: false }
  })
  try {
    await window.loadURL('about:blank')
    const rendered = []
    for (const target of targets) {
      for (const file of target.files) {
        const original = sizes.get(`${target.role}/${file.kind}`)
        const width = file.kind === 'icon' ? ICON_EDGE : original.width
        const height = file.kind === 'icon' ? ICON_EDGE : original.height
        const svg = target.renderAvatarSvg(target.definition, {
          color: target.color,
          size: Math.max(width, height),
          reducedMotion: true
        })
        const bytes = await rasterize(window, { svg, width, height })
        const size = pngSize(bytes)
        if (size.width !== width || size.height !== height) {
          throw new Error(`${relative(file.path)}: rendered ${size.width}x${size.height}, expected ${width}x${height}`)
        }
        rendered.push({ path: file.path, kind: file.kind, bytes, size })
      }
    }
    return rendered
  } finally {
    window.destroy()
  }
}

async function checkReceipt() {
  const receipt = JSON.parse(await fs.readFile(RECEIPT_FILE, 'utf8'))
  const failures = []
  for (const entry of receipt.files) {
    const bytes = await fs.readFile(path.join(ROOT, entry.relativePath)).catch(() => null)
    if (!bytes) {
      failures.push(`${entry.relativePath}: missing`)
      continue
    }
    if (sha256(bytes) !== entry.sha256) failures.push(`${entry.relativePath}: sha256 differs`)
    const size = pngSize(bytes)
    if (size.width !== entry.width || size.height !== entry.height) {
      failures.push(`${entry.relativePath}: ${size.width}x${size.height} != ${entry.width}x${entry.height}`)
    }
  }
  if (failures.length > 0) {
    console.error(failures.join('\n'))
    throw new Error(`${failures.length} receipt mismatches`)
  }
  console.log(`receipt ok: ${receipt.files.length} files`)
}

async function generate() {
  const { defaults, targets } = await loadInputs()
  const originals = await snapshotOriginals(targets)
  await ensureBackup(originals)
  const rendered = await renderAll(targets, originals)
  for (const file of rendered) await writeAtomic(file)
  const receipt = {
    generatedAt: new Date().toISOString(),
    source: 'open-bot-avatar@0.2.0 renderAvatarSvg(..., { reducedMotion: true }) via offscreen Chromium canvas',
    package: 'open-bot-avatar@0.2.0',
    defaults: {
      file: 'apps/desktop/src/renderer/src/assets/open-bot-avatar/defaults.json',
      map: defaults
    },
    roles: targets.map(target => ({ role: target.role, id: target.id, color: target.color })),
    files: rendered.map(file => ({
      relativePath: relative(file.path),
      kind: file.kind,
      width: file.size.width,
      height: file.size.height,
      sha256: sha256(file.bytes)
    }))
  }
  await fs.writeFile(RECEIPT_FILE, `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(`wrote ${receipt.files.length} PNGs, receipt at ${relative(RECEIPT_FILE)}`)
}

const checkOnly = process.argv.includes('--check')
;(checkOnly ? checkReceipt() : generate())
  .then(() => app.quit())
  .catch(error => {
    console.error(error)
    // A failed run must be a failed exit; quit() alone exits 0.
    app.exit(1)
  })
