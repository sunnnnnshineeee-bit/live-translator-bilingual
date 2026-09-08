import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App"
import Overlay from "./Overlay"

const isOverlay =
  window.location.pathname === "/overlay"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isOverlay ? <Overlay /> : <App />}
  </StrictMode>,
)