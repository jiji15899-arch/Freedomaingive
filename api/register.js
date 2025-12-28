// Cloudflare Workers - DNS 레코드 생성 API
// 이 파일을 Cloudflare Workers에 배포하세요

// ============ 설정 (반드시 변경하세요) ============
const CONFIG = {
  CLOUDFLARE_API_TOKEN: 'your_api_token_here',  // Cloudflare API 토큰
  ZONE_ID: 'your_zone_id_here',                 // Cloudflare Zone ID
  BASE_DOMAIN: 'yourdomain.com',                // 귀하의 도메인
  ALLOWED_ORIGINS: [
    'https://jiwungum.dpdns.org',
    'https://www.jiwungum.dpdns.org'
    'https://domain.jiwungum.dpdnz.org
  ]
};

// ============ CORS 헤더 설정 ============
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

// ============ 메인 핸들러 ============
addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  // OPTIONS 요청 처리 (CORS preflight)
  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  // POST 요청만 허용
  if (request.method !== 'POST') {
    return jsonResponse({ 
      success: false, 
      error: 'POST 메서드만 허용됩니다.' 
    }, 405);
  }

  try {
    const body = await request.json();
    const { subdomain, recordType, recordValue, email } = body;

    // 입력 검증
    const validation = validateInput(subdomain, recordType, recordValue);
    if (!validation.valid) {
      return jsonResponse({ 
        success: false, 
        error: validation.error 
      }, 400);
    }

    // 중복 체크
    const exists = await checkDomainExists(subdomain);
    if (exists) {
      return jsonResponse({ 
        success: false, 
        error: '이미 사용 중인 서브도메인입니다.' 
      }, 409);
    }

    // DNS 레코드 생성
    const result = await createDNSRecord(subdomain, recordType, recordValue);
    
    if (result.success) {
      // 성공시 로그 저장 (선택사항)
      await logDomain(subdomain, recordType, recordValue, email);
      
      return jsonResponse({
        success: true,
        domain: `${subdomain}.${CONFIG.BASE_DOMAIN}`,
        recordType,
        recordValue,
        message: 'DNS 레코드가 성공적으로 생성되었습니다.'
      });
    } else {
      throw new Error(result.error || 'DNS 레코드 생성 실패');
    }
    
  } catch (error) {
    console.error('Error:', error);
    return jsonResponse({ 
      success: false, 
      error: error.message || '서버 오류가 발생했습니다.' 
    }, 500);
  }
}

// ============ 입력 검증 ============
function validateInput(subdomain, recordType, recordValue) {
  // 서브도메인 검증
  if (!subdomain || subdomain.length < 1 || subdomain.length > 63) {
    return { valid: false, error: '서브도메인은 1-63자 사이여야 합니다.' };
  }

  const subdomainRegex = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;
  if (!subdomainRegex.test(subdomain)) {
    return { valid: false, error: '서브도메인은 영문 소문자, 숫자, 하이픈만 사용 가능합니다.' };
  }

  // 레코드 타입 검증
  const validTypes = ['A', 'AAAA', 'CNAME', 'NS'];
  if (!validTypes.includes(recordType)) {
    return { valid: false, error: '유효하지 않은 레코드 타입입니다.' };
  }

  // 레코드 값 검증
  if (!recordValue || recordValue.trim().length === 0) {
    return { valid: false, error: '레코드 값을 입력해주세요.' };
  }

  // IP 주소 형식 검증 (A/AAAA 레코드)
  if (recordType === 'A') {
    const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
    if (!ipv4Regex.test(recordValue)) {
      return { valid: false, error: '유효한 IPv4 주소를 입력해주세요.' };
    }
  }

  if (recordType === 'AAAA') {
    const ipv6Regex = /^([0-9a-fA-F]{0,4}:){7}[0-9a-fA-F]{0,4}$/;
    if (!ipv6Regex.test(recordValue)) {
      return { valid: false, error: '유효한 IPv6 주소를 입력해주세요.' };
    }
  }

  return { valid: true };
}

// ============ 도메인 중복 체크 ============
async function checkDomainExists(subdomain) {
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${CONFIG.ZONE_ID}/dns_records?name=${subdomain}.${CONFIG.BASE_DOMAIN}`,
      {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${CONFIG.CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const data = await response.json();
    return data.result && data.result.length > 0;
  } catch (error) {
    console.error('중복 체크 오류:', error);
    return false; // 오류 발생시 중복 아님으로 처리
  }
}

// ============ DNS 레코드 생성 ============
async function createDNSRecord(subdomain, type, content) {
  try {
    const recordData = {
      type: type,
      name: `${subdomain}.${CONFIG.BASE_DOMAIN}`,
      content: content,
      ttl: 3600, // 1시간
      proxied: false // Cloudflare 프록시 비활성화 (NS 레코드는 프록시 불가)
    };

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${CONFIG.ZONE_ID}/dns_records`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.CLOUDFLARE_API_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(recordData)
      }
    );

    const data = await response.json();

    if (data.success) {
      return { success: true, data: data.result };
    } else {
      return { 
        success: false, 
        error: data.errors?.[0]?.message || 'DNS 레코드 생성 실패' 
      };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ============ 도메인 로그 저장 (KV Storage 사용) ============
async function logDomain(subdomain, recordType, recordValue, email) {
  try {
    // Cloudflare Workers KV를 사용하는 경우
    // 먼저 KV namespace를 생성하고 wrangler.toml에 바인딩해야 합니다
    if (typeof DOMAIN_LOG !== 'undefined') {
      const logData = {
        subdomain,
        recordType,
        recordValue,
        email: email || 'anonymous',
        createdAt: new Date().toISOString()
      };
      
      await DOMAIN_LOG.put(
        `domain:${subdomain}`, 
        JSON.stringify(logData)
      );
    }
  } catch (error) {
    console.error('로그 저장 오류:', error);
    // 로그 저장 실패해도 계속 진행
  }
}

// ============ JSON 응답 헬퍼 ============
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: corsHeaders
  });
                             }
