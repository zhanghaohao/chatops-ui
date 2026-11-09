import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";

type ChatMessage = {
  id: number;
  role: "user" | "assistant";
  content: string;
};

type TodoItem = {
  content: string;
  active_form?: string;
  status: "pending" | "in_progress" | "completed";
};

type Progress = {
  todos: TodoItem[];
  tool: string;
};

function parseProgress(data: unknown, previous: Progress): Progress {
  if (typeof data !== "object" || data === null) return previous;
  const record = data as {
    kind?: unknown;
    todos?: unknown;
    tool?: unknown;
    status?: unknown;
  };
  if (record.kind === "todo" && Array.isArray(record.todos)) {
    const todos = record.todos.filter(
      (item): item is TodoItem =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as TodoItem).content === "string",
    );
    return { ...previous, todos };
  }
  if (record.kind === "tool" && typeof record.tool === "string") {
    return { ...previous, tool: record.status === "running" ? record.tool : "" };
  }
  return previous;
}

type StreamEvent = {
  event: string;
  data: unknown;
};

async function readEventStream(
  response: Response,
  onEvent: (event: StreamEvent) => void,
) {
  if (!response.body) {
    throw new Error("服务未提供可读取的答案流。");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  function dispatch(frame: string) {
    let event = "message";
    const data: string[] = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).trimStart());
      }
    }
    if (!data.length) return;
    try {
      onEvent({ event, data: JSON.parse(data.join("\n")) as unknown });
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("服务返回了无法识别的流式事件。");
      }
      throw error;
    }
  }

  function consumeFrames(final = false) {
    buffer = buffer.replace(/\r\n/g, "\n");
    let separator = buffer.indexOf("\n\n");
    while (separator !== -1) {
      dispatch(buffer.slice(0, separator));
      buffer = buffer.slice(separator + 2);
      separator = buffer.indexOf("\n\n");
    }
    if (final && buffer.trim()) {
      dispatch(buffer);
      buffer = "";
    }
  }

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      consumeFrames();
    }
    buffer += decoder.decode();
    consumeFrames(true);
  } finally {
    reader.releaseLock();
  }
}

const suggestions = [
  "检查 prod1 环境中的服务 a 是否可以通过 TCP 协议访问服务 b 的 8080 端口",
  "查询 prod1 环境中服务 a 关联的网络资源",
  "服务之间的连通性是如何判断的？",
];

