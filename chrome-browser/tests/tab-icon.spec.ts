/**
 * The `@` tab rows' favicon renderer: the fallback mark and the identity the
 * menu's candidate icon seat needs.
 */
import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CHROME_ICON_SRC } from '../src/client/chrome-icon.ts'
import { tabIcon } from '../src/client/tab-icon.ts'

describe('tab favicon', () => {
  it('keeps one component identity per favicon URL', () => {
    // A fresh identity per candidate would remount (and reload) the image on
    // every menu render, which is one render per keystroke.
    expect(tabIcon('https://a/fav.ico')).toBe(tabIcon('https://a/fav.ico'))
    expect(tabIcon('https://a/fav.ico')).not.toBe(tabIcon('https://b/fav.ico'))
  })

  it('renders the favicon, and the Chrome mark when Chrome reported none', () => {
    const favicon = renderToStaticMarkup(React.createElement(tabIcon('https://a/fav.ico')))
    expect(favicon).toContain('https://a/fav.ico')
    // Attribute case varies between the DOM and server renderers.
    expect(favicon.toLowerCase()).toContain('referrerpolicy="no-referrer"')
    expect(favicon).not.toContain(CHROME_ICON_SRC)

    const fallback = renderToStaticMarkup(React.createElement(tabIcon('')))
    expect(fallback).toContain(CHROME_ICON_SRC)
  })
})
