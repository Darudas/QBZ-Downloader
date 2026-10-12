#!/usr/bin/env node
// stdio <-> Streamable HTTP bridge. stdout is the protocol channel: log ONLY to stderr.
// Usage: QBZ_MCP_URL=http://127.0.0.1:3000/mcp QBZ_MCP_TOKEN=<token> node dist/mcp/bridge.js
// Deliberately imports nothing from src/: the app logger writes to stdout.
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
    isJSONRPCErrorResponse,
    isJSONRPCNotification,
    isJSONRPCRequest,
    isJSONRPCResultResponse,
    type JSONRPCMessage,
    type RequestId
} from '@modelcontextprotocol/client';

/** How long to wait for answers to requests still in flight when stdin closes. */
const DRAIN_TIMEOUT_MS = 30_000;

const url = new URL(process.env.QBZ_MCP_URL ?? 'http://127.0.0.1:3000/mcp');
const token = process.env.QBZ_MCP_TOKEN;
if (!token) {
    process.stderr.write('QBZ_MCP_TOKEN is not set\n');
    process.exit(1);
}
const log = (m: string) => process.stderr.write(`[qbz-mcp-bridge] ${m}\n`);

// The stdio transport only parses stdin. It closes itself as soon as stdin
// ends, which would drop answers to requests that are still in flight (a
// client may write its requests and close stdin right away), so stdout is
// written directly with the same newline-delimited JSON framing.
const stdio = new StdioServerTransport();
const http = new StreamableHTTPClientTransport(url, {
    requestInit: { headers: { Authorization: `Bearer ${token}` } }
});
const initIds = new Set<RequestId>();
/** Requests forwarded to the server and not answered yet. */
const inFlight = new Set<RequestId>();
/** stdout writes not flushed yet; awaited before exiting. */
const writes = new Set<Promise<void>>();
let stdinClosed = false;
let closing = false;

function emit(msg: JSONRPCMessage): void {
    const done = new Promise<void>((resolve) => {
        process.stdout.write(`${JSON.stringify(msg)}\n`, () => resolve());
    });
    writes.add(done);
    void done.finally(() => writes.delete(done));
}

async function shutdown(code = 0): Promise<void> {
    if (closing) return;
    closing = true;
    await Promise.allSettled([...writes]);
    try { await http.terminateSession(); } catch { /* stateless server answers 405 */ }
    await Promise.allSettled([http.close(), stdio.close()]);
    process.exit(code);
}

function settle(id: RequestId): void {
    inFlight.delete(id);
    if (stdinClosed && inFlight.size === 0) void shutdown(0);
}

stdio.onmessage = (msg: JSONRPCMessage) => {
    if (isJSONRPCRequest(msg)) {
        inFlight.add(msg.id);
        if (msg.method === 'initialize') initIds.add(msg.id);
    } else if (isJSONRPCNotification(msg) && msg.method === 'notifications/cancelled') {
        const id = (msg.params as { requestId?: RequestId } | undefined)?.requestId;
        if (id !== undefined) inFlight.delete(id);
    }
    http.send(msg).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log(`forward failed: ${message}`);
        if (isJSONRPCRequest(msg)) {
            emit({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `QBZ bridge: ${message}` } });
            settle(msg.id);
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
    emit(msg);
    if (isJSONRPCResultResponse(msg) || isJSONRPCErrorResponse(msg)) {
        if (msg.id !== undefined) settle(msg.id);
    }
};
http.onerror = (e) => log(`http: ${e.message}`);
stdio.onerror = (e) => log(`stdio: ${e.message}`);
http.onclose = () => void shutdown(0);
// Fired when stdin ends or closes: finish the requests still in flight, then exit.
stdio.onclose = () => {
    if (stdinClosed) return;
    stdinClosed = true;
    if (inFlight.size === 0) {
        void shutdown(0);
        return;
    }
    setTimeout(() => {
        log(`exiting with ${inFlight.size} unanswered request(s)`);
        void shutdown(0);
    }, DRAIN_TIMEOUT_MS).unref();
};
process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));

await http.start();
await stdio.start();
