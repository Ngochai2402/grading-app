import { useState } from "react";
import UploadPage from "./pages/UploadPage";
import ResultPage from "./pages/ResultPage";
import HistoryPage from "./pages/HistoryPage";
import "./App.css";

export default function App() {
  const [page, setPage] = useState("upload"); // upload | result | history
  const [result, setResult] = useState(null);

  return (
    <div className="app">
      <nav className="nav">
        <div className="nav-logo">
          <span className="nav-icon">✦</span>
          <span>Chấm Bài AI</span>
        </div>
        <div className="nav-links">
          <button
            className={page === "upload" ? "active" : ""}
            onClick={() => setPage("upload")}
          >
            Chấm bài mới
          </button>
          <button
            className={page === "history" ? "active" : ""}
            onClick={() => setPage("history")}
          >
            Lịch sử
          </button>
        </div>
      </nav>

      <main className="main">
        {page === "upload" && (
          <UploadPage
            onResult={(r) => {
              setResult(r);
              setPage("result");
            }}
          />
        )}
        {page === "result" && result && (
          <ResultPage
            result={result}
            onBack={() => setPage("upload")}
          />
        )}
        {page === "history" && (
          <HistoryPage
            onSelect={(r) => {
              setResult(r);
              setPage("result");
            }}
          />
        )}
      </main>
    </div>
  );
}
