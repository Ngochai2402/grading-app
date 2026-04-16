import { useState, useRef } from "react";

const API = "https://grading-app-production-2949.up.railway.app";

const SAMPLE_RUBRIC = {
  ten_de: "Kiểm tra 15 phút - Đại số",
  mon_hoc: "Toán",
  lop: "8A",
  tong_diem: 10,
  cac_cau: [
    { so_cau: "Câu 1", noi_dung: "Rút gọn: (x+2)² - (x-2)²", diem: 3, dap_an: "8x", tieu_chi: [{ mo_ta: "Khai triển đúng", diem: 2 }, { mo_ta: "Kết quả 8x", diem: 1 }] },
    { so_cau: "Câu 2", noi_dung: "Giải PT: 2x + 5 = 13", diem: 3, dap_an: "x = 4", tieu_chi: [{ mo_ta: "Chuyển vế đúng", diem: 1 }, { mo_ta: "Kết quả x=4", diem: 2 }] },
    { so_cau: "Câu 3", noi_dung: "Phân tích: x² - 9", diem: 4, dap_an: "(x-3)(x+3)", tieu_chi: [{ mo_ta: "Nhận dạng HĐT", diem: 2 }, { mo_ta: "Kết quả đúng", diem: 2 }] },
  ]
};

// Trạng thái của từng học sinh
// pending | grading-ocr | grading-score | done | error
function mkStudent(id) {
  return { id, name: "", images: [], status: "pending", result: null, error: null };
}

let _sid = 1;

