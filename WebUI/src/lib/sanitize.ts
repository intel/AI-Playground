import DOMPurify from 'dompurify'

/**
 * DOMPurify configuration for sanitizing markdown-rendered HTML.
 * Allows tags and attributes needed for:
 * - Basic formatting (p, strong, em, etc.)
 * - Code blocks with Shiki syntax highlighting
 * - Tables, lists, blockquotes
 * - Links and images
 * - Copy button in code blocks
 */
const MARKDOWN_CONFIG = {
  ALLOWED_TAGS: [
    // Basic formatting
    'p',
    'br',
    'strong',
    'b',
    'em',
    'i',
    'u',
    's',
    'del',
    'ins',
    'mark',
    'sub',
    'sup',
    'span',
    'div',
    // Headings
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    // Lists
    'ul',
    'ol',
    'li',
    // Code blocks
    'pre',
    'code',
    // Links and images
    'a',
    'img',
    // Blockquotes
    'blockquote',
    // Horizontal rule
    'hr',
    // Tables
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'th',
    'td',
    // Button for copy code functionality
    'button',
  ],
  ALLOWED_ATTR: [
    // Common attributes
    'class',
    'id',
    'title',
    // Link attributes
    'href',
    'target',
    'rel',
    // Image attributes
    'src',
    'alt',
    'width',
    'height',
    // Code block copy button data attribute
    'data-code',
    // Shiki syntax highlighting uses inline styles
    'style',
    // Table attributes
    'colspan',
    'rowspan',
  ],
  // Allow data-* attributes (used by code blocks)
  ALLOW_DATA_ATTR: true,
  // Allow target="_blank" on links
  ALLOW_UNKNOWN_PROTOCOLS: false,
} satisfies DOMPurify.Config

/**
 * Sanitizes HTML output from the markdown parser.
 * Preserves formatting tags needed for rendered markdown while
 * removing potentially dangerous content like scripts and event handlers.
 */
export const sanitizeMarkdown = (html: string | undefined): string => {
  if (!html) return ''
  return DOMPurify.sanitize(html, MARKDOWN_CONFIG)
}
