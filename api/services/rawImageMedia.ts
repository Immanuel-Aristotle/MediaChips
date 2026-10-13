import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import {exiftool, ExifTool, type BinaryField} from 'exiftool-vendored'
import sharp, {type Sharp} from 'sharp'
import {getDisplayDimensions} from './imageGeometry'
import {writeFileAtomically} from './safeFileReplace'

export type RawProcessingMode = 'embedded' | 'develop'

const RAW_PREVIEW_TAGS = ['JpgFromRaw2', 'JpgFromRaw', 'PreviewImage'] as const
const RAW_PIPELINE_CACHE_VERSION = 'rw2-preview-v1'
const RAW_OPERATION_TIMEOUT_SECONDS = 120
const RAW_DEVELOP_QUALITY = 95

const modeValue = process.env.MEDIACHIPS_RAW_MODE ?? 'embedded'
if (modeValue !== 'embedded' && modeValue !== 'develop') {
  throw new Error(`MEDIACHIPS_RAW_MODE must be embedded or develop, received: ${modeValue}`)
}

export const rawProcessingMode: RawProcessingMode = modeValue

const rawExifTool = new ExifTool({
  maxProcs: 2,
  taskTimeoutMillis: RAW_OPERATION_TIMEOUT_SECONDS * 1000,
})

let activeRawOperations = 0
const waitingRawOperations: Array<() => void> = []

async function withRawOperation<T>(operation: () => Promise<T>): Promise<T> {
  if (activeRawOperations >= 2) {
    if (waitingRawOperations.length >= 8) {
      throw new Error('RW2 processing queue is full; retry after current previews finish')
    }
    await new Promise<void>((resolve) => waitingRawOperations.push(resolve))
  } else {
    activeRawOperations += 1
  }

  try {
    return await operation()
  } finally {
    const next = waitingRawOperations.shift()
    if (next) next()
    else activeRawOperations -= 1
  }
}

export function isRawImagePath(filePath: string | null | undefined): boolean {
  return /\.rw2$/i.test(String(filePath || ''))
}

function formatCause(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseOrientation(value: unknown): number {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 8) {
    return value
  }

  const normalized = String(value || '').toLowerCase()
  const orientationByDescription: Record<string, number> = {
    'horizontal (normal)': 1,
    'mirror horizontal': 2,
    'rotate 180': 3,
    'mirror vertical': 4,
    'mirror horizontal and rotate 270 cw': 5,
    'rotate 90 cw': 6,
    'mirror horizontal and rotate 90 cw': 7,
    'rotate 270 cw': 8,
  }

  return orientationByDescription[normalized] ?? 1
}

export async function getRawImageMetadata(filePath: string) {
  let tags
  try {
    tags = await rawExifTool.read(filePath, {numericTags: ['Orientation']})
  } catch (error) {
    throw new Error(`Unable to read RW2 metadata for ${filePath}: ${formatCause(error)}`)
  }

  const width = Number(tags.ImageWidth)
  const height = Number(tags.ImageHeight)
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`RW2 metadata has no valid source dimensions: ${filePath}`)
  }

  const orientation = parseOrientation(tags.Orientation)
  const display = getDisplayDimensions(width, height, orientation)
  return {width: display.width, height: display.height, orientation}
}

async function extractEmbeddedPreview(filePath: string): Promise<Buffer> {
  let tags
  try {
    tags = await rawExifTool.read(filePath)
  } catch (error) {
    throw new Error(`Unable to inspect embedded RW2 previews in ${filePath}: ${formatCause(error)}`)
  }

  const tagValues = tags as unknown as Record<string, unknown>
  for (const tagName of RAW_PREVIEW_TAGS) {
    const field = tagValues[tagName] as BinaryField | undefined
    if (!field || typeof field !== 'object' || !Number.isFinite(field.bytes) || field.bytes <= 0) {
      continue
    }

    try {
      const buffer = await rawExifTool.extractBinaryTagToBuffer(tagName, filePath)
      if (!buffer.length) {
        throw new Error('ExifTool returned an empty preview buffer')
      }
      return buffer
    } catch (error) {
      throw new Error(`RW2 preview tag ${tagName} exists but extraction failed for ${filePath}: ${formatCause(error)}`)
    }
  }

  throw new Error(`RW2 contains no supported embedded JPEG preview: ${filePath}`)
}

