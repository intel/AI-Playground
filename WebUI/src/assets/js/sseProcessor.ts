export class SSEProcessor {
  readonly reader: ReadableStreamDefaultReader<Uint8Array>
  readonly onData?: (data: string) => void
  readonly onFinish?: () => void
  readonly decoder = new TextDecoder()
  processing = false
  message = ''

  constructor(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    onData?: (data: string) => void,
    onFinish?: () => void,
  ) {
    this.reader = reader
    this.onData = onData
    this.onFinish = onFinish
  }

  async start() {
    if (this.processing) {
      return
    }
    this.processing = true
    const result = await this.reader.read()
    return this.processText(result)
  }

  async processText({ done, value }: ReadableStreamReadResult<Uint8Array>) {
    if (done) {
      this.processing = false
      this.onFinish?.call(this)
      return
    }

    const text = this.decoder.decode(value)
    let start = 0
    let pos: number
    while (start < text.length) {
      pos = text.indexOf('\0', start)
      if (pos > -1) {
        const line = text.substring(start, pos)
        if (line.startsWith('data:')) {
          this.onData?.call(this, line)
        } else {
          this.message += line
          this.onData?.call(this, this.message)
        }
        this.message = ''
        start = pos + 1
      } else {
        this.message += text.substring(start)
        break
      }
    }
    const result = await this.reader.read()
    await this.processText(result)
  }
}
