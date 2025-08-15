import { Marked, Token } from 'marked'
import markedShiki from 'marked-shiki'
import { codeToHtml, bundledLanguagesAlias, bundledLanguages } from 'shiki'

const langs = Object.keys(bundledLanguages).concat(Object.keys(bundledLanguagesAlias))

const codeRenderer = markedShiki({
  highlight(code, lang, props) {
    return codeToHtml(code, {
      lang: langs.includes(lang) ? lang : 'text',
      theme: 'github-dark-dimmed',
      meta: { __raw: props.join(' ') }, // required by `transformerMeta*`
    })
  },
  container: `<div class=" rounded-md my-4 code-section">
        <div class="flex justify-between items-center relative text-white bg-gray-800 px-4 py-2 text-xs rounded-t-md">
          <span>%l</span>
          <button class="flex items-center justify-end copy-code" ===ORIGINALCODE%t===>
            <span class="svg-icon i-copy w-4 h-4 mr-1 pointer-events-none"></span><span class="pointer-events-none">Copy</span>
          </button>
        </div>
        %s
      </div>`,
})

const htmlEscaper = {
  walkTokens: (token: Token) => {
    if (token.type === 'html') {
      token.text = token.raw
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    }
  },
}

const dataCodeFixer = (input: string) => {
  if (input.includes('===ORIGINALCODE') && input.includes('===')) {
    console.log('postprocessing', input)
    return input.replace(/===ORIGINALCODE(.*?)===>/gs, (match, data) => {
      console.log({ match, data })
      return `data-code="${btoa(data)}"`
    })
  }
  return input
}

export const parser = new Marked({
  pedantic: false,
  gfm: true,
  breaks: true,
  async: false,
})
  .use(codeRenderer)
  .use(htmlEscaper)
  .use({
    hooks: {
      postprocess: dataCodeFixer,
    },
  })
