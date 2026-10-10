import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { SessionGate } from "./ui/SessionGate";
import "./ui/styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <SessionGate />
  </StrictMode>,
);
