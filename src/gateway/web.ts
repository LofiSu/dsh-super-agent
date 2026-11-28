/** Minimal read-only gateway dashboard, served at `GET /`. */
export function dashboardHtml(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>LofiBot Gateway</title>
<style>
 :root { color-scheme: dark; background: #101735; color: #fbf4f8; }
 body { font: 14px/1.5 -apple-system, system-ui, sans-serif; margin: clamp(1rem, 4vw, 2rem); }
 h1 { font-size: 1.3rem; }
 code { color: #ffa6d2; background: #192750; padding: .1em .3em; border-radius: 4px; }
 pre { background: #192750; border: 1px solid #384b7d; padding: 1rem; border-radius: 8px; overflow: auto; max-height: 70vh; }
 .muted { color: #b7c7e8; }
</style></head>
<body>
<h1>LofiBot Gateway</h1>
<p class="muted">Minimal read-only dashboard. Live providers / plugins / metrics from <code>/health</code> (refreshes every 3s).</p>
<pre id="out">loading…</pre>
<script>
async function refresh(){
  try{ const r=await fetch('/health'); document.getElementById('out').textContent=JSON.stringify(await r.json(),null,2) }
  catch(e){ document.getElementById('out').textContent=String(e) }
}
refresh(); setInterval(refresh,3000);
</script>
</body></html>`
}
