import { request } from "node:http";

function post(url, authorization, body, signal) {
  return new Promise((resolve, reject) => {
    const call = request(url, { method: "POST", headers: { "content-type": "application/json", authorization }, signal }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, text }));
      response.on("error", reject);
    });
    call.on("error", reject);
    call.end(JSON.stringify(body));
  });
}

export default function (pi) {
  const url = process.env.CITROPY_PI_MCP_URL;
  const authorization = process.env.CITROPY_PI_MCP_AUTHORIZATION;
  const tools = JSON.parse(process.env.CITROPY_PI_TOOLS || "[]");
  if (!url || !authorization) return;

  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
      async execute(_toolCallId, params, signal) {
        const response = await post(url, authorization, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool.name, arguments: params } }, signal);
        if (response.status < 200 || response.status >= 300) throw new Error(`Citropy tool request failed (${response.status})`);
        const message = JSON.parse(response.text);
        if (message.error) throw new Error(message.error.message || "Citropy tool request failed");
        if (message.result?.isError) throw new Error(message.result.content?.filter(part => part.type === "text").map(part => part.text).join("\n") || "Citropy tool failed");
        return { content: message.result.content, details: undefined };
      },
    });
  }
}
