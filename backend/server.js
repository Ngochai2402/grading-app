const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const gradeRouter = require('./routes/grade');
const rubricRouter = require('./routes/rubric');
const exportRouter = require('./routes/export');

const app = express();
const PORT = process.env.PORT || 3001;

// Tạo thư mục uploads nếu chưa có
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const RESULTS_DIR = path.join(__dirname, 'results');
[UPLOADS_DIR, RESULTS_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use(cors({ origin: 'http://localhost:3000' }));
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/results', express.static(RESULTS_DIR));

app.use('/api/grade', gradeRouter);
app.use('/api/rubric', rubricRouter);
app.use('/api/export', exportRouter);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`✅ Backend chạy tại http://localhost:${PORT}`);
});
