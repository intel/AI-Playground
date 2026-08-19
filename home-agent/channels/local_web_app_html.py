"""Self-contained chat + login page served by the local-web Home Agent server.

Ported verbatim from the PoC's ``WebUI/electron/localWebChatAppHtml.ts`` so the
browser experience is identical, but served by the Python channel instead of an
Electron-side Node server. Kept in its own module (mirroring the TS split) so the
channel logic in ``local_web.py`` stays readable.

The page connects to ``/api/events`` (Server-Sent Events) for outbound traffic
and POSTs to ``/api/chat`` for inbound messages, guarded by a password login
(``/api/login`` → ``HttpOnly`` session cookie).
"""

# NB: raw string — the embedded JS contains regex escapes (\*, \n) that must
# reach the browser literally.
LOCAL_WEB_CHAT_APP_HTML = r"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>Home Agent</title>
  <style>
    /* Palette mirrors the AI Playground app's shadcn tokens (WebUI index.css):
       light = :root, dark = .dark. Kept as a self-contained copy because this
       page is served standalone (no Tailwind / theme classes). */
    :root {
      color-scheme: light dark;
      --bg: hsl(0 0% 100%);
      --fg: hsl(222.2 47.4% 11.2%);
      --card: hsl(0 0% 100%);
      --muted: hsl(210 40% 96.1%);
      --muted-fg: hsl(215.4 16.3% 46.9%);
      --primary: hsl(209 100% 60%);
      --primary-fg: hsl(0 0% 100%);
      --border: hsl(214.3 31.8% 91.4%);
      --input: hsl(210 40% 96.1%);
      --err: hsl(0 84.2% 60.2%);
      --radius: 8px;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: hsl(280 50% 5%);
        --fg: hsl(280 5% 90%);
        --card: hsl(280 50% 9%);
        --muted: hsl(242 30% 15%);
        --muted-fg: hsl(280 5% 60%);
        --primary: hsl(280 98.4% 50.6%);
        --primary-fg: hsl(0 0% 100%);
        --border: hsl(280 30% 18%);
        --input: hsl(280 30% 18%);
        --err: hsl(0 100% 65%);
      }
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--fg); min-height: 100dvh; }
    .screen { min-height: 100dvh; display: flex; flex-direction: column; }
    .hidden { display: none !important; }
    #login-screen { align-items: center; justify-content: center; padding: 24px; background: var(--bg); }
    .login-card { width: 100%; max-width: 360px; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); padding: 24px; box-shadow: 0 8px 30px rgb(0 0 0 / 0.12); }
    .login-card h1 { margin: 0 0 8px; font-size: 1.25rem; }
    .login-card p { margin: 0 0 16px; font-size: 13px; color: var(--muted-fg); line-height: 1.45; }
    .login-card label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px; }
    .login-card input[type=password] { width: 100%; padding: 10px 12px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--input); color: var(--fg); font: inherit; }
    .login-card button { margin-top: 14px; width: 100%; border: none; border-radius: var(--radius); padding: 11px; background: var(--primary); color: var(--primary-fg); font-weight: 600; cursor: pointer; font: inherit; }
    #login-error { color: var(--err); font-size: 12px; min-height: 1.2em; margin-top: 8px; }
    /* Pin the chat screen to the viewport so #log (flex:1) is the scroll
       container. With only min-height the screen grows with content and the
       whole body scrolls instead — then scrollBottom() (which drives
       log.scrollTop) can't keep the newest message in view. */
    #chat-screen { background: var(--bg); height: 100dvh; overflow: hidden; }
    .tg-header { display: flex; align-items: center; gap: 12px; padding: 10px 16px; background: var(--card); border-bottom: 1px solid var(--border); }
    .tg-avatar { width: 36px; height: 36px; border-radius: 8px; background: var(--primary); color: var(--primary-fg); display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 13px; flex-shrink: 0; }
    .tg-header-text { flex: 1; min-width: 0; }
    .tg-header-text .title { font-weight: 600; font-size: 15px; }
    .tg-header-text .sub { font-size: 12px; color: var(--muted-fg); }
    #log { flex: 1; overflow-y: auto; padding: 12px 12px 88px; display: flex; flex-direction: column; gap: 8px; }
    .row { display: flex; align-items: flex-end; gap: 8px; max-width: 100%; }
    .row-user { justify-content: flex-end; }
    .row-bot { justify-content: flex-start; }
    .bubble { max-width: min(85%, 560px); padding: 8px 12px 6px; border-radius: var(--radius); line-height: 1.45; font-size: 15px; word-break: break-word; }
    .row-user .bubble { background: var(--primary); color: var(--primary-fg); border-bottom-right-radius: 3px; white-space: pre-wrap; }
    .row-bot .bubble { background: var(--card); color: var(--fg); border: 1px solid var(--border); border-bottom-left-radius: 3px; }
    .row-bot .bubble.streaming { min-width: 48px; min-height: 20px; }
    .bubble .time { display: block; text-align: right; font-size: 11px; color: var(--muted-fg); margin-top: 4px; opacity: .8; }
    .row-user .bubble .time { color: var(--primary-fg); }
    .bubble code { font-family: ui-monospace, monospace; font-size: 0.9em; background: rgb(0 0 0 / 0.06); padding: 1px 4px; border-radius: 4px; }
    .row-user .bubble code { background: rgb(255 255 255 / 0.18); }
    .bubble strong { font-weight: 600; }
    .bubble em { font-style: italic; }
    .sys { align-self: center; font-size: 12px; color: var(--muted-fg); background: var(--muted); padding: 4px 10px; border-radius: 999px; margin: 4px 0; }
    .typing-dots { display: inline-flex; gap: 4px; padding: 4px 0; }
    .typing-dots span { width: 7px; height: 7px; border-radius: 50%; background: var(--muted-fg); animation: bounce 1.2s infinite ease-in-out; }
    .typing-dots span:nth-child(2) { animation-delay: .15s; }
    .typing-dots span:nth-child(3) { animation-delay: .3s; }
    @keyframes bounce { 0%, 60%, 100% { transform: translateY(0); opacity: .5; } 30% { transform: translateY(-4px); opacity: 1; } }
    .cursor { animation: blink 1s step-end infinite; opacity: .7; }
    @keyframes blink { 50% { opacity: 0; } }
    .compose { position: fixed; bottom: 0; left: 0; right: 0; display: flex; align-items: flex-end; gap: 8px; padding: 8px 10px calc(8px + env(safe-area-inset-bottom)); background: var(--card); border-top: 1px solid var(--border); }
    .compose-inner { flex: 1; display: flex; align-items: flex-end; background: var(--input); border-radius: var(--radius); padding: 6px 6px 6px 14px; border: 1px solid var(--border); }
    #input { flex: 1; border: none; background: transparent; color: var(--fg); font: inherit; font-size: 15px; resize: none; max-height: 120px; line-height: 1.35; padding: 6px 0; outline: none; }
    #send { width: 42px; height: 42px; border: none; border-radius: var(--radius); background: var(--primary); color: var(--primary-fg); font-size: 18px; cursor: pointer; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
    #send:disabled { opacity: 0.45; }
    #menu-btn { width: 42px; height: 42px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--muted); color: var(--muted-fg); font-size: 20px; font-weight: 700; cursor: pointer; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
    #menu-btn:hover { color: var(--fg); }
    #attach-btn { width: 42px; height: 42px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--muted); color: var(--muted-fg); font-size: 18px; cursor: pointer; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
    #attach-btn:hover { color: var(--fg); }
    .cmd-menu { position: fixed; left: 10px; right: 10px; bottom: calc(64px + env(safe-area-inset-bottom)); max-height: 50vh; overflow-y: auto; background: var(--card); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: 0 8px 30px rgb(0 0 0 / 0.25); z-index: 20; }
    .cmd-item { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; text-align: left; background: transparent; border: none; border-bottom: 1px solid var(--border); padding: 10px 14px; cursor: pointer; color: var(--fg); font: inherit; }
    .cmd-item:last-child { border-bottom: none; }
    .cmd-item:hover { background: var(--muted); }
    .cmd-name { font-weight: 600; font-size: 14px; color: var(--primary); }
    .cmd-desc { font-size: 12px; color: var(--muted-fg); }
    img.inline, video.inline { max-width: 100%; border-radius: var(--radius); margin-top: 6px; display: block; }
    /* A voice reply carries no text, so the bubble has nothing else to size it —
       without a floor the player collapses to ~48px and Chrome hides its controls. */
    audio.inline { width: 100%; min-width: 240px; margin-top: 6px; display: block; }
    .file-chip { display: inline-block; margin-top: 6px; padding: 4px 8px; border-radius: var(--radius); background: var(--muted); color: var(--fg); font-size: 13px; }
    .row-user .file-chip { background: rgb(255 255 255 / 0.18); color: var(--primary-fg); }
    a.doc-link { color: inherit; text-decoration: underline; font-size: 14px; }
    .kbd-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
    .kbd-row button { background: var(--muted); color: var(--fg); border: 1px solid var(--border); font-weight: 500; padding: 8px 12px; font-size: 13px; border-radius: var(--radius); cursor: pointer; }
    details.reasoning { margin: 2px 0; }
    details.reasoning > summary { cursor: pointer; color: var(--muted-fg); font-size: 13px; list-style: none; user-select: none; }
    details.reasoning > summary::-webkit-details-marker { display: none; }
    details.reasoning > summary::before { content: '\25B8\00a0'; }
    details.reasoning[open] > summary::before { content: '\25BE\00a0'; }
    details.reasoning .reasoning-body { color: var(--muted-fg); font-size: 13px; line-height: 1.4; border-left: 2px solid var(--border); padding-left: 8px; margin-top: 4px; }
  </style>
