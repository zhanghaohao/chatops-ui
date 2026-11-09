import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

type RequestRecord = {
  request_id: string;
  session_id: string;
  endpoint: string;
  query: string;
  answer: string;
  status: "succeeded" | "failed";
  error: string;
  http_status: number;
  intent: string;
  started_at: string;
  duration_ms: number;
};

type RequestPage = {
  items: RequestRecord[];
  total: number;
  page: number;
  page_size: number;
};

type Stats = { total: number; succeeded: number; failed: number };
type StatusFilter = "all" | "succeeded" | "failed";
type SortKey = "started_at" | "duration";

const PAGE_SIZE = 20;
const PREVIEW_LENGTH = 80;

function preview(text: string) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > PREVIEW_LENGTH ? `${flat.slice(0, PREVIEW_LENGTH)}…` : flat;
}

// Pretty-print JSON content; plain text keeps its own line breaks.
function formatContent(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return text;
    }
  }
  return text;
}

function formatDuration(ms: number) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`;
}

async function getJSON<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(path, { signal });
  if (!response.ok) {
    throw new Error((await response.text()).trim() || `请求失败(HTTP ${response.status})`);
  }
  return (await response.json()) as T;
}

function AdminPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [data, setData] = useState<RequestPage | null>(null);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<SortKey>("started_at");
  const [order, setOrder] = useState<"asc" | "desc">("desc");
  const [keywordInput, setKeywordInput] = useState("");
  const [keyword, setKeyword] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<{ title: string; content: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(PAGE_SIZE),
      status,
      sort,
      order,
    });
    if (keyword) params.set("q", keyword);
    Promise.all([
      getJSON<RequestPage>(`/api/v1/admin/requests?${params}`, controller.signal),
      getJSON<Stats>("/api/v1/admin/stats", controller.signal),
    ])
      .then(([list, summary]) => {
        setData(list);
        setStats(summary);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "加载失败");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [page, status, sort, order, keyword, reloadToken]);

  useEffect(() => {
    if (!modal) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setModal(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modal]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / PAGE_SIZE)) : 1;

  function toggleSort(key: SortKey) {
    if (sort === key) {
      setOrder(order === "desc" ? "asc" : "desc");
    } else {
      setSort(key);
      setOrder("desc");
    }
    setPage(1);
  }

  function sortMark(key: SortKey) {
    return sort === key ? (order === "desc" ? " ↓" : " ↑") : "";
  }

  function longCell(title: string, text: string) {
    if (!text) return <span className="admin-muted">—</span>;
    return (
      <button
        type="button"
        className="admin-cell-link"
        title="点击查看全部内容"
        onClick={() => setModal({ title, content: formatContent(text) })}
      >
        {preview(text)}
      </button>
    );
  }

  return (
    <main className="admin-page">
      <header className="admin-header">
        <div>
          <h1>后台管理</h1>
          <p>用户请求记录,用于追踪 Agent 的实际工作效果。</p>
        </div>
        <Link to="/" className="admin-back">
          ← 返回对话
        </Link>
      </header>

      <section className="admin-stats" aria-label="请求统计">
        <div className="admin-stat">
          <span>总请求数</span>
          <strong>{stats?.total ?? "—"}</strong>
        </div>
        <div className="admin-stat admin-stat-ok">
          <span>成功请求数</span>
          <strong>{stats?.succeeded ?? "—"}</strong>
        </div>
        <div className="admin-stat admin-stat-fail">
          <span>失败请求数</span>
          <strong>{stats?.failed ?? "—"}</strong>
        </div>
      </section>

      <form
        className="admin-filters"
        onSubmit={(event) => {
          event.preventDefault();
          setKeyword(keywordInput.trim());
          setPage(1);
        }}
      >
        <label>
          状态
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as StatusFilter);
              setPage(1);
            }}
          >
            <option value="all">全部</option>
            <option value="failed">仅失败</option>
            <option value="succeeded">仅成功</option>
          </select>
        </label>
        <label>
          排序
          <select
            value={`${sort}:${order}`}
            onChange={(event) => {
              const [nextSort, nextOrder] = event.target.value.split(":");
              setSort(nextSort as SortKey);
              setOrder(nextOrder as "asc" | "desc");
              setPage(1);
            }}
          >
            <option value="started_at:desc">时间:最新优先</option>
            <option value="started_at:asc">时间:最早优先</option>
            <option value="duration:desc">耗时:从长到短</option>
            <option value="duration:asc">耗时:从短到长</option>
          </select>
        </label>
        <input
          type="search"
          placeholder="搜索查询语句 / Request ID / Session ID"
          value={keywordInput}
          onChange={(event) => setKeywordInput(event.target.value)}
        />
        <button type="submit">搜索</button>
        <button type="button" onClick={() => setReloadToken((value) => value + 1)}>
          刷新
        </button>
      </form>

      {error && <div className="admin-error">{error}</div>}

      <div className={`admin-table-wrap${loading ? " is-loading" : ""}`}>
        <table className="admin-table">
          <thead>
            <tr>
              <th className="sortable" onClick={() => toggleSort("started_at")}>
                发生时间{sortMark("started_at")}
              </th>
              <th>Request ID</th>
              <th>Session ID</th>
              <th>查询语句</th>
              <th>返回结果</th>
              <th>状态</th>
              <th>失败日志</th>
              <th className="sortable" onClick={() => toggleSort("duration")}>
                总耗时{sortMark("duration")}
              </th>
              <th>意图</th>
              <th>接口</th>
            </tr>
          </thead>
          <tbody>
            {data?.items.map((item) => (
              <tr key={item.request_id}>
                <td className="nowrap">{new Date(item.started_at).toLocaleString("zh-CN", { hour12: false })}</td>
                <td className="mono">{item.request_id}</td>
                <td className="mono">{item.session_id || "—"}</td>
                <td>{longCell("查询语句", item.query)}</td>
                <td>{longCell("返回结果", item.answer)}</td>
                <td>
                  <span className={`admin-badge ${item.status}`}>
                    {item.status === "succeeded" ? "成功" : "失败"}
                  </span>
                </td>
                <td>{longCell("失败日志", item.error)}</td>
                <td className="nowrap">{formatDuration(item.duration_ms)}</td>
                <td>{item.intent || "—"}</td>
                <td>{item.endpoint}</td>
              </tr>
            ))}
            {data && data.items.length === 0 && (
              <tr>
                <td colSpan={10} className="admin-empty">
                  暂无记录
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <footer className="admin-pager">
        <span>
          共 {data?.total ?? 0} 条,第 {page} / {totalPages} 页
        </span>
        <button disabled={page <= 1} onClick={() => setPage(1)}>
          首页
        </button>
        <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
          上一页
        </button>
        <button disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
          下一页
        </button>
        <button disabled={page >= totalPages} onClick={() => setPage(totalPages)}>
          末页
        </button>
      </footer>

      {modal && (
        <div className="admin-modal-backdrop" onClick={() => setModal(null)}>
          <div
            className="admin-modal"
            role="dialog"
            aria-modal="true"
            aria-label={modal.title}
            onClick={(event) => event.stopPropagation()}
          >
            <header>
              <h2>{modal.title}</h2>
              <div>
                <button onClick={() => void navigator.clipboard?.writeText(modal.content)}>复制</button>
                <button onClick={() => setModal(null)}>关闭</button>
              </div>
            </header>
            <pre>{modal.content}</pre>
          </div>
        </div>
      )}
    </main>
  );
}

export default AdminPage;
