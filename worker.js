const OPENWEBUI_BASE_URL = "https://chat.qwenlm.ai";
const OPENWEBUI_API_KEY = "xxxxeyJpZCI6IjM4MmZhZDJkLTA5MmEtNGI5MC1iODU5LTQ5MjFhMjA5MDIxNSIsImV4cCI6MTczOTA3MjU5NX0.1NXdCbeMIZS9nHuy5qtLbEH_aqCX86K7iUdaME4JOgA";//qwenlm.ai的key 
const API_KEY = "sk-xxxxxx";//自己设置的验证key

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

// 主处理函数
async function handleRequest(request) {
  if (request.method === "OPTIONS") {
    return handleCORS();
  }

  if (!isAuthorized(request)) {
    return new Response("Unauthorized111", { status: 401 });
  }
  const url = new URL(request.url);
  if (url.pathname.endsWith("/v1/models")) {
    return handleModelsRequest();
  }

  if (request.method !== "POST" || !url.pathname.endsWith("/v1/chat/completions")) {
    return new Response("Not Found", { status: 404 });
  }
  
  return handleChatCompletions(request);
}

// 处理CORS预检请求
function handleCORS() {
  return new Response("", {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      "Access-Control-Allow-Headers": '*'
    }
  });
}

// 验证授权
function isAuthorized(request) {
  const apiKey = request.headers.get('Authorization');
  if (!apiKey || apiKey !== `Bearer ${API_KEY}`) {
    return new Response('Unauthorized', { status: 401 });
  }
  return true;
}

// 处理模型列表请求
async function handleModelsRequest() {
    let apiUrl = `${OPENWEBUI_BASE_URL}/api/models`;
    const customResponse = await fetch(apiUrl, {
          method: "GET",
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENWEBUI_API_KEY}`
          }
        });
    if (!customResponse.ok) {
      throw new Error(`API request failed with status ${customResponse.status}`);
    }
    return customResponse;
}


// 处理聊天完成请求
async function handleChatCompletions(request) {
  try {
    const requestBody = await request.json();
    let apiUrl = `${OPENWEBUI_BASE_URL}/api/chat/completions`;
    const customResponse = await fetch(apiUrl, {
          method: "POST",
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${OPENWEBUI_API_KEY}`
          },
          body: JSON.stringify(requestBody)
        }); 
    if (!customResponse.ok) {
      throw new Error(`API request failed with status ${customResponse.status}`);
    }
    return customResponse;
  } catch (error) {
    return new Response("Internal Server Error: " + error.message, { status: 500 });
  }
}




