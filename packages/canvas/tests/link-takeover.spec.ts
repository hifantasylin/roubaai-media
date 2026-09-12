/**
 * Click policy over canvas links. The interesting cases are the ones that look
 * like a canvas link and are not, and the modifier clicks a user makes to get a
 * real browser window on purpose.
 */
import { describe, expect, it } from 'vitest'
import {
  canvasClickTarget, canvasLinkTarget, registerCanvasLinkTakeover, type CanvasClickLike,
} from '../src/client/link-takeover.ts'

const SELF = 'http://127.0.0.1:43120'
const CONTEXT = { basePath: '/canvas', selfOrigin: SELF, baseHref: `${SELF}/` }

function click(overrides: Partial<CanvasClickLike> & { href?: string | null } = {}): CanvasClickLike {
  const { href = null, ...rest } = overrides
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    target: href === null ? null : { closest: () => ({ getAttribute: () => href }) },
    preventDefault: () => undefined,
    ...rest,
  }
}

describe('canvasLinkTarget', () => {
  it('claims a canvas link on the shell origin', () => {
    expect(canvasLinkTarget(`${SELF}/canvas/?bp=剧集`, CONTEXT)).toBe('/canvas/?bp=%E5%89%A7%E9%9B%86')
  })

  it('claims the mount point itself', () => {
    expect(canvasLinkTarget(`${SELF}/canvas`, CONTEXT)).toBe('/canvas')
  })

  it('claims a link written for another local port', () => {
    // A link the model wrote for the web profile still names this canvas.
    expect(canvasLinkTarget('http://127.0.0.1:3080/canvas/', CONTEXT)).toBe('/canvas/')
    expect(canvasLinkTarget('http://localhost:3080/canvas/x', CONTEXT)).toBe('/canvas/x')
  })

  it('resolves a relative href against the document', () => {
    expect(canvasLinkTarget('/canvas/?bp=x', CONTEXT)).toBe('/canvas/?bp=x')
  })

  it('leaves a foreign site alone', () => {
    expect(canvasLinkTarget('https://example.com/canvas/', CONTEXT)).toBeUndefined()
  })

  it('leaves a path that merely starts with the mount point alone', () => {
    expect(canvasLinkTarget(`${SELF}/canvasx/`, CONTEXT)).toBeUndefined()
  })

  it('leaves non-http schemes and empty hrefs alone', () => {
    expect(canvasLinkTarget('file:///canvas/', CONTEXT)).toBeUndefined()
    expect(canvasLinkTarget('', CONTEXT)).toBeUndefined()
    expect(canvasLinkTarget(undefined, CONTEXT)).toBeUndefined()
    expect(canvasLinkTarget(null, CONTEXT)).toBeUndefined()
    expect(canvasLinkTarget('::::', CONTEXT)).toBeUndefined()
  })
})

describe('canvasClickTarget', () => {
  it('takes over a plain left click on a canvas anchor', () => {
    expect(canvasClickTarget(click({ href: `${SELF}/canvas/?bp=x` }), CONTEXT)).toBe('/canvas/?bp=x')
  })

  it('ignores a modified or non-left click, so a real browser window stays reachable', () => {
    for (const modifier of ['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const) {
      expect(canvasClickTarget(click({ href: `${SELF}/canvas/`, [modifier]: true }), CONTEXT)).toBeUndefined()
    }
    expect(canvasClickTarget(click({ href: `${SELF}/canvas/`, button: 1 }), CONTEXT)).toBeUndefined()
  })

  it('ignores a click another handler already claimed', () => {
    expect(canvasClickTarget(click({ href: `${SELF}/canvas/`, defaultPrevented: true }), CONTEXT)).toBeUndefined()
  })

  it('ignores a click that is not on an anchor', () => {
    expect(canvasClickTarget(click(), CONTEXT)).toBeUndefined()
    expect(canvasClickTarget(click({ href: 'https://example.com/' }), CONTEXT)).toBeUndefined()
  })
})

describe('registerCanvasLinkTakeover', () => {
  interface FakeDocument {
    listeners: Map<string, (event: unknown) => void>
    addEventListener(type: string, listener: (event: unknown) => void): void
    removeEventListener(type: string): void
  }

  function install(): { doc: FakeDocument; opened: string[]; dispose: () => void } {
    const doc: FakeDocument = {
      listeners: new Map(),
      addEventListener(type, listener) { doc.listeners.set(type, listener) },
      removeEventListener(type) { doc.listeners.delete(type) },
    }
    ;(globalThis as { document?: unknown }).document = doc
    const opened: string[] = []
    const dispose = registerCanvasLinkTakeover(
      target => opened.push(target),
      { selfOrigin: SELF, baseHref: `${SELF}/` },
    )
    return { doc, opened, dispose }
  }

  it('opens the panel for a canvas link and swallows the click', () => {
    const { doc, opened } = install()
    let prevented = false
    doc.listeners.get('click')?.(click({
      href: `${SELF}/canvas/?bp=x`,
      preventDefault: () => { prevented = true },
    }))
    expect(opened).toEqual(['/canvas/?bp=x'])
    // Without preventDefault the shell would still open its own browser surface.
    expect(prevented).toBe(true)
  })

  it('lets every other click through', () => {
    const { doc, opened } = install()
    doc.listeners.get('click')?.(click({ href: 'https://example.com/' }))
    expect(opened).toEqual([])
  })

  it('removes its listener on dispose', () => {
    const { doc, dispose } = install()
    expect(doc.listeners.size).toBe(1)
    dispose()
    expect(doc.listeners.size).toBe(0)
  })
})
