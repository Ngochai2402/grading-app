import { useEffect, useRef } from "react";

const API = "https://grading-app-production-2949.up.railway.app";

// Load MathJax
if (typeof window !== "undefined" && !window._mathJaxLoaded) {
  window._mathJaxLoaded = true;
  window.MathJax = {
    tex: { inlineMath: [["\\(", "\\)"]], displayMath: [["\\[", "\\]"]] },
    svg: { fontCache: "global" },
  };
  const s = document.createElement("script");
  s.src = "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js";
  s.async = true;
  document.head.appendChild(s);
}

function toLatex(text) {
  if (!text) return "";
  return text
    .replace(/x₁x₂/g, "\\(x_1 x_2\\)")
    .replace(/x₁/g, "\\(x_1\\)").replace(/x₂/g, "\\(x_2\\)")
    .replace(/x₃/g, "\\(x_3\\)").replace(/x₄/g, "\\(x_4\\)")
    .replace(/\(([^)]+)\)²/g, "\\(($1)^2\\)")
    .replace(/([a-zA-Z0-9])²/g, "\\($1^2\\)")
    .replace(/([a-zA-Z0-9])³/g, "\\($1^3\\)")
    .replace(/√(\d+)/g, "\\(\\sqrt{$1}\\)")
    .replace(/(\d+)\/(\d+)/g, "\\(\\dfrac{$1}{$2}\\)")
    .replace(/[Δ△]/g, "\\(\\Delta\\)")
    .replace(/≈/g, "\\(\\approx\\)")
    .replace(/≤/g, "\\(\\leq\\)")
    .replace(/≥/g, "\\(\\geq\\)")
    .replace(/⟹/g, "\\(\\Rightarrow\\)")
    .replace(/→/g, "\\(\\to\\)");
}

function Math({ text }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current) return;
    const tryRender = () => {
      if (window.MathJax?.typesetPromise) {
        window.MathJax.typesetPromise([ref.current]).catch(() => {});
      } else {
        setTimeout(tryRender, 300);
      }
    };
    tryRender();
  }, [text]);
  return <span ref={ref} dangerouslySetInnerHTML={{ __html: toLatex(text) }} />;
}

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
        <button className="btn btn-ghost" onClick={onBack}>← Quay lại</button>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 24, fontWeight: 700 }}>Kết quả chấm bài</h1>
          <div style={{ fontSize: 13, color: "var(--text2)" }}>{studentName} • {subject}</div>
        </div>
        <a href={`${API}/api/export/${resultId}/annotated-all`} target="_blank" rel="noreferrer" className="btn btn-outline" style={{ fontSize: 13, marginRight: 8 }}>📝 Bài đã chấm</a>
        <a href={`${API}/api/export/${resultId}/html`} target="_blank" rel="noreferrer" className="btn btn-outline" style={{ fontSize: 13 }}>🖨️ In PDF</a>
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
          <p style={{ fontSize: 14, color: "var(--text)", lineHeight: 1.6 }}><Math text={nhan_xet_chung} /></p>
        </div>
      </div>

      {/* CHẤM TỪNG DÒNG */}
      <div className="card">
        <div className="card-title">📋 Chấm từng dòng</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {(cac_cau || []).map((cau, i) => {
            const pct = cau.diem_dat / cau.diem_toi_da;
            const c = pct >= 0.8 ? "var(--green)" : pct >= 0.4 ? "var(--amber)" : "var(--accent)";
            return (
              <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                {/* Header câu */}
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: "var(--surface2)", borderBottom: "1px solid var(--border)" }}>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>{cau.so_cau}</span>
                  {statusBadge(cau.trang_thai)}
                  <span style={{ marginLeft: "auto", fontWeight: 700, color: c, fontSize: 17 }}>
                    {cau.diem_dat}<span style={{ fontSize: 12, color: "var(--text3)", fontWeight: 400 }}>/{cau.diem_toi_da}đ</span>
                  </span>
                </div>

                {/* Bảng chấm từng dòng */}
                {cau.cham_tung_dong && cau.cham_tung_dong.length > 0 && (
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <tbody>
                      {cau.cham_tung_dong.map((dong, j) => {
                        const isDung = dong.ket_qua?.includes("✓");
                        const isSai = dong.ket_qua?.includes("✗");
                        const bg = isSai ? "#fff8f8" : isDung ? "#f8fff9" : "#fffdf5";
                        const kqColor = isSai ? "var(--accent)" : isDung ? "var(--green)" : "var(--amber)";
                        return (
                          <tr key={j} style={{ background: bg, borderTop: j > 0 ? "1px solid var(--border)" : "none" }}>
                            <td style={{ padding: "9px 14px", fontSize: 13, width: "50%" }}>
                              <Math text={dong.dong} />
                            </td>
                            <td style={{ padding: "9px 10px", fontWeight: 700, color: kqColor, fontSize: 13, whiteSpace: "nowrap" }}>
                              {dong.ket_qua}
                            </td>
                            <td style={{ padding: "9px 14px", fontSize: 12, color: isSai ? "var(--accent)" : "var(--text3)", lineHeight: 1.5 }}>
                              <Math text={dong.ghi_chu} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}

                {/* Lỗi sai + gợi ý */}
                {cau.loi_sai && (
                  <div style={{ padding: "10px 16px", background: "#fff8f8", fontSize: 13, color: "var(--accent)", borderTop: "1px solid var(--border)" }}>
                    ✗ <strong>Lỗi sai:</strong> <Math text={cau.loi_sai} />
                  </div>
                )}
                {cau.goi_y_sua && (
                  <div style={{ padding: "10px 16px", background: "#f0f7ff", fontSize: 13, color: "var(--blue)", borderTop: "1px solid var(--border)" }}>
                    💡 <strong>Gợi ý:</strong> <Math text={cau.goi_y_sua} />
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
          {imageUrls.map((url, i) => (
            <img key={i} src={`${API}${url}`} alt={`Trang ${i + 1}`} style={{ width: "100%", borderRadius: 8, border: "1px solid var(--border)", marginBottom: 8 }} />
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
        <button className="btn btn-outline" onClick={onBack} style={{ flex: 1, justifyContent: "center" }}>← Chấm bài khác</button>
        <a href={`${API}/api/export/${resultId}/html`} target="_blank" rel="noreferrer" className="btn btn-primary" style={{ flex: 1, justifyContent: "center" }}>🖨️ In báo cáo PDF</a>
      </div>
    </div>
  );
}
