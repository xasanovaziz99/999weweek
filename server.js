import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);                       // нужно на Render, чтобы видеть настоящий IP посетителя
app.use(express.json({ limit: '6mb' }));

const PAGES_ORIGIN = 'https://xasanovaziz99.github.io';   // сайт на GitHub Pages может обращаться к этому серверу
app.use('/api', (req, res, next) => {
  if (req.headers.origin === PAGES_ORIGIN) {
    res.setHeader('Access-Control-Allow-Origin', PAGES_ORIGIN);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {                     // страница ищется в public, а если её там нет, то в корне
  const a = path.join(__dirname, 'public', 'index.html');
  const b = path.join(__dirname, 'index.html');
  if (fs.existsSync(a)) return res.sendFile(a);
  if (fs.existsSync(b)) return res.sendFile(b);
  res.status(404).send('index.html not found. Put it in the public folder.');
});
app.get('/health', (req, res) => res.send('ok'));

const ai = new Anthropic();                      // ключ берётся из ANTHROPIC_API_KEY (.env локально, Environment на Render)
const MODEL = 'claude-sonnet-5-5';
const LANGS = { en: 'English', ko: 'Korean', ru: 'Russian' };

/* ---------- защита от лишних трат ---------- */
const hits = new Map();
function limit(max, windowMs) {                  // не больше max запросов с одного адреса за окно времени
  return (req, res, next) => {
    const key = req.ip + req.path, now = Date.now();
    const list = (hits.get(key) || []).filter(t => now - t < windowMs);
    if (list.length >= max) return res.status(429).json({ error: 'rate' });
    list.push(now); hits.set(key, list);
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3);

let day = new Date().toDateString(), dayCount = 0;
const DAILY_LIMIT = Number(process.env.DAILY_LIMIT || 600);   // общий потолок запросов к ИИ за сутки
function overDaily() {                           // true, если за сегодня уже слишком много запросов
  const today = new Date().toDateString();
  if (today !== day) { day = today; dayCount = 0; }
  return ++dayCount > DAILY_LIMIT;
}
function dailyCap(req, res, next) {
  if (overDaily()) return res.status(429).json({ error: 'daily' });
  next();
}

/* ---------- кэш: одно и то же здание не считаем дважды ---------- */
const cache = new Map();
function remember(key, value) {
  if (cache.size > 800) cache.delete(cache.keys().next().value);
  cache.set(key, value);
}

function pickJSON(text, open, close) {
  const a = text.indexOf(open), b = text.lastIndexOf(close);
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; }
}
const clean = s => String(s || '').replace(/[\r\n"\\]/g, ' ').slice(0, 120);   // имя здания попадает в запрос к ИИ

/* ---------- 1. Поиск зданий по рисунку ---------- */
app.post('/api/guess', limit(20, 3600e3), dailyCap, async (req, res) => {
  try {
    const { image, lang } = req.body;
    const m = /^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(image || '');
    if (!m) return res.status(400).json({ error: 'bad image' });
    const language = LANGS[lang] || 'English';

    const msg = await ai.messages.create({
      model: MODEL,
      max_tokens: 1000,
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } },
        { type: 'text', text:
          'This is a rough sketch drawn by a user. Which famous towers, skyscrapers, monuments or landmarks of the world does its shape resemble? ' +
          'Return ONLY a JSON array of 3 or 4 objects, no markdown, with keys: ' +
          '"name" (name in ' + language + '), "wiki" (exact English Wikipedia article title), ' +
          '"city" and "country" (in ' + language + '), "match" (integer 0-100, how similar the shape is), ' +
          '"why" (one short sentence in ' + language + ' explaining the resemblance). ' +
          'If the sketch is empty or unrecognizable, return an empty array.' }
      ] }]
    });
    const text = msg.content.map(b => b.text || '').join('');
    const list = pickJSON(text, '[', ']');
    res.json(Array.isArray(list) ? list.slice(0, 4) : []);
  } catch (e) {
    console.error('guess error:', e.message);
    res.status(500).json({ error: 'server error' });
  }
});

/* ---------- 2. Описание здания ---------- */
app.post('/api/info', limit(40, 3600e3), async (req, res) => {
  try {
    const wiki = clean(req.body.wiki), name = clean(req.body.name || req.body.wiki);
    const language = LANGS[req.body.lang] || 'English';
    if (!wiki) return res.status(400).json({ error: 'bad request' });

    const key = 'info|' + wiki + '|' + language;
    if (cache.has(key)) return res.json(cache.get(key));
    if (overDaily()) return res.status(429).json({ error: 'daily' });

    const msg = await ai.messages.create({
      model: MODEL,
      max_tokens: 700,
      messages: [{ role: 'user', content:
        'Give accurate facts about the landmark "' + name + '" (English Wikipedia article: "' + wiki + '"). ' +
        'Return ONLY a JSON object, no markdown, with keys: ' +
        '"type" (short kind of building, e.g. "Observation tower"), "city", "country", ' +
        '"year" (year construction was completed, integer, or null), "height_m" (number or null), ' +
        '"architect" (string or null), "summary" (2-3 sentences: what it is and why it is famous), ' +
        '"fact" (one surprising fact, one sentence), "lat" and "lon" (decimal degrees). ' +
        'Write all text values in ' + language + '. If you are not sure about a value use null. Never invent facts.'
      }]
    });
    const text = msg.content.map(b => b.text || '').join('');
    const info = pickJSON(text, '{', '}');
    if (!info) return res.status(502).json({ error: 'bad answer' });
    remember(key, info);
    res.json(info);
  } catch (e) {
    console.error('info error:', e.message);
    res.status(500).json({ error: 'server error' });
  }
});

