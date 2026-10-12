#!/usr/bin/env node
// stdio <-> Streamable HTTP bridge. stdout is the protocol channel: log ONLY to stderr.
// Usage: QBZ_MCP_URL=http://127.0.0.1:3000/mcp QBZ_MCP_TOKEN=<token> node dist/mcp/bridge.js
// Deliberately imports nothing from src/: the app logger writes to stdout.
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
    isJSONRPCRequest,
    isJSONRPCResultResponse,
    type JSONRPCMessage,
    type RequestId
} from '@modelcontextprotocol/client';

const url = new URL(process.env.QBZ_MCP_URL ?? 'http://127.0.0.1:3000/mcp');
const token = process.env.QBZ_MCP_TOKEN;
if (!token) {
    process.stderr.write('QBZ_MCP_TOKEN is not set\n');
    process.exit(1);
}
const log = (m: string) => process.stderr.write(`[qbz-mcp-bridge] ${m}\n`);

const stdio = new StdioServerTransport();
const http = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
});
const initIds = new Set<RequestId>();
let closing = false;

async function shutdown(code = 0): Promise<void> {
    if (closing) return;
    closing = true;
    try { await http.terminateSession(); } catch { /* stateless server answers 405 */ }
    await Promise.allSettled([http.close(), stdio.close()]);
    process.exit(code);
}

stdio.onmessage = (msg: JSONRPCMessage) => {
    if (isJSONRPCRequest(msg) && msg.method === 'initialize') initIds.add(msg.id);
    http.send(msg).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log(`forward failed: ${message}`);
        if (isJSONRPCRequest(msg)) {
            void stdio.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `QBZ bridge: ${message}` } });
        }
    });
};
http.onmessage = (msg: JSONRPCMessage) => {
    // Client normally does this after initialize; a raw pipe must do it so the
    // mcp-protocol-version header is sent on subsequent requests.
    if (isJSONRPCResultResponse(msg) && initIds.delete(msg.id)) {
        const v = (msg.result as { protocolVersion?: unknown }).protocolVersion;
        if (typeof v === 'string') http.setProtocolVersion(v);
    }
    void stdio.send(msg);
};
http.onerror = (e) => log(`http: ${e.message}`);
stdio.onerror = (e) => log(`stdio: ${e.message}`);
http.onclose = () => void shutdown(0);
// StdioServerTransport does not watch for EOF itself.
process.stdin.on('end', () => void shutdown(0));
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

await http.start();
await stdio.start();
