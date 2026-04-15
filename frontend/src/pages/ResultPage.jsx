const API = import.meta.env.VITE_API_URL || "https://grading-app-production-2949.up.railway.app";

export default function ResultPage({ result, onBack }) {
  const { studentName, subject, gradingResult, imageUrls, resultId } = result;
  const { tong_diem, diem_toi_da, phan_tram, xep_loai, nhan_xet_chung, cac_cau } = gradingResult;

  const scoreColor = phan_tram >= 80 ? "var(--green)" : phan_tram >= 60 ? "var(--amber)" : "var(--accent)";
  const scoreBg = phan_tram >= 80 ? "#e8f5ee" : phan_tram >= 60 ? "#fef3dc" : "#fdecea";

  const statusBadge = (status) => {
    if (status === "Đúng") return <span className="badge badge-green">✓ Đúng</span>;
    if (status === "Một phần") return <span className="badge badge-amber">◑ Một phần</span>;
    if (status === "Bỏ trống") return <span className="badge" style={{ background: "#f0f0f0", color: "#888" }}>— Bỏ trống</span>;
    return <span className="badge badge-red">✗ Sai</span>;
  };

  return (
    <div>
      {/* HEADER */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
        <button className="btn btn-ghost" onClick={onBack} style={{ padding: "8px 12px" }}>← Quay lại</button>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 24, fontWeight: 700 }}>
            Kết quả chấm bài
          </h1>
          <div style={{ fontSize: 13, color: "var(--text2)" }}>{studentName} • {subject}</div>
        </div>
        <a
          href={`${API}/api/export/${resultId}/html`}
          target="_blank"
          rel="noreferrer"
          className="btn btn-outline"
          style={{ fontSize: 13 }}
        >🖨️ In / Xuất PDF</a>
      </div>

      {/* TỔNG ĐIỂM */}
      <div className="card" style={{ display: "flex", alignItems: "center", gap: 24, background: scoreBg, border: `1.5px solid ${scoreColor}` }}>
        <div className="score-circle" style={{ background: scoreColor, color: "#fff", minWidth: 80 }}>
          <div style={{ fontSize: 22, lineHeight: 1 }}>{tong_diem}</div>
          <div style={{ fontSize: 11, opacity: 0.85 }}>/{diem_toi_da}</div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 26, fontWeight: 700, color: scoreColor }}>{phan_tram}%</span>
            <span style={{ fontWeight: 700, fontSize: 16, color: scoreColor }}>{xep_loai}</span>
          </div>
          <p style={{ fontSize: 14, color: "var(--text)", lineHeight: 1.6 }}>{nhan_xet_chung}</p>
        </div>
      </div>

      {/* ĐIỂM TỪNG CÂU */}
      <div className="card">
        <div className="card-title">📊 Chi tiết từng câu</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {(cac_cau || []).map((cau, i) => {
            const pct = (cau.diem_dat / cau.diem_toi_da) * 100;
            const c = pct >= 80 ? "var(--green)" : pct >= 40 ? "var(--amber)" : "var(--accent)";
            return (
              <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 10, padding: "16px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                  <div style={{ fontWeight: 700, fontSize: 15, minWidth: 60 }}>{cau.so_cau}</div>
                  {statusBadge(cau.trang_thai)}
                  <div style={{ marginLeft: "auto", fontWeight: 700, color: c, fontSize: 16 }}>
                    {cau.diem_dat}<span style={{ fontSize: 12, color: "var(--text3)", fontWeight: 400 }}>/{cau.diem_toi_da} điểm</span>
                  </div>
                </div>

                {/* Progress bar */}
                <div style={{ background: "var(--border)", borderRadius: 4, height: 6, marginBottom: 10 }}>
                  <div style={{ background: c, height: 6, borderRadius: 4, width: `${Math.min(pct, 100)}%`, transition: "width 0.5s" }} />
                </div>

                {cau.nhan_xet && (
                  <div style={{ fontSize: 13, color: "var(--text2)", marginBottom: cau.loi_sai ? 6 : 0, lineHeight: 1.6 }}>
                    💬 {cau.nhan_xet}
                  </div>
                )}
                {cau.loi_sai && (
                  <div style={{ fontSize: 13, color: "var(--accent)", marginBottom: cau.goi_y_sua ? 6 : 0, lineHeight: 1.6 }}>
                    ✗ <strong>Lỗi sai:</strong> {cau.loi_sai}
                  </div>
                )}
                {cau.goi_y_sua && (
                  <div style={{ fontSize: 13, color: "var(--blue)", lineHeight: 1.6 }}>
                    💡 <strong>Gợi ý:</strong> {cau.goi_y_sua}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ẢNH BÀI LÀM */}
      {imageUrls && imageUrls.length > 0 && (
        <div className="card">
          <div className="card-title">🖼️ Bài làm học sinh</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {imageUrls.map((url, i) => (
              <img
                key={i}
                src={`${API}${url}`}
                alt={`Trang ${i + 1}`}
                style={{ width: "100%", borderRadius: 8, border: "1px solid var(--border)" }}
              />
            ))}
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
        <button className="btn btn-outline" onClick={onBack} style={{ flex: 1, justifyContent: "center" }}>
          ← Chấm bài khác
        </button>
        <a
          href={`${API}/api/export/${resultId}/html`}
          target="_blank"
          rel="noreferrer"
          className="btn btn-primary"
          style={{ flex: 1, justifyContent: "center" }}
        >
          🖨️ In báo cáo PDF
        </a>
      </div>
    </div>
  );
}
