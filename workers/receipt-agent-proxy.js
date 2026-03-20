export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        }
      });
    }

    const GAS_URL = 'https://script.google.com/macros/s/AKfycbywmY2KZHUlmBV-MFHKCHsFxEjHqHIYh-_1amo_hTAJTn7KshgCm6aZaatK_MkVv7f8gA/exec';

    try {
      let payload;
      if (request.method === 'POST') {
        payload = await request.json();
      } else {
        const url = new URL(request.url);
        const raw = url.searchParams.get('payload');
        payload = raw ? JSON.parse(decodeURIComponent(raw)) : {};
      }

      const gasUrl = `${GAS_URL}?payload=${encodeURIComponent(JSON.stringify(payload))}`;

      ctx.waitUntil(fetch(gasUrl, { method: 'GET', redirect: 'follow' }));

      return new Response(JSON.stringify({
        status: 'ok',
        message: '受付しました。スプレッドシートに登録中です。',
        results: [{
          receiptKey: 'pending_' + Date.now(),
          needsReview: false
        }]
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        }
      });

    } catch (err) {
      return new Response(JSON.stringify({ status: 'error', message: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  }
};
