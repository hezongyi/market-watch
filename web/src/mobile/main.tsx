import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import MobileApp from "./MobileApp";
import "./mobile.css";
import "./watch-a07.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter basename="/m">
      <MobileApp />
    </BrowserRouter>
  </React.StrictMode>,
);
