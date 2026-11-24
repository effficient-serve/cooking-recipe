// 유튜브 주소 → Gemini(무료 모델)로 레시피 정리. API 키는 서버(환경변수)에만 있어요.
import { GoogleGenAI } from '@google/genai';

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const LIMIT = 10;                 // IP 하나당 시간당 호출 수 (서버가 깨어 있는 동안만 세는 대략적인 제한)
const WINDOW_MS = 60 * 60 * 1000;
const hits = new Map();

const FORMATS = {
  ko: {
    head: '이 유튜브 영상의 레시피를 아래 형식 그대로 정리해 줘.',
    body: [
      '영상에서 확인되지 않는 내용은 지어내지 말고 "없음"이라고 적어 줘.',
      '만드는 법의 각 단계 맨 앞에 그 단계가 영상에서 시작되는 시간을 [분:초] 형식으로 적어 줘. 시간을 정확히 모르면 적지 마.',
      '재료는 영상 설명란, 자막, 화면에 나온 것과 영상 속 말로 직접 언급된 것만 적어 줘. 일반적인 레시피에서 흔히 쓰는 재료를 네 판단으로 보태지 말고, 영상에 없는 양은 적지 마.',
      '',
      '요리 이름: ',
      '조리 시간: (영상에 나온 시간. 예: 55분)',
      '재료: 재료1 양, 재료2 양, 재료3 양 (쉼표로 구분)',
      '만드는 법:',
      '1. [0:45] 첫 번째 단계 (시간이 나오면 "중불에서 50분간 졸인다"처럼 그 단계 안에 적고, 한 단계에 시간은 하나만 적어 줘)',
      '2. [2:10] 두 번째 단계',
      '팁:',
      '- 영상에서 알려 준 팁 (없으면 "없음")',
    ].join('\n'),
  },
  en: {
    head: 'Summarize the recipe from this YouTube video in exactly the format below. Write it in English.',
    body: [
      'If something is not confirmed in the video, don\'t make it up — write "None".',
      'At the start of each step, write the time that step begins in the video, in [m:ss] format. If you are not sure of the exact time, leave it out.',
      'For ingredients, list only what appears in the video description, captions or on screen, or is mentioned aloud in the video. Do not add ingredients that are merely common in this kind of recipe, and do not write amounts that are not in the video.',
      '',
      'Dish name: ',
      'Cooking time: (the time shown in the video, e.g. 55 min)',
      'Ingredients: ingredient 1 amount, ingredient 2 amount, ingredient 3 amount (comma-separated)',
      'Steps:',
      '1. [0:45] First step (if a time is mentioned, write it inside that step, like "simmer on medium heat for 50 minutes", and use only one time per step)',
      '2. [2:10] Second step',
      'Tips:',
      '- A tip given in the video (or "None")',
    ].join('\n'),
  },
};

function ytId(u) {
  const m = String(u || '').trim().match(/^https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/);
  return m ? m[1] : '';
}
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

export default async (req, context) => {
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  if (!process.env.GEMINI_API_KEY) return json({ error: 'config' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad_request' }, 400); }
  const id = ytId(body && body.url);
  if (!id) return json({ error: 'bad_url' }, 400);
  const lang = body.lang === 'en' ? 'en' : 'ko';

  // 간단한 호출 횟수 제한
  const ip = (context && context.ip) || req.headers.get('x-nf-client-connection-ip') || 'unknown';
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (list.length >= LIMIT) return json({ error: 'rate' }, 429);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();

  const f = FORMATS[lang];
  const prompt = `${f.head}\n${lang === 'en' ? 'Video URL: ' : '영상 주소: '}https://www.youtube.com/watch?v=${id}\n${f.body}`;
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const res = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ fileData: { fileUri: `https://www.youtube.com/watch?v=${id}` } }, { text: prompt }] }],
    });
    const text = (res && res.text) || '';
    if (!text.trim()) return json({ error: 'empty' }, 502);
    return json({ text });
  } catch (e) {
    const msg = String((e && e.message) || e);
    console.error('gemini error:', msg.slice(0, 300));
    if (/429|quota|rate/i.test(msg)) return json({ error: 'quota' }, 429);
    if (/private|unavailable|not (?:found|accessible)|permission/i.test(msg)) return json({ error: 'video' }, 422);
    return json({ error: 'upstream' }, 502);
  }
};

export const config = { path: '/api/recipe' };
