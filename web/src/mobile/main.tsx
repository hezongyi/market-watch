import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import MobileApp from "./MobileApp";
import "./controls.css";
import "./mobile.css";
import "./watch-a07.css";
import "./watch-controls.css";
import "./more-controls.css";
import "./records-controls.css";
import "./data-controls.css";
import "./login-controls.css";
import "./chart-controls.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter basename="/m">
      <MobileApp />
    </BrowserRouter>
  </React.StrictMode>,
);
