const QWEN_API_URL = "https://chat.qwenlm.ai/api/chat/completions";
const QWEN_MODELS_URL = "https://chat.qwenlm.ai/api/models";
const QWEN_FILES_URL = "https://chat.qwenlm.ai/api/v1/files/";
const CACHE_TTL = 60 * 60 * 1000; // 缓存1小时
const STREAM_TIMEOUT = 60000; // 60秒超时
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1秒

const encoder = new TextEncoder();
const streamDecoder = new TextDecoder();

let cachedModels = null;
let cachedModelsTimestamp = 0;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper function to convert base64 to Blob
function base64ToBlob(base64) {
  const byteString = atob(base64.split(',')[1]);
  const mimeString = base64.split(',')[0].split(':')[1].split(';')[0];
  const ab = new ArrayBuffer(byteString.length);
  const ia = new Uint8Array(ab);
  for (let i = 0; i < byteString.length; i++) {
    ia[i] = byteString.charCodeAt(i);
  }
  return new Blob([ab], { type: mimeString });
}

// Fetch with retry functionality
async function fetchWithRetry(url, options, retries = MAX_RETRIES) {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) return response;
      
      lastError = new Error(`HTTP error! status: ${response.status}`);
      if (i < retries - 1) await sleep(RETRY_DELAY * (i + 1));
    } catch (error) {
      lastError = error;
      if (i < retries - 1) await sleep(RETRY_DELAY * (i + 1));
    }
  }
  throw lastError;
}

// Function to upload image to Qwen
async function uploadImageToQwen(token, imageBlob) {
  const formData = new FormData();
  formData.append('file', imageBlob);
  
  const response = await fetchWithRetry(QWEN_FILES_URL, {
    method: "POST",
    headers: {
      "Authorization": token,
      "accept": "application/json",
    },
    body: formData,
  });

  const data = await response.json();
  if (!data.id) {
    throw new Error("File upload failed: No valid file ID returned");
  }

  return data.id;
}

// Process messages to handle base64 images
async function processMessages(messages, authHeader) {
  return Promise.all(messages.map(async (message) => {
    if (message.content && Array.isArray(message.content)) {
      message.content = await Promise.all(message.content.map(async (content) => {
        if (content.type === "image_url" && content.image_url?.url?.startsWith("data:")) {
          const imageBlob = base64ToBlob(content.image_url.url);
          const imageId = await uploadImageToQwen(authHeader, imageBlob);
          return {
            type: "image",
            image: imageId,
          };
        }
        return content;
      }));
    }
    return message;
  }));
}

async function processLine(line, writer, state) {
  try {
    const data = JSON.parse(line.slice(6));
    if (data.choices?.[0]?.delta?.content) {
      const currentContent = data.choices[0].delta.content;
      let newContent = currentContent;
      
      if (currentContent.startsWith(state.previousContent) && state.previousContent.length > 0) {
        newContent = currentContent.slice(state.previousContent.length);
      }

      if (newContent) {
        const newData = {
          ...data,
          choices: [{
            ...data.choices[0],
            delta: {
              ...data.choices[0].delta,
              content: newContent,
            },
          }],
        };
        await writer.write(encoder.encode(`data: ${JSON.stringify(newData)}\n\n`));
      }
      state.previousContent = currentContent;
    } else {
      await writer.write(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
    }
  } catch (error) {
    await writer.write(encoder.encode(`${line}\n\n`));
  }
}

async function handleStream(context) {
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await context.reader.read();
      if (done) {
        context.state.isCompleted = true;
        if (context.timeoutId) {
          clearTimeout(context.timeoutId);
        }
        if (buffer) {
          const lines = buffer.split("\n");
          for (const line of lines) {
            if (line.trim().startsWith("data: ")) {
              await processLine(line, context.writer, context.state);
            }
          }
        }
        await context.writer.write(encoder.encode("data: [DONE]\n\n"));
        break;
      }

      const valueText = streamDecoder.decode(value, { stream: true });
      buffer += valueText;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      
      for (const line of lines) {
        if (line.trim().startsWith("data: ")) {
          await processLine(line, context.writer, context.state);
        }
      }
    }
  } catch (error) {
    if (!context.state.isCompleted) {
      if (context.timeoutId) {
        clearTimeout(context.timeoutId);
      }
      try {
        await context.writer.write(
          encoder.encode(`data: {"error":true,"message":"${error.message}"}\n\n`)
        );
        await context.writer.write(encoder.encode("data: [DONE]\n\n"));
      } catch {}
    }
  } finally {
    try {
      await context.writer.close();
    } catch {}
  }
}

async function handleModelsRequest(request) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const now = Date.now();
  if (cachedModels && now - cachedModelsTimestamp < CACHE_TTL) {
    return new Response(cachedModels, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    });
  }

  try {
    const response = await fetchWithRetry(QWEN_MODELS_URL, {
      headers: {
        "Authorization": authHeader
      }
    });
    
    cachedModels = await response.text();
    cachedModelsTimestamp = now;
    
    return new Response(cachedModels, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: true, message: error.message }),
      { status: 500 }
    );
  }
}

async function handleChatCompletionsRequest(request) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return new Response("Unauthorized", { status: 401 });
  }

  const requestData = await request.json();
  const { messages, stream = false, model, max_tokens } = requestData;

  if (!model) {
    return new Response(
      JSON.stringify({ error: true, message: "Model parameter is required" }),
      { status: 400 }
    );
  }

  try {
    // Process messages for images
    const processedMessages = await processMessages(messages, authHeader);

    const qwenRequest = {
      model,
      messages: processedMessages,
      stream,
      ...(max_tokens !== undefined && { max_tokens })
    };

    const qwenResponse = await fetch(QWEN_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": authHeader
      },
      body: JSON.stringify(qwenRequest)
    });

    if (stream) {
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const reader = qwenResponse.body.getReader();
      
      const streamContext = {
        writer,
        reader,
        state: {
          isCompleted: false,
          isStreamActive: true,
          previousContent: "",
        },
        timeoutId: setTimeout(() => {
          if (!streamContext.state.isCompleted) {
            streamContext.state.isStreamActive = false;
            writer.write(encoder.encode('data: {"error":true,"message":"Response timeout"}\n\n'))
              .then(() => writer.write(encoder.encode("data: [DONE]\n\n")))
              .then(() => writer.close())
              .catch(() => {});
          }
        }, STREAM_TIMEOUT)
      };

      handleStream(streamContext);

      return new Response(readable, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        }
      });
    }

    return new Response(await qwenResponse.text(), {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: true, message: error.message }),
      { status: 500 }
    );
  }
}

async function handleRequest(request) {
  try {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (request.method === "GET" && pathname === "/v1/models") {
      return await handleModelsRequest(request);
    }

    if (request.method === "POST" && pathname === "/v1/chat/completions") {
      return await handleChatCompletionsRequest(request);
    }

    return new Response("Method not allowed", { status: 405 });
  } catch (error) {
    return new Response(
      JSON.stringify({ error: true, message: error.message }),
      { status: 500 }
    );
  }
}

addEventListener("fetch", event => {
  event.respondWith(handleRequest(event.request));
});
