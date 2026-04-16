import { useEffect, useRef, useState } from "react";

const API = "https://grading-app-production-2949.up.railway.app";

// ── Load KaTeX once ──────────────────────────────────────────────────────────
let _katexState = "idle";
const _katexCbs = [];

function ensureKatex(cb) {
  if (_katexState === "ready") { cb(); return; }
  _katexCbs.push(cb);
  if (_katexState === "loading") return;
  _katexState = "loading";

  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css";
  document.head.appendChild(css);

  const js = document.createElement("script");
  js.src = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js";
  js.onload = () => {
    _katexState = "ready";
    _katexCbs.forEach(f => f());
    _katexCbs.length = 0;
  };
  document.head.appendChild(js);
}

// ── Render text có chứa $...$ bằng KaTeX ────────────────────────────────────
// Tách text thành [text, $math$, text, $math$, ...]
function parseMathSegments(text) {
  if (!text) return [];
  const segments = [];
  const re = /\$([^$]+)\$/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segments.push({ type: "text", value: text.slice(last, m.index) });
    segments.push({ type: "math", value: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) segments.push({ type: "text", value: text.slice(last) });
  return segments;
}

function MathText({ text, style }) {
  const [html, setHtml] = useState(null);

  useEffect(() => {
    if (!text) { setHtml(""); return; }
    ensureKatex(() => {
      const segments = parseMathSegments(text);
      const rendered = segments.map(seg => {
        if (seg.type === "math") {
          try {
            return window.katex.renderToString(seg.value, { throwOnError: false, strict: false });
          } catch {
            return `$${seg.value}$`;
          }
        }
        // Escape HTML cho text thường
        return seg.value
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      });
      setHtml(rendered.join(""));
    });
  }, [text]);

  if (html === null) return <span style={style}>{text}</span>;
  return <span style={style} dangerouslySetInnerHTML={{ __html: html }} />;
}

// ── ResultPage ────────────────────────────────────────────────────────────────
export default function ResultPage({ result, onBack }) {
  const { studentName, subject, gradingResult, imageUrls, resultId } = result;
  const { tong_diem, diem_toi_da, phan_tram, xep_loai, nhan_xet_chung, cac_cau } = gradingResult;

  const scoreColor = phan_tram >= 80 ? "var(--green)" : phan_tram >= 60 ? "var(--amber)" : "var(--accent)";
  const scoreBg   = phan_tram >= 80 ? "#e8f5ee"       : phan_tram >= 60 ? "#fef3dc"       : "#fdecea";

  const statusBadge = (s) => {
    if (s === "Đúng")     return <span className="badge badge-green">✓ Đúng</span>;
    if (s === "Một phần") return <span className="badge badge-amber">◑ Một phần</span>;
    if (s === "Bỏ trống") return <span className="badge" style={{ background: "#f0f0f0", color: "#888" }}>— Bỏ trống</span>;
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
        <a href={`${API}/api/export/${resultId}/pdf`} target="_blank" rel="noreferrer"
          className="btn btn-primary" style={{ fontSize: 13, marginRight: 8 }}>📄 Xuất PDF</a>
        <a href={`${API}/api/export/${resultId}/html`} target="_blank" rel="noreferrer"
          className="btn btn-outline" style={{ fontSize: 13 }}>🖨️ In HTML</a>
      </div>

      {/* ĐIỂM TỔNG */}
      <div className="card" style={{ display: "flex", alignItems: "center", gap: 24, background: scoreBg, border: `1.5px solid ${scoreColor}` }}>
        <div className="score-circle" style={{ background: scoreColor, color: "#fff", minWidth: 80 }}>
          <div style={{ fontSize: 22, lineHeight: 1 }}>{tong_diem}</div>
          <div style={{ fontSize: 11, opacity: 0.8 }}>/{diem_toi_da}</div>
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 26, fontWeight: 700, color: scoreColor }}>{phan_tram}%</span>
            <span style={{ fontWeight: 700, fontSize: 16, color: scoreColor }}>{xep_loai}</span>
          </div>
          <p style={{ fontSize: 14, lineHeight: 1.7, color: "var(--text)" }}>
            <MathText text={nhan_xet_chung} />
          </p>
        </div>
      </div>

      {/* CHẤM TỪNG DÒNG */}
      <div className="card">
        <div className="card-title">📋 Chấm từng dòng</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {(cac_cau || []).map((cau, i) => {
            const pct = cau.diem_dat / cau.diem_toi_da;
            const c   = pct >= 0.8 ? "var(--green)" : pct >= 0.4 ? "var(--amber)" : "var(--accent)";
            return (
              <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>

                {/* Header câu */}
                <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "11px 16px", background: "var(--surface2)", borderBottom: "1px solid var(--border)" }}>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>{cau.so_cau}</span>
                  {statusBadge(cau.trang_thai)}
                  <span style={{ marginLeft: "auto", fontWeight: 700, color: c, fontSize: 17 }}>
                    {cau.diem_dat}<span style={{ fontSize: 12, color: "var(--text3)", fontWeight: 400 }}>/{cau.diem_toi_da}đ</span>
                  </span>
                </div>

                {/* Bảng dòng */}
                {cau.cham_tung_dong?.length > 0 && (
                  <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                    <colgroup>
                      <col style={{ width: "80%" }} />
                      <col style={{ width: "20%" }} />
                    </colgroup>
                    <tbody>
                      {cau.cham_tung_dong.map((dong, j) => {
                        const isDung = dong.ket_qua?.includes("✓");
                        const isSai  = dong.ket_qua?.includes("✗");
                        const bg      = isSai ? "#fff8f8" : isDung ? "#f8fff9" : "#fffdf5";
                        const kqColor = isSai ? "var(--accent)" : isDung ? "var(--green)" : "var(--amber)";
                        return (
                          <tr key={j} style={{ background: bg, borderTop: j > 0 ? "1px solid var(--border)" : "none" }}>
                            {/* Dòng học sinh */}
                            <td style={{ padding: "9px 14px", fontSize: 13, lineHeight: 1.7, verticalAlign: "top", wordBreak: "break-word" }}>
                              <MathText text={dong.dong} />
                            </td>
                            {/* Kết quả */}
                            <td style={{ padding: "9px 8px", fontWeight: 700, color: kqColor, fontSize: 13, verticalAlign: "top", whiteSpace: "nowrap" }}>
                              {dong.ket_qua}
                            </td>

                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}

                {/* Lỗi + Gợi ý */}
                {cau.loi_sai && (
                  <div style={{ padding: "10px 16px", background: "#fff5f5", fontSize: 13, color: "#c62828", borderTop: "1px solid #fdd", lineHeight: 1.6 }}>
                    ✗ <strong>Lỗi:</strong> <MathText text={cau.loi_sai} />
                  </div>
                )}
                {cau.goi_y_sua && (
                  <div style={{ padding: "10px 16px", background: "#f0f7ff", fontSize: 13, color: "#1565c0", borderTop: "1px solid #d0e4ff", lineHeight: 1.6 }}>
                    💡 <MathText text={cau.goi_y_sua} />
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
