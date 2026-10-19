'use strict';
/**
 * 湖內三層雲可訂房日曆：Vercel Serverless 管理 API
 * Token 只從 Vercel 環境變數讀取，絕不交給瀏覽器。
 */
const crypto = require('node:crypto');
const OWNER = 'shouben16-maker';
const REPO = '3clouds';
const BRANCH = 'main';
const COOKIE = '__Host-3clouds_calendar';
const SESSION_SECONDS = 8 * 60 * 60;
const FILE_URL = `https://api.github.com/repos/${OWNER}/${REPO}/contents/calendar-data.json`;

function respond(res, code, data, extra = {}) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  Object.entries(extra).forEach(([name, value]) => res.setHeader(name, value));
  return res.status(code).json(data);
}
function configured() {
  return Boolean(process.env.GITHUB_CALENDAR_TOKEN &&
    process.env.CALENDAR_ADMIN_PASSWORD && process.env.CALENDAR_ADMIN_PASSWORD.length >= 12 &&
    process.env.CALENDAR_SESSION_SECRET && process.env.CALENDAR_SESSION_SECRET.length >= 32);
}
function hash(v) { return crypto.createHash('sha256').update(v).digest(); }
function same(a, b) { return crypto.timingSafeEqual(hash(a), hash(b)); }
function makeMac(text) {
  return crypto.createHmac('sha256', process.env.CALENDAR_SESSION_SECRET)
    .update('3clouds-calendar-v1:').update(text).digest('hex');
}
function newSession() {
  const timestamp = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const content = `${timestamp}.${crypto.randomBytes(16).toString('hex')}`;
  return `${content}.${makeMac(content)}`;
}
function authorized(req) {
  if (!configured()) return false;
  const cookie = (req.headers.cookie || '').split(';').map(v => v.trim())
    .find(v => v.startsWith(COOKIE + '='));
  if (!cookie) return false;
  const value = cookie.slice(COOKIE.length + 1);
  const match = /^(\d{10})\.([a-f\d]{32})\.([a-f\d]{64})$/.exec(value);
  if (!match || Number(match[1]) < Math.floor(Date.now() / 1000)) return false;
  const raw = match[1] + '.' + match[2];
  return same(match[3], makeMac(raw));
}
function verifyOrigin(req) {
  const origin = req.headers.origin;
  if (!origin || !req.headers.host) return false;
  try {
    const src = new URL(origin);
    return src.host === req.headers.host &&
      (src.protocol === 'https:' || (src.protocol === 'http:' && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(src.host)));
  } catch { return false; }
}
function parseBody(req) {
  if (typeof req.body === 'string') return JSON.parse(req.body);
  return req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
}
function cookieHeader(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
async function github(method, payload) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), 12000);
  try {
    const url = FILE_URL + (method === 'GET' ? `?ref=${BRANCH}` : '');
    const r = await fetch(url, {
      method, signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_CALENDAR_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(method === 'PUT' ? {'Content-Type':'application/json'} : {})
      },
      ...(payload ? {body: JSON.stringify(payload)} : {})
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(r.status === 401 || r.status === 403 ? 'GitHub Token 權限不足或已失效。' :
        r.status === 409 || r.status === 422 ? 'GitHub 房況已被更新或提交衝突，請重新載入最新資料。' :
        r.status === 404 ? '找不到指定的 GitHub 檔案或儲存庫。' : 'GitHub 暫時無法完成操作。');
      err.status = r.status;
      throw err;
    }
    return json;
  } finally { clearTimeout(timeout); }
}
function validateCalendar(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.dates !== 'object' ||
      !data.dates || Array.isArray(data.dates) || !data.settings || typeof data.settings !== 'object') return false;
  if (![4,5,6,8,12].includes(data.settings.monthsAhead) || ![0,1].includes(data.settings.startMonthOffset)) return false;
  if (Object.keys(data.dates).length > 730) return false;
  for (const [date, entry] of Object.entries(data.dates)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const d = new Date(date + 'T00:00:00Z');
    if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0,10) !== date) return false;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    if (Object.keys(entry).some(k => !['stay','checkout'].includes(k))) return false;
    if (entry.stay !== undefined && !['open','closed','booked'].includes(entry.stay)) return false;
    if (entry.checkout !== undefined && !['open','closed'].includes(entry.checkout)) return false;
  }
  return true;
}
const defaultData = {version:1,settings:{monthsAhead:4,startMonthOffset:1},dates:{}};

module.exports = async function handler(req, res) {
  if (!['GET','POST'].includes(req.method)) return respond(res,405,{error:'不支援的請求方式。'},{Allow:'GET, POST'});
  if (!configured()) return respond(res,503,{error:'後台尚未完成 Vercel 安全環境變數設定。請先設定 Token、管理密碼與 Session Secret。'});
  if (req.method === 'POST' && !verifyOrigin(req)) return respond(res,403,{error:'安全驗證失敗，請從原網站開啟後台。'});
  const action = req.method === 'GET' ? (req.query.action || 'session') : parseBody(req).action;
  if (action === 'login' && req.method === 'POST') {
    const input = parseBody(req);
    if (typeof input.password !== 'string' || input.password.length > 256 || !same(input.password, process.env.CALENDAR_ADMIN_PASSWORD)) {
      return respond(res,401,{error:'管理密碼不正確。'});
    }
    return respond(res,200,{ok:true},{'Set-Cookie':cookieHeader(newSession(), SESSION_SECONDS)});
  }
  if (action === 'session' && req.method === 'GET') return respond(res,200,{authenticated:authorized(req)});
  if (action === 'logout' && req.method === 'POST')
    return respond(res,200,{ok:true},{'Set-Cookie':cookieHeader('',0)});
  if (!authorized(req)) return respond(res,401,{error:'登入已過期，請重新登入。'});
  if (action === 'read' && req.method === 'GET') {
    try {
      const result = await github('GET');
      const raw = Buffer.from(result.content.replace(/\s/g,''),'base64').toString('utf8');
      const data = JSON.parse(raw);
      return respond(res,200,{data,sha:result.sha});
    } catch (e) {
      if (e.status === 404) return respond(res,200,{data:defaultData,sha:null});
      return respond(res,502,{error:e.message === 'The operation was aborted' ? 'GitHub 連線逾時。' : (e.message || 'GitHub 讀取失敗。')});
    }
  }
  if (action === 'publish' && req.method === 'POST') {
    const input = parseBody(req);
    if (!validateCalendar(input.data) || JSON.stringify(input.data).length > 60000 ||
        !(input.sha === null || (typeof input.sha === 'string' && /^[a-f0-9]{40}$/.test(input.sha))))
      return respond(res,400,{error:'房況資料格式不正確，請重新載入最新資料。'});
    try {
      const commit = {
        message:'Update 三層雲可訂房日曆',
        content:Buffer.from(JSON.stringify(input.data,null,2)+'\n','utf8').toString('base64'),
        branch:BRANCH
      };
      if (input.sha) commit.sha = input.sha;
      const result = await github('PUT',commit);
      return respond(res,200,{ok:true,sha:result.content?.sha || null});
    } catch (e) {
      if ([409,422].includes(e.status)) return respond(res,409,{error:'其他管家可能已發布新版房況。你目前的草稿未被覆蓋，請先與搭檔確認，再重新載入最新資料。'});
      return respond(res,502,{error:e.message || 'GitHub 更新失敗。'});
    }
  }
  return respond(res,404,{error:'找不到這個後台功能。'});
};
