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

export default function UploadPage({ onResult }) {
  const [images, setImages] = useState([]);
  const [studentName, setStudentName] = useState("");
  const [subject, setSubject] = useState("Toán");
  const [rubricMode, setRubricMode] = useState("json"); // json | file
  const [rubricJson, setRubricJson] = useState(JSON.stringify(SAMPLE_RUBRIC, null, 2));
  const [rubricFile, setRubricFile] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dragging, setDragging] = useState(false);

  const imgRef = useRef();
  const rubricRef = useRef();

  const addImages = (files) => {
    const imgs = Array.from(files).filter(f => f.type.startsWith("image/"));
    setImages(prev => [...prev, ...imgs]);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    addImages(e.dataTransfer.files);
  };

  const removeImage = (i) => setImages(prev => prev.filter((_, idx) => idx !== i));

  const handleSubmit = async () => {
    if (!images.length) return setError("Vui lòng upload ảnh bài làm");
    if (!studentName.trim()) return setError("Vui lòng nhập tên học sinh");
    setError("");
    setLoading(true);

    try {
      const fd = new FormData();
      images.forEach(img => fd.append("images[]", img));
      fd.append("studentName", studentName);
      fd.append("subject", subject);

      if (rubricMode === "json") {
        fd.append("rubric", rubricJson);
      } else if (rubricFile) {
        // Parse rubric file first
        const ffd = new FormData();
        ffd.append("file", rubricFile);
        const parseRes = await fetch(`${API}/api/rubric/parse`, { method: "POST", body: ffd });
        const parseData = await parseRes.json();
        if (!parseRes.ok) throw new Error(parseData.error);
        fd.append("rubric", JSON.stringify(parseData.rubric));
      }

      const res = await fetch(`${API}/api/grade`, { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      onResult(data);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return (
    <div className="loading">
      <div className="spinner" />
      <div style={{ fontWeight: 600, fontSize: 16 }}>Đang chấm bài...</div>
      <div style={{ fontSize: 13, color: "var(--text3)" }}>Claude đang đọc và phân tích bài làm</div>
    </div>
  );

  return (
    <div>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 28, fontWeight: 700, marginBottom: 6 }}>
          Chấm bài tự luận
        </h1>
        <p style={{ color: "var(--text2)", fontSize: 14 }}>Upload ảnh bài làm và đáp án — AI sẽ chấm điểm từng câu</p>
      </div>

      {/* UPLOAD ẢNH */}
      <div className="card">
        <div className="card-title">📸 Ảnh bài làm học sinh</div>
        <div
          className={`drop-zone ${dragging ? "dragging" : ""}`}
          style={{
            border: `2px dashed ${dragging ? "var(--accent)" : "var(--border)"}`,
            borderRadius: 10,
            padding: "32px 20px",
            textAlign: "center",
            background: dragging ? "#fdf0ed" : "var(--surface2)",
            cursor: "pointer",
            transition: "all 0.15s",
            marginBottom: images.length ? 16 : 0,
          }}
          onClick={() => imgRef.current.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          <div style={{ fontSize: 32, marginBottom: 8 }}>🖼️</div>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Kéo thả ảnh vào đây</div>
          <div style={{ fontSize: 13, color: "var(--text3)" }}>hoặc bấm để chọn file — JPG, PNG, WebP</div>
          <input ref={imgRef} type="file" accept="image/*" multiple hidden onChange={e => addImages(e.target.files)} />
        </div>

        {images.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            {images.map((img, i) => (
              <div key={i} style={{ position: "relative" }}>
                <img
                  src={URL.createObjectURL(img)}
                  alt=""
                  style={{ width: 100, height: 100, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)" }}
                />
                <button
                  onClick={() => removeImage(i)}
                  style={{
                    position: "absolute", top: -6, right: -6,
                    width: 20, height: 20, borderRadius: "50%",
                    background: "var(--accent)", color: "#fff", border: "none",
                    cursor: "pointer", fontSize: 11, fontWeight: 700,
                    display: "flex", alignItems: "center", justifyContent: "center"
                  }}
                >×</button>
              </div>
            ))}
            <div
              onClick={() => imgRef.current.click()}
              style={{
                width: 100, height: 100, borderRadius: 8,
                border: "2px dashed var(--border)", display: "flex",
                alignItems: "center", justifyContent: "center",
                cursor: "pointer", color: "var(--text3)", fontSize: 24
              }}
            >+</div>
          </div>
        )}
      </div>

      {/* THÔNG TIN */}
      <div className="card">
        <div className="card-title">👤 Thông tin học sinh</div>
        <div className="form-row">
          <div className="form-group">
            <label>Họ tên học sinh *</label>
            <input type="text" placeholder="Nguyễn Văn A" value={studentName} onChange={e => setStudentName(e.target.value)} />
          </div>
          <div className="form-group">
            <label>Môn học</label>
            <select value={subject} onChange={e => setSubject(e.target.value)}>
              <option>Toán</option>
              <option>Ngữ văn</option>
              <option>Tiếng Anh</option>
              <option>Khoa học tự nhiên</option>
              <option>Lịch sử</option>
              <option>Địa lý</option>
            </select>
          </div>
        </div>
      </div>

      {/* RUBRIC */}
      <div className="card">
        <div className="card-title">📋 Đáp án & thang điểm (Rubric)</div>
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          <button
            className={`btn ${rubricMode === "json" ? "btn-primary" : "btn-outline"}`}
            style={{ fontSize: 13, padding: "7px 16px" }}
            onClick={() => setRubricMode("json")}
          >JSON / Nhập tay</button>
          <button
            className={`btn ${rubricMode === "file" ? "btn-primary" : "btn-outline"}`}
            style={{ fontSize: 13, padding: "7px 16px" }}
            onClick={() => setRubricMode("file")}
          >Upload file Word/JSON</button>
        </div>

        {rubricMode === "json" ? (
          <div className="form-group">
            <label>Nội dung rubric (JSON)</label>
            <textarea
              value={rubricJson}
              onChange={e => setRubricJson(e.target.value)}
              rows={12}
              style={{ fontFamily: "monospace", fontSize: 12 }}
            />
          </div>
        ) : (
          <div
            style={{
              border: "2px dashed var(--border)", borderRadius: 10,
              padding: "28px 20px", textAlign: "center",
              background: "var(--surface2)", cursor: "pointer"
            }}
            onClick={() => rubricRef.current.click()}
          >
            <div style={{ fontSize: 28, marginBottom: 8 }}>📄</div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              {rubricFile ? rubricFile.name : "Bấm để chọn file"}
            </div>
            <div style={{ fontSize: 13, color: "var(--text3)" }}>Chấp nhận .docx, .json, .txt</div>
            <input ref={rubricRef} type="file" accept=".docx,.json,.txt" hidden onChange={e => setRubricFile(e.target.files[0])} />
          </div>
        )}
      </div>

      {error && (
        <div style={{ background: "#fdecea", border: "1px solid #f5c6c2", borderRadius: 8, padding: "12px 16px", marginBottom: 16, color: "var(--accent)", fontSize: 14 }}>
          ⚠️ {error}
        </div>
      )}

      <button
        className="btn btn-primary"
        style={{ width: "100%", justifyContent: "center", padding: "14px", fontSize: 16 }}
        onClick={handleSubmit}
        disabled={!images.length || !studentName.trim()}
      >
        ✦ Chấm bài ngay
      </button>
    </div>
  );
}
