# ChatOps UI

A React chat interface for the sibling `chatops` agent project.

## Run locally

Install dependencies, then start the Vite development server:

```sh
npm install
npm run dev
```

The UI proxies `/api/*` to the ChatOps HTTP API at `http://127.0.0.1:8080` by
default. Set `CHATOPS_API_TARGET` to override the backend URL, for example:

```sh
CHATOPS_API_TARGET=http://localhost:8080 npm run dev
```

The UI uses the backend's `POST /v1/chat/stream` endpoint and reads the answer
as Server-Sent Events over a `fetch` request. The endpoint emits processing
status, answer text deltas, optional answer resets when validation triggers a
retry, and a completion or error event. It creates a session when the first
request omits `session_id`; the UI stores the returned `X-Session-ID` in page
state and includes it in subsequent requests. Starting a new conversation
aborts the active stream, clears the session state and visible message history;
opening a new page also starts a fresh conversation.

For production, configure the hosting reverse proxy to forward `/api/*` to the
ChatOps HTTP API and strip the `/api` prefix. Disable response buffering for
the streaming route so SSE events are forwarded immediately. This keeps the
browser request same-origin and avoids requiring CORS support from the backend.

## Admin page

The sidebar's "后台管理" button opens `#/admin` (hash routing, so static hosting
needs no SPA fallback). It lists chat requests from the backend's
`GET /v1/admin/requests` and `GET /v1/admin/stats` (20 per page, newest first),
with status filter, time/duration sorting, keyword search, and a dialog for the
full answer or error text. The backend only records requests made after the
`agent_requests` table was introduced.
