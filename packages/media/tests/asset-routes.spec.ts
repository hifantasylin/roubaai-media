import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ASSETS_ROUTE_PREFIX, assetsRoot, handleAssetsRequest, parseRange, resolveAssetPath } from '../src/asset-routes.ts'
import { createTempAssetsRoot } from './temp-assets.ts'

let root = ''
const assets = createTempAssetsRoot('roubaai-assets-')

beforeEach(async () => {
  root = assets.install()
  await mkdir(join(root, 'proj', '01_角色'), { recursive: true })
  await writeFile(join(root, 'proj', '01_角色', 'a.png'), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]))
  await writeFile(join(root, 'proj', 'clip.mp4'), Buffer.from('video'))
  await writeFile(join(dirname(root), 'secret.txt'), 'not an asset')
})

afterEach(async () => {
  await assets.restore()
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
    expect(resolveAssetPath('/etc/passwd')).toBe(join(root, 'etc', 'passwd'))
  })

  it('keeps a path inside the tree and answers the serving root', () => {
    expect(resolveAssetPath('proj/clip.mp4')).toBe(join(root, 'proj', 'clip.mp4'))
    expect(assetsRoot()).toBe(root)
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

describe('asset routes: library', () => {
  it('lists the whole tree as projects and files', async () => {
    const { status, json } = await get('/library')
    expect(status).toBe(200)
    const projects = json['projects'] as Array<Record<string, unknown>>
    expect(projects).toHaveLength(1)
    expect(projects[0]).toMatchObject({ name: 'proj', files: 2, bytes: 13 })
    // The newest image is what the library shows as the project's cover.
    expect(String(projects[0]?.['cover'])).toBe('proj/01_角色/a.png')
    const files = json['files'] as Array<Record<string, unknown>>
    expect(files.map(file => file['path']).sort()).toEqual(['proj/01_角色/a.png', 'proj/clip.mp4'])
    expect(files.find(file => file['name'] === 'a.png')).toMatchObject({ project: 'proj', group: '01_角色', kind: 'image', size: 8 })
    // A file filed directly in the project has no group.
    expect(files.find(file => file['name'] === 'clip.mp4')).toMatchObject({ group: '', kind: 'video' })
  })

  it('keeps the tree bookkeeping out of the library', async () => {
    await writeFile(join(root, 'proj', 'assets-index.md'), '| 类别 |')
    await writeFile(join(root, 'proj', 'media-cost.jsonl'), '{}\n')
    const { json } = await get('/library')
    const paths = (json['files'] as Array<Record<string, unknown>>).map(file => file['path'])
    expect(paths).not.toContain('proj/assets-index.md')
    expect(paths).not.toContain('proj/media-cost.jsonl')
  })

  it('answers an empty library when the tree does not exist', async () => {
    // Removing the whole tree is how this spec stands in for "no library yet".
    await rm(root, { recursive: true, force: true })
    const { status, json } = await get('/library')
    expect(status).toBe(200)
    expect(json).toMatchObject({ ok: true, projects: [], files: [], truncated: false })
  })

  it('orders projects by their newest file', async () => {
    await mkdir(join(root, 'older'), { recursive: true })
    await writeFile(join(root, 'older', 'x.png'), Buffer.from([1]))
    const past = new Date(Date.now() - 86_400_000)
    await utimes(join(root, 'older', 'x.png'), past, past)
    const { json } = await get('/library')
    expect((json['projects'] as Array<Record<string, unknown>>).map(project => project['name'])).toEqual(['proj', 'older'])
  })

  it('never hands out an absolute path', async () => {
    const { json } = await get('/library')
    expect(JSON.stringify(json)).not.toContain(root)
  })
})

describe('asset routes: upload', () => {
  /** One multipart body with a project field and one file part. */
  function multipart(project: string, filename: string, content: Buffer): { body: Buffer; contentType: string } {
    const boundary = '----roubaai-test'
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="project"\r\n\r\n${project}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: image/png\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ])
    return { body, contentType: `multipart/form-data; boundary=${boundary}` }
  }

  async function post(payload: { body: Buffer; contentType: string }): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = fakeResponse()
    // A request stream the handler can attach its body listeners to, then read.
    const request = new Readable({
      read() {
        this.push(payload.body)
        this.push(null)
      },
    })
    Object.assign(request, { method: 'POST', headers: { 'content-type': payload.contentType } })
    await handleAssetsRequest(
      request as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      new URL(`${ASSETS_ROUTE_PREFIX}/upload`, 'http://127.0.0.1:3080'),
    )
    return { status: res.status, json: JSON.parse(Buffer.concat(res.chunks).toString('utf8')) as Record<string, unknown> }
  }

  it('lands an uploaded file through the asset landing path', async () => {
    const { status, json } = await post(multipart('proj', 'poster.png', Buffer.from('IMAGE')))
    expect(status).toBe(200)
    expect(json['ok']).toBe(true)
    const saved = json['saved'] as Array<Record<string, unknown>>
    expect(String(saved[0]?.['relative'])).toBe('proj/08_上传/poster.png')
    // Written through landing, so the project index records it too.
    const index = await readFile(join(root, 'proj', 'assets-index.md'), 'utf8')
    expect(index).toContain('poster.png')
    // An upload answers relative paths only, like every other listing here.
    expect(JSON.stringify(json)).not.toContain(root)
  })

  it('refuses a project that escapes the asset root', async () => {
    const { status, json } = await post(multipart('../outside', 'poster.png', Buffer.from('IMAGE')))
    expect(status).toBe(400)
    expect(String(json['error'])).toContain('project')
  })

  it('takes POST only', async () => {
    const { status } = await get('/upload')
    expect(status).toBe(405)
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
