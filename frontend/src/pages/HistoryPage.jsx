import { useState, useEffect } from "react";

const API = import.meta.env.VITE_API_URL || "https://grading-app-production-2949.up.railway.app";

export default function HistoryPage({ onSelect }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`${API}/api/grade`)
      .then(r => r.json())
      .then(data => { setList(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  if (loading) return (
    <div className="loading"><div className="spinner" /><div>Đang tải...</div></div>
  );

  if (!list.length) return (
    <div style={{ textAlign: "center", padding: "60px 20px", color: "var(--text2)" }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>📭</div>
      <div style={{ fontWeight: 600, fontSize: 16 }}>Chưa có bài nào được chấm</div>
      <div style={{ fontSize: 14, marginTop: 6 }}>Quay lại trang chính để chấm bài mới</div>
    </div>
  );

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 28, fontWeight: 700, marginBottom: 6 }}>
          Lịch sử chấm bài
        </h1>
        <p style={{ color: "var(--text2)", fontSize: 14 }}>{list.length} bài đã chấm</p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {list.map((item) => {
          const pct = item.tongDiem && item.diemToiDa
            ? Math.round((item.tongDiem / item.diemToiDa) * 100) : null;
          const c = pct >= 80 ? "var(--green)" : pct >= 60 ? "var(--amber)" : "var(--accent)";

          return (
            <div
              key={item.id}
              className="card"
              style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 16, padding: "16px 20px", marginBottom: 0 }}
              onClick={async () => {
                const res = await fetch(`${API}/api/grade/${item.id}`);
                const data = await res.json();
                onSelect({ ...data, resultId: item.id });
              }}
            >
              <div style={{
                width: 52, height: 52, borderRadius: "50%",
                background: pct !== null ? (pct >= 80 ? "#e8f5ee" : pct >= 60 ? "#fef3dc" : "#fdecea") : "var(--bg)",
                display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
                color: c, fontWeight: 700, fontSize: pct !== null ? 15 : 20, flexShrink: 0
              }}>
                {pct !== null ? <>{pct}<span style={{ fontSize: 9 }}>%</span></> : "?"}
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 15 }}>{item.studentName}</div>
                <div style={{ fontSize: 13, color: "var(--text2)" }}>
                  {item.subject} •{" "}
                  {item.tongDiem !== undefined ? `${item.tongDiem}/${item.diemToiDa} điểm` : "Không có điểm"}
                </div>
              </div>
              <div style={{ fontSize: 12, color: "var(--text3)", textAlign: "right" }}>
                {new Date(item.createdAt).toLocaleString("vi-VN")}
              </div>
              <div style={{ color: "var(--text3)", fontSize: 18 }}>›</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
