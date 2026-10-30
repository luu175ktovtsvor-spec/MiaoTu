import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Plugin } from 'vite'
import { LandingHeader, LandingHero } from '../src/landing/LandingHero.js'
import CanvasFilmStage from '../src/landing/CanvasFilmStage.js'
import ChangelogFrame from '../src/landing/ChangelogFrame.js'
import { initialLandingLanguage } from '../src/landing/initialLandingLanguage.mjs'

// Generate the first paint from the exact components/copy/styles used by React.
// It remains visible while scripts load; no separate legacy homepage or SSR server.
export function landingFirstPaintPlugin(webRoot: string): Plugin {
  return {
    name: 'miaoimg-current-first-paint',
    transformIndexHtml: {
      order: 'post',
      handler(html, context) {
        if (!html.includes('<!--miao-first-paint-body-->')) return html
        const styles = ['landing.css', 'canvas-film.css'].map(name => readFileSync(resolve(webRoot, 'src/landing', name), 'utf8')).join('\n')
        const image = (name: string) => {
          if (!context.bundle) return '/src/landing/assets/turkey/' + name
          const matches = Object.values(context.bundle).filter((asset: any) => asset.type === 'asset' && (asset.name === name || asset.names?.includes(name)))
          if (matches.length !== 1) throw new Error('First-paint image asset is missing or ambiguous: ' + name)
          return '/' + matches[0].fileName
        }
        const images = { city: image('city.jpg'), sea: image('sea.jpg'), balloon: image('balloon.jpg') }
        const markup = (lang: string) => renderToStaticMarkup(h('div', { className: 'miao-site', id: 'top' },
          h(LandingHeader, { lang }), h('main', null, h(LandingHero, { lang, film: h(CanvasFilmStage, { lang, images }) }))))
        const boot = `<script>(()=>{const landing=location.hostname!=='admin.miaoimg.cn'&&!location.pathname.startsWith('/manage');if(!landing)return;const lang=(${initialLandingLanguage.toString()})();document.documentElement.dataset.landing='1';document.documentElement.dataset.landingPage=/^\\/changelog\\/?$/.test(location.pathname)?'changelog':'home';document.documentElement.dataset.landingLang=lang;document.documentElement.lang=lang==='zh'?'zh-CN':'en';window.__OIP_INITIAL_LANG__=lang})()</script>`
        const css = `<style>html{background:#0b0b0c}body{margin:0}html[data-landing] body{background:#0b0b0c}${styles}</style>`
        const shell = ['zh', 'en'].map(lang => `<template id="miao-first-home-${lang}">${markup(lang)}</template><template id="miao-first-changelog-${lang}">${renderToStaticMarkup(h(ChangelogFrame, { lang }))}</template>`).join('')
          + `<script>(()=>{const html=document.documentElement;if(!html.dataset.landing)return;const template=document.getElementById('miao-first-'+html.dataset.landingPage+'-'+html.dataset.landingLang);if(template)document.getElementById('root').replaceChildren(template.content.cloneNode(true))})()</script>`

        return html.replace('<!--miao-first-paint-head-->', boot + css).replace('<!--miao-first-paint-body-->', shell)
      },
    },
  }
}
