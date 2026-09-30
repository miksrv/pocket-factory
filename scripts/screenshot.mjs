// Screenshot a page of the running UI via the DevTools protocol:
//   node scripts/screenshot.mjs http://localhost:8080/chat/<id> out.png [width] [height] [js]
// The optional js runs in the page before the capture (open <details>, click a tab …).
// Unlike `chrome --headless --screenshot`, it does not wait for the load
// event, which never fires on the Chat page (it keeps an SSE stream open).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
const [url, out, width = '1280', height = '760', js] = process.argv.slice(2)
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=${width},${height}`, '--remote-debugging-port=9333', `--user-data-dir=${process.env.TMPDIR ?? '/tmp'}/pf-screenshot-profile`, 'about:blank'], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
try {
    let target
    for (let i = 0; i < 30 && !target; i++) {
        await sleep(300)
        target = await fetch('http://127.0.0.1:9333/json/list').then((r) => r.json()).then((l) => l.find((t) => t.type === 'page')).catch(() => undefined)
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((r) => (ws.onopen = r))
    let id = 0
    const call = (method, params = {}) =>
        new Promise((resolve) => {
            const me = ++id
            const on = (e) => { const m = JSON.parse(e.data); if (m.id === me) { ws.removeEventListener('message', on); resolve(m.result) } }
            ws.addEventListener('message', on)
            ws.send(JSON.stringify({ id: me, method, params }))
        })
    // Basic auth: credentials in the URL would break the page's own fetches, so they go into a header instead.
    const page = new URL(url)
    if (page.username) {
        await call('Network.enable')
        await call('Network.setExtraHTTPHeaders', { headers: { Authorization: `Basic ${Buffer.from(`${decodeURIComponent(page.username)}:${decodeURIComponent(page.password)}`).toString('base64')}` } })
        page.username = ''
        page.password = ''
    }
    await call('Page.navigate', { url: page.toString() })
    await sleep(4000)
    if (js) {
        const { result } = await call('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true })
        if (result?.value !== undefined) console.log('js:', JSON.stringify(result.value))
        await sleep(500)
    }
    const { data } = await call('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(out, Buffer.from(data, 'base64'))
    console.log('wrote', out)
} finally {
    chrome.kill('SIGKILL')
}
