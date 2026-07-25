import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

const App = () => (
  <main className="flex min-h-screen items-center justify-center">
    <span className="text-6xl" style={{ fontFamily: "var(--mp-font-display)" }}>
      mayo.pizza
    </span>
  </main>
);

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("The application root is missing.");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
