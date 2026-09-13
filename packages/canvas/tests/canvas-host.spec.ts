import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import type { Context } from '@deepseek-ai/cordis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply, bundledCanvasRoot, handleCanvasRequest, handlePanelInfoRequest, pickCanvasRoot, resolveCanvasFile } from '../src/index.ts'

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

async function get(path: string, config = { basePath: '/canvas', canvasRoot: root, openaiBasePath: '/api/roubaai-media/openai' }): Promise<{ status: number; headers: Record<string, string>; text: string }> {
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

describe('canvas host: which frontend gets served', () => {
  const anything = () => true
  const nothing = () => false
  const bundled = 'C:/package/frontend'

  it('prefers a configured root while it holds a build', () => {
    const choice = pickCanvasRoot('C:/checkout/web/dist', bundled, anything)
    expect(choice.source).toBe('configured')
    expect(choice.root).toContain('web')
  })

  it('falls back to the build shipped in the package when the configured root is gone', () => {
    // The reported bug: a packaged install carried the packaging machine's path.
    const choice = pickCanvasRoot('C:/packaging-machine/web/dist', bundled, directory => directory === bundled)
    expect(choice.source).toBe('bundled')
    expect(choice.root).toBe(bundled)
    expect(choice.requested).toContain('packaging-machine')
  })

  it('serves the shipped build when nothing is configured', () => {
    const choice = pickCanvasRoot(undefined, bundled, anything)
    expect(choice.source).toBe('bundled')
    expect(choice.root).toBe(bundled)
    expect(choice.requested).toBe('')
  })

  it('treats a blank canvasRoot as unconfigured', () => {
    expect(pickCanvasRoot('   ', bundled, anything).source).toBe('bundled')
  })

  it('reports nothing to serve when neither the configured root nor the shipped build exists', () => {
    const choice = pickCanvasRoot('C:/gone', bundled, nothing)
    expect(choice.source).toBe('missing')
    expect(choice.root).toBe('')
  })

  it('serves the frontend the package actually ships, once it has been synced in', async () => {
    const shipped = bundledCanvasRoot()
    const hasShipped = existsSync(join(shipped, 'index.html'))
    const choice = pickCanvasRoot(undefined)
    const { status, text } = await get('/canvas/', {
      basePath: '/canvas',
      canvasRoot: choice.root,
      requestedCanvasRoot: choice.requested,
      openaiBasePath: '/api/roubaai-media/openai',
    })
    if (hasShipped) {
      // A release build: the tarball carries the workbench, so an install with no
      // configuration of its own serves a real app.
      expect(status).toBe(200)
      expect(text).toContain('/canvas/assets/')
      expect(text).toContain('id="root"')
      return
    }
    // A source checkout that never ran `sync:frontend` has nothing to serve, and
    // the explanation must name the path it looked in rather than claim that no
    // canvasRoot was configured.
    expect(status).toBe(503)
    expect(text).toContain('no canvas frontend to serve')
    expect(text).toContain(shipped)
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

  it('serves a config.js that points generation at the host, not at a browser key', async () => {
    const { status, headers, text } = await get('/canvas/config.js')
    expect(status).toBe(200)
    expect(headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(text).toContain('window.__RUNTIME_CONFIG__')
    expect(text).toContain('"/api/roubaai-media/openai"')
    // Nothing here may carry a credential: the key lives in the host's settings.
    expect(text).not.toMatch(/apiKey|sk-/)
  })

  it('explains how to build the frontend when none is configured', async () => {
    const { status, text } = await get('/canvas/', { basePath: '/canvas', canvasRoot: '', openaiBasePath: '/api/roubaai-media/openai' })
    expect(status).toBe(503)
    expect(text).toContain('VITE_BASE=/canvas/')
  })

  it('honours a custom mount point', async () => {
    const { status, text } = await get('/workbench/', { basePath: '/workbench', canvasRoot: root, openaiBasePath: '/api/roubaai-media/openai' })
    expect(status).toBe(200)
    expect(text).toContain('<title>canvas</title>')
  })
})

describe('canvas host: the in-app panel route', () => {
  it('answers the mount point as JSON', () => {
    const res = fakeResponse()
    handlePanelInfoRequest(
      { method: 'GET' } as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      { basePath: '/workbench' },
    )
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(JSON.parse((res as unknown as { text: () => string }).text())).toEqual({ basePath: '/workbench' })
  })

  it('carries no credential', () => {
    const res = fakeResponse()
    handlePanelInfoRequest(
      { method: 'GET' } as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      { basePath: '/canvas' },
    )
    expect((res as unknown as { text: () => string }).text()).not.toMatch(/apiKey|sk-/)
  })

  it('refuses a write', () => {
    const res = fakeResponse()
    handlePanelInfoRequest(
      { method: 'POST' } as unknown as IncomingMessage,
      res as unknown as ServerResponse,
      { basePath: '/canvas' },
    )
    expect(res.status).toBe(405)
  })
})

describe('canvas host: route registration', () => {
  interface Route { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }

  function mounted(config: Parameters<typeof apply>[1] = {}): Route[] {
    const routes: Route[] = []
    const ctx = {
      logger: { info: () => undefined, warn: () => undefined },
      effect: (fn: () => unknown) => fn(),
      webServer: {
        register: (route: Route) => {
          routes.push(route)
          return () => undefined
        },
      },
    } as unknown as Context
    apply(ctx, { canvasRoot: root, ...config })
    return routes
  }

  it('mounts the app and the panel route', () => {
    expect(mounted().map(route => route.path)).toEqual(['/canvas', '/api/roubaai-canvas'])
  })

  it('follows a custom mount point and panel route', () => {
    const routes = mounted({ basePath: '/workbench', panelInfoPath: '/api/panel' })
    expect(routes.map(route => route.path)).toEqual(['/workbench', '/api/panel'])
  })

  it('serves the panel route the client half reads', async () => {
    // The browser half can only hardcode this path: it holds no configuration.
    const route = mounted()[1] as Route
    const res = fakeResponse()
    route.handler(
      { method: 'GET', url: '/api/roubaai-canvas/panel' } as unknown as IncomingMessage,
      res as unknown as ServerResponse,
    )
    expect(JSON.parse((res as unknown as { text: () => string }).text())).toEqual({ basePath: '/canvas' })
  })

  it('answers nothing else under the panel prefix', () => {
    const route = mounted()[1] as Route
    const res = fakeResponse()
    route.handler(
      { method: 'GET', url: '/api/roubaai-canvas/anything' } as unknown as IncomingMessage,
      res as unknown as ServerResponse,
    )
    expect(res.status).toBe(404)
  })
})
