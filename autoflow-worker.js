export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      return jsonResponse({ success: false, error: "Method not allowed" }, 405, corsHeaders);
    }

    if (!env.DISCORD_WEBHOOK_URL) {
      return jsonResponse({ success: false, error: "Webhook not configured" }, 500, corsHeaders);
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

    if (!name || !email || !service || !message) {
      return jsonResponse({ success: false, error: "Missing required fields" }, 400, corsHeaders);
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
        const discordText = await discordResponse.text();
        return jsonResponse(
          {
            success: false,
            error: "Failed to forward message to Discord",
            details: discordText.slice(0, 300)
          },
          502,
          corsHeaders
        );
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
