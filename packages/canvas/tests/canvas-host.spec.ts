import type { IncomingMessage, ServerResponse } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { handleCanvasRequest, resolveCanvasFile } from '../src/index.ts'

let root = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'roubaai-canvas-'))
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(join(root, 'index.html'), '<!doctype html><title>canvas</title>')
  await writeFile(join(root, 'assets', 'app.js'), 'console.log("canvas")')
  await writeFile(join(root, '..', 'outside.txt'), 'not the canvas')
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

function fakeResponse() {
  const chunks: Buffer[] = []
  const res = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  }) as Writable & { status: number; headers: Record<string, string>; writeHead(status: number, headers?: Record<string, string>): unknown }
  res.status = 0
  res.headers = {}
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers ?? {}
    return res
  }
  ;(res as unknown as { text: () => string }).text = () => Buffer.concat(chunks).toString('utf8')
  return res
}

async function get(path: string, config = { basePath: '/canvas', canvasRoot: root }): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const res = fakeResponse()
  await handleCanvasRequest(
    { method: 'GET', headers: {}, on: () => undefined } as unknown as IncomingMessage,
    res as unknown as ServerResponse,
    new URL(path, 'http://127.0.0.1:3080'),
    config,
  )
  await new Promise<void>((resolve) => {
    if (res.writableFinished) resolve()
    else res.on('finish', () => resolve())
  })
  return { status: res.status, headers: res.headers, text: (res as unknown as { text: () => string }).text() }
}

describe('canvas host: confinement', () => {
  it('refuses a path that leaves the frontend directory', () => {
    expect(resolveCanvasFile(root, '../outside.txt')).toBeUndefined()
    expect(resolveCanvasFile(root, 'assets/../../outside.txt')).toBeUndefined()
  })

  it('keeps a path inside the frontend directory', () => {
    expect(resolveCanvasFile(root, 'assets/app.js')).toBe(join(root, 'assets', 'app.js'))
  })
})

describe('canvas host: serving', () => {
  it('redirects the mount point to its directory form', async () => {
    const { status, headers } = await get('/canvas')
    expect(status).toBe(302)
    expect(headers['location']).toBe('/canvas/')
  })

  it('serves index.html at the mount root', async () => {
    const { status, text } = await get('/canvas/')
    expect(status).toBe(200)
    expect(text).toContain('<title>canvas</title>')
  })

  it('serves a bundle file with a script content type', async () => {
    const { status, headers } = await get('/canvas/assets/app.js')
    expect(status).toBe(200)
    expect(headers['content-type']).toBe('text/javascript; charset=utf-8')
  })

  it('falls back to index.html for an unknown route, so client routing works', async () => {
    const { status, text } = await get('/canvas/canvas/some-project')
    expect(status).toBe(200)
    expect(text).toContain('<title>canvas</title>')
  })

  it('lists the bundled node plugin in the manifest', async () => {
    const { status, text } = await get('/canvas/plugins/index.json')
    expect(status).toBe(200)
    expect(JSON.parse(text)).toEqual(['/canvas/plugins/roubaai-assets.js'])
  })

  it('serves the bundled node plugin itself', async () => {
    const { status, headers, text } = await get('/canvas/plugins/roubaai-assets.js')
    expect(status).toBe(200)
    expect(headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(text).toContain('roubaai-assets')
  })

  it('explains how to build the frontend when none is configured', async () => {
    const { status, text } = await get('/canvas/', { basePath: '/canvas', canvasRoot: '' })
    expect(status).toBe(503)
    expect(text).toContain('VITE_BASE=/canvas/')
  })

  it('honours a custom mount point', async () => {
    const { status, text } = await get('/workbench/', { basePath: '/workbench', canvasRoot: root })
    expect(status).toBe(200)
    expect(text).toContain('<title>canvas</title>')
  })
})