function applyExifOrientationToSharp(pipeline: Sharp, orientation: number): Sharp {
  switch (orientation) {
    case 2:
      return pipeline.flop()
    case 3:
      return pipeline.rotate(180)
    case 4:
      return pipeline.flip()
    case 5:
      return pipeline.flop().rotate(90)
    case 6:
      return pipeline.rotate(90)
    case 7:
      return pipeline.flop().rotate(270)
    case 8:
      return pipeline.rotate(270)
    default:
      return pipeline
  }
}

async function renderRawImage(filePath: string, maxEdge?: number, quality = 85): Promise<Buffer> {
  if (rawProcessingMode === 'embedded') {
    const preview = await extractEmbeddedPreview(filePath)
    const metadata = await sharp(preview, {
      failOn: 'error',
    }).timeout({seconds: RAW_OPERATION_TIMEOUT_SECONDS}).metadata()
    if (metadata.format !== 'jpeg' || !metadata.width || !metadata.height) {
      throw new Error(`Embedded RW2 preview is not a decodable JPEG: ${filePath}`)
    }

    let pipeline = sharp(preview, {
      failOn: 'error',
    }).timeout({seconds: RAW_OPERATION_TIMEOUT_SECONDS})
    pipeline = metadata.orientation
      ? pipeline.rotate()
      : applyExifOrientationToSharp(pipeline, (await getRawImageMetadata(filePath)).orientation)
    if (maxEdge) {
      pipeline = pipeline.resize({width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true})
    }
    return pipeline.jpeg({quality, mozjpeg: true}).toBuffer()
  }

  try {
    let pipeline = sharp(filePath, {
      failOn: 'error',
      limitInputPixels: false,
    }).timeout({seconds: RAW_OPERATION_TIMEOUT_SECONDS}).rotate()
    if (maxEdge) {
      pipeline = pipeline.resize({width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true})
    }
    return await pipeline.jpeg({quality: RAW_DEVELOP_QUALITY, mozjpeg: true}).toBuffer()
  } catch (error) {
    throw new Error(`RW2 develop mode could not decode pixels through the configured Sharp/libvips pipeline: ${formatCause(error)}`)
  }
}

export async function createRawViewerPreview(filePath: string, maxEdge: number) {
  const buffer = await withRawOperation(() => renderRawImage(filePath, maxEdge, 82))
  const metadata = await sharp(buffer).metadata()
  if (!metadata.width || !metadata.height) {
    throw new Error(`Generated RW2 viewer preview has no dimensions: ${filePath}`)
  }
  return {buffer, width: metadata.width, height: metadata.height}
}

function rawManifestPath(dbPath: string, id: string | number): string {
  return path.join(dbPath, 'media/images/thumbs', `${id}.raw.json`)
}

async function sourceDigest(filePath: string): Promise<string> {
  const digest = crypto.createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(filePath)
    stream.on('data', (chunk: Buffer) => digest.update(chunk))
    stream.on('error', reject)
    stream.on('end', resolve)
  })
  return digest.digest('hex')
}

async function currentFingerprint(filePath: string) {
  const stats = await fs.promises.stat(filePath)
  return {
    version: RAW_PIPELINE_CACHE_VERSION,
    mode: rawProcessingMode,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    sha256: await sourceDigest(filePath),
  }
}

export async function isRawThumbCurrent(filePath: string, id: string | number, dbPath: string): Promise<boolean> {
  const manifestPath = rawManifestPath(dbPath, id)
  return withRawOperation(async () => {
    try {
      const stored = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as Record<string, unknown>
      const current = await currentFingerprint(filePath)
      return Object.entries(current).every(([key, value]) => stored[key] === value)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw new Error(`Unable to validate RW2 thumbnail cache ${manifestPath}: ${formatCause(error)}`)
    }
  })
}

export async function createRawThumb(filePath: string, id: string | number, dbPath: string): Promise<string> {
  return withRawOperation(async () => {
    const thumbPath = path.join(dbPath, 'media/images/thumbs', `${id}.jpg`)
    const fingerprint = await currentFingerprint(filePath)
    const preview = await renderRawImage(filePath, 320, 85)
    await writeFileAtomically(thumbPath, async (tempPath) => fs.promises.writeFile(tempPath, preview))
    await writeFileAtomically(rawManifestPath(dbPath, id), async (tempPath) => (
      fs.promises.writeFile(tempPath, JSON.stringify(fingerprint), 'utf8')
    ))
    return thumbPath
  })
}
