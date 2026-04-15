import { useEffect, useRef, useState } from "react";

const API = "https://grading-app-production-2949.up.railway.app";

// ── Load KaTeX once ──────────────────────────────────────────────────────────
const _cbs = [];
let _state = "idle"; // idle | loading | ready

function ensureKatex(cb) {
  if (_state === "ready") { cb(); return; }
  _cbs.push(cb);
  if (_state === "loading") return;
  _state = "loading";

  const css = document.createElement("link");
  css.rel = "stylesheet";
  css.href = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css";
  document.head.appendChild(css);

  const js = document.createElement("script");
  js.src = "https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js";
  js.onload = () => {
    _state = "ready";
    _cbs.forEach(f => f());
    _cbs.length = 0;
  };
  document.head.appendChild(js);
}

// ── Tokenizer: text → [{type,value}] ────────────────────────────────────────
const SUB = "₀₁₂₃₄₅₆₇₈₉";

function tokenize(text) {
  if (!text) return [];
  const tokens = [];
  let i = 0;

  const pushText = (ch) => {
    if (tokens.length && tokens[tokens.length - 1].type === "text")
      tokens[tokens.length - 1].value += ch;
    else tokens.push({ type: "text", value: ch });
  };
  const pushMath = (v) => tokens.push({ type: "math", value: v });

  while (i < text.length) {
    const ch = text[i];

    // Phân số: digits/digits (không bắt như 300.25%=75)
    const fracM = text.slice(i).match(/^(\d+)\/(\d+)/);
    if (fracM) {
      pushMath(`\\dfrac{${fracM[1]}}{${fracM[2]}}`);
      i += fracM[0].length; continue;
    }

    // x₁ y₁ etc
    if (/[a-zA-Z]/.test(ch) && i + 1 < text.length && SUB.includes(text[i + 1])) {
      const sub = SUB.indexOf(text[i + 1]);
      pushMath(`${ch}_{${sub}}`);
      i += 2; continue;
    }

    // lũy thừa ²  ³
    if (ch === '²' || ch === '³') {
      const exp = ch === '²' ? 2 : 3;
      const prev = tokens.pop();
      if (prev) {
        const base = prev.type === "math" ? prev.value : prev.value.replace(/ +$/, '');
        // Kiểm tra có ngoặc đóng trước không
        const lastChar = base[base.length - 1];
        if (lastChar === ')') pushMath(`${base}^${exp}`);
        else pushMath(`${base}^${exp}`);
      } else pushMath(`^${exp}`);
      i++; continue;
    }

    // √
    if (ch === '√') {
      let num = '', j = i + 1;
      while (j < text.length && /\d/.test(text[j])) { num += text[j]; j++; }
      pushMath(num ? `\\sqrt{${num}}` : `\\sqrt{}`);
      i = j; continue;
    }

    // Ký hiệu đặc biệt
    const symbols = { 'Δ': '\\Delta', '△': '\\Delta', '≈': '\\approx', '≤': '\\leq', '≥': '\\geq', '⟹': '\\Rightarrow', '→': '\\to', '≠': '\\neq', '∈': '\\in', '×': '\\times', '·': '\\cdot' };
    if (symbols[ch]) { pushMath(symbols[ch]); i++; continue; }

    pushText(ch);
    i++;
  }
  return tokens;
}

// ── MathSpan component ───────────────────────────────────────────────────────
function MathSpan({ text, style }) {
  const [parts, setParts] = useState(() => [{ type: "text", value: text || "" }]);

  useEffect(() => {
    if (!text) { setParts([]); return; }
    ensureKatex(() => {
      const tokens = tokenize(text);
      const rendered = tokens.map(t => {
        if (t.type !== "math") return t;
        try {
          return { type: "html", value: window.katex.renderToString(t.value, { throwOnError: false, strict: false }) };
        } catch { return { type: "text", value: t.value }; }
      });
      setParts(rendered);
    });
  }, [text]);

  return (
    <span style={style}>
      {parts.map((p, i) =>
        p.type === "html"
          ? <span key={i} dangerouslySetInnerHTML={{ __html: p.value }} />
          : <span key={i}>{p.value}</span>
      )}
    </span>
  );
}

