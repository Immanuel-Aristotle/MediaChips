/**
 * @vitest-environment node
 */
import sharp from 'sharp'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

const exiftoolState = vi.hoisted(() => ({
  read: vi.fn(),
  extractBinaryTagToBuffer: vi.fn(),
}))

vi.mock('exiftool-vendored', () => ({
  ExifTool: class {
    read(...args: unknown[]) {
      return exiftoolState.read(...args)
    }

    extractBinaryTagToBuffer(...args: unknown[]) {
      return exiftoolState.extractBinaryTagToBuffer(...args)
    }
  },
}))

describe('rawImageMedia', () => {
  beforeEach(() => {
    vi.resetModules()
    exiftoolState.read.mockReset()
    exiftoolState.extractBinaryTagToBuffer.mockReset()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('extracts the highest priority embedded preview and returns JPEG', async () => {
    vi.stubEnv('MEDIACHIPS_RAW_MODE', 'embedded')
    exiftoolState.read.mockResolvedValueOnce({
      ImageWidth: 6000,
      ImageHeight: 4000,
      Orientation: 6,
      JpgFromRaw2: {bytes: 1000},
    }).mockResolvedValueOnce({ImageWidth: 6000, ImageHeight: 4000, Orientation: 6})
    const cameraPreview = await sharp({
      create: {width: 20, height: 10, channels: 3, background: {r: 90, g: 110, b: 130}},
    }).jpeg().toBuffer()
    exiftoolState.extractBinaryTagToBuffer.mockResolvedValue(cameraPreview)

    const raw = await import('./rawImageMedia')
    const result = await raw.createRawViewerPreview('/media/sample.RW2', 512)
    const metadata = await sharp(result.buffer).metadata()

    expect(raw.rawProcessingMode).toBe('embedded')
    expect(exiftoolState.extractBinaryTagToBuffer).toHaveBeenCalledWith('JpgFromRaw2', '/media/sample.RW2')
    expect(metadata.format).toBe('jpeg')
    expect(result.width).toBe(10)
    expect(result.height).toBe(20)
  })

  it('reports a missing embedded preview distinctly from extraction failure', async () => {
    vi.stubEnv('MEDIACHIPS_RAW_MODE', 'embedded')
    exiftoolState.read.mockResolvedValue({})
    const raw = await import('./rawImageMedia')
    await expect(raw.createRawViewerPreview('/media/no-preview.rw2', 512))
      .rejects.toThrow('contains no supported embedded JPEG preview')
    expect(exiftoolState.extractBinaryTagToBuffer).not.toHaveBeenCalled()
  })

  it('surfaces failure extracting a tag that metadata reports as present', async () => {
    vi.stubEnv('MEDIACHIPS_RAW_MODE', 'embedded')
    exiftoolState.read.mockResolvedValue({JpgFromRaw2: {bytes: 32}})
    exiftoolState.extractBinaryTagToBuffer.mockRejectedValue(new Error('ExifTool failed'))
    const raw = await import('./rawImageMedia')

    await expect(raw.createRawViewerPreview('/media/broken.rw2', 512))
      .rejects.toThrow('JpgFromRaw2 exists but extraction failed')
  })

  it('uses RAW dimensions and EXIF orientation instead of embedded preview dimensions', async () => {
    vi.stubEnv('MEDIACHIPS_RAW_MODE', 'embedded')
    exiftoolState.read.mockResolvedValue({ImageWidth: 6000, ImageHeight: 4000, Orientation: 6})
    const raw = await import('./rawImageMedia')

    await expect(raw.getRawImageMetadata('/media/sample.rw2')).resolves.toEqual({
      width: 4000,
      height: 6000,
      orientation: 6,
    })
  })

  it('does not suppress develop-mode decoder errors', async () => {
    vi.stubEnv('MEDIACHIPS_RAW_MODE', 'develop')
    const raw = await import('./rawImageMedia')

    await expect(raw.createRawViewerPreview('/not-a-raw-file.rw2', 512))
      .rejects.toThrow('develop mode could not decode pixels through the configured Sharp/libvips pipeline')
  })

  it('recognizes upper-case RW2 suffixes', async () => {
    vi.stubEnv('MEDIACHIPS_RAW_MODE', 'embedded')
    const raw = await import('./rawImageMedia')
    expect(raw.isRawImagePath('/media/Camera.RW2')).toBe(true)
    expect(raw.isRawImagePath('/media/Camera.jpg')).toBe(false)
  })

  it('keeps RAW thumbnail cache under app data and invalidates it when source bytes change', async () => {
    vi.stubEnv('MEDIACHIPS_RAW_MODE', 'embedded')
    const inputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-raw-input-'))
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-raw-data-'))
    const sourcePath = path.join(inputDir, 'sample.rw2')
    fs.writeFileSync(sourcePath, 'first source contents')
    exiftoolState.read.mockResolvedValue({
      ImageWidth: 6000,
      ImageHeight: 4000,
      Orientation: 1,
      JpgFromRaw2: {bytes: 1000},
    })
    const cameraPreview = await sharp({
      create: {width: 20, height: 10, channels: 3, background: {r: 90, g: 110, b: 130}},
    }).jpeg().toBuffer()
    exiftoolState.extractBinaryTagToBuffer.mockResolvedValue(cameraPreview)

    try {
      const raw = await import('./rawImageMedia')
      const thumbPath = await raw.createRawThumb(sourcePath, 321, dataDir)
      expect(thumbPath).toBe(path.join(dataDir, 'media/images/thumbs/321.jpg'))
      expect(await raw.isRawThumbCurrent(sourcePath, 321, dataDir)).toBe(true)
      expect(fs.existsSync(path.join(dataDir, 'media/images/thumbs/321.raw.json'))).toBe(true)
      expect(fs.readdirSync(inputDir)).toEqual(['sample.rw2'])

      fs.writeFileSync(sourcePath, 'changed source contents')
      expect(await raw.isRawThumbCurrent(sourcePath, 321, dataDir)).toBe(false)
    } finally {
      fs.rmSync(inputDir, {recursive: true, force: true})
      fs.rmSync(dataDir, {recursive: true, force: true})
    }
  })
})
