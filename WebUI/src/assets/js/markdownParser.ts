import { Marked, Renderer } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js";
import * as util from "./util";

export class MarkdownParser {
    pattern = /```([^\n]*)(.*?)(?:(?:```)|$)/gs;
    copyText = "";
    marked: Marked;
    constructor(copyText: string) {
        this.copyText = copyText;
        this.marked = new Marked(
            markedHighlight({
                langPrefix: 'hljs language-',
                highlight(code, lang, _info) {
                    const language = hljs.getLanguage(lang) ? lang : 'plaintext';
                    const html = hljs.highlight(code, { language }).value;
                    return html;
                }
            })
        );
        this.marked.setOptions({
            renderer: new Renderer(),
            pedantic: false,
            gfm: true,
            breaks: true,
        });
    }

    parseMarkdown(content: string) {
        let lastIndex = 0;
        let html = "";
        let matches;
        //删除所有Html标签
        content = content.replace(/<[^>]+>/g, "");
        while ((matches = this.pattern.exec(content))) {
            const index = matches.index;
            if (index > lastIndex) {
                html += util.processHTMLTag(content.substring(lastIndex, index));
            }
            html += `<div class="bg-black rounded-md my-4 code-section">
                    <div class="flex justify-between items-center relative text-white bg-gray-800 px-4 py-2 text-xs rounded-t-md">
                        <span>${matches[1] || ""}</span>
                        <button class="flex items-center justify-end copy-code">
                            <span class="svg-icon i-copy mx-1"></span>
                            <span class="text-sm">${this.copyText}</span>
                        </button>
                    </div>
                    <div class="p-4 code-content overflow-auto">${this.marked.parse(matches[0])}</div>
                </div>`;
            lastIndex = index + matches[0].length;
        }
        if (lastIndex == 0) {
            html = util.processHTMLTag(content);
        } else if (lastIndex != content.length - 1) {
            html += util.processHTMLTag(content.substring(lastIndex));
        }
        return html;
    }
}