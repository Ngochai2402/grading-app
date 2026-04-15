import { useEffect, useRef, useState } from "react";

const API = "https://grading-app-production-2949.up.railway.app";

// Inject KaTeX một lần duy nhất
function ensureKatex(cb) {
  if (window.katex) { cb(); return; }
  if (window._katexLoading) { window._katexCbs = window._katexCbs || []; window._katexCbs.push(cb); return; }
  window._katexLoading = true;

  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css";
  document.head.appendChild(css);

  const js = document.createElement("script");
  js.src = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js";
  js.onload = () => {
    cb();
    (window._katexCbs || []).forEach(f => f());
  };
  document.head.appendChild(js);
}

// Tách text thành mảng {type: "text"|"math", value}
function tokenize(text) {
  if (!text) return [];
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    // x₁, x₂...
    if ((ch === 'x' || ch === 'y') && i + 1 < text.length && "₀₁₂₃₄₅₆₇₈₉".includes(text[i+1])) {
      const sub = "₀₁₂₃₄₅₆₇₈₉".indexOf(text[i+1]);
      tokens.push({ type: "math", value: `${ch}_{${sub}}` });
      i += 2; continue;
    }
    // lũy thừa: a²  a³
    if (i > 0 && text[i] === '²') { 
      const prev = tokens.pop();
      if (prev) tokens.push({ type: "math", value: `${prev.type === "math" ? prev.value : prev.value}^2` });
      else tokens.push({ type: "math", value: "^2" });
      i++; continue;
    }
    if (i > 0 && text[i] === '³') {
      const prev = tokens.pop();
      if (prev) tokens.push({ type: "math", value: `${prev.type === "math" ? prev.value : prev.value}^3` });
      else tokens.push({ type: "math", value: "^3" });
      i++; continue;
    }
    // √
    if (ch === '√') {
      let num = '';
      let j = i + 1;
      while (j < text.length && /\d/.test(text[j])) { num += text[j]; j++; }
      tokens.push({ type: "math", value: num ? `\\sqrt{${num}}` : `\\sqrt{}` });
      i = j; continue;
    }
    // Δ △
    if (ch === 'Δ' || ch === '△') { tokens.push({ type: "math", value: "\\Delta" }); i++; continue; }
    // ≈ ≤ ≥ ⟹ →
    if (ch === '≈') { tokens.push({ type: "math", value: "\\approx" }); i++; continue; }
    if (ch === '≤') { tokens.push({ type: "math", value: "\\leq" }); i++; continue; }
    if (ch === '≥') { tokens.push({ type: "math", value: "\\geq" }); i++; continue; }
    if (ch === '⟹') { tokens.push({ type: "math", value: "\\Rightarrow" }); i++; continue; }
    if (ch === '→') { tokens.push({ type: "math", value: "\\to" }); i++; continue; }
    // phân số số/số
    const fracMatch = text.slice(i).match(/^(\d+)\/(\d+)/);
    if (fracMatch) {
      tokens.push({ type: "math", value: `\\dfrac{${fracMatch[1]}}{${fracMatch[2]}}` });
      i += fracMatch[0].length; continue;
    }
    // text thường
    if (tokens.length && tokens[tokens.length-1].type === "text") {
      tokens[tokens.length-1].value += ch;
    } else {
      tokens.push({ type: "text", value: ch });
    }
    i++;
  }
  return tokens;
}

function MathLine({ text }) {
  const [parts, setParts] = useState(null);

  useEffect(() => {
    if (!text) { setParts([]); return; }
    ensureKatex(() => {
      const tokens = tokenize(text);
      const rendered = tokens.map((t, i) => {
        if (t.type === "math") {
          try {
            return { type: "html", value: window.katex.renderToString(t.value, { throwOnError: false }) };
          } catch { return { type: "text", value: t.value }; }
        }
        return t;
      });
      setParts(rendered);
    });
  }, [text]);

  if (!parts) return <span>{text}</span>;
  return (
    <span>
      {parts.map((p, i) =>
        p.type === "html"
          ? <span key={i} dangerouslySetInnerHTML={{ __html: p.value }} />
          : <span key={i}>{p.value}</span>
      )}
    </span>
  );
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
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 24 }}>
        <button className="btn btn-ghost" onClick={onBack}>← Quay lại</button>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 24, fontWeight: 700 }}>Kết quả chấm bài</h1>
          <div style={{ fontSize: 13, color: "var(--text2)" }}>{studentName} • {subject}</div>
        </div>
        <a href={`${API}/api/export/${resultId}/annotated-all`} target="_blank" rel="noreferrer" className="btn btn-outline" style={{ fontSize: 13, marginRight: 8 }}>📝 Bài đã chấm</a>
        <a href={`${API}/api/export/${resultId}/html`} target="_blank" rel="noreferrer" className="btn btn-outline" style={{ fontSize: 13 }}>🖨️ In PDF</a>
      </div>

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
          <p style={{ fontSize: 14, color: "var(--text)", lineHeight: 1.6 }}><MathLine text={nhan_xet_chung} /></p>
        </div>
      </div>

      <div className="card">
        <div className="card-title">📋 Chấm từng dòng</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {(cac_cau || []).map((cau, i) => {
            const pct = cau.diem_dat / cau.diem_toi_da;
            const c = pct >= 0.8 ? "var(--green)" : pct >= 0.4 ? "var(--amber)" : "var(--accent)";
            return (
              <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: "var(--surface2)", borderBottom: "1px solid var(--border)" }}>
                  <span style={{ fontWeight: 700, fontSize: 15 }}>{cau.so_cau}</span>
                  {statusBadge(cau.trang_thai)}
                  <span style={{ marginLeft: "auto", fontWeight: 700, color: c, fontSize: 17 }}>
                    {cau.diem_dat}<span style={{ fontSize: 12, color: "var(--text3)", fontWeight: 400 }}>/{cau.diem_toi_da}đ</span>
                  </span>
                </div>

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
                            <td style={{ padding: "9px 14px", fontSize: 13, width: "45%" }}>
                              <MathLine text={dong.dong} />
                            </td>
                            <td style={{ padding: "9px 10px", fontWeight: 700, color: kqColor, fontSize: 13, whiteSpace: "nowrap", width: "14%" }}>
                              {dong.ket_qua}
                            </td>
                            <td style={{ padding: "9px 14px", fontSize: 12, color: isSai ? "var(--accent)" : "var(--text3)", lineHeight: 1.5 }}>
                              <MathLine text={dong.ghi_chu} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}

                {cau.loi_sai && (
                  <div style={{ padding: "10px 16px", background: "#fff8f8", fontSize: 13, color: "var(--accent)", borderTop: "1px solid var(--border)" }}>
                    ✗ <strong>Lỗi sai:</strong> <MathLine text={cau.loi_sai} />
                  </div>
                )}
                {cau.goi_y_sua && (
                  <div style={{ padding: "10px 16px", background: "#f0f7ff", fontSize: 13, color: "var(--blue)", borderTop: "1px solid var(--border)" }}>
                    💡 <strong>Gợi ý:</strong> <MathLine text={cau.goi_y_sua} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {imageUrls && imageUrls.length > 0 && (
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
        <a href={`${API}/api/export/${resultId}/html`} target="_blank" rel="noreferrer"
          className="btn btn-primary" style={{ flex: 1, justifyContent: "center" }}>🖨️ In báo cáo PDF</a>
      </div>
    </div>
  );
}