function App() {
  const navigate = useNavigate();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isWaiting, setIsWaiting] = useState(false);
  const [isStreamingAnswer, setIsStreamingAnswer] = useState(false);
  const [progress, setProgress] = useState<Progress>({ todos: [], tool: "" });
  const [error, setError] = useState<string | null>(null);
  const nextMessageId = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);
  const requestInProgress = useRef(false);
  const messageListRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messageListRef.current?.scrollTo({
      top: messageListRef.current.scrollHeight,
      behavior: isWaiting ? "auto" : "smooth",
    });
  }, [messages, isWaiting]);

  useEffect(
    () => () => {
      activeRequest.current?.abort();
    },
    [],
  );

  async function sendMessage(messageText = input) {
    const message = messageText.trim();
    if (!message || requestInProgress.current) return;

    requestInProgress.current = true;
    setInput("");
    setError(null);
    const userMessageId = nextMessageId.current++;
    const assistantMessageId = nextMessageId.current++;
    setMessages((current) => [
      ...current,
      { id: userMessageId, role: "user", content: message },
      { id: assistantMessageId, role: "assistant", content: "" },
    ]);
    setIsWaiting(true);
    setIsStreamingAnswer(false);
    setProgress({ todos: [], tool: "" });
    let currentProgress: Progress = { todos: [], tool: "" };

    const controller = new AbortController();
    activeRequest.current = controller;

    try {
      const response = await fetch("/api/v1/chat/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message,
          ...(sessionId ? { session_id: sessionId } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const details = (await response.text()).trim();
        throw new Error(details || `请求失败（HTTP ${response.status}）`);
      }
      if (!response.headers.get("Content-Type")?.startsWith("text/event-stream")) {
        throw new Error("服务未返回预期的流式响应。");
      }

      const returnedSessionId = response.headers.get("X-Session-ID");
      if (!returnedSessionId) {
        throw new Error("服务响应中缺少会话标识，请检查后端 API 配置。");
      }
      setSessionId(returnedSessionId);
      let answer = "";
      let completed = false;
      await readEventStream(response, ({ event, data }) => {
        if (event === "status") return;
        if (event === "progress") {
          currentProgress = parseProgress(data, currentProgress);
          setProgress(currentProgress);
          return;
        }
        if (event === "delta") {
          if (
            typeof data !== "object" ||
            data === null ||
            !("text" in data) ||
            typeof data.text !== "string"
          ) {
            throw new Error("服务返回了无法识别的答案片段。");
          }
          answer += data.text;
          setIsStreamingAnswer(true);
          setMessages((current) =>
            current.map((item) =>
              item.id === assistantMessageId
                ? { ...item, content: answer }
                : item,
            ),
          );
          return;
        }
        if (event === "reset") {
          answer = "";
          setIsStreamingAnswer(false);
          setMessages((current) =>
            current.map((item) =>
              item.id === assistantMessageId ? { ...item, content: "" } : item,
            ),
          );
          return;
        }
        if (event === "done") {
          if (
            typeof data !== "object" ||
            data === null ||
            !("complete" in data) ||
            data.complete !== true
          ) {
            throw new Error("服务未确认答案完整结束。");
          }
          completed = true;
          return;
        }
        if (event === "error") {
          const message =
            typeof data === "object" &&
            data !== null &&
            "message" in data &&
            typeof data.message === "string"
              ? data.message
              : "回答生成失败，请稍后重试。";
          throw new Error(message);
        }
        throw new Error(`服务返回了未知的流式事件：${event}`);
      });
      if (!completed) {
        throw new Error("答案流意外中断，当前内容可能不完整。");
      }
      if (!answer.trim()) {
        throw new Error("服务未返回有效答案，请稍后重试。");
      }
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === "AbortError") {
        return;
      }
      controller.abort();
      setMessages((current) =>
        current.filter(
          (item) => item.id !== assistantMessageId || item.content !== "",
        ),
      );
      setInput(message);
      setError(
        requestError instanceof TypeError
          ? "无法连接到 ChatOps 服务，请检查后端是否正在运行。"
          : requestError instanceof Error
            ? requestError.message
            : "暂时无法连接服务，请稍后重试。",
      );
    } finally {
      if (activeRequest.current === controller) {
        activeRequest.current = null;
        requestInProgress.current = false;
        setIsWaiting(false);
        setIsStreamingAnswer(false);
      }
    }
  }

  function startNewChat() {
    activeRequest.current?.abort();
    activeRequest.current = null;
    requestInProgress.current = false;
    setMessages([]);
    setInput("");
    setSessionId(null);
    setError(null);
    setIsWaiting(false);
    setIsStreamingAnswer(false);
    inputRef.current?.focus();
  }

  function handleInputKeyDown(
    event: KeyboardEvent<HTMLTextAreaElement>,
  ) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  const hasMessages = messages.length > 0;

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="ChatOps 首页">
          <span className="brand-mark" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className="brand-name">ChatOps</span>
        </a>

        <button className="new-chat-button" onClick={startNewChat}>
          <span aria-hidden="true">＋</span>
          新建对话
        </button>
        <button className="new-chat-button admin-button" onClick={() => navigate("/admin")}>
          <span aria-hidden="true">⚙</span>
          后台管理
        </button>

        <div className="sidebar-note">
          <div className="note-icon" aria-hidden="true">✦</div>
          <p>用自然语言探索服务、资源与网络连通性。</p>
        </div>

        <div className="sidebar-footer">
          <span className="status-dot" />
          ChatOps AI 助手
        </div>
      </aside>

      <section className="chat-panel" aria-label="聊天对话">
        <header className="topbar">
          <div className="assistant-identity">
            <div className="assistant-avatar" aria-hidden="true">✦</div>
            <div>
              <div className="assistant-title">基础设施助手</div>
              <div className="assistant-subtitle">
                <span className="status-dot" />
                ChatOps AI Agent
              </div>
            </div>
          </div>
          <div className="mobile-actions">
            <button className="mobile-new-chat" onClick={startNewChat}>
              新建对话
            </button>
            <button className="mobile-new-chat" onClick={() => navigate("/admin")}>
              后台管理
            </button>
          </div>
        </header>

        <div className="conversation" ref={messageListRef} aria-live="polite">
          {!hasMessages ? (
            <div className="welcome">
              <div className="welcome-orb" aria-hidden="true">
                <span>✦</span>
              </div>
              <p className="eyebrow">CHATOPS AI 助手</p>
              <h1>你好，今天想了解什么？</h1>
              <p className="welcome-copy">
                询问服务依赖、资源信息或网络连通性，我来帮你查找答案。
              </p>
              <div className="suggestion-grid">
                {suggestions.map((suggestion) => (
                  <button
                    className="suggestion-card"
                    key={suggestion}
                    onClick={() => void sendMessage(suggestion)}
                    disabled={isWaiting}
                  >
                    <span>{suggestion}</span>
                    <span className="suggestion-arrow" aria-hidden="true">↗</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="message-list">
              {messages.filter((message) => message.content !== "").map((message) => (
                <article
                  className={`message-row ${message.role}`}
                  key={message.id}
                >
                  {message.role === "assistant" && (
                    <div className="message-avatar" aria-hidden="true">✦</div>
                  )}
                  <div className="message-bubble">{message.content}</div>
                </article>
              ))}
              {isWaiting && !isStreamingAnswer && (
                <div className="message-row assistant" role="status">
                  <div className="message-avatar" aria-hidden="true">✦</div>
                  <div className="thinking-bubble">
                    <span className="spinner" aria-hidden="true" />
                    <div className="progress-body">
                      <span>
                        正在处理中…
                        {progress.tool && `（调用 ${progress.tool}）`}
                      </span>
                      {progress.todos.length > 0 && (
                        <ul className="todo-list">
                          {progress.todos.map((todo, index) => (
                            <li className={`todo-item ${todo.status}`} key={index}>
                              <span className="todo-mark" aria-hidden="true">
                                {todo.status === "completed"
                                  ? "✓"
                                  : todo.status === "in_progress"
                                    ? "›"
                                    : "○"}
                              </span>
                              <span>
                                {todo.status === "in_progress" && todo.active_form
                                  ? todo.active_form
                                  : todo.content}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </div>
                </div>
              )}
              {error && (
                <div className="error-message" role="alert">
                  <span aria-hidden="true">!</span>
                  <span>{error}</span>
                  <button onClick={() => inputRef.current?.focus()}>
                    继续输入
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="composer-wrap">
          <form
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              void sendMessage();
            }}
          >
            <textarea
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleInputKeyDown}
              placeholder="发送消息给 ChatOps AI 助手…"
              aria-label="输入消息"
              rows={1}
              disabled={isWaiting}
            />
            <button
              className="send-button"
              type="submit"
              disabled={!input.trim() || isWaiting}
              aria-label="发送消息"
            >
              <span aria-hidden="true">↑</span>
            </button>
          </form>
          <p className="composer-hint">
            Enter 发送 · Shift + Enter 换行
          </p>
        </div>
      </section>
    </main>
  );
}

export default App;
