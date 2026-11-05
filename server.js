const express = require("express");
const cors = require("cors");
const path = require("path");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, "public")));

const payheroRoutes = require("./routes/payhero");
// Mounted under /api/payhero to match the frontend fetch call
app.use("/api/payhero", payheroRoutes);

// Serve homepage
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Serve the M-Pesa deposit page directly at /mpesa
app.get("/mpesa", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "mpesa.html"));
});

const PORT = process.env.PORT || 3000;

// Always run app.listen so Render detects the open port
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});

module.exports = app;
