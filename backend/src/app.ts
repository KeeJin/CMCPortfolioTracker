import express from "express";
import transactionsRouter from "./routes/transactions.js";
import baselineRouter from "./routes/baseline.js";
import portfolioRouter from "./routes/portfolio.js";

const app = express();
const port = Number(process.env.PORT) || 3001;

app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.use("/api/transactions", transactionsRouter);
app.use("/api/baseline", baselineRouter);
app.use("/api/portfolio", portfolioRouter);

app.listen(port, () => {
  console.log(`Backend server is running on port ${port}`);
});