/* ---------- 3. 3D-модель здания (набор простых деталей, из которых браузер делает облако точек) ---------- */
const EXAMPLE = JSON.stringify({ parts: [
  { t: 'path', pts: [[-62,0,-62],[-52,30,-52],[-38,57,-38],[-22,115,-22],[-10,200,-10],[-4,276,-4]], r: 5, r2: 1.5 },
  { t: 'path', pts: [[62,0,-62],[52,30,-52],[38,57,-38],[22,115,-22],[10,200,-10],[4,276,-4]], r: 5, r2: 1.5 },
  { t: 'path', pts: [[-62,0,62],[-52,30,52],[-38,57,38],[-22,115,22],[-10,200,10],[-4,276,4]], r: 5, r2: 1.5 },
  { t: 'path', pts: [[62,0,62],[52,30,52],[38,57,38],[22,115,22],[10,200,10],[4,276,4]], r: 5, r2: 1.5 },
  { t: 'box', x: 0, y: 55, z: 0, w: 72, d: 72, h: 4 },
  { t: 'box', x: 0, y: 113, z: 0, w: 42, d: 42, h: 4 },
  { t: 'box', x: 0, y: 274, z: 0, w: 18, d: 18, h: 5 },
  { t: 'cyl', x: 0, y: 279, z: 0, r: 5, r2: 1, h: 51 }
] });

function num(v) { v = Number(v); return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0; }
function cleanPart(p) {
  if (!p || typeof p !== 'object') return null;
  const out = { t: String(p.t) };
  for (const k of ['x', 'y', 'z', 'w', 'd', 'h', 'w2', 'd2', 'r', 'r2', 'sx', 'sz']) if (p[k] !== undefined) out[k] = num(p[k]);
  if (p.hollow) out.hollow = true;
  if (p.half) out.half = true;
  if (Array.isArray(p.pts)) out.pts = p.pts.slice(0, 12).map(q => [num(q[0]), num(q[1]), num(q[2])]);
  return ['box', 'cyl', 'sphere', 'path'].includes(out.t) ? out : null;
}

app.post('/api/model', limit(30, 3600e3), async (req, res) => {
  try {
    const wiki = clean(req.body.wiki), name = clean(req.body.name || req.body.wiki);
    if (!wiki) return res.status(400).json({ error: 'bad request' });

    const key = 'model|' + wiki;
    if (cache.has(key)) return res.json(cache.get(key));

    if (overDaily()) return res.status(429).json({ error: 'daily' });

    const prompt =
        'Design a simplified 3D model of the landmark "' + name + '" (English Wikipedia: "' + wiki + '") as a short list of geometric parts. ' +
        'Use METERS and real proportions. x and z are horizontal, y is up. The landmark is centered on x=0, z=0 and its base sits at y=0.\n' +
        'Allowed parts (numbers only; leave out optional keys you do not need):\n' +
        '{"t":"box","x":0,"y":0,"z":0,"w":W,"d":D,"h":H,"w2":W_TOP,"d2":D_TOP}  rectangular block, tapered tower or pyramid. (x,y,z) is the CENTER of the base. w2,d2 = size at the top (default = w,d; 0 makes a pyramid tip).\n' +
        '{"t":"cyl","x":0,"y":0,"z":0,"r":R,"h":H,"r2":R_TOP,"sx":1,"sz":1,"hollow":false}  cylinder, cone or frustum. (x,y,z) is the center of the base. r2 = top radius (default r). sx and sz stretch it into an ellipse. hollow=true gives a ring wall (arenas, stadiums).\n' +
        '{"t":"sphere","x":0,"y":0,"z":0,"r":R,"half":false}  sphere or dome. (x,y,z) is the CENTER; half=true keeps only the upper half.\n' +
        '{"t":"path","pts":[[x,y,z],[x,y,z]],"r":R_START,"r2":R_END}  smooth curved tube through 3 to 9 points: arches, curved legs, cables, bridges. r2 defaults to r.\n' +
        'Rules: use 4 to 25 parts (keep the JSON short); make the silhouette instantly recognizable; write symmetric parts out explicitly; no comments or text outside the JSON.\n' +
        'Example (Eiffel Tower): ' + EXAMPLE + '\n' +
        'Return ONLY a JSON object {"parts":[...]} for "' + name + '".';

    let parts = [];
    for (let attempt = 0; attempt < 2 && !parts.length; attempt++) {   // одна повторная попытка, если ответ пришёл битый
      const msg = await ai.messages.create({
        model: MODEL,
        max_tokens: 6000,
        messages: [{ role: 'user', content: prompt }]
      });
      const text = msg.content.map(b => b.text || '').join('');
      const data = pickJSON(text, '{', '}');
      parts = data && Array.isArray(data.parts) ? data.parts.slice(0, 40).map(cleanPart).filter(Boolean) : [];
      if (!parts.length) console.error('model attempt ' + (attempt + 1) + ' bad answer for ' + wiki + ', stop=' + msg.stop_reason);
    }
    if (!parts.length) return res.status(502).json({ error: 'bad model' });
    const result = { parts };
    remember(key, result);
    res.json(result);
  } catch (e) {
    console.error('model error:', e.message);
    res.status(500).json({ error: 'server error' });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('Server running on port ' + (process.env.PORT || 3000)));
