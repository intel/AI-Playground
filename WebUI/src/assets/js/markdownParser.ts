import { Marked, Renderer } from 'marked'
import { markedHighlight } from 'marked-highlight'
import hljs from 'highlight.js'
import * as util from './util'

export class MarkdownParser {
  pattern = /```([^\n]*)([\s\S]*?)(?:(?:```)|$)/gs
  copyText = ''
  marked: Marked
  constructor(copyText: string) {
    this.copyText = copyText
    this.marked = new Marked(
      markedHighlight({
        langPrefix: 'hljs language-',
        highlight(code, lang, _info) {
          const language = hljs.getLanguage(lang) ? lang : 'plaintext'
          const html = hljs.highlight(code, { language }).value
          return html
        },
      }),
    )
    this.marked.setOptions({
      renderer: new Renderer(),
      pedantic: false,
      gfm: true,
      breaks: true,
    })
  }

  parseMarkdown(content: string) {
    const codeBlocks: string[] = []
    let codeMatch
    const allCodeRegex = new RegExp(this.pattern, 'gs')

    let tempContent = content

    // Seperate each block of code deoted by (```lang\ncode...```)
    while ((codeMatch = allCodeRegex.exec(content))) {
      codeBlocks.push(codeMatch[0])
    }

    // Replace each code block with a placeholder
    codeBlocks.forEach((block, i) => {
      tempContent = tempContent.replace(block, `__CODEBLOCK_${i}__`)
    })

    // Remove unsafe tags
    tempContent = tempContent.replace(/<[^>]+>/g, '')

    // Replace the code where placeholder was
    codeBlocks.forEach((originalBlock, i) => {
      tempContent = tempContent.replace(`__CODEBLOCK_${i}__`, originalBlock)
    })

    let lastIndex = 0
    let html = ''
    let matches

    while ((matches = this.pattern.exec(tempContent))) {
      const index = matches.index
      if (index > lastIndex) {
        html += util.processHTMLTag(tempContent.substring(lastIndex, index))
      }

      html += `<div class="bg-black rounded-md my-4 code-section">
                    <div class="flex justify-between items-center relative text-white bg-gray-800 px-4 py-2 text-xs rounded-t-md">
                        <span>${matches[1] || ''}</span>
                        <button class="flex items-center justify-end copy-code">
                            <span class="svg-icon i-copy w-4 h-4"></span>
                            <span class="text-sm">${this.copyText}</span>
                        </button>
                    </div>
                    <div class="p-4 code-content overflow-auto">${this.marked.parse(matches[0])}</div>
                </div>`
      lastIndex = index + matches[0].length
    }

    if (lastIndex < tempContent.length) {
      html += util.processHTMLTag(tempContent.substring(lastIndex, tempContent.length))
    }

    return html
  }
}
