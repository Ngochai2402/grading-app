# 🎓 Grading App — Chấm bài tự luận bằng Claude Vision

Ứng dụng chấm bài kiểm tra viết tay bằng AI. Upload ảnh bài làm → nhận kết quả điểm từng câu + nhận xét chi tiết.

## Cấu trúc

```
grading-app/
├── backend/          ← Node.js/Express + Claude Vision
└── frontend/         ← React (sẽ thêm sau)
```

---

## 🚀 Cài đặt & Deploy

### Bước 1 — Clone về máy

```bash
git clone https://github.com/<username>/grading-app.git
cd grading-app/backend
npm install
```

### Bước 2 — Chạy local

Tạo file `backend/.env`:
```
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxxxxx
PORT=3001
```

```bash
npm run dev
# → http://localhost:3001/api/health
```

### Bước 3 — Deploy lên Railway

1. Vào [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Chọn repo này, chọn thư mục **backend** làm Root Directory
3. Vào **Variables** → thêm:
   - `ANTHROPIC_API_KEY` = `sk-ant-...`
   - `PORT` = `3001`
4. Railway tự build và deploy. Copy URL dạng `https://grading-app-xxx.up.railway.app`

---

## 📡 API Endpoints

| Method | URL | Mô tả |
|--------|-----|-------|
| GET | `/api/health` | Kiểm tra server |
| POST | `/api/grade` | Chấm bài (upload ảnh + rubric) |
| GET | `/api/grade` | Danh sách bài đã chấm |
| GET | `/api/grade/:id` | Chi tiết 1 bài |
| POST | `/api/rubric/parse` | Parse file Word/JSON thành rubric |
| GET | `/api/export/:id/html` | Báo cáo HTML (có nút in PDF) |
| GET | `/api/export/:id/annotated` | Ảnh bài làm có chú thích điểm |

## 📋 Format Rubric JSON

```json
{
  "ten_de": "Kiểm tra 15 phút - Đại số",
  "mon_hoc": "Toán",
  "lop": "8A",
  "tong_diem": 10,
  "cac_cau": [
    {
      "so_cau": "Câu 1",
      "noi_dung": "Rút gọn...",
      "diem": 3,
      "dap_an": "Đáp án chi tiết...",
      "tieu_chi": [
        { "mo_ta": "Bước 1 đúng", "diem": 1 },
        { "mo_ta": "Kết quả đúng", "diem": 2 }
      ]
    }
  ]
}
```
