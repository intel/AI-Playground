import { Marked, Token, Tokens } from 'marked'
import hljs from 'highlight.js'
import { stringToBase64 } from 'uint8array-extras'

import 'highlight.js/styles/github-dark-dimmed.css'

const startMarker = '===ORIGINALCODE'
const endMarker = 'ENDOFORIGINALCODE==='
const replaceRegex = new RegExp(`${startMarker}(.*?)${endMarker}`, 'gs')

const codeRenderer = {
  renderer: {
    code(token: Tokens.Code) {
      const lang = token.lang || 'plaintext'
      const code = token.text
      const language = hljs.getLanguage(lang) ? lang : 'plaintext'
      const highlighted = hljs.highlight(code, { language }).value

      return `<div class=" rounded-md my-4 code-section">
        <div class="flex justify-between items-center sticky -top-4 text-white bg-gray-800 px-4 py-2 text-xs rounded-t-md">
          <span>${language.toUpperCase()}</span>
          <button class="hidden flex items-center justify-end copy-code" ${startMarker}${code}${endMarker}>
            <span class="svg-icon i-copy w-4 h-4 mr-1 pointer-events-none"></span><span class="pointer-events-none">Copy</span>
          </button>
        </div>
        <pre class="hljs"><code class="hljs">${highlighted}</code></pre>
      </div>`
    },
  },
}

const htmlEscaper = {
  walkTokens: (token: Token) => {
    try {
      if (token.type === 'html') {
        token.text = token.raw
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;')
      }
    } catch (error) {
      console.error('error while html escaping', { error, token })
    }
  },
}

const dataCodeFixer = (input: string) => {
  try {
    if (input.includes(startMarker) && input.includes(endMarker)) {
      return input.replace(replaceRegex, (_, data) => {
        return `data-code="${stringToBase64(data)}"`
      })
    }
    return input
  } catch (error) {
    console.error('error while data code encoding', { error, input })
    throw error
  }
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

export const plainParser = new Marked({
  pedantic: false,
  gfm: true,
  breaks: true,
  async: false,
}).use(htmlEscaper)

export const parse = (input: string) => {
  try {
    return parser.parse(input)
  } catch (error) {
    console.error('error while parsing', { error, input })
  }

  try {
    return plainParser.parse(input)
  } catch (error) {
    console.error('error while plain parsing', { error, input })
    return input
  }
}
