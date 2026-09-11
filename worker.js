import { DurableObject } from 'cloudflare:workers';

const TBANK_URL = 'https://secured-openapi.tbank.ru/api/v1/acq/payments/initiate';
const TBANK_QR_URL = 'https://secured-openapi.tbank.ru/api/v1/acq/payments/qrs/get';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      const id = env.PRESENCE.idFromName('global');
      const stub = env.PRESENCE.get(id);
      return stub.fetch(new Request('https://pavluyo.internal' + url.pathname, request));
    }
    return env.ASSETS.fetch(request);
  }
};

export class Presence extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.ready = ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      first_seen INTEGER NOT NULL,
      last_seen INTEGER NOT NULL,
      last_learning INTEGER NOT NULL DEFAULT 0,
      day TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      order_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      payment_id TEXT,
      amount INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      premium_until INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const now = Date.now();

    if (request.method === 'POST' && url.pathname === '/api/presence/heartbeat') {
      const body = await request.json().catch(() => ({}));
      const id = String(body.id || '').slice(0, 120);
      if (!id) return json({ok:false}, 400);
      const learning = !!body.learning;
      const day = new Date(now).toISOString().slice(0,10);
      this.ctx.storage.sql.exec(
        `INSERT INTO sessions(id,first_seen,last_seen,last_learning,day) VALUES(?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET last_seen=excluded.last_seen,last_learning=excluded.last_learning,day=excluded.day`,
        id, now, now, learning ? now : 0, day
      );
      this.cleanup(now);
      return json(await this.stats(now));
    }

    if (request.method === 'GET' && url.pathname === '/api/presence/stats') {
      this.cleanup(now);
      return json(await this.stats(now));
    }

    if (request.method === 'POST' && url.pathname === '/api/payment/create') {
      return this.createPayment(request, now);
    }

    if (request.method === 'GET' && url.pathname === '/api/payment/status') {
      const orderId = url.searchParams.get('orderId') || '';
      const sessionId = url.searchParams.get('sessionId') || '';
      const row = this.ctx.storage.sql.exec(`SELECT * FROM orders WHERE order_id=? AND session_id=?`, orderId, sessionId).one();
      if (!row) return json({ok:false,error:'Заказ не найден'},404);
      return json({ok:true,status:row.status,premiumUntil:Number(row.premium_until||0),orderId:row.order_id});
    }

    if (request.method === 'POST' && url.pathname === '/api/payment/webhook') {
      return this.paymentWebhook(request, now);
    }

    return new Response('Not found', {status:404});
  }

  async createPayment(request, now) {
    if (!this.env.TBANK_API_TOKEN || !this.env.TBANK_TERMINAL_KEY) {
      return json({ok:false,error:'Платежи ещё не подключены на сервере. Добавьте TBANK_API_TOKEN и TBANK_TERMINAL_KEY в Cloudflare Worker Secrets.'},503);
    }
    const body = await request.json().catch(() => ({}));
    const sessionId = String(body.sessionId || '').slice(0,120);
    if (!sessionId) return json({ok:false,error:'Нет sessionId'},400);
    const orderId = 'PV-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomUUID().slice(0,8).toUpperCase();
    const amount = 9900;
    const base = new URL(request.url).origin;
    const payload = {
      terminalKey: this.env.TBANK_TERMINAL_KEY,
      payment: {
        orderId,
        amount,
        description: 'PAVLUYO PREMIUM на 30 дней',
        successUrl: base + '/?payment=success&orderId=' + encodeURIComponent(orderId),
        failUrl: base + '/?payment=fail&orderId=' + encodeURIComponent(orderId),
        paymentMethod: {name:'SBP'}
      }
    };
    try {
      const r = await fetch(TBANK_URL, {
        method:'POST',
        headers:{'content-type':'application/json','authorization':'Bearer '+this.env.TBANK_API_TOKEN,'x-request-id':crypto.randomUUID()},
        body:JSON.stringify(payload)
      });
      const data = await r.json().catch(()=>({}));
      if (!r.ok) return json({ok:false,error:data.message || data.errorDetails || 'Т‑Банк не принял запрос на оплату'},502);
      const paymentId = String(data.paymentId || data.PaymentId || data.payment?.paymentId || data.payment?.PaymentId || '');
      const paymentURL = data.paymentURL || data.paymentUrl || data.PaymentURL || data.payment?.paymentURL || data.payment?.paymentUrl || '';
      this.ctx.storage.sql.exec(`INSERT INTO orders(order_id,session_id,payment_id,amount,status,premium_until,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`,orderId,sessionId,paymentId,amount,'PENDING',0,now,now);

      let qr = '';
      if (paymentId) {
        try {
          const qrResp = await fetch(TBANK_QR_URL,{method:'POST',headers:{'content-type':'application/json','authorization':'Bearer '+this.env.TBANK_API_TOKEN,'x-request-id':crypto.randomUUID()},body:JSON.stringify({terminalKey:this.env.TBANK_TERMINAL_KEY,payment:{paymentId},paymentMethod:{name:'SBP'}})});
          const qrData = await qrResp.json().catch(()=>({}));
          const raw = qrData.qr || qrData.QR || qrData.svg || qrData.data?.qr || '';
          if (raw) qr = typeof raw === 'string' && raw.trim().startsWith('<svg') ? btoa(unescape(encodeURIComponent(raw))) : raw;
        } catch(e) {}
      }
      return json({ok:true,orderId,paymentId,paymentURL,qr});
    } catch(e) {
      return json({ok:false,error:'Не удалось связаться с Т‑Банком. Попробуйте ещё раз.'},502);
    }
  }

  async paymentWebhook(request, now) {
    const body = await request.json().catch(()=>null);
    if (!body) return new Response('BAD REQUEST',{status:400});
    if (this.env.TBANK_NOTIFICATION_PASSWORD && body.Token) {
      const ok = await verifyTbankToken(body, this.env.TBANK_NOTIFICATION_PASSWORD);
      if (!ok) return new Response('FORBIDDEN',{status:403});
    }
    const orderId = String(body.OrderId || body.orderId || '');
    if (!orderId) return new Response('OK');
    const status = String(body.Status || body.status || '');
    const success = body.Success === true || body.Success === 'true' || body.success === true || body.success === 'true';
    const amount = Number(body.Amount || body.amount || 0);
    const row = this.ctx.storage.sql.exec(`SELECT * FROM orders WHERE order_id=?`,orderId).one();
    if (!row) return new Response('OK');
    if (amount && amount !== row.amount) return new Response('OK');
    const paid = success && ['CONFIRMED','AUTHORIZED','PAID'].includes(status.toUpperCase());
    const cancelled = ['REJECTED','CANCELLED','EXPIRED','REFUNDED'].includes(status.toUpperCase());
    if (paid) {
      const until = now + 30*24*60*60*1000;
      this.ctx.storage.sql.exec(`UPDATE orders SET status=?,premium_until=?,updated_at=? WHERE order_id=?`,'PAID',until,now,orderId);
    } else if (cancelled) {
      this.ctx.storage.sql.exec(`UPDATE orders SET status=?,updated_at=? WHERE order_id=?`,status.toUpperCase(),now,orderId);
    }
    return new Response('OK');
  }

  cleanup(now) { this.ctx.storage.sql.exec(`DELETE FROM sessions WHERE last_seen < ?`, now - 120000); }
  async stats(now) {
    const online = this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM sessions WHERE last_seen >= ?`, now - 20000).one().n;
    const learning = this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM sessions WHERE last_learning >= ?`, now - 60000).one().n;
    const today = new Date(now).toISOString().slice(0,10);
    const visits = this.ctx.storage.sql.exec(`SELECT COUNT(*) AS n FROM sessions WHERE day = ?`, today).one().n;
    return {ok:true,online:Number(online),learning:Number(learning),today:Number(visits),updatedAt:now};
  }
}

async function verifyTbankToken(body, password) {
  const pairs=[];
  for (const [k,v] of Object.entries(body)) {
    if (k==='Token' || k==='Data' || k==='Receipt') continue;
    if (v!==null && typeof v!=='object') pairs.push([k,String(v)]);
  }
  pairs.push(['Password',password]);
  pairs.sort((a,b)=>a[0].localeCompare(b[0]));
  const source=pairs.map(x=>x[1]).join('');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(source));
  const hex=[...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
  return hex.toLowerCase()===String(body.Token).toLowerCase();
}

function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}})}