export default function BatchPage() {
  const [students, setStudents] = useState([mkStudent(_sid++)]);
  const [subject, setSubject] = useState("Toán");
  const [rubricJson, setRubricJson] = useState(JSON.stringify(SAMPLE_RUBRIC, null, 2));
  const [rubricError, setRubricError] = useState("");
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [showRubric, setShowRubric] = useState(false);

  const fileRefs = useRef({});

  // ── helpers ──────────────────────────────────────────────────────────────────
  const updateStudent = (id, patch) =>
    setStudents(prev => prev.map(s => s.id === id ? { ...s, ...patch } : s));

  const addStudent = () => {
    setStudents(prev => [...prev, mkStudent(_sid++)]);
  };

  const removeStudent = (id) => {
    setStudents(prev => prev.filter(s => s.id !== id));
  };

  const addImages = (id, files) => {
    const imgs = Array.from(files).filter(f => f.type.startsWith("image/"));
    updateStudent(id, { images: [...(students.find(s => s.id === id)?.images || []), ...imgs] });
  };

  const removeImage = (sid, idx) => {
    setStudents(prev => prev.map(s => {
      if (s.id !== sid) return s;
      return { ...s, images: s.images.filter((_, i) => i !== idx) };
    }));
  };

  // ── Tải PDF tự động ──────────────────────────────────────────────────────────
  const downloadPdf = async (resultId, studentName) => {
    try {
      const safeName = studentName.replace(/[^a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF\s_-]/g, "").trim() || resultId;
      const url = `${API}/api/export/${resultId}/pdf`;
      const res = await fetch(url);
      if (!res.ok) throw new Error("PDF lỗi");
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `${safeName}.pdf`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    } catch (e) {
      console.error("Lỗi tải PDF:", e);
    }
  };

  // ── Chấm 1 học sinh ──────────────────────────────────────────────────────────
  const gradeOne = async (student, rubric) => {
    updateStudent(student.id, { status: "grading-ocr", error: null });

    try {
      const fd = new FormData();
      student.images.forEach(img => fd.append("images[]", img));
      fd.append("studentName", student.name);
      fd.append("subject", subject);
      fd.append("rubric", JSON.stringify(rubric));

      updateStudent(student.id, { status: "grading-ocr" });

      const res = await fetch(`${API}/api/grade`, { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Lỗi chấm bài");

      updateStudent(student.id, { status: "done", result: data });

      // Tải PDF ngay sau khi xong
      await downloadPdf(data.resultId, student.name);
    } catch (e) {
      updateStudent(student.id, { status: "error", error: e.message });
    }
  };

  // ── Chạy tuần tự ────────────────────────────────────────────────────────────
  const handleStart = async () => {
    setRubricError("");
    let rubric;
    try {
      rubric = JSON.parse(rubricJson);
    } catch {
      setRubricError("Rubric không đúng định dạng JSON");
      return;
    }

    const valid = students.filter(s => s.name.trim() && s.images.length > 0);
    if (valid.length === 0) {
      setRubricError("Chưa có học sinh nào đủ thông tin (cần tên + ảnh)");
      return;
    }

    setRunning(true);
    setDone(false);

    // Reset trạng thái pending cho tất cả học sinh hợp lệ
    setStudents(prev => prev.map(s =>
      s.name.trim() && s.images.length > 0
        ? { ...s, status: "pending", result: null, error: null }
        : s
    ));

    // Chạy tuần tự
    for (const student of valid) {
      await gradeOne(student, rubric);
    }

    setRunning(false);
    setDone(true);
  };

  // ── Stats ────────────────────────────────────────────────────────────────────
  const validCount = students.filter(s => s.name.trim() && s.images.length > 0).length;
  const doneCount  = students.filter(s => s.status === "done").length;
  const errorCount = students.filter(s => s.status === "error").length;
  const gradingIdx = students.findIndex(s => s.status === "grading-ocr" || s.status === "grading-score");

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* TIÊU ĐỀ */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 700, marginBottom: 4 }}>
          Chấm cả lớp
        </h1>
        <p style={{ color: "var(--text2)", fontSize: 14 }}>
          Thêm danh sách học sinh → bấm Chấm → PDF tự động tải về lần lượt
        </p>
      </div>

      {/* ── BẢNG CÀI ĐẶT CHUNG ── */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-title">⚙️ Cài đặt chung</div>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
          <div style={{ flex: "0 0 180px" }}>
            <label style={labelStyle}>Môn học</label>
            <select value={subject} onChange={e => setSubject(e.target.value)} style={inputStyle} disabled={running}>
              <option>Toán</option>
              <option>Ngữ văn</option>
              <option>Tiếng Anh</option>
              <option>Khoa học tự nhiên</option>
              <option>Lịch sử</option>
              <option>Địa lý</option>
            </select>
          </div>

          <div style={{ flex: 1, minWidth: 240 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6 }}>
              <label style={labelStyle}>Đáp án / Rubric (JSON)</label>
              <button
                style={{ fontSize: 12, color: "var(--accent)", background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}
                onClick={() => setShowRubric(v => !v)}
              >
                {showRubric ? "▲ Thu gọn" : "▼ Mở rộng"}
              </button>
            </div>
            {showRubric ? (
              <textarea
                value={rubricJson}
                onChange={e => { setRubricJson(e.target.value); setRubricError(""); }}
                rows={10}
                style={{ ...inputStyle, fontFamily: "monospace", fontSize: 12 }}
                disabled={running}
              />
            ) : (
              <div
                onClick={() => setShowRubric(true)}
                style={{
                  padding: "10px 14px", background: "var(--surface2)", border: "1px solid var(--border)",
                  borderRadius: 8, fontSize: 12, color: "var(--text3)", cursor: "pointer",
                  fontFamily: "monospace", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis"
                }}
              >
                {rubricJson.slice(0, 120)}...
              </div>
            )}
            {rubricError && (
              <div style={{ color: "var(--accent)", fontSize: 12, marginTop: 6 }}>⚠️ {rubricError}</div>
            )}
          </div>
        </div>
      </div>

      {/* ── DANH SÁCH HỌC SINH ── */}
      <div style={{ marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>
          Danh sách học sinh
          <span style={{ fontWeight: 400, color: "var(--text3)", fontSize: 13, marginLeft: 8 }}>
            ({validCount} học sinh sẵn sàng)
          </span>
        </div>
        {running && (
          <div style={{ fontSize: 13, color: "var(--text2)" }}>
            ✅ {doneCount}/{validCount} xong
            {errorCount > 0 && <span style={{ color: "var(--accent)", marginLeft: 8 }}>⚠️ {errorCount} lỗi</span>}
          </div>
        )}
      </div>

      {students.map((student, idx) => (
        <StudentCard
          key={student.id}
          student={student}
          idx={idx}
          running={running}
          fileRef={el => fileRefs.current[student.id] = el}
          onNameChange={name => updateStudent(student.id, { name })}
          onAddImages={files => addImages(student.id, files)}
          onRemoveImage={i => removeImage(student.id, i)}
          onRemove={() => removeStudent(student.id)}
          onRetry={() => gradeOne(student, (() => { try { return JSON.parse(rubricJson); } catch { return null; } })())}
          isActive={gradingIdx >= 0 && students[gradingIdx]?.id === student.id}
        />
      ))}

      {/* NÚT THÊM */}
      {!running && (
        <button
          onClick={addStudent}
          style={{
            width: "100%", padding: "13px", border: "2px dashed var(--border)",
            borderRadius: 10, background: "none", cursor: "pointer",
            fontSize: 14, color: "var(--text2)", fontFamily: "inherit",
            display: "flex", alignItems: "center", justifyContent: "center", gap: 8,
            marginBottom: 24, transition: "all 0.15s"
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--accent)"; e.currentTarget.style.color = "var(--accent)"; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = "var(--border)"; e.currentTarget.style.color = "var(--text2)"; }}
        >
          <span style={{ fontSize: 20, lineHeight: 1 }}>+</span>
          Thêm học sinh
        </button>
      )}

      {/* ── NÚT CHẤM ── */}
      {!done ? (
        <button
          className="btn btn-primary"
          style={{ width: "100%", justifyContent: "center", padding: "15px", fontSize: 16 }}
          onClick={handleStart}
          disabled={running || validCount === 0}
        >
          {running
            ? <><Spinner /> Đang chấm {doneCount + 1}/{validCount}...</>
            : `✦ Chấm cả lớp (${validCount} học sinh)`
          }
        </button>
      ) : (
        <div style={{
          background: "var(--surface)", border: "1.5px solid var(--green)",
          borderRadius: 12, padding: "20px 24px", textAlign: "center"
        }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>🎉</div>
          <div style={{ fontWeight: 700, fontSize: 16, color: "var(--green)", marginBottom: 4 }}>
            Đã chấm xong {doneCount} học sinh!
          </div>
          <div style={{ fontSize: 13, color: "var(--text2)", marginBottom: 16 }}>
            PDF đã được tải về tự động. Nếu có bài chưa tải được, bấm nút bên dưới.
          </div>
          {errorCount > 0 && (
            <div style={{ color: "var(--accent)", fontSize: 13, marginBottom: 12 }}>
              ⚠️ {errorCount} bài bị lỗi — hãy kiểm tra lại ảnh và bấm "Thử lại"
            </div>
          )}
          <button
            className="btn btn-outline"
            onClick={() => { setDone(false); setStudents([mkStudent(_sid++)]); }}
            style={{ fontSize: 14 }}
          >
            ← Chấm lớp mới
          </button>
        </div>
      )}
    </div>
  );
}

// ── StudentCard ───────────────────────────────────────────────────────────────
function StudentCard({ student, idx, running, fileRef, onNameChange, onAddImages, onRemoveImage, onRemove, onRetry, isActive }) {
  const [dragging, setDragging] = useState(false);
  const { status, result, error, name, images } = student;

  const statusColor = {
    pending: "var(--text3)",
    "grading-ocr": "var(--amber)",
    "grading-score": "var(--amber)",
    done: "var(--green)",
    error: "var(--accent)",
  }[status] || "var(--text3)";

  const statusLabel = {
    pending: "Chờ",
    "grading-ocr": "Đang OCR...",
    "grading-score": "Đang chấm...",
    done: `${result?.gradingResult?.tong_diem ?? "?"}/${result?.gradingResult?.diem_toi_da ?? "?"} điểm`,
    error: "Lỗi",
  }[status] || "";

  const isGrading = status === "grading-ocr" || status === "grading-score";

  return (
    <div style={{
      background: "#fff",
      border: `1.5px solid ${isActive ? "var(--accent)" : status === "done" ? "#b8d9c3" : status === "error" ? "#f5c6c2" : "var(--border)"}`,
      borderRadius: 12,
      marginBottom: 12,
      overflow: "hidden",
      boxShadow: isActive ? "0 0 0 3px rgba(200,75,49,0.12)" : "var(--shadow)",
      transition: "all 0.2s",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", gap: 12,
        padding: "12px 16px",
        background: status === "done" ? "#f5fdf8" : status === "error" ? "#fff8f8" : "var(--surface2)",
        borderBottom: "1px solid var(--border)"
      }}>
        {/* Số thứ tự */}
        <div style={{
          width: 28, height: 28, borderRadius: "50%",
          background: status === "done" ? "var(--green)" : status === "error" ? "var(--accent)" : "var(--border)",
          color: status === "done" || status === "error" ? "#fff" : "var(--text2)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 13, fontWeight: 700, flexShrink: 0
        }}>
          {status === "done" ? "✓" : status === "error" ? "✗" : idx + 1}
        </div>

        {/* Tên */}
        <input
          type="text"
          placeholder={`Tên học sinh ${idx + 1}...`}
          value={name}
          onChange={e => onNameChange(e.target.value)}
          disabled={running}
          style={{
            flex: 1, border: "none", outline: "none", background: "transparent",
            fontSize: 15, fontWeight: 600, fontFamily: "inherit", color: "var(--text)"
          }}
        />

        {/* Status badge */}
        <div style={{
          fontSize: 12, fontWeight: 600, color: statusColor,
          display: "flex", alignItems: "center", gap: 6
        }}>
          {isGrading && <Spinner size={14} />}
          {statusLabel}
        </div>

        {/* Nút tải lại PDF nếu done */}
        {status === "done" && result && (
          <button
            onClick={() => {
              const safeName = name.replace(/[^a-zA-Z0-9\u00C0-\u024F\u1E00-\u1EFF\s_-]/g, "").trim() || result.resultId;
              fetch(`${API}/api/export/${result.resultId}/pdf`)
                .then(r => r.blob())
                .then(blob => {
                  const a = document.createElement("a");
                  a.href = URL.createObjectURL(blob);
                  a.download = `${safeName}.pdf`;
                  a.click();
                });
            }}
            style={{
              padding: "5px 12px", fontSize: 12, background: "var(--green)",
              color: "#fff", border: "none", borderRadius: 6, cursor: "pointer",
              fontFamily: "inherit", fontWeight: 600
            }}
          >
            ↓ PDF
          </button>
        )}

        {/* Thử lại nếu lỗi */}
        {status === "error" && !running && (
          <button
            onClick={onRetry}
            style={{
              padding: "5px 12px", fontSize: 12, background: "var(--accent)",
              color: "#fff", border: "none", borderRadius: 6, cursor: "pointer",
              fontFamily: "inherit", fontWeight: 600
            }}
          >
            Thử lại
          </button>
        )}

        {/* Xóa */}
        {!running && (
          <button
            onClick={onRemove}
            style={{
              width: 26, height: 26, borderRadius: "50%", border: "1px solid var(--border)",
              background: "none", cursor: "pointer", fontSize: 14, color: "var(--text3)",
              display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0
            }}
          >×</button>
        )}
      </div>

      {/* Body: upload ảnh */}
      {status !== "done" && (
        <div style={{ padding: "14px 16px" }}>
          {error && (
            <div style={{ fontSize: 12, color: "var(--accent)", background: "#fff5f5", borderRadius: 6, padding: "8px 12px", marginBottom: 10 }}>
              ⚠️ {error}
            </div>
          )}

          {/* Drop zone nhỏ gọn */}
          <div
            style={{
              border: `2px dashed ${dragging ? "var(--accent)" : "var(--border)"}`,
              borderRadius: 8, padding: images.length ? "10px 14px" : "18px 14px",
              background: dragging ? "#fff5f4" : "var(--surface2)",
              cursor: running ? "not-allowed" : "pointer",
              transition: "all 0.15s", textAlign: images.length ? "left" : "center",
            }}
            onClick={() => !running && fileRef?.click()}
            onDragOver={e => { if (!running) { e.preventDefault(); setDragging(true); } }}
            onDragLeave={() => setDragging(false)}
            onDrop={e => {
              e.preventDefault(); setDragging(false);
              if (!running) onAddImages(e.dataTransfer.files);
            }}
          >
            {images.length === 0 ? (
              <>
                <div style={{ fontSize: 22, marginBottom: 4 }}>🖼️</div>
                <div style={{ fontSize: 13, color: "var(--text2)", fontWeight: 500 }}>Kéo thả hoặc bấm để chọn ảnh bài làm</div>
                <div style={{ fontSize: 12, color: "var(--text3)" }}>JPG, PNG, WebP — nhiều trang OK</div>
              </>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center" }}>
                {images.map((img, i) => (
                  <div key={i} style={{ position: "relative" }}>
                    <img
                      src={URL.createObjectURL(img)}
                      alt=""
                      style={{ width: 68, height: 68, objectFit: "cover", borderRadius: 6, border: "1px solid var(--border)", display: "block" }}
                    />
                    {!running && (
                      <button
                        onClick={e => { e.stopPropagation(); onRemoveImage(i); }}
                        style={{
                          position: "absolute", top: -5, right: -5,
                          width: 18, height: 18, borderRadius: "50%",
                          background: "var(--accent)", color: "#fff", border: "none",
                          cursor: "pointer", fontSize: 10, fontWeight: 700,
                          display: "flex", alignItems: "center", justifyContent: "center", lineHeight: 1
                        }}
                      >×</button>
                    )}
                  </div>
                ))}
                {!running && (
                  <div
                    style={{
                      width: 68, height: 68, borderRadius: 6,
                      border: "2px dashed var(--border)", display: "flex",
                      alignItems: "center", justifyContent: "center",
                      fontSize: 22, color: "var(--text3)", cursor: "pointer"
                    }}
                  >+</div>
                )}
              </div>
            )}
            <input
              ref={fileRef}
              type="file" accept="image/*" multiple hidden
              onChange={e => onAddImages(e.target.files)}
            />
          </div>
        </div>
      )}

      {/* Kết quả mini khi done */}
      {status === "done" && result && (
        <div style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 16 }}>
          <ScorePill result={result.gradingResult} />
          <div style={{ flex: 1, fontSize: 13, color: "var(--text2)", lineHeight: 1.5 }}>
            {(result.gradingResult.cac_cau || []).map((c, i) => (
              <span key={i} style={{ marginRight: 12 }}>
                <span style={{ color: "var(--text3)" }}>{c.so_cau}:</span>{" "}
                <strong style={{ color: scoreColor(c.diem_dat / c.diem_toi_da) }}>
                  {c.diem_dat}/{c.diem_toi_da}
                </strong>
              </span>
            ))}
          </div>
          <a
            href={`${API}/api/export/${result.resultId}/html`}
            target="_blank" rel="noreferrer"
            style={{ fontSize: 12, color: "var(--text3)", textDecoration: "none" }}
          >
            Xem chi tiết →
          </a>
        </div>
      )}
    </div>
  );
}

// ── Micro components ──────────────────────────────────────────────────────────
function ScorePill({ result }) {
  const { tong_diem, diem_toi_da, phan_tram, xep_loai } = result;
  const c = phan_tram >= 80 ? "var(--green)" : phan_tram >= 60 ? "var(--amber)" : "var(--accent)";
  const bg = phan_tram >= 80 ? "#eaf5ee" : phan_tram >= 60 ? "#fef9e7" : "#fdecea";
  return (
    <div style={{
      background: bg, border: `1.5px solid ${c}`, borderRadius: 8,
      padding: "6px 14px", textAlign: "center", minWidth: 80, flexShrink: 0
    }}>
      <div style={{ fontSize: 18, fontWeight: 800, color: c, lineHeight: 1 }}>{tong_diem}/{diem_toi_da}</div>
      <div style={{ fontSize: 11, color: c, fontWeight: 600, marginTop: 2 }}>{xep_loai}</div>
    </div>
  );
}

function scoreColor(pct) {
  return pct >= 0.8 ? "var(--green)" : pct >= 0.4 ? "var(--amber)" : "var(--accent)";
}

function Spinner({ size = 16 }) {
  return (
    <span style={{
      display: "inline-block", width: size, height: size,
      border: `2px solid currentColor`, borderTopColor: "transparent",
      borderRadius: "50%", animation: "spin 0.7s linear infinite", flexShrink: 0
    }} />
  );
}

const labelStyle = { fontSize: 13, fontWeight: 600, color: "var(--text2)", display: "block", marginBottom: 6 };
const inputStyle = {
  width: "100%", padding: "9px 12px", border: "1px solid var(--border)",
  borderRadius: 8, fontSize: 14, fontFamily: "inherit", outline: "none",
  background: "#fff", color: "var(--text)"
};
