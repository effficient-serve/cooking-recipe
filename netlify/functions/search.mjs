// 요리 이름 → 유튜브 영상 검색 (YouTube Data API v3). 키는 서버 환경변수 YOUTUBE_API_KEY에만 있어요.
const LIMIT = 30;                  // IP 하나당 시간당 검색 수
const WINDOW_MS = 60 * 60 * 1000;
const CACHE_MS = 6 * 60 * 60 * 1000; // 같은 검색어는 6시간 동안 저장해 두고 한도를 아껴요
const hits = new Map();
const cache = new Map();

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
}

export default async (req, context) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  if (!process.env.YOUTUBE_API_KEY) return json({ error: 'config' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const q = String((body && body.q) || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (q.length < 1) return json({ error: 'bad_query' }, 400);
  const lang = body.lang === 'en' ? 'en' : 'ko';

  const ck = lang + '|' + q.toLowerCase();
  const c = cache.get(ck);
  if (c && Date.now() - c.t < CACHE_MS) return json({ items: c.items, cached: true });

  const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || 'unknown';
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= LIMIT) return json({ error: 'rate' }, 429);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();

  const params = new URLSearchParams({
    part: 'snippet', type: 'video', maxResults: '8', videoEmbeddable: 'true', safeSearch: 'moderate',
    q: q + (lang === 'en' ? ' recipe' : ' 레시피'),
    relevanceLanguage: lang, key: process.env.YOUTUBE_API_KEY,
  });
  try {
    const r = await fetch('https://www.googleapis.com/youtube/v3/search?' + params.toString());
    if (!r.ok) {
      let reason = '';
      try { const j = await r.json(); reason = JSON.stringify(j.error && j.error.errors || j.error || '').slice(0, 200); } catch {}
      console.error('youtube search error:', r.status, reason.replace(/key=[^&"\s]+/g, 'key=***'));
      if (r.status === 403 && /quota/i.test(reason)) return json({ error: 'quota' }, 429);
      return json({ error: 'upstream' }, 502);
    }
    const j = await r.json();
    const items = (j.items || [])
      .filter((it) => it && it.id && it.id.videoId && it.snippet)
      .map((it) => ({
        id: it.id.videoId,
        title: decode(it.snippet.title),
        channel: decode(it.snippet.channelTitle),
        thumb: (it.snippet.thumbnails && ((it.snippet.thumbnails.medium || it.snippet.thumbnails.default || {}).url)) || '',
      }));
    cache.set(ck, { t: now, items });
    if (cache.size > 500) cache.clear();
    return json({ items });
  } catch (e) {
    console.error('youtube search failed:', String((e && e.message) || e).slice(0, 200));
    return json({ error: 'upstream' }, 502);
  }
};

export const config = { path: '/api/search' };