</head>
<body>
  <div id="login-screen" class="screen" role="group" aria-label="Sign in">
    <div class="login-card">
      <h1>Home Agent</h1>
      <p>Enter the password from AI Playground &rarr; Home Agent &rarr; LAN chat.</p>
      <label for="password">Password</label>
      <input id="password" type="password" autocomplete="current-password" placeholder="Password" />
      <div id="login-error"></div>
      <button type="button" id="login-btn">Sign in</button>
    </div>
  </div>
  <div id="chat-screen" class="screen hidden" role="group" aria-label="Chat">
    <div class="tg-header">
      <div class="tg-avatar">HA</div>
      <div class="tg-header-text">
        <div class="title">Home Agent</div>
        <div class="sub" id="status-line">online</div>
      </div>
    </div>
    <div id="log" role="log" aria-label="Conversation"></div>
    <div id="cmd-menu" class="cmd-menu hidden" role="menu" aria-label="Commands"></div>
    <div class="compose">
      <button type="button" id="menu-btn" title="Commands" aria-label="Commands">/</button>
      <button type="button" id="attach-btn" title="Attach files" aria-label="Attach files">&#128206;</button>
      <input type="file" id="file-input" multiple style="display:none" aria-label="Attach files" />
      <div class="compose-inner">
        <textarea id="input" rows="1" placeholder="Message" aria-label="Message" autocomplete="off"></textarea>
      </div>
      <button type="button" id="send" title="Send" aria-label="Send">&#10148;</button>
    </div>
  </div>
  <script>
    const loginScreen = document.getElementById('login-screen')
    const chatScreen = document.getElementById('chat-screen')
    const passwordInput = document.getElementById('password')
    const loginBtn = document.getElementById('login-btn')
    const loginError = document.getElementById('login-error')
    const log = document.getElementById('log')
    const input = document.getElementById('input')
    const sendBtn = document.getElementById('send')
    const menuBtn = document.getElementById('menu-btn')
    const cmdMenu = document.getElementById('cmd-menu')
    const attachBtn = document.getElementById('attach-btn')
    const fileInput = document.getElementById('file-input')
    const statusLine = document.getElementById('status-line')
    let draftBubble = null
    let draftRow = null
    let typingRow = null
    let es = null
    // Guards re-entrant session checks while the SSE stream is flapping.
    let recovering = false

    // Accessible names for the message bubbles. The chat log is driven by role +
    // name (by screen readers, and by the e2e that plays the user), so a settled
    // reply has to be distinguishable from the in-flight draft.
    const LABEL_USER = 'Your message'
    const LABEL_BOT = 'Home Agent response'
    const LABEL_DRAFT = 'Home Agent draft'
    // A prompt asks for input rather than answering, so it is named apart from a
    // settled reply — "wait for the reply" must not settle on the question.
    const LABEL_PROMPT = 'Home Agent prompt'
    const LABEL_KEYBOARD = 'Choose an option'

    function scrollBottom() { log.scrollTop = log.scrollHeight }

    function bubbleEl(label) {
      const bubble = document.createElement('div')
      bubble.className = 'bubble'
      bubble.setAttribute('role', 'article')
      bubble.setAttribute('aria-label', label)
      return bubble
    }

    function escapeHtml(s) {
      return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')
    }
    // Reasoning sentinels emitted by localWebAdapter.ts: OPEN label SEP body CLOSE.
    // An empty label = a live "Thinking…" block (while streaming); a filled label
    // ("Thought for X.X seconds") = the final message. Either way the block is
    // collapsed by default — the user expands it to read the reasoning. Control
    // chars so they survive escapeHtml and never collide with model text. MUST
    // stay in sync with THINK_* in localWebAdapter.ts.
    const THINK_OPEN = String.fromCharCode(1)
    const THINK_SEP = String.fromCharCode(2)
    const THINK_CLOSE = String.fromCharCode(3)
    const THINK_RE = new RegExp(THINK_OPEN + '([\\s\\S]*?)' + THINK_SEP + '([\\s\\S]*?)' + THINK_CLOSE, 'g')
    // Emphasis sentinels (image prompt italics) — see EM_* in localWebAdapter.ts.
    const EM_OPEN = String.fromCharCode(5)
    const EM_CLOSE = String.fromCharCode(6)
    const EM_RE = new RegExp(EM_OPEN + '([\\s\\S]*?)' + EM_CLOSE, 'g')
    function renderReasoning(s) {
      return s.replace(THINK_RE, function (_m, label, body) {
        const lbl = label.trim()
        const summary = lbl ? '💭 ' + lbl : '💭 Thinking…'
        return '<details class="reasoning"><summary>' + summary +
               '</summary><div class="reasoning-body">' + body + '</div></details>'
      })
    }
    function formatBotText(raw) {
      if (!raw) return ''
      let s = escapeHtml(raw)
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      s = s.replace(/`([^`]+)`/g, '<code>$1</code>')
      s = s.replace(EM_RE, '<em>$1</em>')
      s = s.replace(/\n/g, '<br>')
      // Rewrite reasoning sentinels last so the block body already carries the
      // inline (bold/code/italic) + <br> formatting applied above.
      s = renderReasoning(s)
      // The reasoning block is block-level; strip <br>s hugging it so there is
      // no big empty gap between the thinking block and the answer text.
      s = s.replace(/(?:<br>\s*)+(<details)/g, '$1').replace(/(<\/details>)(?:\s*<br>)+/g, '$1')
      return s
    }
    function timeNow() {
      const d = new Date()
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }

    function appendSys(text) {
      const el = document.createElement('div')
      el.className = 'sys'
      el.textContent = text
      log.appendChild(el)
      scrollBottom()
    }

    function appendUser(text, images, fileLabels) {
      const row = document.createElement('div')
      row.className = 'row row-user'
      const bubble = bubbleEl(LABEL_USER)
      if (text) bubble.appendChild(document.createTextNode(text))
      for (const b64 of (images || [])) bubble.appendChild(inlineImg(b64))
      for (const label of (fileLabels || [])) {
        const chip = document.createElement('div')
        chip.className = 'file-chip'
        chip.textContent = '📎 ' + label
        bubble.appendChild(chip)
      }
      const t = document.createElement('span')
      t.className = 'time'
      t.textContent = timeNow()
      bubble.appendChild(t)
      row.appendChild(bubble)
      log.appendChild(row)
      scrollBottom()
    }

    // Build an inline <img> from base64. Browsers sniff the real format, so the
    // declared jpeg mime works for png/webp too. Scroll once it loads (its height
    // isn't known until then, so an earlier scrollBottom lands short).
    function inlineImg(b64) {
      const img = document.createElement('img')
      img.className = 'inline'
      img.src = 'data:image/jpeg;base64,' + b64
      img.addEventListener('load', scrollBottom)
      return img
    }
    function inlineVideo(b64, filename) {
      const v = document.createElement('video')
      v.className = 'inline'
      v.controls = true
      v.setAttribute('playsinline', '')
      v.src = 'data:' + mimeForVideo(filename) + ';base64,' + b64
      v.addEventListener('loadeddata', scrollBottom)
      return v
    }
    function inlineDoc(b64, filename) {
      const name = filename || 'file'
      const wrap = document.createElement('div')
      const a = document.createElement('a')
      a.className = 'doc-link'
      a.download = name.replace(/["\\]/g, '')
      a.href = 'data:application/octet-stream;base64,' + b64
      a.textContent = '📎 ' + name
      wrap.appendChild(a)
      return wrap
    }
    // Containers the renderer's TTS / voice replies may arrive in. The declared
    // type is data, so it is matched against this list instead of being trusted.
    const AUDIO_MIMES = [
      'audio/ogg', 'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/wav',
      'audio/x-wav', 'audio/webm', 'audio/flac', 'audio/aac',
    ]
    function inlineAudio(b64, mime) {
      const a = document.createElement('audio')
      a.className = 'inline'
      a.controls = true
      const declared = String(mime || '').toLowerCase().split(';')[0].trim()
      a.src = 'data:' + (AUDIO_MIMES.indexOf(declared) !== -1 ? declared : 'audio/ogg') +
              ';base64,' + b64
      a.addEventListener('loadeddata', scrollBottom)
      return a
    }

    // Repaint the whole log from a conversation transcript (the `history` event
    // the renderer sends when a chat is loaded), text and images alike. Old
    // messages render without a timestamp since the original send time isn't
    // carried.
    function appendHistory(messages) {
      log.innerHTML = ''
      clearDraft()
      hideTyping()
      for (const m of messages) {
        if (!m) continue
        const imgs = Array.isArray(m.images) ? m.images : []
        const vids = Array.isArray(m.videos) ? m.videos : []
        const docs = Array.isArray(m.documents) ? m.documents : []
        if (!m.text && imgs.length === 0 && vids.length === 0 && docs.length === 0) continue
        const media = imgs.map(inlineImg)
          .concat(vids.map((v) => inlineVideo(v.base64, v.filename)))
          .concat(docs.map((d) => inlineDoc(d.base64, d.filename)))
        if (m.role === 'user') {
          const row = document.createElement('div')
          row.className = 'row row-user'
          const bubble = bubbleEl(LABEL_USER)
          if (m.text) bubble.appendChild(document.createTextNode(m.text))
          for (const node of media) bubble.appendChild(node)
          row.appendChild(bubble)
          log.appendChild(row)
        } else {
          appendBotHtml(m.text ? formatBotText(m.text) : '', false, media)
        }
      }
      scrollBottom()
    }

    // `html` is trusted-by-construction markup (formatBotText escapes first, then
    // re-introduces only its own tags). Anything carrying data — base64 payloads,
    // mime types, filenames — must arrive as a node in `media` instead, built by
    // the inline* helpers so values are set through DOM properties and can never
    // break out of an attribute. Media is inserted before the timestamp so the
    // time still reads last.
    function appendBotHtml(html, withTime, media) {
      clearDraft()
      hideTyping()
      const row = document.createElement('div')
      row.className = 'row row-bot'
      const av = document.createElement('div')
      av.className = 'tg-avatar'
      av.style.width = '32px'
      av.style.height = '32px'
      av.style.fontSize = '11px'
      av.textContent = 'HA'
      const bubble = bubbleEl(LABEL_BOT)
      bubble.innerHTML = html
      // Inline media loads asynchronously; scroll to the bottom once each is
      // ready so the newest content stays in view.
      bubble.querySelectorAll('img').forEach((im) => im.addEventListener('load', scrollBottom))
      bubble.querySelectorAll('video').forEach((v) => v.addEventListener('loadeddata', scrollBottom))
      for (const node of (media || [])) bubble.appendChild(node)
      if (withTime !== false) {
        const tm = document.createElement('span')
        tm.className = 'time'
        tm.textContent = timeNow()
        bubble.appendChild(tm)
      }
      row.appendChild(av)
      row.appendChild(bubble)
      log.appendChild(row)
      scrollBottom()
      return bubble
    }

    function showTyping() {
      if (typingRow || draftRow) return
      typingRow = document.createElement('div')
      typingRow.className = 'row row-bot'
      const av = document.createElement('div')
      av.className = 'tg-avatar'
      av.style.width = '32px'
      av.style.height = '32px'
      av.style.fontSize = '11px'
      av.textContent = 'HA'
      const bubble = document.createElement('div')
      bubble.className = 'bubble'
      bubble.setAttribute('role', 'status')
      bubble.setAttribute('aria-label', 'Home Agent is typing')
      bubble.innerHTML = '<span class="typing-dots"><span></span><span></span><span></span></span>'
      typingRow.appendChild(av)
      typingRow.appendChild(bubble)
      log.appendChild(typingRow)
      statusLine.textContent = 'typing…'
      scrollBottom()
    }

    function hideTyping() {
      if (typingRow) { typingRow.remove(); typingRow = null }
      statusLine.textContent = 'online'
    }

    function ensureDraftRow() {
      hideTyping()
      if (draftRow) return
      draftRow = document.createElement('div')
      draftRow.className = 'row row-bot'
      const av = document.createElement('div')
      av.className = 'tg-avatar'
      av.style.width = '32px'
      av.style.height = '32px'
      av.style.fontSize = '11px'
      av.textContent = 'HA'
      draftBubble = bubbleEl(LABEL_DRAFT)
      draftBubble.className = 'bubble streaming'
      draftRow.appendChild(av)
      draftRow.appendChild(draftBubble)
      log.appendChild(draftRow)
    }

    function setDraft(text) {
      ensureDraftRow()
      draftBubble.innerHTML = formatBotText(text) + '<span class="cursor">▋</span>'
      scrollBottom()
    }

    function clearDraft() {
      if (draftRow) { draftRow.remove(); draftRow = null; draftBubble = null }
    }

    function finalizeBot(text) {
      const html = formatBotText(text)
      if (draftBubble && draftRow) {
        draftBubble.classList.remove('streaming')
        draftBubble.setAttribute('aria-label', LABEL_BOT)
        draftBubble.innerHTML = html
        const tm = document.createElement('span')
        tm.className = 'time'
        tm.textContent = timeNow()
        draftBubble.appendChild(tm)
        draftRow = null
        draftBubble = null
        scrollBottom()
        return
      }
      appendBotHtml(html)
    }

    async function api(path, body) {
      const res = await fetch(path, {
        method: body !== undefined ? 'POST' : 'GET',
        headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
        credentials: 'same-origin',
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      if (!res.ok) {
        // Keep the status and parsed body on the error: callers distinguish a
        // rejected password from a rate-limited one.
        const text = await res.text()
        let detail = {}
        try { detail = JSON.parse(text) } catch (_) {}
        const err = new Error(detail.error || text || res.statusText)
        err.status = res.status
        err.detail = detail
        throw err
      }
      return res.json().catch(() => ({}))
    }

    function showChat() { loginScreen.classList.add('hidden'); chatScreen.classList.remove('hidden') }
    function showLogin(msg) {
      chatScreen.classList.add('hidden')
      loginScreen.classList.remove('hidden')
      if (es) { es.close(); es = null }
      if (msg) loginError.textContent = msg
    }

    async function trySession() {
      try {
        const s = await api('/api/session')
        if (s.ok) { showChat(); startChat(); return }
      } catch (_) {}
      showLogin('')
    }

    /** Is the current cookie still a valid session on the server? Used to tell a
     *  transient stream blip from a real session loss (e.g. AI Playground was
     *  restarted, so the server forgot every session). */
    async function verifySession() {
      try {
        const s = await api('/api/session')
        return !!s.ok
      } catch (_) {
        return false
      }
    }

    const SESSION_ENDED_MSG = 'Your session ended (was AI Playground restarted?). Please sign in again.'

    async function doLogin() {
      loginError.textContent = ''
      loginBtn.disabled = true
      try {
        await api('/api/login', { password: passwordInput.value })
        passwordInput.value = ''
        showChat()
        startChat()
      } catch (e) {
        loginError.textContent = e && e.status === 429
          ? 'Too many attempts. Try again in ' + ((e.detail && e.detail.retryAfter) || 30) + ' s.'
          : 'Wrong password. Check AI Playground setup.'
      } finally {
        loginBtn.disabled = false
      }
    }

    loginBtn.onclick = () => doLogin()
    passwordInput.onkeydown = (e) => { if (e.key === 'Enter') doLogin() }

    // Post an inbound message / callback, recovering gracefully when the session
    // is gone (server restart): bounce to the login screen instead of failing
    // silently on the dropped POST.
    async function postChat(body) {
      try {
        await api('/api/chat', body)
      } catch (_) {
        if (!(await verifySession())) showLogin(SESSION_ENDED_MSG)
        else appendSys('Could not send — please try again.')
      }
    }

    async function sendText(text) {
      const t = text.trim()
      if (!t) return
      appendUser(t)
      input.value = ''
      input.style.height = 'auto'
      await postChat({ text: t })
    }

    sendBtn.onclick = () => sendText(input.value)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendText(input.value) }
    })

    // ── File attachments ────────────────────────────────────────────────────
    // Read picked files as base64 and post them shaped like the other channels'
    // inbound (images → vision, audio → transcription, everything else → RAG
    // documents), alongside any typed text.
    function mimeForVideo(filename) {
      const f = (filename || '').toLowerCase()
      if (f.endsWith('.webm')) return 'video/webm'
      if (f.endsWith('.mov')) return 'video/quicktime'
      if (f.endsWith('.ogv') || f.endsWith('.ogg')) return 'video/ogg'
      return 'video/mp4'
    }
    function fileToBase64(file) {
      return new Promise((resolve, reject) => {
        const r = new FileReader()
        r.onload = () => resolve(String(r.result).split(',')[1] || '')
        r.onerror = () => reject(r.error)
        r.readAsDataURL(file)
      })
    }
    async function sendFiles(fileArray) {
      if (!fileArray || !fileArray.length) return
      const images = [], audio = [], documents = [], userImgs = [], labels = []
      for (const f of fileArray) {
        let b64
        try { b64 = await fileToBase64(f) } catch (_) { continue }
        if (!b64) continue
        const type = f.type || ''
        if (type.startsWith('image/')) { images.push({ mime: type, data_base64: b64 }); userImgs.push(b64) }
        else if (type.startsWith('audio/')) { audio.push({ mime: type, data_base64: b64 }); labels.push(f.name) }
        else { documents.push({ filename: f.name, mime: type || 'application/octet-stream', data_base64: b64 }); labels.push(f.name) }
      }
      const text = input.value.trim()
      input.value = ''
      input.style.height = 'auto'
      appendUser(text, userImgs, labels)
      await postChat({
        text: text || undefined,
        images: images.length ? images : undefined,
        audio: audio.length ? audio : undefined,
        documents: documents.length ? documents : undefined,
      })
    }
    attachBtn.onclick = () => fileInput.click()
    fileInput.onchange = () => {
      const picked = Array.from(fileInput.files || [])
      fileInput.value = '' // allow re-picking the same file later
      void sendFiles(picked)
    }

    input.addEventListener('input', () => {
      input.style.height = 'auto'
      input.style.height = Math.min(input.scrollHeight, 120) + 'px'
    })

    // ── Command menu (parity with Telegram's command list) ──────────────────
    // `send: true` fires the command immediately; `false` pre-fills the composer
    // so the user can type an argument (e.g. the message after /chat).
    const COMMANDS = [
      { cmd: '/imgGen', desc: 'Generate an image — pick a preset, then send a prompt', send: true },
      { cmd: '/chat', desc: 'Force a plain text reply (type your message after)', send: false },
      { cmd: '/new', desc: 'Start a fresh chat thread', send: true },
      { cmd: '/history', desc: 'List your saved chat threads', send: true },
      { cmd: '/load', desc: 'Pick a recent chat to resume', send: true },
      { cmd: '/reset', desc: 'Restore Home Agent settings to their defaults', send: true },
      { cmd: '/cancel', desc: 'Cancel a pending /imgGen flow', send: true },
      { cmd: '/help', desc: 'Show all commands', send: true },
    ]

    function buildMenu() {
      cmdMenu.innerHTML = ''
      for (const c of COMMANDS) {
        const item = document.createElement('button')
        item.type = 'button'
        item.className = 'cmd-item'
        const name = document.createElement('span')
        name.className = 'cmd-name'
        name.textContent = c.cmd
        const desc = document.createElement('span')
        desc.className = 'cmd-desc'
        desc.textContent = c.desc
        item.appendChild(name)
        item.appendChild(desc)
        item.onclick = () => {
          hideMenu()
          if (c.send) {
            sendText(c.cmd)
          } else {
            input.value = c.cmd + ' '
            input.focus()
            input.dispatchEvent(new Event('input'))
          }
        }
        cmdMenu.appendChild(item)
      }
    }
    function hideMenu() { cmdMenu.classList.add('hidden') }
    menuBtn.onclick = (e) => { e.stopPropagation(); cmdMenu.classList.toggle('hidden') }
    document.addEventListener('click', (e) => {
      if (cmdMenu.classList.contains('hidden')) return
      if (e.target !== menuBtn && !cmdMenu.contains(e.target)) hideMenu()
    })
    buildMenu()

    function onEvent(ev) {
      const d = ev.data ? JSON.parse(ev.data) : {}
      const action = d.action
      if (action === 'history' && Array.isArray(d.messages)) { appendHistory(d.messages); return }
      if (action === 'typing') {
        // A turn that ends without any output still has to stop the dots, so the
        // heartbeat's disposer sends state=stop (see send_typing).
        if (d.state === 'stop') hideTyping()
        else showTyping()
        return
      }
      if (action === 'draftUpdate' || action === 'update') {
        setDraft(d.text || '')
        return
      }
      if (action === 'draftFinal' || action === 'reply') {
        finalizeBot(d.text || '')
        return
      }
      if (action === 'editMessage') {
        // The store settles an interactive prompt in place (confirmed/cancelled/
        // timed out). SSE has no message edit, so retire the live buttons and post
        // the outcome — otherwise the prompt stays tappable and fires again.
        consumeKeyboards()
        finalizeBot(d.text || '')
        return
      }
      const caption = d.caption ? formatBotText(d.caption) : ''
      if (action === 'photo' && d.base64) {
        appendBotHtml(caption, true, [inlineImg(d.base64)])
        return
      }
      if (action === 'video' && d.base64) {
        appendBotHtml(caption, true, [inlineVideo(d.base64, d.filename)])
        return
      }
      if (action === 'voice' && d.base64) {
        appendBotHtml('', true, [inlineAudio(d.base64, d.mime)])
        return
      }
      if (action === 'document' && (d.base64 || d.filename)) {
        const name = d.filename || 'file'
        if (d.base64) appendBotHtml(caption, true, [inlineDoc(d.base64, name)])
        else appendBotHtml(caption + '📎 ' + escapeHtml(name))
        return
      }
      if (action === 'keyboard' && d.buttons) {
        const row = document.createElement('div')
        row.className = 'kbd-row'
        row.setAttribute('role', 'group')
        row.setAttribute('aria-label', LABEL_KEYBOARD)
        const bubble = appendBotHtml(formatBotText(d.text || ''), false, [row])
        bubble.setAttribute('aria-label', LABEL_PROMPT)
        for (const btn of d.buttons.flat()) {
          const cb = btn.callbackData || btn.callback
          const b = document.createElement('button')
          b.type = 'button'
          b.textContent = btn.text || cb
          b.onclick = () => {
            // Consume before posting: the row is the only thing stopping a second
            // tap from re-running the callback (a duplicate image generation, a
            // second download confirmation, …).
            consumeKeyboard(row, b.textContent)
            postChat({ callback: cb })
          }
          row.appendChild(b)
        }
        const tm = document.createElement('span')
        tm.className = 'time'
        tm.textContent = timeNow()
        bubble.appendChild(tm)
        scrollBottom()
      }
    }

    /** Replace a prompt's buttons with the choice that was made. */
    function consumeKeyboard(row, choice) {
      row.innerHTML = ''
      row.setAttribute('aria-label', 'Chosen option')
      const chip = document.createElement('span')
      chip.className = 'file-chip'
      chip.textContent = '✅ ' + (choice || 'Done')
      row.appendChild(chip)
    }

    /** Retire every prompt still showing buttons (the flow moved on without a tap). */
    function consumeKeyboards() {
      for (const row of log.querySelectorAll('.kbd-row')) {
        if (row.querySelector('button')) consumeKeyboard(row, '—')
      }
    }

    function startChat() {
      log.innerHTML = ''
      clearDraft()
      hideTyping()
      appendSys('Connected · try /help')
      if (es) es.close()
      es = new EventSource('/api/events', { withCredentials: true })
      es.onopen = () => { statusLine.textContent = 'online' }
      es.onmessage = onEvent
      es.onerror = async () => {
        // The stream dropped. A transient blip auto-reconnects (EventSource) and
        // the session is still valid; a server/app restart forgot the session.
        // Verify: if the session is gone, return to the login page rather than
        // leaving a dead chat screen that silently swallows prompts.
        statusLine.textContent = 'reconnecting…'
        if (recovering) return
        recovering = true
        try {
          if (!(await verifySession())) showLogin(SESSION_ENDED_MSG)
        } finally {
          recovering = false
        }
      }
    }

    trySession()
  </script>
</body>
</html>"""
