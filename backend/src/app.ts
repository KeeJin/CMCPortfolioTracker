import express from "express";

const app = express();
const port = Number(process.env.PORT) || 3001;

app.get("/api/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.listen(port, () => {
  console.log(`Backend server is running on port ${port}`);
});
