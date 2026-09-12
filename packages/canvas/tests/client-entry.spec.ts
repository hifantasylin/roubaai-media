/**
 * The client half contributes one sidebar tab and takes over canvas links.
 * Both must address the same type id: a link that opened a type nobody
 * registered would fail at the open, and no other check would catch it.
 */
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply, inject } from '../src/client/index.tsx'

interface Descriptor {
  id: string
  title: string | (() => string)
  order?: number
  single?: boolean
  component: unknown
}

interface Harness {
  tabs: Descriptor[]
  opens: Array<Record<string, unknown>>
  click: (event: unknown) => void
  ctx: Context
}

/** A document/location stand-in: the takeover reads the origin it installs on. */
function harness(): Harness {
  const tabs: Descriptor[] = []
  const opens: Array<Record<string, unknown>> = []
  const listeners = new Map<string, (event: unknown) => void>()
  ;(globalThis as { document?: unknown }).document = {
    addEventListener(type: string, listener: (event: unknown) => void) { listeners.set(type, listener) },
    removeEventListener(type: string) { listeners.delete(type) },
  }
  ;(globalThis as { location?: unknown }).location = {
    origin: 'http://127.0.0.1:43120',
    href: 'http://127.0.0.1:43120/',
  }
  const ctx = {
    effect: (fn: () => unknown) => fn(),
    betterSidebar: {
      registerTab(descriptor: Descriptor) {
        tabs.push(descriptor)
        return () => undefined
      },
      openTab(seed: Record<string, unknown>) { opens.push(seed) },
    },
  } as unknown as Context
  return { tabs, opens, click: event => listeners.get('click')?.(event), ctx }
}

function canvasClick(): unknown {
  return {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    defaultPrevented: false,
    target: { closest: () => ({ getAttribute: () => 'http://127.0.0.1:43120/canvas/?bp=x' }) },
    preventDefault: () => undefined,
  }
}

describe('canvas client half', () => {
  it('waits for the sidebar service', () => {
    expect(inject).toEqual(['betterSidebar'])
  })

  it('registers one single-instance tab named in the shell locale', () => {
    const { tabs, ctx } = harness()
    apply(ctx)
    expect(tabs).toHaveLength(1)
    const tab = tabs[0] as Descriptor
    expect(tab.id).toBe('roubaai:canvas')
    expect(typeof tab.title === 'function' ? tab.title() : tab.title).toBe('画布')
    expect(tab.single).toBe(true)
    expect(typeof tab.component).toBe('function')
  })

  it('opens a canvas link in that same tab', () => {
    const { tabs, opens, click, ctx } = harness()
    apply(ctx)
    click(canvasClick())
    expect(opens).toEqual([{ type: (tabs[0] as Descriptor).id, title: '画布' }])
  })
})
