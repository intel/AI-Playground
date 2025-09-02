export async function copyImage(url: string) {
  const response = await fetch(url)
  const blob = await response.blob()
  navigator.clipboard.write([
    new ClipboardItem({
      'image/png': blob,
    }),
  ])
}

/**
 * Execute after X ms delay
 * @param ms millisecond
 * @returns
 */
export function delay(ms: number) {
  return new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      clearTimeout(t)
      resolve()
    }, ms)
  })
}
/**
 * 日期格式化
 * @param date 日期
 * @param format 格式化字符串 y-年 M-月 d-日 h-时 m-分 s-秒 f-毫秒
 */
export function dateFormat(date: Date, format: string) {
  const dateVals: Record<string, number> = {
    M: date.getMonth() + 1,
    d: date.getDate(),
    h: date.getHours(),
    m: date.getMinutes(),
    s: date.getSeconds(),
    f: date.getMilliseconds(),
  }
  const result = format.replace(/(M{1,2}|d{1,2}|h{1,2}|m{1,2}|s{1,2})|f{1,3}/g, function (v) {
    const val = dateVals[v.substring(0, 1)]
    return val.toString().padStart(v.length, '0')
  })
  return result.replace(/(y+)/g, function (v) {
    const year = date.getFullYear().toString()
    return year.substring(year.length - v.length)
  })
}
/**
 * HTML escape of line breaks and Spaces in text
 * @param content
 */
function escapeWhiteSpace(content: string) {
  return content.replace(/\n/g, '<br/>')
}

/**
 * Handling HTML tags
 * @param content
 */
export function processHTMLTag(content: string) {
  return escapeWhiteSpace(content.replace(/<[^>]+>/g, ''))
}

const htmlEscape = new Map<string, string>(
  Object.entries({
    '<': '&lt;',
    '>': '&gt;',
    '&': '&amp;',
    '"': '&quot;',
    '©': '&copy;',
    '®': '&reg;',
    ' ': '&nbsp;',
    '\n': '<br/>',
  }),
)

const arrEntities = new Map<string, string>(
  Object.entries({
    '&lt': '<',
    '&gt': '>',
    '&nbsp': ' ',
    '&amp': '&',
    '&quot': '"',
  }),
)

export function html2Escape(sHtml: string) {
  return sHtml.replace(/[<>&" ©®]/g, function (c) {
    return htmlEscape.get(c) || ''
  })
}

export function escape2Html(str: string) {
  return str.replace(/&(lt|gt|nbsp|amp|quot|copy|reg);/gi, function (c) {
    return arrEntities.get(c) || ''
  })
}

export function log(message: string) {
  console.log(`[${dateFormat(new Date(), 'hh:mm:ss:fff')}] ${message}`)
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function convertToFormData(data: any) {
  const formData = new FormData()
  for (const key in data) {
    const val = data[key]
    if (val == null) {
      continue
    }
    if (typeof val == 'boolean') {
      formData.append(key, val ? '1' : '0')
    } else if (val as Blob) {
      formData.append(key, val)
    } else {
      formData.append(key, val.toString())
    }
  }
  return formData
}

export function getDomOffset(target: HTMLElement) {
  const offset = { left: 0, top: 0 }
  let enumElement: HTMLElement | null = target
  while (enumElement && enumElement != document.body) {
    offset.left += enumElement.offsetLeft
    enumElement = enumElement.parentElement
  }
  return offset
}

export function toFixed(num: number, fractionDigits: number) {
  return parseFloat(num.toFixed(fractionDigits))
}
