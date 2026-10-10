import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MAP_PATH = path.join(ROOT, 'codemap.json')
const HTML_PATH = path.join(ROOT, 'codemap.html')
const LOCK_PATH = path.join(ROOT, 'codemap.lock')
const GENERATOR_VERSION = '1.0.0'

const INCLUDED_EXTENSIONS = new Set([
  '.css', '.html', '.js', '.json', '.mjs', '.md', '.py', '.ts', '.tsx', '.vue', '.yaml', '.yml',
])
const IGNORED_DIRECTORIES = new Set([
  '.git', '.pytest_cache', '.venv', '.vite', 'node_modules', 'dist', 'build', '__pycache__',
  '.ayatori-data', 'data', 'coverage',
])
const IGNORED_FILES = new Set([
  'codemap.html', 'codemap.json', 'codemap.lock', 'package-lock.json', '.DS_Store',
])

const LANE_DEFINITIONS = [
  ['frontend-entry', 'Frontend entrypoints', 'Vue application bootstrap and the top-level shell'],
  ['frontend-shell', 'Frontend shell', 'Navigation, theme, layout, shared models and API access'],
  ['frontend-features', 'Frontend features', 'Feature pages, dialogs and stateful composables'],
  ['backend-entry', 'Backend API', 'FastAPI entrypoints and request schemas'],
  ['backend-runtime', 'Backend runtime', 'Authentication, services and persistence adapters'],
  ['resources-tests', 'Resources & tests', 'Seed data, documentation and automated tests'],
  ['tooling', 'Tooling & config', 'Build, deployment and repository configuration'],
]

const LANE_LOOKUP = new Map(LANE_DEFINITIONS.map(([id, label, description]) => [id, { id, label, description }]))

async function walk(directory, result = []) {
  const entries = await fs.readdir(directory, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORED_DIRECTORIES.has(entry.name)) continue
    const absolutePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      await walk(absolutePath, result)
      continue
    }
    if (!entry.isFile() || IGNORED_FILES.has(entry.name)) continue
    if (!INCLUDED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) continue
    result.push(absolutePath)
  }
  return result
}

function relativeFile(absolutePath) {
  return path.relative(ROOT, absolutePath).split(path.sep).join('/')
}

function fileKind(filePath) {
  const extension = path.extname(filePath).slice(1).toLowerCase()
  if (extension === 'vue') return 'vue'
  if (extension === 'ts' || extension === 'tsx') return 'typescript'
  if (extension === 'js' || extension === 'mjs') return 'javascript'
  if (extension === 'py') return 'python'
  if (extension === 'css') return 'stylesheet'
  if (extension === 'json') return 'json'
  if (extension === 'md') return 'documentation'
  return extension || 'file'
}

function classifyLane(filePath) {
  if (filePath === 'frontend/src/main.ts' || filePath === 'frontend/src/App.vue' || filePath === 'backend/__main__.py' || filePath === 'backend/app/main.py') {
    return filePath.startsWith('backend/') ? 'backend-entry' : 'frontend-entry'
  }
  if (filePath.startsWith('frontend/src/components/') || filePath.startsWith('frontend/src/api/') || filePath.startsWith('frontend/src/models/') || filePath.startsWith('frontend/src/utils/') || filePath.startsWith('frontend/src/features/shell/')) return 'frontend-shell'
  if (filePath.startsWith('frontend/src/features/')) return 'frontend-features'
  if (filePath.startsWith('backend/app/core/') || filePath === 'backend/app/schemas.py' || filePath.startsWith('backend/app/services/') || filePath.startsWith('backend/app/storage/')) return 'backend-runtime'
  if (filePath.startsWith('backend/app/resources/') || filePath.startsWith('backend/tests/') || filePath === 'backend/app/README.md' || filePath === 'README.md') return 'resources-tests'
  return 'tooling'
}

