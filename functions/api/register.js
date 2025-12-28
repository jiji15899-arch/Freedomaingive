// register.js
// Cloudflare Workers - DNS 레코드 생성 및 관리 API

// ============ 설정 ============
const CONFIG = {
  CLOUDFLARE_API_TOKEN: 'YXMqlCtuuHwP11EG3lOBb2MQJ0esY2p3T7HGIzOF', // 실제 토큰값
  ZONE_ID: 'd5c67a7f0c791d39dbce41c3aa5d2221',                 // 실제 Zone ID
  BASE_DOMAIN: 'com',
  ADMIN_PASSWORD: 'admin_password_here' // [보안] 관리자 페이지 접속용 비밀번호를 설정하세요
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
  'Content-Type': 'application/json'
};

// ============ 메인 라우터 ============
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. API 요청 처리 (/api/*)
    if (url.pathname.startsWith('/api')) {
      return handleApiRequest(request, env, url);
    }

    // 2. 정적 파일(HTML) 서빙
    try {
      if (url.pathname === '/') {
        return env.ASSETS.fetch(new URL('/index.html', request.url));
      }
      if (url.pathname === '/admin') {
        return env.ASSETS.fetch(new URL('/admin.html', request.url));
      }
      return env.ASSETS.fetch(request);
    } catch (e) {
      return new Response("Page Not Found", { status: 404 });
    }
  }
};

// ============ API 핸들러 ============
async function handleApiRequest(request, env, url) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const path = url.pathname.replace('/api/', '');

  try {
    // [공개] 도메인 등록
    if (path === 'register' && request.method === 'POST') {
      return await handleRegister(request, env);
    }

    // [관리자] 도메인 목록 조회
    if (path === 'list' && request.method === 'GET') {
      if (!checkAdminAuth(request)) return jsonResponse({ error: 'Unauthorized' }, 401);
      return await handleListDomains();
    }

    // [관리자] 도메인 삭제
    if (path === 'delete' && request.method === 'DELETE') {
      if (!checkAdminAuth(request)) return jsonResponse({ error: 'Unauthorized' }, 401);
      const params = await request.json();
      return await handleDeleteDomain(params.id);
    }

    return jsonResponse({ error: 'Not Found' }, 404);

  } catch (error) {
    return jsonResponse({ success: false, error: error.message }, 500);
  }
}

// ============ 기능 1: 도메인 등록 (다중 레코드 지원) ============
async function handleRegister(request, env) {
  const body = await request.json();
  const { subdomain, recordType, recordValues, email } = body; // recordValues는 배열

  // 1. 값 검증
  if (!recordValues || !Array.isArray(recordValues) || recordValues.length === 0) {
    return jsonResponse({ success: false, error: '최소 1개의 값이 필요합니다.' }, 400);
  }

  for (const value of recordValues) {
    const valid = validateInput(subdomain, recordType, value);
    if (!valid.ok) return jsonResponse({ success: false, error: valid.error }, 400);
  }

  // 2. 중복 체크
  if (await checkDomainExists(subdomain)) {
    return jsonResponse({ success: false, error: '이미 사용 중인 서브도메인입니다.' }, 409);
  }

  // 3. DNS 레코드 생성 (병렬 처리)
  const promises = recordValues.map(val => createDNSRecord(subdomain, recordType, val));
  const results = await Promise.all(promises);
  
  const failed = results.find(r => !r.success);
  if (failed) throw new Error(failed.error || '레코드 생성 실패');

  // 4. 로그 저장 (KV)
  if (env.DOMAIN_LOG) {
    await env.DOMAIN_LOG.put(`domain:${subdomain}`, JSON.stringify({
      subdomain, type: recordType, values: recordValues, email, created: new Date().toISOString()
    }));
  }

  return jsonResponse({ success: true, message: '등록 성공' });
}

// ============ 기능 2: 관리자 기능 (목록/삭제) ============
function checkAdminAuth(request) {
  const pw = request.headers.get('X-Admin-Password');
  return pw === CONFIG.ADMIN_PASSWORD;
}

async function handleListDomains() {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${CONFIG.ZONE_ID}/dns_records?per_page=100`,
    { headers: { 'Authorization': `Bearer ${CONFIG.CLOUDFLARE_API_TOKEN}` } }
  );
  const data = await res.json();
  // 기본 도메인 제외하고 서브도메인만 필터링
  const domains = data.result.filter(r => r.name.endsWith(CONFIG.BASE_DOMAIN) && r.name !== CONFIG.BASE_DOMAIN);
  return jsonResponse({ success: true, result: domains });
}

async function handleDeleteDomain(recordId) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${CONFIG.ZONE_ID}/dns_records/${recordId}`,
    {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${CONFIG.CLOUDFLARE_API_TOKEN}` }
    }
  );
  const data = await res.json();
  return jsonResponse(data);
}

// ============ 헬퍼 함수들 ============
function validateInput(subdomain, type, value) {
  if (!subdomain || subdomain.length > 63 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(subdomain)) {
    return { ok: false, error: '서브도메인 형식이 올바르지 않습니다.' };
  }
  if (type === 'A' && !/^(\d{1,3}\.){3}\d{1,3}$/.test(value)) return { ok: false, error: '유효한 IPv4가 아닙니다.' };
  if (!value || value.trim() === '') return { ok: false, error: '값이 비어있습니다.' };
  return { ok: true };
}

async function checkDomainExists(subdomain) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${CONFIG.ZONE_ID}/dns_records?name=${subdomain}.${CONFIG.BASE_DOMAIN}`,
    { headers: { 'Authorization': `Bearer ${CONFIG.CLOUDFLARE_API_TOKEN}` } }
  );
  const data = await res.json();
  return data.result && data.result.length > 0;
}

async function createDNSRecord(sub, type, content) {
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${CONFIG.ZONE_ID}/dns_records`,
    {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${CONFIG.CLOUDFLARE_API_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, name: `${sub}.${CONFIG.BASE_DOMAIN}`, content, ttl: 3600, proxied: false })
    }
  );
  const data = await res.json();
  return { success: data.success, error: data.errors?.[0]?.message };
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}
