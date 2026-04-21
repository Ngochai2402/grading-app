import { useEffect, useRef } from "react";

const API = "https://grading-app-production-2949.up.railway.app";

// ── Inject KaTeX + auto-render một lần ─────────────────────────────────────
let _loaded = false;
function injectKatex(cb) {
  if (_loaded && window.renderMathInElement) { cb(); return; }

  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css";
  document.head.appendChild(css);

  const s1 = document.createElement("script");
  s1.src = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js";
  s1.onload = () => {
    const s2 = document.createElement("script");
    s2.src = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/contrib/auto-render.min.js";
    s2.onload = () => { _loaded = true; cb(); };
    document.head.appendChild(s2);
  };
  document.head.appendChild(s1);
}

// ── MathText ───────────────────────────────────────────────────────────────
function MathText({ text, style }) {
  const ref = useRef(null);

  useEffect(() => {
    if (!text || !ref.current) return;
    ref.current.textContent = text;
    injectKatex(() => {
      if (!ref.current) return;
      window.renderMathInElement(ref.current, {
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "$", right: "$", display: false },
        ],
        throwOnError: false,
        strict: false,
      });
    });
  }, [text]);

  return <span ref={ref} style={style}>{text}</span>;
}

// ── ResultPage ─────────────────────────────────────────────────────────────
export default function ResultPage({ result, onBack }) {
  const { studentName, subject, gradingResult, imageUrls, resultId } = result;
  const { tong_diem, diem_toi_da, phan_tram, xep_loai, cac_cau, tom_tat_review } = gradingResult;

  const scoreColor = phan_tram >= 80 ? "var(--green)" : phan_tram >= 60 ? "var(--amber)" : "var(--accent)";
  const scoreBg    = phan_tram >= 80 ? "#e8f5ee"      : phan_tram >= 60 ? "#fef3dc"      : "#fdecea";

  const statusBadge = (s) => {
    if (s === "Đúng")                             return <span className="badge badge-green">✓ Đúng</span>;
    if (s === "Đúng một phần" || s === "Một phần") return <span className="badge badge-amber">◑ Một phần</span>;
    if (s === "Bỏ trống")                         return <span className="badge" style={{ background: "#f0f0f0", color: "#888" }}>— Bỏ trống</span>;
    return <span className="badge badge-red">✗ Sai</span>;
  };

  return (
    <div>
      {/* NAV */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
        <button className="btn btn-ghost" onClick={onBack}>← Quay lại</button>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontFamily: "'Playfair Display',serif", fontSize: 24, fontWeight: 700 }}>Kết quả chấm bài</h1>
          <div style={{ fontSize: 13, color: "var(--text2)" }}>{studentName} • {subject}</div>
        </div>
        <a href={`${API}/api/export/${resultId}/annotated-all`} target="_blank" rel="noreferrer" className="btn btn-outline" style={{ fontSize: 13, marginRight: 6 }}>📝 Bài đã chấm</a>
        <a href={`${API}/api/export/${resultId}/pdf`} target="_blank" rel="noreferrer" className="btn btn-primary" style={{ fontSize: 13, marginRight: 6 }}>📄 Xuất PDF</a>
        <a href={`${API}/api/export/${resultId}/html`} target="_blank" rel="noreferrer" className="btn btn-outline" style={{ fontSize: 13 }}>🖨️ In HTML</a>
      </div>

      {/* CẢNH BÁO HALLUCINATION (nếu có) */}
      {gradingResult.canh_bao_hallucination?.co_bia_dong && (
        <div className="card" style={{ background: "#fdecea", borderLeft: "4px solid #c0392b", color: "#7a1d13", marginBottom: 16 }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>🚨 Phát hiện AI bịa bước giải</div>
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>{gradingResult.canh_bao_hallucination.canh_bao_chung}</div>
        </div>
      )}

      {/* BANNER: cần thầy xem */}
      {tom_tat_review?.so_cau_can_xem > 0 && (
        <div className="card" style={{ background: "#fef3dc", borderLeft: "4px solid #e67e22", color: "#8b5a1a", marginBottom: 16, padding: "14px 18px" }}>
          <div style={{ fontWeight: 700, marginBottom: 4, fontSize: 14 }}>
            ⚠ Có {tom_tat_review.so_cau_can_xem}/{tom_tat_review.tong_so_cau} câu cần giáo viên xem lại
          </div>
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            Lý do: {tom_tat_review.ly_do_chinh.join(" · ")}
          </div>
        </div>
      )}

      {/* ĐIỂM TỔNG */}
      <div className="card" style={{ display: "flex", alignItems: "center", gap: 24, background: scoreBg, border: `1.5px solid ${scoreColor}` }}>
        <div className="score-circle" style={{ background: scoreColor, color: "#fff", minWidth: 80 }}>
          <div style={{ fontSize: 22, lineHeight: 1 }}>{tong_diem}</div>
          <div style={{ fontSize: 11, opacity: 0.8 }}>/{diem_toi_da}</div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 26, fontWeight: 700, color: scoreColor }}>{phan_tram}%</span>
            <span style={{ fontWeight: 700, fontSize: 16, color: scoreColor }}>{xep_loai}</span>
          </div>
        </div>
      </div>

      {/* CHẤM TỪNG DÒNG */}
      <div className="card">
        <div className="card-title">📋 Chấm từng dòng</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {(cac_cau || []).map((cau, i) => {
            const pct = cau.diem_toi_da > 0 ? cau.diem_dat / cau.diem_toi_da : 0;
            const c   = pct >= 0.8 ? "var(--green)" : pct >= 0.4 ? "var(--amber)" : "var(--accent)";
            const doTinCayPct = typeof cau.do_tin_cay === "number" ? Math.round(cau.do_tin_cay * 100) : null;
            const needReview = cau.can_giao_vien_xem === true;
            // Highlight card cho câu cần review
            const cardStyle = needReview
              ? { border: "2px solid #e67e22", borderRadius: 10, overflow: "hidden", boxShadow: "0 0 0 3px #fef3dc" }
              : { border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" };

            return (
              <div key={i} style={cardStyle}>
                {/* Header câu */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "11px 16px", background: "var(--surface2)", borderBottom: "1px solid var(--border)", flexWrap: "wrap" }}>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>{cau.so_cau}</span>
                  {statusBadge(cau.trang_thai)}
                  {needReview && (
                    <span style={{ background: "#e67e22", color: "#fff", fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 4 }}>
                      ⚠ Cần xem lại
                    </span>
                  )}
                  {doTinCayPct !== null && (
                    <span style={{
                      fontSize: 11,
                      color: doTinCayPct >= 70 ? "#1b7a3e" : "#e67e22",
                      background: "#fff",
                      border: `1px solid ${doTinCayPct >= 70 ? "#1b7a3e" : "#e67e22"}`,
                      padding: "2px 6px",
                      borderRadius: 4
                    }}>
                      Tin cậy {doTinCayPct}%
                    </span>
                  )}
                  {cau.tieu_chi_auto_tach && (
                    <span style={{ fontSize: 11, color: "#1565c0", background: "#e3f2fd", padding: "2px 6px", borderRadius: 4 }}>
                      Tiêu chí AI tự tách
                    </span>
                  )}
                  <span style={{ marginLeft: "auto", fontWeight: 700, color: c, fontSize: 17 }}>
                    {cau.diem_dat}<span style={{ fontSize: 12, color: "var(--text3)", fontWeight: 400 }}>/{cau.diem_toi_da}đ</span>
                  </span>
                </div>

                {/* Lý do cần xem */}
                {needReview && Array.isArray(cau.ly_do_can_xem) && cau.ly_do_can_xem.length > 0 && (
                  <div style={{ padding: "6px 16px", background: "#fef3dc", fontSize: 12, color: "#8b5a1a", borderBottom: "1px solid #f5d7a8" }}>
                    <strong>Lý do:</strong> {cau.ly_do_can_xem.join(" · ")}
                  </div>
                )}

                {/* Bảng dòng — 3 cột */}
                {cau.cham_tung_dong?.length > 0 ? (
                  <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                    <colgroup>
                      <col style={{ width: "55%" }} />
                      <col style={{ width: "12%" }} />
                      <col style={{ width: "33%" }} />
                    </colgroup>
                    <thead>
                      <tr style={{ background: "#f5f5f5", fontSize: 12, color: "#555" }}>
                        <th style={{ textAlign: "left", padding: "6px 12px", borderBottom: "1px solid var(--border)", fontWeight: 600 }}>Bài làm học sinh</th>
                        <th style={{ textAlign: "center", padding: "6px 10px", borderBottom: "1px solid var(--border)", fontWeight: 600 }}>Kết quả</th>
                        <th style={{ textAlign: "left", padding: "6px 12px", borderBottom: "1px solid var(--border)", fontWeight: 600 }}>Nhận xét</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cau.cham_tung_dong.map((dong, j) => {
                        const isDung = dong.ket_qua?.includes("✓");
                        const isSai  = dong.ket_qua?.includes("✗");
                        const bg      = isSai ? "#fff8f8" : isDung ? "#f8fff9" : "#fff";
                        const kqColor = isSai ? "var(--accent)" : isDung ? "var(--green)" : "#888";
                        return (
                          <tr key={j} style={{ background: bg, borderTop: "1px solid var(--border)" }}>
                            <td style={{ padding: "10px 14px", fontSize: 13.5, lineHeight: 1.7, verticalAlign: "top", wordBreak: "break-word" }}>
                              <MathText text={dong.dong_katex || dong.dong} />
                            </td>
                            <td style={{ padding: "10px 10px", fontWeight: 700, color: kqColor, fontSize: 15, verticalAlign: "top", whiteSpace: "nowrap", textAlign: "center" }}>
                              {dong.ket_qua}
                            </td>
                            <td style={{ padding: "10px 14px", fontSize: 12.5, color: isSai ? "#c62828" : "#888", lineHeight: 1.6, verticalAlign: "top", wordBreak: "break-word" }}>
                              {dong.ghi_chu ? <MathText text={dong.ghi_chu_katex || dong.ghi_chu} /> : ""}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                ) : (
                  <div style={{ padding: "12px 16px", color: "#999", fontSize: 13, fontStyle: "italic" }}>
                    (Không có bước giải nào được ghi nhận)
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ẢNH BÀI LÀM */}
      {imageUrls?.length > 0 && (
        <div className="card">
          <div className="card-title">🖼️ Bài làm học sinh</div>
          {imageUrls.map((url, i) => (
            <img key={i} src={`${API}${url}`} alt={`Trang ${i + 1}`}
              style={{ width: "100%", borderRadius: 8, border: "1px solid var(--border)", marginBottom: 8 }} />
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
        <button className="btn btn-outline" onClick={onBack} style={{ flex: 1, justifyContent: "center" }}>← Chấm bài khác</button>
        <a href={`${API}/api/export/${resultId}/pdf`} target="_blank" rel="noreferrer"
          className="btn btn-primary" style={{ flex: 1, justifyContent: "center" }}>📄 Xuất PDF</a>
      </div>
    </div>
  );
}