function extractReferences(filePath, source) {
  const references = new Set()
  const extension = path.extname(filePath).toLowerCase()
  if (['.ts', '.tsx', '.js', '.mjs', '.vue'].includes(extension)) {
    const importFrom = /(?:import|export)\s+(?:[\s\S]*?\sfrom\s*)?["']([^"']+)["']/g
    const dynamicImport = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g
    const requireCall = /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g
    for (const pattern of [importFrom, dynamicImport, requireCall]) {
      for (const match of source.matchAll(pattern)) references.add(match[1])
    }
  } else if (extension === '.css') {
    for (const match of source.matchAll(/@import\s+(?:url\(\s*)?["']?([^"')\s]+)["']?/g)) references.add(match[1])
  } else if (extension === '.py') {
    for (const match of source.matchAll(/^\s*from\s+([.\w]+)\s+import|^\s*import\s+([.\w]+)/gm)) references.add(match[1] || match[2])
  }
  return [...references]
}

function resolveReference(fromPath, reference, knownFiles) {
  if (!reference || (!reference.startsWith('.') && !reference.startsWith('/'))) return null
  const base = reference.startsWith('/')
    ? path.join(ROOT, reference.slice(1))
    : path.resolve(ROOT, path.dirname(fromPath), reference)
  const candidates = [base]
  for (const extension of INCLUDED_EXTENSIONS) candidates.push(`${base}${extension}`)
  for (const extension of INCLUDED_EXTENSIONS) candidates.push(path.join(base, `index${extension}`))
  for (const candidate of candidates) {
    const normalized = relativeFile(candidate)
    if (knownFiles.has(normalized)) return normalized
  }
  return null
}

function hashSource(files) {
  const hash = createHash('sha256')
  for (const file of files) hash.update(`${file.path}\0${file.hash}\n`)
  return hash.digest('hex')
}

function buildTree(files) {
  const root = { name: '.', path: '', type: 'directory', children: [] }
  for (const file of files) {
    let current = root
    const parts = file.path.split('/')
    parts.forEach((part, index) => {
      const isFile = index === parts.length - 1
      let child = current.children.find((item) => item.name === part)
      if (!child) {
        child = { name: part, path: parts.slice(0, index + 1).join('/'), type: isFile ? 'file' : 'directory', children: [] }
        current.children.push(child)
      }
      current = child
    })
  }
  return root
}

function escapeJsonForHtml(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function makeHtml(map) {
  const embedded = escapeJsonForHtml(map)
  return String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Ayatori · interactive code map</title>
  <style>
    :root { color-scheme: dark; --bg:#07131d; --panel:#0d1d2a; --panel-2:#102535; --line:#294252; --text:#e6f1f3; --muted:#91a9b5; --cyan:#4bc5ef; --pink:#ef6f9f; --green:#55d5b2; --amber:#e6b35a; --blue:#6c9ef8; --purple:#ad91f3; --shadow:0 16px 40px rgba(0,0,0,.22); }
    * { box-sizing:border-box; }
    body { margin:0; min-width:1100px; height:100vh; overflow:hidden; background:radial-gradient(circle at 50% -10%, #153345 0, var(--bg) 38%); color:var(--text); font:12px/1.45 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    button,input { font:inherit; }
    button { color:inherit; cursor:pointer; }
    .app { display:grid; grid-template-columns:220px minmax(660px,1fr) 270px; height:100vh; }
    aside { background:rgba(7,18,28,.88); border-color:rgba(86,136,159,.24); }
    .left { padding:18px 14px; border-right:1px solid var(--line); overflow:auto; }
    .right { padding:18px 14px; border-left:1px solid var(--line); overflow:auto; }
    .brand { display:flex; gap:10px; align-items:center; margin:0 6px 18px; }
    .brand-mark { width:29px; height:29px; display:grid; place-items:center; border:1px solid var(--cyan); border-radius:8px; color:var(--cyan); font-weight:800; }
    h1,h2,h3,p { margin:0; }
    h1 { font-size:15px; letter-spacing:.3px; }
    h2 { margin:22px 6px 8px; color:var(--muted); font-size:9px; letter-spacing:1.4px; text-transform:uppercase; }
    .sub { color:var(--muted); font-size:10px; }
    .search { width:100%; height:32px; padding:0 9px; border:1px solid var(--line); border-radius:6px; outline:none; color:var(--text); background:#091925; }
    .search:focus { border-color:var(--cyan); box-shadow:0 0 0 2px rgba(75,197,239,.14); }
    .toolbar { display:flex; gap:6px; margin-top:8px; }
    .toolbar button,.view-button { flex:1; min-height:29px; padding:4px 6px; border:1px solid var(--line); border-radius:6px; background:#0b1c29; color:var(--muted); font-size:10px; }
    .toolbar button:hover,.view-button:hover,.view-button.active { border-color:var(--cyan); color:var(--text); background:#112b3b; }
    .filters { display:grid; gap:7px; }
    .filter { display:flex; gap:7px; align-items:center; color:var(--muted); font-size:10px; }
    .filter input { accent-color:var(--cyan); }
    .legend { display:grid; gap:6px; }
    .legend-row { display:flex; gap:8px; align-items:center; color:var(--muted); font-size:10px; }
    .swatch { width:8px; height:8px; border-radius:50%; background:var(--cyan); }
    .swatch.frontend { background:var(--pink); } .swatch.backend { background:var(--green); } .swatch.tooling { background:var(--amber); }
    .map-shell { min-width:0; display:flex; flex-direction:column; }
    .header { height:66px; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:0 18px; border-bottom:1px solid var(--line); background:rgba(8,22,33,.76); }
    .header-meta { color:var(--muted); font-size:10px; }
    .header-actions { display:flex; gap:7px; }
    .header-actions button { padding:6px 9px; border:1px solid var(--line); border-radius:6px; background:#0c202f; font-size:10px; }
    .header-actions button:hover { border-color:var(--cyan); }
    .board-wrap { position:relative; flex:1; min-height:0; overflow:auto; padding:22px; }
    .board { position:relative; display:grid; grid-template-columns:repeat(7,minmax(168px,1fr)); gap:12px; min-width:1220px; min-height:calc(100vh - 110px); padding-bottom:30px; }
    .edges { position:absolute; inset:0; width:100%; height:100%; overflow:visible; pointer-events:none; }
    .lane { position:relative; z-index:1; min-height:560px; padding:10px 8px; border:1px solid rgba(72,126,150,.28); border-radius:11px; background:rgba(12,31,45,.52); }
    .lane-title { display:flex; align-items:center; gap:6px; min-height:28px; margin:0 4px 10px; color:#a9c2cb; font-size:9px; font-weight:700; letter-spacing:1.2px; text-transform:uppercase; }
    .lane-title::before { content:""; width:4px; height:14px; border-radius:3px; background:var(--cyan); }
    .lane-count { margin-left:auto; color:var(--muted); font-size:9px; letter-spacing:0; }
    .lane:nth-child(2) .lane-title::before,.node.backend { background-color:var(--green); }
    .lane:nth-child(3) .lane-title::before,.node.frontend { background-color:var(--pink); }
    .lane:nth-child(4) .lane-title::before { background:var(--green); }
    .lane:nth-child(5) .lane-title::before { background:var(--green); }
    .lane:nth-child(6) .lane-title::before { background:var(--amber); }
    .lane:nth-child(7) .lane-title::before { background:var(--amber); }
    .node { position:relative; display:block; width:100%; margin:0 0 8px; padding:9px 9px 8px; border:1px solid rgba(75,197,239,.72); border-left:3px solid var(--cyan); border-radius:7px; text-align:left; background:linear-gradient(135deg,rgba(17,49,68,.96),rgba(10,27,41,.96)); box-shadow:0 5px 16px rgba(0,0,0,.14); transition:transform .14s,border-color .14s,opacity .14s; }
    .node:hover,.node:focus-visible { transform:translateY(-1px); border-color:#b6f0ff; outline:none; }
    .node.frontend { border-color:rgba(239,111,159,.68); border-left-color:var(--pink); background:linear-gradient(135deg,rgba(55,31,53,.95),rgba(25,24,41,.96)); }
    .node.backend { border-color:rgba(85,213,178,.68); border-left-color:var(--green); background:linear-gradient(135deg,rgba(22,57,55,.95),rgba(12,31,40,.96)); }
    .node.tooling { border-color:rgba(230,179,90,.68); border-left-color:var(--amber); background:linear-gradient(135deg,rgba(58,49,31,.95),rgba(28,29,31,.96)); }
    .node.dim { opacity:.16; }
    .node.focused { box-shadow:0 0 0 2px rgba(75,197,239,.72),0 8px 26px rgba(0,0,0,.24); }
    .node.neighbor { box-shadow:0 0 0 1px rgba(230,179,90,.92); }
    .node-name { display:block; overflow:hidden; color:#f3fbfc; font-size:11px; font-weight:700; text-overflow:ellipsis; white-space:nowrap; }
    .node-path { display:block; overflow:hidden; margin-top:3px; color:#9cb5bf; font:9px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace; text-overflow:ellipsis; white-space:nowrap; }
    .node-tag { display:inline-block; margin-top:7px; padding:2px 5px; border:1px solid currentColor; border-radius:4px; color:var(--cyan); font-size:8px; letter-spacing:.5px; text-transform:uppercase; }
    .frontend .node-tag { color:var(--pink); } .backend .node-tag { color:var(--green); } .tooling .node-tag { color:var(--amber); }
    .edge { fill:none; stroke:rgba(92,141,161,.34); stroke-width:1.2; }
    .edge.active { stroke:var(--cyan); stroke-width:2; opacity:.95; }
    .edge.neighbor { stroke:var(--amber); stroke-width:1.6; opacity:.9; }
    .edge.search { stroke:var(--pink); stroke-width:1.6; opacity:.82; }
    .right h2 { margin-top:0; }
    .detail-empty { margin-top:24px; color:var(--muted); font-size:11px; }
    .detail-title { overflow-wrap:anywhere; color:#f4fcfd; font-size:15px; }
    .detail-path { margin-top:5px; overflow-wrap:anywhere; color:var(--muted); font:10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; }
    .detail-stats { display:grid; grid-template-columns:1fr 1fr; gap:7px; margin:15px 0; }
    .stat { padding:8px; border:1px solid var(--line); border-radius:6px; background:#0a1b27; }
    .stat b { display:block; color:var(--text); font-size:13px; } .stat span { color:var(--muted); font-size:9px; }
    .detail-list { display:grid; gap:5px; margin-top:8px; }
    .detail-list a { overflow:hidden; color:#83d8ee; font:9px ui-monospace,SFMono-Regular,Menlo,monospace; text-overflow:ellipsis; white-space:nowrap; text-decoration:none; }
    .detail-list a:hover { text-decoration:underline; }
    .status { position:absolute; left:22px; bottom:12px; color:var(--muted); font-size:9px; pointer-events:none; }
    @media (max-width:1200px) { .app { grid-template-columns:200px minmax(620px,1fr) 240px; } }
  </style>
</head>
<body>
  <div class="app" id="codemap-app">
    <aside class="left">
      <div class="brand"><div class="brand-mark">⌘</div><div><h1>Ayatori</h1><div class="sub">interactive code map</div></div></div>
      <input class="search" id="search" type="search" placeholder="Search name, role, or path" aria-label="Search files">
      <div class="toolbar"><button id="fit" type="button">Fit map</button><button id="clear" type="button">Clear focus</button></div>
      <h2>Map views</h2>
      <div id="views"></div>
      <h2>Module filters</h2>
      <div class="filters" id="filters"></div>
      <h2>Legend</h2>
      <div class="legend"><div class="legend-row"><span class="swatch frontend"></span>Frontend</div><div class="legend-row"><span class="swatch backend"></span>Backend</div><div class="legend-row"><span class="swatch"></span>Dependency edge</div><div class="legend-row"><span class="swatch tooling"></span>Tooling / data</div></div>
    </aside>
    <main class="map-shell">
      <header class="header"><div><h1>Ayatori · interactive code map</h1><div class="header-meta" id="meta"></div></div><div class="header-actions"><button id="fit-top" type="button">Fit map</button><button id="clear-top" type="button">Clear focus</button></div></header>
      <div class="board-wrap" id="board-wrap"><div class="board" id="board"><svg class="edges" id="edges" aria-hidden="true"></svg></div><div class="status" id="status"></div></div>
    </main>
    <aside class="right"><h2>Selection</h2><div id="detail"><div class="detail-empty">Select a module to inspect its imports, dependents, and source metadata.</div></div></aside>
  </div>
  <script type="application/json" id="codemap-data">__CODEMAP_DATA__</script>
  <script>
    (function () {
      const map = JSON.parse(document.getElementById('codemap-data').textContent)
      const board = document.getElementById('board')
      const edgesSvg = document.getElementById('edges')
      const searchInput = document.getElementById('search')
      const detail = document.getElementById('detail')
      const status = document.getElementById('status')
      const meta = document.getElementById('meta')
      const views = document.getElementById('views')
      const filters = document.getElementById('filters')
      let activeView = 'all'
      let activeGroups = new Set(['frontend', 'backend', 'tooling', 'resources'])
      let selectedId = null

      const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]))
      const groupOf = (node) => node.lane.startsWith('frontend') ? 'frontend' : node.lane.startsWith('backend') ? 'backend' : node.lane === 'tooling' ? 'tooling' : 'resources'
      const nodeMap = new Map(map.nodes.map((node) => [node.id, node]))
      const incoming = new Map(map.nodes.map((node) => [node.id, []]))
      map.edges.forEach((edge) => incoming.get(edge.to)?.push(edge.from))
      map.nodes.forEach((node) => { node.importedBy = incoming.get(node.id) || [] })
      meta.textContent = map.stats.files + ' files · ' + map.stats.edges + ' internal links · source ' + map.sourceHash.slice(0, 12)

      const viewDefinitions = [['all', 'All modules'], ['frontend', 'Frontend flow'], ['backend', 'Backend flow'], ['resources', 'Resources & tests']]
      viewDefinitions.forEach(([id, label]) => {
        const button = document.createElement('button')
        button.className = 'view-button' + (id === activeView ? ' active' : '')
        button.type = 'button'; button.textContent = label
        button.addEventListener('click', () => { activeView = id; render() })
        views.appendChild(button)
      })
      [['frontend','Frontend'], ['backend','Backend'], ['tooling','Tooling'], ['resources','Resources']].forEach(([id, label]) => {
        const labelElement = document.createElement('label'); labelElement.className = 'filter'
        labelElement.innerHTML = '<input type="checkbox" checked> ' + label
        const input = labelElement.querySelector('input')
        input.addEventListener('change', () => { input.checked ? activeGroups.add(id) : activeGroups.delete(id); render() })
        filters.appendChild(labelElement)
      })

      function matches(node) {
        const query = searchInput.value.trim().toLowerCase()
        const viewMatch = activeView === 'all' || groupOf(node) === activeView
        const groupMatch = activeGroups.has(groupOf(node))
        const textMatch = !query || (node.id + ' ' + node.name + ' ' + node.kind + ' ' + node.lane).toLowerCase().includes(query)
        return viewMatch && groupMatch && textMatch
      }

      function render() {
        views.querySelectorAll('button').forEach((button, index) => button.classList.toggle('active', viewDefinitions[index][0] === activeView))
        board.querySelectorAll('.lane').forEach((lane) => lane.remove())
        map.lanes.forEach((lane) => {
          const laneElement = document.createElement('section'); laneElement.className = 'lane'; laneElement.dataset.lane = lane.id
          const visibleNodes = lane.nodeIds.map((id) => nodeMap.get(id)).filter(Boolean).filter(matches)
          laneElement.innerHTML = '<div class="lane-title">' + esc(lane.label) + '<span class="lane-count">' + visibleNodes.length + '</span></div>'
          visibleNodes.forEach((node) => {
            const button = document.createElement('button'); button.type = 'button'; button.className = 'node ' + groupOf(node); button.dataset.node = node.id
            button.innerHTML = '<span class="node-name">' + esc(node.name) + '</span><span class="node-path">' + esc(node.id) + '</span><span class="node-tag">' + esc(node.kind) + '</span>'
            button.addEventListener('click', () => selectNode(node.id))
            button.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); selectNode(node.id) } })
            laneElement.appendChild(button)
          })
          board.appendChild(laneElement)
        })
        status.textContent = board.querySelectorAll('.node').length + ' visible modules · ' + map.stats.edges + ' discovered relationships'
        updateSelection()
        requestAnimationFrame(drawEdges)
      }

      function selectNode(id) { selectedId = id; updateSelection(); drawEdges() }
      function updateSelection() {
        const selected = selectedId ? nodeMap.get(selectedId) : null
        board.querySelectorAll('.node').forEach((element) => {
          const node = nodeMap.get(element.dataset.node)
          const neighbor = selected && (node.id === selected.id || selected.imports.includes(node.id) || (node.importedBy || []).includes(node.id))
          element.classList.toggle('focused', Boolean(selected && node.id === selected.id))
          element.classList.toggle('neighbor', Boolean(selected && neighbor && node.id !== selected.id))
          element.classList.toggle('dim', Boolean(selected && !neighbor))
        })
        if (!selected) { detail.innerHTML = '<div class="detail-empty">Select a module to inspect its imports, dependents, and source metadata.</div>'; return }
        const linkList = (label, ids) => '<h2>' + label + ' <span class="lane-count">' + ids.length + '</span></h2><div class="detail-list">' + (ids.length ? ids.map((id) => '<a href="#" data-select="' + esc(id) + '">' + esc(id) + '</a>').join('') : '<span class="sub">None</span>') + '</div>'
        detail.innerHTML = '<h3 class="detail-title">' + esc(selected.name) + '</h3><div class="detail-path">' + esc(selected.id) + '</div><div class="detail-stats"><div class="stat"><b>' + selected.lines + '</b><span>lines</span></div><div class="stat"><b>' + selected.size + '</b><span>bytes</span></div><div class="stat"><b>' + selected.imports.length + '</b><span>imports</span></div><div class="stat"><b>' + selected.importedBy.length + '</b><span>dependents</span></div></div>' + linkList('Imports', selected.imports) + linkList('Imported by', selected.importedBy)
        detail.querySelectorAll('[data-select]').forEach((link) => link.addEventListener('click', (event) => { event.preventDefault(); selectNode(link.dataset.select) }))
      }

      function drawEdges() {
        const boardRect = board.getBoundingClientRect(); edgesSvg.setAttribute('width', board.scrollWidth); edgesSvg.setAttribute('height', board.scrollHeight); edgesSvg.setAttribute('viewBox', '0 0 ' + board.scrollWidth + ' ' + board.scrollHeight); edgesSvg.innerHTML = ''
        const visible = new Set([...board.querySelectorAll('.node')].map((element) => element.dataset.node))
        map.edges.forEach((edge) => {
          if (!visible.has(edge.from) || !visible.has(edge.to)) return
          const from = board.querySelector('[data-node="' + CSS.escape(edge.from) + '"]'); const to = board.querySelector('[data-node="' + CSS.escape(edge.to) + '"]')
          if (!from || !to) return
          const a = from.getBoundingClientRect(); const b = to.getBoundingClientRect(); const x1 = a.right - boardRect.left; const y1 = a.top - boardRect.top + a.height / 2; const x2 = b.left - boardRect.left; const y2 = b.top - boardRect.top + b.height / 2; const curve = Math.max(24, Math.abs(x2 - x1) * .42)
          const pathElement = document.createElementNS('http://www.w3.org/2000/svg', 'path'); pathElement.setAttribute('d', 'M ' + x1 + ' ' + y1 + ' C ' + (x1 + curve) + ' ' + y1 + ', ' + (x2 - curve) + ' ' + y2 + ', ' + x2 + ' ' + y2); pathElement.classList.add('edge')
          if (selectedId && (edge.from === selectedId || edge.to === selectedId)) pathElement.classList.add('active')
          else if (selectedId && (nodeMap.get(selectedId)?.imports.includes(edge.from) || nodeMap.get(selectedId)?.imports.includes(edge.to))) pathElement.classList.add('neighbor')
          edgesSvg.appendChild(pathElement)
        })
      }

      function clearSelection() { selectedId = null; updateSelection(); drawEdges() }
      document.getElementById('fit').addEventListener('click', () => document.getElementById('board-wrap').scrollTo({ left:0, top:0, behavior:'smooth' }))
      document.getElementById('fit-top').addEventListener('click', () => document.getElementById('board-wrap').scrollTo({ left:0, top:0, behavior:'smooth' }))
      document.getElementById('clear').addEventListener('click', clearSelection); document.getElementById('clear-top').addEventListener('click', clearSelection)
      searchInput.addEventListener('input', render); window.addEventListener('resize', drawEdges); document.getElementById('board-wrap').addEventListener('scroll', drawEdges)
      render()
    })()
  </script>
</body>
</html>
`.replace('__CODEMAP_DATA__', embedded)
}

async function createMap() {
  const absoluteFiles = await walk(ROOT)
  const files = []
  for (const absolutePath of absoluteFiles) {
    const source = await fs.readFile(absolutePath)
    const text = source.toString('utf8')
    const filePath = relativeFile(absolutePath)
    files.push({
      id: filePath,
      path: filePath,
      name: path.basename(filePath),
      kind: fileKind(filePath),
      lane: classifyLane(filePath),
      size: source.byteLength,
      lines: text ? text.split(/\r?\n/).length : 0,
      hash: createHash('sha256').update(source).digest('hex'),
      references: extractReferences(filePath, text),
    })
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  const knownFiles = new Set(files.map((file) => file.path))
  const edges = []
  for (const file of files) {
    const resolved = new Set(file.references.map((reference) => resolveReference(file.path, reference, knownFiles)).filter(Boolean))
    file.imports = [...resolved].sort()
    for (const target of file.imports) edges.push({ from: file.id, to: target, kind: 'import' })
    delete file.references
  }
  const incoming = new Map(files.map((file) => [file.id, []]))
  edges.forEach((edge) => incoming.get(edge.to)?.push(edge.from))
  files.forEach((file) => { file.importedBy = (incoming.get(file.id) || []).sort() })
  const sourceHash = hashSource(files)
  const lanes = LANE_DEFINITIONS.map(([id]) => ({ ...LANE_LOOKUP.get(id), nodeIds: files.filter((file) => file.lane === id).map((file) => file.id) })).filter((lane) => lane.nodeIds.length)
  const entrypoints = files.filter((file) => ['frontend-entry', 'backend-entry'].includes(file.lane)).map((file) => file.id)
  const nodes = files.map(({ references, ...file }) => file)
  const map = {
    schemaVersion: 1,
    generator: `scripts/generate-codemap.mjs@${GENERATOR_VERSION}`,
    root: path.basename(ROOT),
    sourceHash,
    stats: {
      files: nodes.length,
      edges: edges.length,
      lines: nodes.reduce((total, file) => total + file.lines, 0),
      lanes: lanes.length,
    },
    entrypoints,
    lanes,
    nodes,
    edges,
    tree: buildTree(nodes),
  }
  return map
}

async function main() {
  const map = await createMap()
  const expectedLock = {
    schemaVersion: 1,
    generator: `scripts/generate-codemap.mjs@${GENERATOR_VERSION}`,
    sourceHash: map.sourceHash,
    fileCount: map.stats.files,
  }
  if (process.argv.includes('--check')) {
    let actualLock
    try { actualLock = JSON.parse(await fs.readFile(LOCK_PATH, 'utf8')) } catch { actualLock = null }
    const fresh = actualLock?.sourceHash === expectedLock.sourceHash && actualLock?.fileCount === expectedLock.fileCount
    console.log(fresh ? `codemap is fresh (${map.sourceHash.slice(0, 12)})` : 'codemap is stale; run npm run codemap')
    if (!fresh) process.exitCode = 1
    return
  }
  await fs.writeFile(MAP_PATH, `${JSON.stringify(map, null, 2)}\n`, 'utf8')
  await fs.writeFile(HTML_PATH, makeHtml(map), 'utf8')
  await fs.writeFile(LOCK_PATH, `${JSON.stringify(expectedLock, null, 2)}\n`, 'utf8')
  console.log(`generated codemap.html, codemap.json, codemap.lock (${map.stats.files} files, ${map.stats.edges} internal links)`)
}

await main()