// ── ResultPage ────────────────────────────────────────────────────────────────
export default function ResultPage({ result, onBack }) {
  const { studentName, subject, gradingResult, imageUrls, resultId } = result;
  const { tong_diem, diem_toi_da, phan_tram, xep_loai, nhan_xet_chung, cac_cau } = gradingResult;

  const scoreColor = phan_tram >= 80 ? "var(--green)" : phan_tram >= 60 ? "var(--amber)" : "var(--accent)";
  const scoreBg   = phan_tram >= 80 ? "#e8f5ee"       : phan_tram >= 60 ? "#fef3dc"       : "#fdecea";

  const statusBadge = (s) => {
    if (s === "Đúng")       return <span className="badge badge-green">✓ Đúng</span>;
    if (s === "Một phần")   return <span className="badge badge-amber">◑ Một phần</span>;
    if (s === "Bỏ trống")   return <span className="badge" style={{ background: "#f0f0f0", color: "#888" }}>— Bỏ trống</span>;
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
        <a href={`${API}/api/export/${resultId}/annotated-all`} target="_blank" rel="noreferrer" className="btn btn-outline" style={{ fontSize: 13, marginRight: 8 }}>📝 Bài đã chấm</a>
        <a href={`${API}/api/export/${resultId}/pdf`} target="_blank" rel="noreferrer" className="btn btn-primary" style={{ fontSize: 13, marginRight: 8 }}>📄 Xuất PDF</a>
        <a href={`${API}/api/export/${resultId}/html`}          target="_blank" rel="noreferrer" className="btn btn-outline" style={{ fontSize: 13 }}>🖨️ In HTML</a>
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
            <MathSpan text={nhan_xet_chung} />
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
                      <col style={{ width: "44%" }} />
                      <col style={{ width: "13%" }} />
                      <col style={{ width: "43%" }} />
                    </colgroup>
                    <tbody>
                      {cau.cham_tung_dong.map((dong, j) => {
                        const isDung = dong.ket_qua?.includes("✓");
                        const isSai  = dong.ket_qua?.includes("✗");
                        const bg       = isSai ? "#fff8f8" : isDung ? "#f8fff9" : "#fffdf5";
                        const kqColor  = isSai ? "var(--accent)" : isDung ? "var(--green)" : "var(--amber)";
                        return (
                          <tr key={j} style={{ background: bg, borderTop: j > 0 ? "1px solid var(--border)" : "none" }}>
                            {/* Dòng học sinh */}
                            <td style={{ padding: "9px 14px", fontSize: 13, lineHeight: 1.6, verticalAlign: "top", wordBreak: "break-word" }}>
                              <MathSpan text={dong.dong} />
                            </td>
                            {/* Kết quả */}
                            <td style={{ padding: "9px 8px", fontWeight: 700, color: kqColor, fontSize: 13, verticalAlign: "top", whiteSpace: "nowrap" }}>
                              {dong.ket_qua}
                            </td>
                            {/* Ghi chú — font sans, không italic */}
                            <td style={{ padding: "9px 14px", fontSize: 12.5, lineHeight: 1.6, color: isSai ? "#b71c1c" : "var(--text2)", verticalAlign: "top", fontStyle: "normal", wordBreak: "break-word" }}>
                              <MathSpan text={dong.ghi_chu} />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}

                {/* Lỗi sai */}
                {cau.loi_sai && (
                  <div style={{ padding: "10px 16px", background: "#fff5f5", fontSize: 13, color: "#c62828", borderTop: "1px solid #fdd", lineHeight: 1.6 }}>
                    ✗ <strong>Lỗi:</strong> <MathSpan text={cau.loi_sai} />
                  </div>
                )}
                {/* Gợi ý */}
                {cau.goi_y_sua && (
                  <div style={{ padding: "10px 16px", background: "#f0f7ff", fontSize: 13, color: "#1565c0", borderTop: "1px solid #d0e4ff", lineHeight: 1.6 }}>
                    💡 <MathSpan text={cau.goi_y_sua} />
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
        <a href={`${API}/api/export/${resultId}/html`} target="_blank" rel="noreferrer"
          className="btn btn-primary" style={{ flex: 1, justifyContent: "center" }}>🖨️ In báo cáo PDF</a>
      </div>
    </div>
  );
}
