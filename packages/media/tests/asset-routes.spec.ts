import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ASSETS_ROUTE_PREFIX, assetsRoot, handleAssetsRequest, parseRange, resolveAssetPath } from '../src/asset-routes.ts'

let root = ''
const previous = process.env['DSH_MEDIA_ASSETS_ROOT']

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'roubaai-assets-'))
  process.env['DSH_MEDIA_ASSETS_ROOT'] = root
  await mkdir(join(root, '.assets', 'proj', '01_角色'), { recursive: true })
  await writeFile(join(root, '.assets', 'proj', '01_角色', 'a.png'), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))
  await writeFile(join(root, '.assets', 'proj', 'clip.mp4'), Buffer.from('video'))
  await writeFile(join(root, 'secret.txt'), 'not an asset')
})

afterEach(async () => {
  if (previous === undefined) delete process.env['DSH_MEDIA_ASSETS_ROOT']
  else process.env['DSH_MEDIA_ASSETS_ROOT'] = previous
  await rm(root, { recursive: true, force: true })
})

function fakeRequest(method = 'GET', headers: Record<string, string> = {}) {
  return { method, headers, on: () => undefined, pipe: () => undefined }
}

/** A response stand-in that is a real Writable, so `pipe()` from a file stream works. */
function fakeResponse() {
  const chunks: Buffer[] = []
  const res = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  }) as Writable & {
    status: number
    headers: Record<string, string>
    chunks: Buffer[]
    writeHead(status: number, headers?: Record<string, string>): unknown
  }
  res.status = 0
  res.headers = {}
  res.chunks = chunks
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers ?? {}
    return res
  }
  return res
}

async function get(path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string>; json: Record<string, unknown> }> {
  const res = fakeResponse()
  await handleAssetsRequest(
    fakeRequest('GET', headers) as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    new URL(`${ASSETS_ROUTE_PREFIX}${path}`, 'http://127.0.0.1:3080'),
  )
  // A piped file body lands after the handler returns; wait for the response to
  // finish so a body assertion never races the stream.
  await new Promise<void>((resolve) => {
    if (res.writableFinished) resolve()
    else res.on('finish', () => resolve())
  })
  // Only a JSON answer is parsed; a served file body is bytes, not a document.
  const text = Buffer.concat(res.chunks).toString('utf8')
  const isJson = (res.headers['content-type'] ?? '').includes('application/json')
  return {
    status: res.status,
    headers: res.headers,
    json: isJson && text !== '' ? JSON.parse(text) as Record<string, unknown> : {},
  }
}

describe('asset routes: confinement', () => {
  it('refuses a path that climbs out of the asset root', () => {
    expect(resolveAssetPath('../../secret.txt')).toBeUndefined()
    expect(resolveAssetPath('proj/../../../secret.txt')).toBeUndefined()
  })

  it('refuses a drive letter and keeps a leading-slash path inside the root', () => {
    expect(resolveAssetPath('C:/Windows/win.ini')).toBeUndefined()
    // A POSIX-style absolute path is not absolute on Windows; it is stripped to a
    // relative one, so it lands inside the tree instead of at the filesystem root.
    expect(resolveAssetPath('/etc/passwd')).toBe(join(root, '.assets', 'etc', 'passwd'))
  })

  it('keeps a path inside the tree and answers the serving root', () => {
    expect(resolveAssetPath('proj/clip.mp4')).toBe(join(root, '.assets', 'proj', 'clip.mp4'))
    expect(assetsRoot()).toBe(join(root, '.assets'))
  })

  it('answers 400 for an escaping file request instead of 404, so the refusal is visible', async () => {
    const { status } = await get('/file?path=../secret.txt')
    expect(status).toBe(400)
  })
})

describe('asset routes: tree', () => {
  it('lists directories before files and labels each entry kind', async () => {
    const { status, json } = await get('/tree?path=proj')
    expect(status).toBe(200)
    const entries = json['entries'] as Array<{ name: string; dir: boolean; kind?: string }>
    expect(entries.map((entry) => entry.name)).toEqual(['01_角色', 'clip.mp4'])
    expect(entries[0]?.dir).toBe(true)
    expect(entries[1]).toMatchObject({ dir: false, kind: 'video' })
  })

  it('lists the root when no path is given and never hands out an absolute path', async () => {
    const { json } = await get('/tree')
    expect((json['entries'] as Array<{ name: string }>).map((entry) => entry.name)).toEqual(['proj'])
    expect(JSON.stringify(json)).not.toContain(root)
  })

  it('answers 404 for a directory that does not exist', async () => {
    const { status } = await get('/tree?path=nope')
    expect(status).toBe(404)
  })
})

describe('asset routes: file', () => {
  it('serves a file with its media type, byte length and a range-capable head', async () => {
    const { status, headers } = await get('/file?path=proj/01_角色/a.png')
    expect(status).toBe(200)
    expect(headers['content-type']).toBe('image/png')
    expect(headers['content-length']).toBe('8')
    expect(headers['accept-ranges']).toBe('bytes')
  })

  it('answers 206 with a content-range for a ranged video request', async () => {
    const { status, headers } = await get('/file?path=proj/clip.mp4', { range: 'bytes=0-2' })
    expect(status).toBe(206)
    expect(headers['content-type']).toBe('video/mp4')
    expect(headers['content-range']).toBe('bytes 0-2/5')
    expect(headers['content-length']).toBe('3')
  })

  it('parses a single byte range and clamps the tail', () => {
    expect(parseRange('bytes=0-3', 8)).toEqual({ start: 0, end: 3 })
    expect(parseRange('bytes=4-', 8)).toEqual({ start: 4, end: 7 })
    expect(parseRange('bytes=-2', 8)).toEqual({ start: 6, end: 7 })
    expect(parseRange('bytes=9-12', 8)).toBeUndefined()
    expect(parseRange(undefined, 8)).toBeUndefined()
  })

  it('answers 404 for a missing file', async () => {
    const { status } = await get('/file?path=proj/missing.png')
    expect(status).toBe(404)
  })
})
