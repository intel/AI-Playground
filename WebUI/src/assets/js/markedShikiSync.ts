import { MarkedExtension } from 'marked'

/**
 * A [marked](https://marked.js.org/) extension for integrating [Shiki](https://shiki.style/) syntax highlighting.

From https://github.com/bent10/marked-extensions/blob/1fb8194ef93359c1158f386bdf4d696c0ecfce32/packages/shiki/src/index.ts
Modified for synchronous usage

LICENSE
=======
the MIT License (MIT)

Copyright (c) 2023-2024 Stilearning (https://stilearning.com)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
 */
type Options = {
  /**
   * Formats and highlights the code according to a specific coding style or
   * convention.
   *
   * @param code - The code to highlight.
   * @param lang - The language of the code.
   * @param props - Additional properties for code highlighting.
   * @returns A string representing the highlighted code.
   */
  highlight?: (code: string, lang: string, props: string[]) => string

  /**
   * The container template for the highlighted code.
   *
   * @default '%s'
   */
  container?: string
}
export function markedShiki(options: Options = {}): MarkedExtension {
  const { highlight, container } = options

  return {
    async: false,
    walkTokens(token) {
      if (token.type !== 'code' || typeof highlight !== 'function') return

      const [lang = 'text', ...props] = token.lang?.split(' ') ?? []

      const { text } = token
      const highlightedText = highlight(text, lang, props)
      const htmlText = !container
        ? highlightedText
        : container
            .replace('%l', String(lang).toUpperCase())
            .replace('%s', highlightedText)
            .replace('%t', text)

      // transforms token to html
      Object.assign(token, {
        type: 'html',
        block: true,
        text: `${htmlText}\n`,
      })
    },
  }
}
