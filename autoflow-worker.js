const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 5;
const MAX_BODY_BYTES = 16 * 1024;
const ipRequestLog = new Map();

export default {
  async fetch(request, env) {
    const corsHeaders = buildCorsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (corsHeaders["X-Origin-Allowed"] === "false") {
      delete corsHeaders["X-Origin-Allowed"];
      return jsonResponse({ success: false, error: "Origin not allowed" }, 403, corsHeaders);
    }

    delete corsHeaders["X-Origin-Allowed"];

    if (request.method !== "POST") {
      return jsonResponse({ success: false, error: "Method not allowed" }, 405, corsHeaders);
    }

    if (!env.DISCORD_WEBHOOK_URL) {
      return jsonResponse({ success: false, error: "Webhook not configured" }, 500, corsHeaders);
    }

    const contentType = request.headers.get("content-type") || "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return jsonResponse({ success: false, error: "Unsupported content type" }, 415, corsHeaders);
    }

    const contentLength = Number.parseInt(request.headers.get("content-length") || "", 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return jsonResponse({ success: false, error: "Payload too large" }, 413, corsHeaders);
    }

    const clientIp = getClientIp(request);
    if (isRateLimited(clientIp)) {
      return jsonResponse({ success: false, error: "Too many requests" }, 429, corsHeaders);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return jsonResponse({ success: false, error: "Invalid JSON body" }, 400, corsHeaders);
    }

    const name = sanitize(body.name);
    const email = sanitize(body.email);
    const service = sanitize(body.service || body.servicio);
    const company = sanitize(body.company || body.empresa);
    const message = sanitize(body.message || body.mensaje);
    const sessionToken = sanitize(body.sessionToken);
    const website = sanitize(body.website);

    if (!name || !email || !service || !message) {
      return jsonResponse({ success: false, error: "Missing required fields" }, 400, corsHeaders);
    }

    if (website) {
      return jsonResponse({ success: true }, 200, corsHeaders);
    }

    const validationError = validateSubmission({ name, email, service, company, message, sessionToken });
    if (validationError) {
      return jsonResponse({ success: false, error: validationError }, 400, corsHeaders);
    }

    const now = new Date().toLocaleString("es-ES", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: "Europe/Madrid"
    });

    const discordPayload = {
      username: "AutoFlow · Solicitudes",
      avatar_url: "https://cdn-icons-png.flaticon.com/512/906/906175.png",
      embeds: [
        {
          title: "📋 Nueva solicitud recibida",
          color: 0x5ff0d2,
          fields: [
            { name: "👤 Nombre", value: truncate(name, 1024), inline: true },
            { name: "📧 Email", value: truncate(email, 1024), inline: true },
            { name: "🛠️ Servicio", value: truncate(service, 1024), inline: true },
            { name: "🏢 Empresa", value: truncate(company || "—", 1024), inline: true },
            { name: "📝 Descripción del proyecto", value: truncate(message, 1024), inline: false }
          ],
          footer: {
            text: `Token: ${sessionToken ? `${sessionToken.slice(0, 8)}...` : "n/d"} · ${now} · AutoFlow`
          },
          thumbnail: {
            url: "https://cdn-icons-png.flaticon.com/512/906/906175.png"
          }
        }
      ]
    };

    try {
      const discordResponse = await fetch(env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(discordPayload)
      });

      if (!discordResponse.ok) {
        return jsonResponse({ success: false, error: "Failed to forward message to Discord" }, 502, corsHeaders);
      }

      return jsonResponse({ success: true }, 200, corsHeaders);
    } catch {
      return jsonResponse({ success: false, error: "Unexpected server error" }, 500, corsHeaders);
    }
  }
};

function jsonResponse(payload, status, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
      ...headers
    }
  });
}

function sanitize(value) {
  return typeof value === "string" ? value.trim() : "";
}

function truncate(value, maxLength) {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}

function buildCorsHeaders(request, env) {
  const requestOrigin = request.headers.get("Origin");
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const originAllowed = isOriginAllowed(requestOrigin, allowedOrigins);
  const allowOrigin = requestOrigin && originAllowed ? requestOrigin : allowedOrigins[0] || "null";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
    "X-Origin-Allowed": originAllowed ? "true" : "false"
  };
}

function parseAllowedOrigins(value) {
  if (!value) return [];

  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isOriginAllowed(requestOrigin, allowedOrigins) {
  if (!requestOrigin) return true;
  if (requestOrigin === "null") return true;
  if (allowedOrigins.length === 0) return true;
  return allowedOrigins.includes(requestOrigin);
}

function getClientIp(request) {
  const forwardedFor = request.headers.get("CF-Connecting-IP")
    || request.headers.get("X-Forwarded-For")
    || "";
  return forwardedFor.split(",")[0].trim() || "unknown";
}

function isRateLimited(ip) {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const entries = (ipRequestLog.get(ip) || []).filter((timestamp) => timestamp > windowStart);

  if (entries.length >= RATE_LIMIT_MAX_REQUESTS) {
    ipRequestLog.set(ip, entries);
    return true;
  }

  entries.push(now);
  ipRequestLog.set(ip, entries);

  if (ipRequestLog.size > 1000) {
    for (const [key, timestamps] of ipRequestLog.entries()) {
      if (!timestamps.some((timestamp) => timestamp > windowStart)) {
        ipRequestLog.delete(key);
      }
    }
  }

  return false;
}

function validateSubmission({ name, email, service, company, message, sessionToken }) {
  if (name.length < 2 || name.length > 80) return "Invalid name";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return "Invalid email";
  if (service.length < 2 || service.length > 120) return "Invalid service";
  if (company.length > 120) return "Invalid company";
  if (message.length < 20 || message.length > 1200) return "Invalid message";
  if (sessionToken && !/^[a-f0-9]{16,128}$/i.test(sessionToken)) return "Invalid session token";
  return null;
}
